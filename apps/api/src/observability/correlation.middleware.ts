import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { requestContext } from './logger';

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
}
interface ResLike {
  setHeader(name: string, value: string): void;
}

/**
 * Un identifiant de corrélation FIABLE : borné et alphabet fermé. Il sort dans chaque ligne
 * pino ET dans le corps des réponses d'erreur — un header hors patron (injection de logs,
 * taille arbitraire) est REMPLACÉ par un UUID, jamais propagé.
 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function claimedCorrelationId(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && CORRELATION_ID_PATTERN.test(value) ? value : null;
}

/**
 * Corrélation bout-en-bout (SPEC_SYSTEME_ERREUR §3.1) : reprend `x-correlation-id` généré par le
 * client, sinon `x-request-id` (legacy), sinon génère — puis l'expose à tout le pipeline via
 * AsyncLocalStorage et le REND dans les deux headers de réponse.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: ReqLike, res: ResLike, next: () => void): void {
    const correlationId =
      claimedCorrelationId(req.headers['x-correlation-id']) ??
      claimedCorrelationId(req.headers['x-request-id']) ??
      randomUUID();
    res.setHeader('x-request-id', correlationId);
    res.setHeader('x-correlation-id', correlationId);
    requestContext.run({ correlationId }, () => next());
  }
}
