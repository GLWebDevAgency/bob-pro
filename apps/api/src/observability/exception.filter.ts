import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { rootLogger, getCorrelationId } from './logger';
import { ERROR_REPORTER, type ErrorReporter } from './error-reporter';

/** Résumé loggable de l'AppError embarqué dans une HttpException fabriquée par http/result.ts. */
export interface AppErrorLogSummary {
  kind: string;
  service?: string;
  port?: string;
  cause?: string;
  entity?: string;
  reason?: string;
}

const APP_ERROR_SUMMARY_FIELDS = ['service', 'port', 'cause', 'entity', 'reason'] as const;
const APP_ERROR_FIELD_MAX_CHARS = 300;

/**
 * Kinds d'AppError qui décrivent une DÉGRADATION ASSUMÉE, pas un plantage : le serveur a
 * délibérément refusé de servir une donnée qu'il n'a pas (`unavailable`) ou constaté qu'un amont
 * a échoué (`dependency`). Les journaliser comme « exception non gérée » brouille le diagnostic
 * et noie l'alerting sous des états normaux.
 */
const DEGRADED_KINDS: ReadonlySet<string> = new Set(['unavailable', 'dependency']);

/**
 * Extrait le kind + les champs descriptifs de l'AppError transporté par l'enveloppe
 * `{ ok: false, error }` (unwrap, http/result.ts). LISTE BLANCHE stricte : uniquement des
 * chaînes écrites par le code serveur (service indisponible, port en panne, cause technique) —
 * jamais les `issues` de validation ni le contenu d'un DomainError, qui peuvent refléter des
 * données utilisateur. Sans ce résumé, un 503 se logge en « Http Exception » muet.
 */
export function appErrorLogSummary(body: unknown): AppErrorLogSummary | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const fields = error as Record<string, unknown>;
  if (typeof fields.kind !== 'string') return null;
  const summary: AppErrorLogSummary = { kind: fields.kind };
  for (const field of APP_ERROR_SUMMARY_FIELDS) {
    const value = fields[field];
    if (typeof value === 'string' && value.length > 0) {
      summary[field] = value.slice(0, APP_ERROR_FIELD_MAX_CHARS);
    }
  }
  return summary;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(ERROR_REPORTER) private readonly reporter: ErrorReporter) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void } }>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: 500, message: 'Internal server error' };
    if (status >= 500) {
      // La stack d'une HttpException issue de unwrap() est muette (« Http Exception ») : le
      // résumé du AppError (kind + service/port/cause) rend le log diagnosticable en une lecture.
      const appError = exception instanceof HttpException ? appErrorLogSummary(body) : null;
      const record = {
        correlationId: getCorrelationId(),
        status,
        ...(appError ? { appError } : {}),
        err: exception instanceof Error ? exception.stack : String(exception),
      };
      if (appError && DEGRADED_KINDS.has(appError.kind)) {
        // Un 5xx PORTEUR d'un AppError structuré n'est pas une exception non gérée : c'est le
        // contrat fail-closed du produit qui s'exprime (« missing/error ⇒ unavailable, jamais un
        // zéro fabriqué »). Le journaliser en `error` mentait sur sa nature et — surtout —
        // saturerait le rapporteur d'incidents (et demain Sentry) avec des états NORMAUX :
        // constaté en prod le 20/07, `unavailable/cashflow-banking-source` répété pour un tenant
        // sans banque connectée. Reste en `warn` : cherchable, compté, mais jamais alarmant.
        rootLogger.warn(record, 'dépendance indisponible');
        // `unavailable` = refus ASSUMÉ (donnée absente/non configurée) : rien à réparer côté
        // serveur, aucune remontée. `dependency` = un amont a RÉELLEMENT échoué (fournisseur
        // OCR/annuaire en panne) : ça reste un signal d'exploitation à capturer.
        if (appError.kind !== 'unavailable') {
          this.reporter.captureException(exception, { correlationId: getCorrelationId() });
        }
        res.status(status).json(typeof body === 'object' ? body : { message: body });
        return;
      }
      rootLogger.error(record, 'unhandled exception');
      this.reporter.captureException(exception, { correlationId: getCorrelationId() });
    }
    res.status(status).json(typeof body === 'object' ? body : { message: body });
  }
}
