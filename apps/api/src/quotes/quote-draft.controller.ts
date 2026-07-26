import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Put,
} from '@nestjs/common';
import { unwrap } from '../http/result';
import { WithoutTenantPersistenceTransaction } from '../persistence/tenant-persistence.interceptor';
import { QuoteDraftService } from './quote-draft.service';

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function invalidBody(field: string, message: string): never {
  throw new HttpException(
    { ok: false, error: { kind: 'validation', issues: [{ field, message }] } },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function exactBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const body = jsonObject(value);
  if (body === null) invalidBody('body', 'Corps JSON objet requis.');
  const unknown = Object.keys(body).find((field) => !allowed.includes(field));
  if (unknown !== undefined) invalidBody(unknown, 'Champ non autorisé.');
  for (const field of allowed) {
    if (!(field in body)) invalidBody(field, 'Champ requis.');
  }
  return body;
}

/**
 * Route implicitement protégée par le SupabaseAuthGuard global. Aucun identifiant tenant ou owner
 * n'est accepté dans le chemin, les query params ou le body : le service lit uniquement le JWT.
 */
@Controller('quote-drafts')
@WithoutTenantPersistenceTransaction()
export class QuoteDraftController {
  constructor(private readonly quoteDrafts: QuoteDraftService) {}

  @Get('current')
  @Header('Cache-Control', 'private, no-store')
  async getCurrent() {
    return unwrap(await this.quoteDrafts.getCurrent());
  }

  @Put('current')
  @Header('Cache-Control', 'private, no-store')
  async saveCurrent(@Body() value: unknown) {
    const body = exactBody(value, ['expectedRevision', 'payload']);
    return unwrap(await this.quoteDrafts.saveCurrent({
      expectedRevision: body.expectedRevision as number,
      payload: body.payload,
    }));
  }

  @Delete('current')
  @Header('Cache-Control', 'private, no-store')
  async deleteCurrent(@Body() value: unknown) {
    const body = exactBody(value, ['expectedRevision']);
    return unwrap(await this.quoteDrafts.deleteCurrent({
      expectedRevision: body.expectedRevision as number,
    }));
  }
}
