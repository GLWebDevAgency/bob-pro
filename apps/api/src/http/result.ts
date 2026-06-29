import { HttpException, HttpStatus } from '@nestjs/common';
import type { Result, AppError } from '@bob/core';

/** Déballe un Result du domaine ; mappe AppError -> code HTTP (microcopy renvoyée telle quelle). */
export function unwrap<T>(r: Result<T, AppError>): T {
  if (r.ok) return r.value;
  const e = r.error;
  const status =
    e.kind === 'not_found'
      ? HttpStatus.NOT_FOUND
      : e.kind === 'forbidden'
        ? HttpStatus.FORBIDDEN
        : e.kind === 'validation' || e.kind === 'domain'
          ? HttpStatus.UNPROCESSABLE_ENTITY
          : HttpStatus.BAD_GATEWAY;
  throw new HttpException({ ok: false, error: e }, status);
}
