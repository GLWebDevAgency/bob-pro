import { timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { setPrincipal } from '../observability/logger';

interface RequestLike {
  url: string;
  method?: string;
  headers: Record<string, string | undefined>;
}

/** Format de tenant admis à la frontière (neutralise tout métacaractère avant le GUC RLS). */
const COMPANY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Niveau 1 — PUBLIC (aucune Authorization exigée) : à l'étape SIRET de l'inscription,
 * l'utilisateur N'A PAS ENCORE de compte, donc aucun JWT. Seul le lookup annuaire est ouvert
 * (données officielles publiques, ZÉRO donnée tenant ; garde-fou : @Throttle 20/min côté
 * controller). Traité AVANT toute lecture du header Authorization : un Bearer invalide ou
 * statique (EXPO_PUBLIC_API_TOKEN de dev) ne doit jamais transformer cet endpoint en 403.
 * Liste EXPLICITE (méthode + chemin exact) — jamais d'ouverture par préfixe large.
 */
function isPublicSignupEndpoint(method: string, url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return method === 'GET' && path === '/company/lookup';
}

/** Replay one-way d'une tombstone push après destruction du JWT. Aucun autre verbe/chemin public. */
function isPublicPushRevocationEndpoint(method: string, url: string): boolean {
  // Interdit même une query ignorée : un secret/capability dans l'URL finirait dans proxy/APM.
  return method === 'POST' && url === '/public/push-revocations';
}

/** Webhook Stripe : public au sens JWT uniquement ; signature HMAC vérifiée sur le raw body. */
function isStripeWebhookEndpoint(method: string, url: string): boolean {
  return method === 'POST' && url === '/webhooks/stripe';
}

/**
 * Niveau 2 — JWT VALIDE requis mais tenant OPTIONNEL (C24b) : le provisioning exige d'être
 * authentifié (le JWT fournit le userId pour l'id déterministe company-<userId> et l'écriture
 * app_metadata), mais le compte neuf n'a pas encore de company_id. Liste blanche EXPLICITE.
 */
function allowsMissingTenant(method: string, url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return (method === 'POST' && path === '/onboarding/company') || isCabinetEndpoint(url);
}

/** Le bounded context Cabinet possède son propre tenant ; app_metadata.company_id n'y fait pas autorité. */
function isCabinetEndpoint(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return path === '/cabinet/v1' || path.startsWith('/cabinet/v1/');
}

/** /metrics est toujours fail-closed derrière un secret, quel que soit le profil de démarrage. */
function hasValidMetricsCredential(headers: Record<string, string | undefined>): boolean {
  const expected = process.env.METRICS_TOKEN;
  if (!expected || expected.length < 32) return false;
  const authorization = headers['authorization'];
  const candidate =
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : headers['x-metrics-token'];
  if (typeof candidate !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const candidateBytes = Buffer.from(candidate, 'utf8');
  return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
}

/**
 * Garde d'authentification.
 * - Tous les profils : vérifie le JWT Supabase via JWKS public (signature + exp), pose le
 *   Principal (anti-IDOR). Aucun header local ni variable d'environnement ne peut contourner
 *   cette frontière dans l'artefact serveur.
 *   Un JWT valide SANS app_metadata.company_id conforme → principal { userId, companyId: null } :
 *   seuls les endpoints de la liste blanche passent ; le reste reçoit 403 PROVISIONING_REQUIRED
 *   (JAMAIS de repli sur le tenant de démo — c'était une lecture cross-tenant).
 * Endpoints d'infra (/health, /metrics) toujours ouverts.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private jwks: JWTVerifyGetKey | null = null;

  private getJwks(): JWTVerifyGetKey | null {
    const url = process.env.SUPABASE_JWKS_URL;
    if (!url) return null;
    this.jwks ??= createRemoteJWKSet(new URL(url));
    return this.jwks;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestLike>();
    // Infra + endpoints publics EXPLICITES (signature client à distance). Préfixe étroit volontaire :
    // tout nouvel endpoint public doit être ajouté ici sciemment (pas d'ouverture /public/* large).
    const path = req.url.split('?', 1)[0] ?? req.url;
    if (path === '/health' || path.startsWith('/health/') || path.startsWith('/public/sign/')) return true;
    if (path === '/metrics') return hasValidMetricsCredential(req.headers);
    // Inscription AVANT compte (C24b) : lookup annuaire public, AVANT toute lecture d'Authorization.
    if (isPublicSignupEndpoint(req.method ?? 'GET', req.url)) return true;
    if (isPublicPushRevocationEndpoint(req.method ?? 'GET', req.url)) return true;
    if (isStripeWebhookEndpoint(req.method ?? 'GET', req.url)) return true;

    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
    const token = auth.slice('Bearer '.length);

    const jwks = this.getJwks();
    if (!jwks) return false;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        audience: process.env.SUPABASE_JWT_AUD ?? 'authenticated',
      });
      const claims = payload as {
        app_metadata?: { company_id?: string };
        email?: unknown;
        email_verified?: unknown;
      };
      const meta = claims.app_metadata;
      // Valide le format du company_id (issu du JWT) à la frontière : neutralise tout métacaractère
      // avant qu'il n'atteigne la couche persistance / le GUC RLS. Non conforme ou absent -> NULL
      // (compte non provisionné) — plus JAMAIS le tenant de démo.
      const raw = meta?.company_id;
      const companyId = typeof raw === 'string' && COMPANY_ID_PATTERN.test(raw) ? raw : null;
      const userId = String(payload.sub ?? '');
      if (!userId) return false;
      if (companyId === null && !allowsMissingTenant(req.method ?? 'GET', req.url)) {
        // THROW (≠ return false) : le JWT est VALIDE — le client doit provisionner son tenant
        // (POST /onboarding/company), pas se ré-authentifier. Le corps porte un code stable.
        throw new ForbiddenException({
          code: 'PROVISIONING_REQUIRED',
          message: 'Compte sans espace de travail : appelle POST /onboarding/company pour le créer.',
        });
      }
      const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
      // Ne jamais faire autorité sur user_metadata.email_verified : ces métadonnées sont
      // modifiables par l'utilisateur. L'acceptation revalide l'email via GoTrue Admin en live.
      const emailVerified = claims.email_verified === true;
      setPrincipal({
        userId,
        companyId,
        ...(email ? { email, emailVerified } : {}),
      });
      return true;
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      return false;
    }
  }
}
