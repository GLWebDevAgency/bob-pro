import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../observability/logger';
import { BrevoEmailNotifier } from './notifier';

const audit = vi.fn();
const logger = { audit } as unknown as AppLogger;

describe('BrevoEmailNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
      idempotencyKey: '79e27b85-d458-445e-a759-e8b1a49e1641',
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
      headers: { idempotencyKey: '79e27b85-d458-445e-a759-e8b1a49e1641' },
    });
    expect(logger.audit).toHaveBeenCalledWith('notification.sent', {
      provider: 'brevo',
      channel: 'email',
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('client@example.com');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Devis D2026-001');
  });

  it('PR-01 facture : pièce jointe + Reply-To + Cc + nom d’expéditeur société — From INCHANGÉ (domaine vérifié)', async () => {
    const fetchFn = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify({ messageId: 'm-2' }), { status: 201 }));
    const notifier = new BrevoEmailNotifier(
      logger,
      {
        apiKey: 'secret-key',
        senderEmail: 'hello@bobpro.fr',
        senderName: 'Bob Pro',
        baseUrl: 'https://api.brevo.com/v3',
      },
      fetchFn,
    );

    await notifier.send({
      channel: 'email',
      to: 'compta@ratp-cap.fr',
      subject: 'Facture F-2026-0042 — Fly Services',
      body: 'Bonjour,\nVoici votre facture.',
      idempotencyKey: '79e27b85-d458-445e-a759-e8b1a49e1641',
      senderName: 'Fly Services',
      replyTo: 'contact@fly-services.fr',
      cc: ['contact@fly-services.fr'],
      attachments: [
        { filename: 'facture-F-2026-0042.pdf', mimeType: 'application/pdf', contentBase64: 'JVBERi0xLjc=' },
      ],
    });

    const [, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    // Amendement fondateur : display name = la société, ADRESSE From = domaine vérifié Brevo.
    expect(payload.sender).toEqual({ name: 'Fly Services', email: 'hello@bobpro.fr' });
    expect(payload.replyTo).toEqual({ email: 'contact@fly-services.fr', name: 'Fly Services' });
    expect(payload.cc).toEqual([{ email: 'contact@fly-services.fr' }]);
    expect(payload.attachment).toEqual([
      { name: 'facture-F-2026-0042.pdf', content: 'JVBERi0xLjc=' },
    ]);
  });

  it('sans extensions : payload historique inchangé (ni replyTo, ni cc, ni attachment)', async () => {
    const fetchFn = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify({ messageId: 'm-3' }), { status: 201 }));
    const notifier = new BrevoEmailNotifier(
      logger,
      { apiKey: 'k', senderEmail: 'hello@bobpro.fr', senderName: 'Bob Pro', baseUrl: 'https://api.brevo.com/v3' },
      fetchFn,
    );
    await notifier.send({ channel: 'email', to: 'a@b.fr', subject: 's', body: 'b' });
    const payload = JSON.parse(String(fetchFn.mock.calls[0]![1].body));
    expect(payload.sender).toEqual({ name: 'Bob Pro', email: 'hello@bobpro.fr' });
    expect(payload).not.toHaveProperty('replyTo');
    expect(payload).not.toHaveProperty('cc');
    expect(payload).not.toHaveProperty('attachment');
  });

  it('considère le duplicate_parameter d’une même clé comme un accusé provider', async () => {
    const duplicate = vi.fn(async () => new Response(
      JSON.stringify({ code: 'duplicate_parameter', message: 'Key already used' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const notifier = new BrevoEmailNotifier(
      logger,
      {
        apiKey: 'secret-key',
        senderEmail: 'hello@bobpro.fr',
        senderName: 'Bob Pro',
        baseUrl: 'https://api.brevo.com/v3',
      },
      duplicate,
    );

    await expect(notifier.send({
      channel: 'email',
      to: 'client@example.com',
      subject: 'Invitation',
      body: 'Reprise du même envoi.',
      idempotencyKey: 'f74608cd-0c6e-4aae-a008-a0a116266e1e',
    })).resolves.toBeUndefined();
    expect(logger.audit).toHaveBeenCalledWith('notification.deduplicated', {
      provider: 'brevo',
      channel: 'email',
    });
  });

  it('ne masque pas une erreur duplicate_parameter sans clé d’idempotence', async () => {
    const duplicate = vi.fn(async () => new Response(
      JSON.stringify({ code: 'duplicate_parameter' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const notifier = new BrevoEmailNotifier(
      logger,
      {
        apiKey: 'secret-key',
        senderEmail: 'hello@bobpro.fr',
        senderName: 'Bob Pro',
        baseUrl: 'https://api.brevo.com/v3',
      },
      duplicate,
    );

    await expect(notifier.send({
      channel: 'email',
      to: 'client@example.com',
      subject: 'Invitation',
      body: 'Envoi sans clé.',
    })).rejects.toThrow('Brevo HTTP 400');
  });

  it('refuse une clé non UUID avant tout appel provider', async () => {
    const fetchFn = vi.fn();
    const notifier = new BrevoEmailNotifier(
      logger,
      {
        apiKey: 'secret-key',
        senderEmail: 'hello@bobpro.fr',
        senderName: 'Bob Pro',
        baseUrl: 'https://api.brevo.com/v3',
      },
      fetchFn,
    );

    await expect(notifier.send({
      channel: 'email',
      to: 'client@example.com',
      subject: 'Invitation',
      body: 'Envoi invalide.',
      idempotencyKey: 'invitation-1',
    })).rejects.toThrow(/UUID/);
    expect(fetchFn).not.toHaveBeenCalled();
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
