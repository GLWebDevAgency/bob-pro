import { describe, it, expect } from 'vitest';
import { RegisterPayment } from './register-payment';
import { type Invoice } from '../../domain/billing/invoice/invoice';
import { type Payment } from '../../domain/payment/payment';
import { type InvoiceRepository, type PaymentRepository } from '../ports/repositories';
import { ok } from '../../shared-kernel/result';

const clock = { now: () => '2026-06-30T00:00:00.000Z', today: () => '2026-06-30' };
const ids = { newId: () => 'pay-1' };
const uow = { runInTransaction: <T>(fn: () => Promise<T>): Promise<T> => fn() };

function makeDeps(opts: { existingKey?: string | null; status?: string; existingInvoiceId?: string; existingAmount?: number; existingMethod?: string }) {
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
    findByParentQuoteId: async () => null,
    listByCompany: async () => [],
    save: async () => {
      invoiceSaves++;
    },
    deleteById: async () => {},
  };
  const payments: PaymentRepository = {
    save: async () => {
      paymentSaves++;
    },
    findById: async () => null,
    listByInvoice: async () => [],
    findByIdempotencyKey: async (_c, key) =>
      opts.existingKey && key === opts.existingKey
        ? ({
            id: 'pay-0',
            invoiceId: opts.existingInvoiceId ?? 'inv-1',
            amount: opts.existingAmount ?? 1000,
            method: opts.existingMethod ?? 'transfer',
          } as unknown as Payment)
        : null,
  };
  const deps = { invoices, payments, uow, ids, clock };
  return { deps, counts: () => ({ paymentSaves, invoiceSaves }) };
}

describe('RegisterPayment — idempotence', () => {
  it('une clé déjà vue ne crée PAS un second paiement (réponse idempotente)', async () => {
    const { deps, counts } = makeDeps({ existingKey: 'k1', status: 'paid' });
    const r = await new RegisterPayment(deps).execute({ invoiceId: 'inv-1', amount: 1000, method: 'transfer', idempotencyKey: 'k1' });
    expect(r.ok && r.value).toEqual({ status: 'paid', paymentId: 'pay-0' });
    expect(counts()).toEqual({ paymentSaves: 0, invoiceSaves: 0 });
  });

  it('sans clé connue : encaisse (paiement + facture sauvés ensemble)', async () => {
    const { deps, counts } = makeDeps({ existingKey: null });
    const r = await new RegisterPayment(deps).execute({ invoiceId: 'inv-1', amount: 1000, method: 'transfer', idempotencyKey: 'k2' });
    expect(r.ok && r.value).toEqual({ status: 'partially_paid', paymentId: 'pay-1' });
    expect(counts()).toEqual({ paymentSaves: 1, invoiceSaves: 1 });
  });

  it("appelle le hook applicatif apres l'enregistrement du paiement", async () => {
    const { deps } = makeDeps({ existingKey: null });
    const calls: unknown[] = [];
    const r = await new RegisterPayment({
      ...deps,
      afterPaymentRecorded: async (ctx) => {
        calls.push(ctx);
        return ok(undefined);
      },
    }).execute({ invoiceId: 'inv-1', amount: 1000, method: 'transfer', idempotencyKey: 'k2' });

    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ companyId: 'co-1', invoiceId: 'inv-1', paymentId: 'pay-1', status: 'partially_paid' }]);
  });

  it("renvoie l'erreur du hook applicatif pour rollback la transaction", async () => {
    const { deps } = makeDeps({ existingKey: null });
    const r = await new RegisterPayment({
      ...deps,
      afterPaymentRecorded: async () => ({ ok: false, error: { kind: 'dependency', port: 'accounting', cause: 'down' } }),
    }).execute({ invoiceId: 'inv-1', amount: 1000, method: 'transfer', idempotencyKey: 'k2' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'dependency', port: 'accounting' });
  });

  it('clé déjà utilisée pour une AUTRE facture : rejet (anti-rejeu cross-facture)', async () => {
    const { deps, counts } = makeDeps({ existingKey: 'k1', existingInvoiceId: 'inv-999' });
    const r = await new RegisterPayment(deps).execute({ invoiceId: 'inv-1', amount: 1000, method: 'transfer', idempotencyKey: 'k1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toEqual({ paymentSaves: 0, invoiceSaves: 0 });
  });

  it('clé déjà utilisée avec un montant différent : rejet (anti-rejeu incohérent)', async () => {
    const { deps, counts } = makeDeps({ existingKey: 'k1', existingAmount: 500 });
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
