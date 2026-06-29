import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { isDemoMode } from '../config/env';

/**
 * Garde d'authentification. En mode démo : pass-through (pas de base ni d'IdP).
 * En production : valide le JWT Supabase via JWKS et extrait companyId du Principal (anti-IDOR).
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ url: string; headers: Record<string, string | undefined> }>();
    // Endpoints d'infrastructure toujours ouverts (liveness/readiness + scrape Prometheus).
    if (req.url.startsWith('/health') || req.url.startsWith('/metrics')) return true;
    if (isDemoMode()) return true;
    const auth = req.headers['authorization'];
    // TODO(prod) : vérifier signature JWKS (aud/iss/exp), résoudre memberships -> companyId + rôle.
    return typeof auth === 'string' && auth.startsWith('Bearer ');
  }
}
