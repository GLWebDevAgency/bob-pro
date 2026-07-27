import { describe, expect, it, vi } from 'vitest';
import { Quote, type Company, type Customer, type NotificationPort } from '@bob/core';
import {
  QuoteFollowupService,
  quoteIdOfQuoteRelanceReminderDedupeKey,
  quoteRelanceReminderDedupeKey,
} from './quote-followup.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import type { AppLogger } from '../observability/logger';
import type { SupabaseAdminPort } from '../auth/supabase-admin';
import { InMemoryPersistence } from '../persistence/persistence.testing';

/**
 * PR-05 « Encaisser » — suivi des devis au cron 6 h : sweep d'expiration IDEMPOTENT (borne
 * calendrier Paris, MÊME use case ExpireQuote) + rappels de relance J+15/J+30 dédupliqués PAR
 * PALIER, ancrés sur issuedAt RÉEL (legacy exclu fail-closed), annulés à la livraison si le
 * devis a quitté sent/viewed.
 */

const logger = { audit: vi.fn(), warn: vi.fn() } as unknown as AppLogger;

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** VRAI agrégat Quote (réhydraté) : le sweep passe par ExpireQuote → markExpired réel. */
function quote(
  id: string,
  opts: { status?: 'sent' | 'viewed' | 'signed' | 'expired'; issuedAt?: string | null; validUntil?: string | null } = {},
): Quote {
  return Quote.rehydrate({
    id,
    companyId: 'company-user1',
    customerId: 'cu-1',
    status: opts.status ?? 'sent',
    lines: [
      { id: `${id}-l1`, label: 'Maintenance', category: 'labor', qty: 1, unitPriceHT: 40_000, vatRate: 20 },
    ],
    number: `D-${id}`,
    depositPct: null,
    validUntil: opts.validUntil ?? null,
    signature: null,
    issuedAt: opts.issuedAt ?? null,
  });
}

async function makeService(quotes: Quote[]) {
  const persistence = new InMemoryPersistence();
  persistence.companies.seed({ id: 'company-user1' } as Company);
  persistence.customers.seed([
    { id: 'cu-1', companyId: 'company-user1', name: 'RATP CAP', type: 'b2g' } as unknown as Customer,
  ]);
  for (const q of quotes) await persistence.quotes.save(q);
  const notifier = {
    send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined),
  } satisfies NotificationPort;
  const delivery = new NotificationDeliveryService(
    persistence,
    notifier,
    new ScheduledTenantDirectory(persistence, logger),
    logger,
  );
  const supabaseAdmin = {
    getUserIdentity: vi.fn(async () => ({ email: 'artisan@fly-services.fr', displayName: null })),
  } as unknown as SupabaseAdminPort;
  const service = new QuoteFollowupService(
    persistence,
    delivery,
    new ScheduledTenantDirectory(persistence, logger),
    supabaseAdmin,
    logger,
  );
  return { service, delivery, persistence, notifier };
}

describe('QuoteFollowupService — sweep d’expiration (PR-05)', () => {
  it('bascule expired tout devis sent/viewed périmé — IDEMPOTENT au rejeu', async () => {
    const { service, persistence } = await makeService([
      quote('q-perime', { validUntil: daysAgo(1), issuedAt: daysAgo(40) }),
      quote('q-vivant', { validUntil: daysAgo(-10), issuedAt: daysAgo(3) }),
      quote('q-deja-expire', { status: 'expired', validUntil: daysAgo(5) }),
    ]);

    const first = await service.runForCompany('company-user1');
    expect(first.expired).toBe(1);
    expect((await persistence.quotes.findById('q-perime'))!.status).toBe('expired');
    expect((await persistence.quotes.findById('q-vivant'))!.status).toBe('sent');

    const second = await service.runForCompany('company-user1');
    expect(second.expired).toBe(0); // borne Paris : un devis déjà expiré n'est plus candidat
  });

  it('un devis expiré par le sweep du matin n’est JAMAIS rappelé « à relancer » le même matin', async () => {
    const { service, persistence } = await makeService([
      quote('q-perime', { validUntil: daysAgo(1), issuedAt: daysAgo(20) }),
    ]);
    const result = await service.runForCompany('company-user1');
    expect(result).toMatchObject({ expired: 1, reminders: 0 });
    expect(await persistence.notificationJobs.listRecent('company-user1', 10)).toEqual([]);
  });
});

describe('QuoteFollowupService — rappels de relance par palier (PR-05)', () => {
  it('J+16 : rappel palier j15, dédupliqué au rejeu ; J+35 : clé PAR PALIER j30', async () => {
    const { service, delivery, persistence, notifier } = await makeService([
      quote('q-15', { issuedAt: daysAgo(16), validUntil: daysAgo(-20) }),
      quote('q-30', { status: 'viewed', issuedAt: daysAgo(35), validUntil: daysAgo(-20) }),
    ]);

    const first = await service.runForCompany('company-user1');
    expect(first).toMatchObject({ reminders: 2, deduplicated: 0 });
    const jobs = await persistence.notificationJobs.listRecent('company-user1', 10);
    expect(jobs.map((job) => job.dedupeKey).sort()).toEqual([
      'quote:q-15:relance-reminder:j15',
      'quote:q-30:relance-reminder:j30',
    ]);

    await delivery.runForCompany('company-user1');
    expect(notifier.send).toHaveBeenCalledTimes(2);
    const sent = (notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { to: string };
    expect(sent.to).toBe('artisan@fly-services.fr'); // rappel interne, jamais le client

    // Rejeu du cron : mêmes paliers, mêmes clés → dédupliqué, aucun second envoi.
    const second = await service.runForCompany('company-user1');
    expect(second).toMatchObject({ reminders: 0, deduplicated: 2 });
    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  it('fail-closed : devis legacy SANS issuedAt jamais rappelé ; sous J+15 rien', async () => {
    const { service, persistence } = await makeService([
      quote('q-legacy', { issuedAt: null }),
      quote('q-frais', { issuedAt: daysAgo(5) }),
    ]);
    const result = await service.runForCompany('company-user1');
    expect(result).toMatchObject({ reminders: 0, deduplicated: 0 });
    expect(await persistence.notificationJobs.listRecent('company-user1', 10)).toEqual([]);
  });

  it('extinction à la livraison : devis signé APRÈS l’enqueue → job ANNULÉ, jamais livré', async () => {
    const { service, delivery, persistence, notifier } = await makeService([
      quote('q-course', { issuedAt: daysAgo(16), validUntil: daysAgo(-20) }),
    ]);

    await service.runForCompany('company-user1');
    // Le client signe entre l'enqueue (6 h) et le passage du worker (*/5 min) : rejoue le même
    // agrégat au statut signé (réhydratation — l'InMemory stocke des agrégats réels).
    await persistence.quotes.save(quote('q-course', { status: 'signed', issuedAt: daysAgo(16) }));

    const delivered = await delivery.runForCompany('company-user1');
    expect(delivered.sent).toBe(0);
    expect(notifier.send).not.toHaveBeenCalled();
    const jobs = await persistence.notificationJobs.listRecent('company-user1', 10);
    expect(jobs.filter((job) => job.status === 'pending')).toEqual([]);
  });

  it('clé de dédup : construction et inverse fail-closed', () => {
    expect(quoteRelanceReminderDedupeKey('q-9', 'j15')).toBe('quote:q-9:relance-reminder:j15');
    expect(quoteIdOfQuoteRelanceReminderDedupeKey('quote:q-9:relance-reminder:j30')).toBe('q-9');
    expect(quoteIdOfQuoteRelanceReminderDedupeKey('quote:q-9:relance-reminder:j45')).toBeNull();
    expect(quoteIdOfQuoteRelanceReminderDedupeKey('invoice:q-9:relance-reminder:j15')).toBeNull();
  });
});
