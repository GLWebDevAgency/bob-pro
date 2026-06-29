import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { requestContext } from './logger';

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
}
interface ResLike {
  setHeader(name: string, value: string): void;
}

/** Génère / propage un x-request-id et l'expose à tout le pipeline via AsyncLocalStorage. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: ReqLike, res: ResLike, next: () => void): void {
    const header = req.headers['x-request-id'];
    const correlationId = (Array.isArray(header) ? header[0] : header) ?? randomUUID();
    res.setHeader('x-request-id', correlationId);
    requestContext.run({ correlationId }, () => next());
  }
}
