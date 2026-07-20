import { describe, expect, it } from 'vitest';
import { makeEnv } from './in-memory-env';
import { ComposeStandaloneInvoice } from './compose-standalone-invoice';
import { IssueInvoice } from './issue-invoice';
import { RecordInvoiceTransmission } from './record-invoice-transmission';

/**
 * Suivi MANUEL de transmission — use case : fusion sous verrou (champ absent = inchangé,
 * null = effacé), invariants délégués à l'agrégat, not_found honnête.
 */

async function issuedStandaloneInvoice(env: ReturnType<typeof makeEnv>): Promise<string> {
  // Client B2B (aucune qualification d'urgence requise pour une facture directe).
  const composed = await new ComposeStandaloneInvoice({
    invoices: env.invoiceRepo,
    companies: env.companyRepo,
    customers: env.customerRepo,
    ids: env.ids,
    clock: env.clock,
  }).execute({
    companyId: env.company.id,
    customerId: 'cust-martin',
    lines: [{ label: 'Régie juillet', category: 'labor', qty: 5, unitPriceHT: 60_000, vatRate: 20 }],
  });
  if (!composed.ok) throw new Error('compose failed');
  const issued = await new IssueInvoice({
    invoices: env.invoiceRepo,
    companies: env.companyRepo,
    customers: env.customerRepo,
    quotes: env.quoteRepo,
    counters: env.counters,
    uow: env.uow,
    clock: env.clock,
  }).execute({
    invoiceId: composed.value.invoiceId,
    defaultTerms: { days: 30, endOfMonth: false, label: 'Paiement à 30 jours' },
  });
  if (!issued.ok) throw new Error('issue failed');
  return composed.value.invoiceId;
}

function useCase(env: ReturnType<typeof makeEnv>): RecordInvoiceTransmission {
  return new RecordInvoiceTransmission({
    invoices: env.invoiceRepo,
    uow: env.uow,
    clock: env.clock,
  });
}

describe('RecordInvoiceTransmission', () => {
  it('facture introuvable : not_found honnête', async () => {
    const env = makeEnv();
    const r = await useCase(env).execute({ invoiceId: 'ghost', depositedAt: '2026-06-02' });
    expect(!r.ok && r.error.kind).toBe('not_found');
  });

  it('dépôt déclaré, puis acceptation en PATCH PARTIEL (dépôt inchangé — fusion sous verrou)', async () => {
    const env = makeEnv();
    const invoiceId = await issuedStandaloneInvoice(env);
    const deposit = await useCase(env).execute({ invoiceId, depositedAt: '2026-06-02' });
    expect(deposit.ok && deposit.value.transmission).toEqual({
      depositedAt: '2026-06-02',
      acceptedAt: null,
    });
    // Patch PARTIEL : seul acceptedAt voyage — depositedAt reste ce qu'il était.
    const accept = await useCase(env).execute({ invoiceId, acceptedAt: '2026-06-05' });
    expect(accept.ok && accept.value.transmission).toEqual({
      depositedAt: '2026-06-02',
      acceptedAt: '2026-06-05',
    });
    // Persisté : relu depuis le repo, pas seulement retourné.
    const stored = await env.invoiceRepo.findById(invoiceId);
    expect(stored!.transmission).toEqual({ depositedAt: '2026-06-02', acceptedAt: '2026-06-05' });
  });

  it('acceptation sans dépôt : refus du domaine (jamais un suivi incohérent)', async () => {
    const env = makeEnv();
    const invoiceId = await issuedStandaloneInvoice(env);
    const r = await useCase(env).execute({ invoiceId, acceptedAt: '2026-06-05' });
    expect(r.ok).toBe(false);
  });

  it('effacement du dépôt alors qu’une acceptation existe : refus (l’acceptation suppose le dépôt)', async () => {
    const env = makeEnv();
    const invoiceId = await issuedStandaloneInvoice(env);
    await useCase(env).execute({ invoiceId, depositedAt: '2026-06-02', acceptedAt: '2026-06-05' });
    const r = await useCase(env).execute({ invoiceId, depositedAt: null });
    expect(r.ok).toBe(false);
  });

  it('brouillon : refus (rien à transmettre avant émission)', async () => {
    const env = makeEnv();
    const composed = await new ComposeStandaloneInvoice({
      invoices: env.invoiceRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({
      companyId: env.company.id,
      customerId: 'cust-martin',
      lines: [{ label: 'Régie', category: 'labor', qty: 1, unitPriceHT: 60_000, vatRate: 20 }],
    });
    if (!composed.ok) throw new Error('compose failed');
    const r = await useCase(env).execute({
      invoiceId: composed.value.invoiceId,
      depositedAt: '2026-06-02',
    });
    expect(r.ok).toBe(false);
  });
});
