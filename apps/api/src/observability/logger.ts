import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type LoggerService } from '@nestjs/common';
import pino from 'pino';

export interface Principal {
  userId: string;
  companyId: string;
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
