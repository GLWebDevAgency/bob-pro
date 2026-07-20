import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { StripeReconciliationError } from './stripe-billing.service';
import { StripeWebhookController } from './stripe-webhook.controller';

describe('StripeWebhookController', () => {
  it('refuse tout body déjà parsé : seule la preuve raw peut être vérifiée', async () => {
    const service = { handleWebhook: vi.fn() };
    const controller = new StripeWebhookController(service as never);
    await expect(controller.receive({}, 'sig')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.handleWebhook).not.toHaveBeenCalled();
  });

  it('renvoie un non-2xx retryable sur une indisponibilité transactionnelle', async () => {
    const service = {
      handleWebhook: vi.fn().mockRejectedValue(new StripeReconciliationError('DB_DOWN', true)),
    };
    const controller = new StripeWebhookController(service as never);
    await expect(controller.receive({ rawBody: Buffer.from('{}') }, 'sig')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('n’expose jamais le payload et transmet les octets bruts inchangés', async () => {
    const receipt = { received: true, eventId: 'evt_1', outcome: 'processed' } as const;
    const service = { handleWebhook: vi.fn().mockResolvedValue(receipt) };
    const controller = new StripeWebhookController(service as never);
    const rawBody = Buffer.from('{"id":"evt_1"}\n');

    await expect(controller.receive({ rawBody }, 'sig')).resolves.toEqual(receipt);
    expect(service.handleWebhook).toHaveBeenCalledWith(rawBody, 'sig');
  });
});
