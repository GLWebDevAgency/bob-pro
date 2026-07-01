import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../observability/logger';
import { BrevoEmailNotifier } from './notifier';

const logger = {
  audit: vi.fn(),
} as unknown as AppLogger;

describe('BrevoEmailNotifier', () => {
  it('envoie un email transactionnel via Brevo sans exposer la clé dans le body', async () => {
    const fetchFn = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify({ messageId: 'm-1' }), { status: 201 }));
    const notifier = new BrevoEmailNotifier(
      logger,
      {
        apiKey: 'secret-key',
        senderEmail: 'hello@bobpro.fr',
        senderName: 'Bob Pro',
        baseUrl: 'https://api.brevo.com/v3/',
      },
      fetchFn,
    );

    await notifier.send({
      channel: 'email',
      to: 'client@example.com',
      subject: 'Devis D2026-001',
      body: 'Bonjour,\nVoici votre lien.',
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers).toMatchObject({ 'api-key': 'secret-key', 'content-type': 'application/json' });
    expect(String(init.body)).not.toContain('secret-key');
    expect(JSON.parse(String(init.body))).toMatchObject({
      sender: { name: 'Bob Pro', email: 'hello@bobpro.fr' },
      to: [{ email: 'client@example.com' }],
      subject: 'Devis D2026-001',
      textContent: 'Bonjour,\nVoici votre lien.',
    });
  });

  it('échoue explicitement sur les canaux non email', async () => {
    const notifier = new BrevoEmailNotifier(logger, {
      apiKey: 'secret-key',
      senderEmail: 'hello@bobpro.fr',
      senderName: 'Bob Pro',
      baseUrl: 'https://api.brevo.com/v3',
    });

    await expect(notifier.send({ channel: 'sms', to: '+33600000000', subject: 'x', body: 'x' })).rejects.toThrow(/Canal non supporté/);
  });
});
