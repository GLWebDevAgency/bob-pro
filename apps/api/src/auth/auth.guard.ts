import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { MERCIER_PROPS } from '@bob/core';
import { setPrincipal } from '../observability/logger';
import { isDemoMode } from '../config/env';

interface RequestLike {
  url: string;
  headers: Record<string, string | undefined>;
  principal?: { userId: string; companyId: string };
}

/**
 * Garde d'authentification.
 * - Démo (pas de JWKS) : pass-through.
 * - Prod : vérifie le JWT Supabase via JWKS public (signature + exp), pose le Principal (anti-IDOR).
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

    if (isDemoMode()) {
      // Démo : tenant via header x-company-id (par défaut la société de seed).
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
      setPrincipal({ userId: String(payload.sub ?? ''), companyId: meta?.company_id ?? MERCIER_PROPS.id });
      return true;
    } catch {
      return false;
    }
  }
}
