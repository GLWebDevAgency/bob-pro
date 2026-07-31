import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AccountController } from './api.controllers';
import type { BackendService } from './backend.service';

describe('AccountController.confirmTimeZone', () => {
  it('délègue uniquement le fuseau explicite au BackendService', async () => {
    const confirmConversationTimeZone = vi.fn(async () => ({
      ok: true as const,
      value: {
        timeZone: 'Europe/Paris',
        confirmedAt: '2026-07-31T00:00:00.000Z',
        requiresSessionRefresh: true as const,
      },
    }));
    const controller = new AccountController({
      confirmConversationTimeZone,
    } as unknown as BackendService);

    await expect(
      controller.confirmTimeZone({ timeZone: 'Europe/Paris' }),
    ).resolves.toEqual({
      timeZone: 'Europe/Paris',
      confirmedAt: '2026-07-31T00:00:00.000Z',
      requiresSessionRefresh: true,
    });
    expect(confirmConversationTimeZone).toHaveBeenCalledWith('Europe/Paris');
  });

  it.each([
    null,
    [],
    {},
    { timeZone: 1 },
    { timeZone: 'Europe/Paris', companyId: 'company-autre' },
  ])('refuse une forme de body non exacte : %j', async (body) => {
    const controller = new AccountController({} as BackendService);
    await expect(controller.confirmTimeZone(body)).rejects.toBeInstanceOf(HttpException);
  });
});
