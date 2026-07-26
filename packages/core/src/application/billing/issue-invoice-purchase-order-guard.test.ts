import { describe, expect, it } from 'vitest';
import { Customer } from '../../domain/customer/customer';
import { makeEnv } from './in-memory-env';
import { ComposeStandaloneInvoice } from './compose-standalone-invoice';
import { CreateCreditNote } from './create-credit-note';
import { IssueInvoice } from './issue-invoice';
import { type PurchaseOrderOverrideAuditPort } from '../ports/services';

/**
 * PR-04 « Encaisser » — garde « BC obligatoire » à l'émission (cas RATP CAP : une facture sans
 * n° d'engagement est rejetée). PAR CLIENT, désactivée par défaut (amendement fondateur) :
 * flag absent = comportement STRICTEMENT inchangé ; flag actif + BC absent = refus actionnable
 * AVANT tout compteur ; override `true` strict = émission tracée (fail-closed sans journal).
 */

type Env = ReturnType<typeof makeEnv>;

/** Rend `cust-martin` exigeant en BC (le reste de la fiche inchangé). */
function requirePurchaseOrderForMartin(env: Env): void {
  const base = env.customerRepo.findById;
  env.customerRepo.findById = async (id) => {
    const customer = await base(id);
    if (!customer || customer.id !== 'cust-martin') return customer;
    const rebuilt = Customer.of({ ...customer.toProps(), requiresPurchaseOrder: true });
    if (!rebuilt.ok) throw new Error('fixture');
    return rebuilt.value;
  };
}

async function draftInvoice(env: Env, withPurchaseOrder = false): Promise<string> {
  const composed = await new ComposeStandaloneInvoice({
    invoices: env.invoiceRepo,
    companies: env.companyRepo,
    customers: env.customerRepo,
    ids: env.ids,
    clock: env.clock,
  }).execute({
    companyId: env.company.id,
    customerId: 'cust-martin',
    lines: [{ label: 'Maintenance', category: 'labor', qty: 1, unitPriceHT: 40_000, vatRate: 20 }],
  });
  if (!composed.ok) throw new Error('compose failed');
  if (withPurchaseOrder) {
    const invoice = await env.invoiceRepo.findById(composed.value.invoiceId);
    const attached = invoice!.attachPurchaseOrder(
      { number: 'BC-4500012345', receivedAt: null, documentId: null },
      env.clock.now(),
    );
    if (!attached.ok) throw new Error('attach failed');
    await env.invoiceRepo.save(invoice!);
  }
  return composed.value.invoiceId;
}

function issueUseCase(env: Env, audit?: PurchaseOrderOverrideAuditPort): IssueInvoice {
  return new IssueInvoice({
    invoices: env.invoiceRepo,
    companies: env.companyRepo,
    customers: env.customerRepo,
    quotes: env.quoteRepo,
    counters: env.counters,
    uow: env.uow,
    clock: env.clock,
    ...(audit !== undefined ? { purchaseOrderAudit: audit } : {}),
  });
}

const DEFAULT_TERMS = { days: 30, endOfMonth: false, label: 'Paiement à 30 jours' };

describe('IssueInvoice — garde « BC obligatoire » (PR-04)', () => {
  it('flag actif + BC absent : refus PURCHASE_ORDER_REQUIRED actionnable, AUCUN numéro consommé', async () => {
    const env = makeEnv();
    requirePurchaseOrderForMartin(env);
    const invoiceId = await draftInvoice(env);
    const r = await issueUseCase(env).execute({ invoiceId, defaultTerms: DEFAULT_TERMS });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain') {
      expect(r.error.error.code).toBe('PURCHASE_ORDER_REQUIRED');
      if (r.error.error.code === 'PURCHASE_ORDER_REQUIRED') {
        expect(r.error.error.customerName).toBe('SARL Martin Rénovation');
        expect(r.error.error.overridable).toBe(true);
        expect(r.error.error.message).toContain('bon de commande');
      }
    }
    // Aucun numéro consommé : la pièce reste brouillon, une émission conforme suit sans trou.
    const stored = await env.invoiceRepo.findById(invoiceId);
    expect(stored!.number).toBeNull();
  });

  it('flag actif + BC présent : émission normale (la garde ne bloque que l’absence)', async () => {
    const env = makeEnv();
    requirePurchaseOrderForMartin(env);
    const invoiceId = await draftInvoice(env, true);
    const r = await issueUseCase(env).execute({ invoiceId, defaultTerms: DEFAULT_TERMS });
    expect(r.ok).toBe(true);
  });

  it('override `true` + journal câblé : émission TRACÉE (invoice.purchase_order_overridden)', async () => {
    const env = makeEnv();
    requirePurchaseOrderForMartin(env);
    const invoiceId = await draftInvoice(env);
    const events: unknown[] = [];
    const audit: PurchaseOrderOverrideAuditPort = {
      purchaseOrderOverridden: async (event) => {
        events.push(event);
      },
    };
    const r = await issueUseCase(env, audit).execute({
      invoiceId,
      defaultTerms: DEFAULT_TERMS,
      purchaseOrderOverride: true,
    });
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'invoice.purchase_order_overridden',
      invoiceId,
      companyId: env.company.id,
      customerId: 'cust-martin',
      invoiceKind: 'final',
    });
  });

  it('override sans journal câblé : refus fail-closed (jamais d’override sans trace écrite)', async () => {
    const env = makeEnv();
    requirePurchaseOrderForMartin(env);
    const invoiceId = await draftInvoice(env);
    const r = await issueUseCase(env).execute({
      invoiceId,
      defaultTerms: DEFAULT_TERMS,
      purchaseOrderOverride: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain') {
      expect(r.error.error.code).toBe('PURCHASE_ORDER_REQUIRED');
    }
  });

  it('flag absent (défaut) : comportement STRICTEMENT inchangé — émission sans BC acceptée', async () => {
    const env = makeEnv();
    const invoiceId = await draftInvoice(env);
    const r = await issueUseCase(env).execute({ invoiceId, defaultTerms: DEFAULT_TERMS });
    expect(r.ok).toBe(true);
  });

  it('avoir EXEMPTÉ : la rectification d’une pièce fautive n’est jamais bloquée par la garde', async () => {
    const env = makeEnv();
    // La source est émise AVANT l'activation de la garde (BC jamais saisi).
    const sourceId = await draftInvoice(env);
    const issued = await issueUseCase(env).execute({ invoiceId: sourceId, defaultTerms: DEFAULT_TERMS });
    expect(issued.ok).toBe(true);
    requirePurchaseOrderForMartin(env);
    const credit = await new CreateCreditNote({ invoices: env.invoiceRepo, ids: env.ids }).execute({
      invoiceId: sourceId,
    });
    expect(credit.ok).toBe(true);
    if (!credit.ok) return;
    const r = await issueUseCase(env).execute({
      invoiceId: credit.value.creditNoteId,
      defaultTerms: DEFAULT_TERMS,
    });
    expect(r.ok).toBe(true);
  });
});
