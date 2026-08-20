import type { AppError } from '@bob/core';

/**
 * Projection technique bornée d'une erreur applicative. Elle ne remplace jamais l'erreur
 * structurée rendue à l'appelant et ne doit contenir ni payload libre, ni secret.
 */
export function appErrorSummary(error: AppError): string {
  if (error.kind === 'domain')
    return `${error.error.code}:${'field' in error.error ? error.error.field : ''}`;
  if (error.kind === 'not_found') return `not_found:${error.entity}:${error.id}`;
  if (error.kind === 'gone') return `gone:${error.entity}:${error.reason}`;
  if (error.kind === 'forbidden') return `forbidden:${error.reason}`;
  if (error.kind === 'validation')
    return `validation:${error.issues.map((issue) => `${issue.field}:${issue.message}`).join(';')}`;
  if (error.kind === 'conflict') return `conflict:${error.entity}:${error.reason}`;
  if (error.kind === 'rate_limited')
    return `rate_limited:${error.reason}:${error.retryAfterSeconds}`;
  if (error.kind === 'unavailable') return `unavailable:${error.service}`;
  return `dependency:${error.port}:${error.cause}`;
}
