import { HttpException, Injectable, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { type Observable, tap } from 'rxjs';
import { Metrics } from './metrics';
import { rootLogger, getCorrelationId } from './logger';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly metrics: Metrics) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{ method: string; url: string; route?: { path?: string } }>();
    const start = Date.now();
    const route = req.route?.path ?? req.url;
    const finalize = (status: number): void => {
      const ms = Date.now() - start;
      this.metrics.httpRequests.inc({ method: req.method, route, status: String(status) });
      this.metrics.httpDuration.observe({ method: req.method, route }, ms / 1000);
      rootLogger.info({ correlationId: getCorrelationId(), method: req.method, route, status, ms }, 'http');
    };
    return next.handle().pipe(
      tap({
        next: () => finalize(http.getResponse<{ statusCode: number }>().statusCode),
        error: (error: unknown) => {
          const status = error instanceof HttpException
            ? error.getStatus()
            : typeof (error as { status?: unknown } | null)?.status === 'number'
              ? (error as { status: number }).status
              : 500;
          finalize(status);
        },
      }),
    );
  }
}
