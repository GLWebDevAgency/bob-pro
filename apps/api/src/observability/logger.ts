import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type LoggerService } from '@nestjs/common';
import pino from 'pino';

export interface Principal {
  userId: string;
  /**
   * Tenant du user authentifié. NULL = JWT valide SANS app_metadata.company_id conforme
   * (compte neuf, pas encore provisionné — C24b) : seuls les endpoints de la liste blanche
   * du guard (lookup public, provisioning) sont joignables dans cet état.
   */
  companyId: string | null;
  /** Email JWT normalisé, utilisé uniquement pour faire correspondre une invitation cabinet. */
  email?: string | null;
  /** Doit être explicitement vrai pour accepter une invitation ; jamais déduit d'un body client. */
  emailVerified?: boolean;
}

interface RequestContext {
  correlationId: string;
  principal?: Principal;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
export const getCorrelationId = (): string => requestContext.getStore()?.correlationId ?? '-';
export const getPrincipal = (): Principal | undefined => requestContext.getStore()?.principal;
export const setPrincipal = (principal: Principal): void => {
  const store = requestContext.getStore();
  if (store) store.principal = principal;
};

/**
 * Tenant courant OBLIGATOIRE (C24b — plus AUCUN repli sur la société de démo).
 * Principal absent ou sans tenant ici = bug d'ordonnancement : le guard doit avoir bloqué
 * en amont (403 PROVISIONING_REQUIRED) — on échoue EXPLICITEMENT, jamais un tenant par défaut.
 */
export const requireTenant = (): string => {
  const companyId = getPrincipal()?.companyId ?? null;
  if (companyId === null) {
    throw new Error(
      'Aucun tenant sur le Principal — le guard doit avoir refusé la requête (PROVISIONING_REQUIRED) avant ce point.',
    );
  }
  return companyId;
};

export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'bob-pro-api' },
  formatters: { level: (label) => ({ level: label }) },
});

/** Logger NestJS adossé à pino : sortie JSON structurée + correlationId automatique. */
@Injectable()
export class AppLogger implements LoggerService {
  private fields(context?: string): Record<string, unknown> {
    return { correlationId: getCorrelationId(), context };
  }
  log(message: unknown, context?: string): void {
    rootLogger.info(this.fields(context), String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    rootLogger.error({ ...this.fields(context), trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    rootLogger.warn(this.fields(context), String(message));
  }
  debug(message: unknown, context?: string): void {
    rootLogger.debug(this.fields(context), String(message));
  }
  verbose(message: unknown, context?: string): void {
    rootLogger.trace(this.fields(context), String(message));
  }
  /** Trace d'audit des actions sensibles (émission facture, paiement, signature, IA). */
  audit(action: string, data: Record<string, unknown>): void {
    rootLogger.info({ correlationId: getCorrelationId(), audit: true, action, ...data }, `audit:${action}`);
  }
}
