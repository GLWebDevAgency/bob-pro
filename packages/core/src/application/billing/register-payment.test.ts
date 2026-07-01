import { describe, it, expect } from 'vitest';
import { RegisterPayment } from './register-payment';
import { type Invoice } from '../../domain/billing/invoice/invoice';
import { type Payment } from '../../domain/payment/payment';
import { type InvoiceRepository, type PaymentRepository } from '../ports/repositories';
import { ok } from '../../shared-kernel/result';

const clock = { now: () => '2026-06-30T00:00:00.000Z', today: () => '2026-06-30' };
const ids = { newId: () => 'pay-1' };
const uow = { runInTransaction: <T>(fn: () => Promise<T>): Promise<T> => fn() };

function makeDeps(opts: { existingKey?: string | null; status?: string; existingInvoiceId?: string }) {
  let paymentSaves = 0;
  let invoiceSaves = 0;
  const invoice = {
    id: 'inv-1',
    companyId: 'co-1',
    status: opts.status ?? 'partially_paid',
    registerPayment: () => ok(undefined),
  } as unknown as Invoice;
  const invoices: InvoiceRepository = {
    findById: async () => invoice,
    lockById: async () => invoice,
    listByCompany: async () => [],
    save: async () => {
      invoiceSaves++;
    },
  };
  const payments: PaymentRepository = {
    save: async () => {
      paymentSaves++;
    },
    listByInvoice: async () => [],
    findByIdempotencyKey: async (_c, key) =>
      opts.existingKey && key === opts.existingKey
        ? ({ id: 'pay-0', invoiceId: opts.existingInvoiceId ?? 'inv-1' } as unknown as Payment)
        : null,
  };
  const deps = { invoices, payments, uow, ids, clock };
  return { deps, counts: () => ({ paymentSaves, invoiceSaves }) };
}

describe('RegisterPayment — idempotence', () => {
  it('une clé déjà vue ne crée PAS un second paiement (réponse idempotente)', async () => {
    const { deps, counts } = makeDeps({ existingKey: 'k1', status: 'paid' });
    const r = await new RegisterPayment(deps).execute({ invoiceId: 'inv-1', amount: 1000, method: 'transfer', idempotencyKey: 'k1' });
    expect(r.ok && r.value.status).toBe('paid');
    expect(counts()).toEqual({ paymentSaves: 0, invoiceSaves: 0 });
  });

  it('sans clé connue : encaisse (paiement + facture sauvés ensemble)', async () => {
    const { deps, counts } = makeDeps({ existingKey: null });
    const r = await new RegisterPayment(deps).execute({ invoiceId: 'inv-1', amount: 1000, method: 'transfer', idempotencyKey: 'k2' });
    expect(r.ok).toBe(true);
    expect(counts()).toEqual({ paymentSaves: 1, invoiceSaves: 1 });
  });

  it('clé déjà utilisée pour une AUTRE facture : rejet (anti-rejeu cross-facture)', async () => {
    const { deps, counts } = makeDeps({ existingKey: 'k1', existingInvoiceId: 'inv-999' });
    const r = await new RegisterPayment(deps).execute({ invoiceId: 'inv-1', amount: 1000, method: 'transfer', idempotencyKey: 'k1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toEqual({ paymentSaves: 0, invoiceSaves: 0 });
  });

  it('clé idempotente invalide : rejet avant toute mutation', async () => {
    const { deps, counts } = makeDeps({ existingKey: null });
    const r = await new RegisterPayment(deps).execute({
      invoiceId: 'inv-1',
      amount: 1000,
      method: 'transfer',
      idempotencyKey: 'bad key /',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toEqual({ paymentSaves: 0, invoiceSaves: 0 });
  });
});
