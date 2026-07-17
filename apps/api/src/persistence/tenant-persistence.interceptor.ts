import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { getPrincipal } from '../observability/logger';
import type { Persistence } from './persistence';
import { PERSISTENCE } from './persistence-token';

const TENANT_TRANSACTION_DISABLED = Symbol('tenant-transaction-disabled');

/**
 * Une route worker portant ce décorateur doit ouvrir elle-même ses transactions RLS courtes.
 * À réserver aux orchestrations qui font de l'I/O externe entre claim et finalisation.
 */
export const WithoutTenantPersistenceTransaction = () =>
  SetMetadata(TENANT_TRANSACTION_DISABLED, true);

/**
 * Enrôle chaque requête tenant dans le contexte de persistance courant.
 * Prisma : transaction + GUC RLS app.current_company_id.
 * In-memory : no-op, mais même contrat applicatif.
 */
@Injectable()
export class TenantPersistenceInterceptor implements NestInterceptor {
  constructor(
    @Inject(PERSISTENCE) private readonly persistence: Persistence,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const transactionDisabled = this.reflector.getAllAndOverride<boolean>(
      TENANT_TRANSACTION_DISABLED,
      [context.getHandler(), context.getClass()],
    );
    if (transactionDisabled) return next.handle();
    const principal = getPrincipal();
    const url = context.switchToHttp().getRequest<{ url?: string }>().url ?? '';
    // Cabinet possède son propre tenant. Son service ouvre une transaction avec userId+cabinetId
    // après résolution de la membership ; ne jamais hériter implicitement du Company JWT.
    const path = url.split('?', 1)[0] ?? url;
    if (path === '/cabinet/v1' || path.startsWith('/cabinet/v1/')) return next.handle();
    // Assertion défensive C24b : un Principal SANS tenant (companyId null) ne pose JAMAIS le GUC
    // RLS — seuls les endpoints de la liste blanche du guard arrivent ici dans cet état (lookup
    // public, provisioning), et registerCompany ouvre lui-même runWithTenant sur l'id provisionné.
    if (!principal || principal.companyId === null) return next.handle();
    const companyId = principal.companyId;
    return from(
      this.persistence.runWithTenant(companyId, async () => {
        // Clôture de compte (CloseAccount, Apple 5.1.1(v)) : DANS la transaction tenant (donc
        // après pose du GUC RLS) pour que ce lookup voie le même row que la politique appliquera
        // — un findById hors transaction serait fail-closed sous FORCE RLS en prod (rôle
        // non-superuser) et laisserait ce garde silencieusement inopérant. La route DELETE
        // /account elle-même désactive cette transaction automatique (@WithoutTenantPersistenceTransaction)
        // et gère son propre runWithTenant : elle n'est donc jamais bloquée par son propre effet.
        const company = await this.persistence.companies.findById(companyId);
        if (company?.isClosed()) {
          throw new ForbiddenException({ code: 'ACCOUNT_CLOSED', message: 'Compte clôturé.' });
        }
        return lastValueFrom(next.handle());
      }),
    );
  }
}
