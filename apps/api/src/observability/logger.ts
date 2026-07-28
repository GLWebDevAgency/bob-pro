import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type LoggerService } from '@nestjs/common';
import { redactTelemetryText } from '@bob/core';
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

const MAX_LOG_REDACTION_DEPTH = 6;

export function redactLogValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactTelemetryText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_LOG_REDACTION_DEPTH) return '[truncated]';
  if (value instanceof Error) {
    const redacted = new Error(redactTelemetryText(value.message));
    redacted.name = redactTelemetryText(value.name);
    redacted.stack = value.stack ? redactTelemetryText(value.stack) : undefined;
    return redacted;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  }
  if (value instanceof URL) return redactTelemetryText(value.toString());
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValue(entry, depth + 1, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return '[non-plain-object]';
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactTelemetryText(key),
      redactLogValue(entry, depth + 1, seen),
    ]),
  );
}

export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'bob-pro-api' },
  formatters: { level: (label) => ({ level: label }) },
  hooks: {
    logMethod(args, method) {
      const safeArgs = args.map((argument) => redactLogValue(argument));
      method.apply(
        this,
        safeArgs as unknown as [obj: unknown, msg?: string, ...args: unknown[]],
      );
    },
  },
});

/** Logger NestJS adossé à pino : sortie JSON structurée + correlationId automatique. */
@Injectable()
export class AppLogger implements LoggerService {
  private fields(context?: string): Record<string, unknown> {
    return { correlationId: getCorrelationId(), context };
  }
  log(message: unknown, context?: string): void {
    rootLogger.info(this.fields(context), redactTelemetryText(String(message)));
  }
  error(message: unknown, trace?: string, context?: string): void {
    rootLogger.error(
      { ...this.fields(context), trace: trace ? redactTelemetryText(trace) : trace },
      redactTelemetryText(String(message)),
    );
  }
  warn(message: unknown, context?: string): void {
    rootLogger.warn(this.fields(context), redactTelemetryText(String(message)));
  }
  debug(message: unknown, context?: string): void {
    rootLogger.debug(this.fields(context), redactTelemetryText(String(message)));
  }
  verbose(message: unknown, context?: string): void {
    rootLogger.trace(this.fields(context), redactTelemetryText(String(message)));
  }
  /** Trace d'audit des actions sensibles (émission facture, paiement, signature, IA). */
  audit(action: string, data: Record<string, unknown>): void {
    const safeData = redactLogValue(data) as Record<string, unknown>;
    rootLogger.info(
      { correlationId: getCorrelationId(), audit: true, action, ...safeData },
      `audit:${action}`,
    );
  }
}
