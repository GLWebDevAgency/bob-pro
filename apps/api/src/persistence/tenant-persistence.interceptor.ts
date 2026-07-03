import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { getPrincipal } from '../observability/logger';
import { PERSISTENCE, type Persistence } from './persistence';

/**
 * Enrôle chaque requête tenant dans le contexte de persistance courant.
 * Prisma : transaction + GUC RLS app.current_company_id.
 * In-memory : no-op, mais même contrat applicatif.
 */
@Injectable()
export class TenantPersistenceInterceptor implements NestInterceptor {
  constructor(@Inject(PERSISTENCE) private readonly persistence: Persistence) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const principal = getPrincipal();
    // Assertion défensive C24b : un Principal SANS tenant (companyId null) ne pose JAMAIS le GUC
    // RLS — seuls les endpoints de la liste blanche du guard arrivent ici dans cet état (lookup
    // public, provisioning), et registerCompany ouvre lui-même runWithTenant sur l'id provisionné.
    if (!principal || principal.companyId === null) return next.handle();
    return from(this.persistence.runWithTenant(principal.companyId, () => lastValueFrom(next.handle())));
  }
}
