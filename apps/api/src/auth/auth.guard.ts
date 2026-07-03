import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { MERCIER_PROPS } from '@bob/core';
import { setPrincipal } from '../observability/logger';
import { isDemoMode } from '../config/env';

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

/**
 * Niveau 2 — JWT VALIDE requis mais tenant OPTIONNEL (C24b) : le provisioning exige d'être
 * authentifié (le JWT fournit le userId pour l'id déterministe company-<userId> et l'écriture
 * app_metadata), mais le compte neuf n'a pas encore de company_id. Liste blanche EXPLICITE.
 */
function allowsMissingTenant(method: string, url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return method === 'POST' && path === '/onboarding/company';
}

/**
 * Garde d'authentification.
 * - Démo (DEMO_MODE) : pass-through, tenant via x-company-id (défaut : société de seed).
 * - Prod : vérifie le JWT Supabase via JWKS public (signature + exp), pose le Principal (anti-IDOR).
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
    if (req.url.startsWith('/health') || req.url.startsWith('/metrics') || req.url.startsWith('/public/sign/')) return true;
    // Inscription AVANT compte (C24b) : lookup annuaire public, AVANT toute lecture d'Authorization.
    if (isPublicSignupEndpoint(req.method ?? 'GET', req.url)) return true;

    if (isDemoMode()) {
      // Démo : tenant via header x-company-id (par défaut la société de seed). Comportement C24b inchangé.
      const tenant = req.headers['x-company-id'];
      setPrincipal({ userId: 'demo', companyId: (typeof tenant === 'string' && tenant) || MERCIER_PROPS.id });
      return true;
    }

    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
    const token = auth.slice('Bearer '.length);

    const jwks = this.getJwks();
    if (!jwks) return false;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        audience: process.env.SUPABASE_JWT_AUD ?? 'authenticated',
      });
      const meta = (payload as { app_metadata?: { company_id?: string } }).app_metadata;
      // Valide le format du company_id (issu du JWT) à la frontière : neutralise tout métacaractère
      // avant qu'il n'atteigne la couche persistance / le GUC RLS. Non conforme ou absent -> NULL
      // (compte non provisionné) — plus JAMAIS le tenant de démo.
      const raw = meta?.company_id;
      const companyId = typeof raw === 'string' && COMPANY_ID_PATTERN.test(raw) ? raw : null;
      const userId = String(payload.sub ?? '');
      if (companyId === null && !allowsMissingTenant(req.method ?? 'GET', req.url)) {
        // THROW (≠ return false) : le JWT est VALIDE — le client doit provisionner son tenant
        // (POST /onboarding/company), pas se ré-authentifier. Le corps porte un code stable.
        throw new ForbiddenException({
          code: 'PROVISIONING_REQUIRED',
          message: 'Compte sans espace de travail : appelle POST /onboarding/company pour le créer.',
        });
      }
      setPrincipal({ userId, companyId });
      return true;
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      return false;
    }
  }
}
