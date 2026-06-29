import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { rootLogger, getCorrelationId } from './logger';
import { ERROR_REPORTER, type ErrorReporter } from './error-reporter';

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
      rootLogger.error(
        { correlationId: getCorrelationId(), err: exception instanceof Error ? exception.stack : String(exception) },
        'unhandled exception',
      );
      this.reporter.captureException(exception, { correlationId: getCorrelationId() });
    }
    res.status(status).json(typeof body === 'object' ? body : { message: body });
  }
}
