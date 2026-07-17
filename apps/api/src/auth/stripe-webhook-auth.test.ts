import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { SupabaseAuthGuard } from './auth.guard';

function context(method: string, url: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, url, headers: {} }),
    }),
  } as unknown as ExecutionContext;
}

describe('SupabaseAuthGuard — frontière webhook Stripe', () => {
  it('ouvre uniquement POST /webhooks/stripe sans JWT (la signature est vérifiée ensuite)', async () => {
    const guard = new SupabaseAuthGuard();
    await expect(guard.canActivate(context('POST', '/webhooks/stripe'))).resolves.toBe(true);
    await expect(guard.canActivate(context('GET', '/webhooks/stripe'))).rejects.toThrow();
    await expect(guard.canActivate(context('POST', '/webhooks/stripe/forged'))).rejects.toThrow();
    await expect(guard.canActivate(context('POST', '/webhooks/stripe?x=1'))).rejects.toThrow();
  });
});
