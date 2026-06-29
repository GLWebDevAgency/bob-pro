import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { MERCIER_PROPS } from '@bob/core';
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
    if (req.url.startsWith('/health') || req.url.startsWith('/metrics')) return true;
    if (isDemoMode()) return true;

    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
    const token = auth.slice('Bearer '.length);

    const jwks = this.getJwks();
    if (!jwks) return false;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        audience: process.env.SUPABASE_JWT_AUD ?? 'authenticated',
      });
      // V1 mono-tenant : companyId = société de seed. Multi-tenant -> dériver de payload.app_metadata.
      req.principal = { userId: String(payload.sub ?? ''), companyId: MERCIER_PROPS.id };
      return true;
    } catch {
      return false;
    }
  }
}
