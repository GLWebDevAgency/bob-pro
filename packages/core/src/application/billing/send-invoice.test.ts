import { describe, expect, it } from 'vitest';
import { Company } from '../../domain/company/company';
import { Customer } from '../../domain/customer/customer';
import { MERCIER_PROPS } from '../fixtures';
import { makeEnv } from './in-memory-env';
import { ComposeStandaloneInvoice } from './compose-standalone-invoice';
import { IssueInvoice } from './issue-invoice';
import {
  SendInvoice,
  buildInvoiceDeliveryEmail,
  invoiceDeliveryDedupeKey,
  invoiceIdOfInvoiceDeliveryDedupeKey,
  type InvoiceArchivePdfPort,
  type InvoiceDeliveryOutboxPort,
} from './send-invoice';

/**
 * PR-01 « Encaisser » — SendInvoice : gardes fail-closed (brouillon refusé, destinataire requis),
 * composition (lien public + PDF archivé + expéditeur perçu = la société), déduplication par clé
 * `invoice:{id}:delivery:{hash}` (patron sendQuote). Aucun réseau : l'outbox est un port stubé.
 */

interface EnqueuedOrder {
  companyId: string;
  kind: 'invoice-delivery';
  dedupeKey: string;
  notification: import('../ports/output').Notification;
}

function makeOutbox(): { orders: EnqueuedOrder[]; port: InvoiceDeliveryOutboxPort } {
  const orders: EnqueuedOrder[] = [];
  const done = new Set<string>();
  const port: InvoiceDeliveryOutboxPort = {
    enqueue: async (order) => {
      // Émule la dédup de l'outbox réelle : une clé déjà vue rend le job existant (done).
      if (done.has(order.dedupeKey)) return { jobId: `job-${order.dedupeKey}`, status: 'done' };
      orders.push(order);
      done.add(order.dedupeKey);
      return { jobId: `job-${order.dedupeKey}`, status: 'pending' };
    },
  };
  return { orders, port };
}

const archiveOk: InvoiceArchivePdfPort = {
  loadIssuedInvoicePdf: async (_companyId, invoiceId) => ({
    ok: true,
    value: {
      filename: `facture-${invoiceId}.pdf`,
      mimeType: 'application/pdf',
      contentBase64: 'JVBERi0xLjc=',
    },
  }),
};

async function issuedInvoice(env: ReturnType<typeof makeEnv>): Promise<string> {
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

function useCase(
  env: ReturnType<typeof makeEnv>,
  outbox: InvoiceDeliveryOutboxPort,
  archive: InvoiceArchivePdfPort = archiveOk,
): SendInvoice {
  return new SendInvoice({
    invoices: env.invoiceRepo,
    customers: env.customerRepo,
    companies: env.companyRepo,
    quotes: env.quoteRepo,
    publicAccessTokens: env.publicAccessTokens,
    uow: env.uow,
    clock: env.clock,
    outbox,
    archivePdf: archive,
    viewUrlOf: (token) => `https://sign.test/d/${token}`,
  });
}

describe('SendInvoice', () => {
  it('facture introuvable : not_found honnête', async () => {
    const env = makeEnv();
    const { port } = makeOutbox();
    const r = await useCase(env, port).execute({ invoiceId: 'ghost' });
    expect(!r.ok && r.error.kind).toBe('not_found');
  });

  it('brouillon refusé — refus actionnable, aucun ordre d’envoi', async () => {
    const env = makeEnv();
    const { orders, port } = makeOutbox();
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
    const r = await useCase(env, port).execute({ invoiceId: composed.value.invoiceId });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'validation') {
      expect(r.error.issues[0]!.message).toContain('brouillon');
    }
    expect(orders).toHaveLength(0);
  });

  it('sans destinataire résolu : refus actionnable (fiche client à compléter), rien ne part', async () => {
    const env = makeEnv();
    const { orders, port } = makeOutbox();
    const invoiceId = await issuedInvoice(env);
    // Le client n'a plus d'e-mail connu : projection sans email (renseigné absent).
    const bare = env.customerRepo.findById;
    env.customerRepo.findById = async (id) => {
      const c = await bare(id);
      if (!c) return null;
      const props = c.toProps();
      delete props.email;
      const rebuilt = Customer.of(props);
      if (!rebuilt.ok) throw new Error('fixture');
      return rebuilt.value;
    };
    const r = await useCase(env, port).execute({ invoiceId });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'validation') {
      expect(r.error.issues[0]!.field).toBe('customer.email');
      expect(r.error.issues[0]!.message).toContain('Complète');
    }
    expect(orders).toHaveLength(0);
  });

  it('envoi nominal : outbox `invoice-delivery`, clé invoice:{id}:delivery:{hash}, lien + PDF + expéditeur société', async () => {
    const env = makeEnv();
    const { orders, port } = makeOutbox();
    // Société AVEC e-mail : Reply-To + copie attendus (amendement fondateur).
    const withEmail = Company.of({ ...MERCIER_PROPS, email: 'contact@mercier-plomberie.fr' });
    if (!withEmail.ok) throw new Error('fixture');
    env.companyRepo.findById = async (id) => (id === env.company.id ? withEmail.value : null);
    env.companyRepo.lockForShareById = env.companyRepo.findById;

    const invoiceId = await issuedInvoice(env);
    const r = await useCase(env, port).execute({ invoiceId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.deliveryStatus).toBe('queued');
    expect(r.value.recipient).toBe('contact@martin-renov.fr');
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order.kind).toBe('invoice-delivery');
    expect(order.dedupeKey).toMatch(new RegExp(`^invoice:${invoiceId}:delivery:[0-9a-f]{64}$`));
    expect(invoiceIdOfInvoiceDeliveryDedupeKey(order.dedupeKey)).toBe(invoiceId);
    const n = order.notification;
    expect(n.to).toBe('contact@martin-renov.fr');
    expect(n.senderName).toBe('Mercier Plomberie');
    expect(n.replyTo).toBe('contact@mercier-plomberie.fr');
    expect(n.cc).toEqual(['contact@mercier-plomberie.fr']);
    expect(n.body).toContain('https://sign.test/d/');
    expect(n.attachments).toHaveLength(1);
    expect(n.attachments![0]!.mimeType).toBe('application/pdf');
    expect(n.subject).toContain(r.value.number);
  });

  it('société sans e-mail : ni Reply-To ni copie inventés (fail-closed), l’envoi part quand même', async () => {
    const env = makeEnv();
    const { orders, port } = makeOutbox();
    const invoiceId = await issuedInvoice(env);
    const r = await useCase(env, port).execute({ invoiceId });
    expect(r.ok).toBe(true);
    expect(orders[0]!.notification.replyTo).toBeUndefined();
    expect(orders[0]!.notification.cc).toBeUndefined();
    expect(orders[0]!.notification.senderName).toBe('Mercier Plomberie');
  });

  it('destinataire explicite (contact choisi) prioritaire sur la fiche ; adresse invalide refusée', async () => {
    const env = makeEnv();
    const { orders, port } = makeOutbox();
    const invoiceId = await issuedInvoice(env);
    const bad = await useCase(env, port).execute({ invoiceId, recipientEmail: 'pas-un-email' });
    expect(bad.ok).toBe(false);
    const r = await useCase(env, port).execute({
      invoiceId,
      recipientEmail: 'Compta@Martin-Renov.fr',
    });
    expect(r.ok && r.value.recipient).toBe('compta@martin-renov.fr');
    expect(orders[0]!.notification.to).toBe('compta@martin-renov.fr');
  });

  it('archive PDF indisponible : refus fail-closed, aucun e-mail sans la pièce', async () => {
    const env = makeEnv();
    const { orders, port } = makeOutbox();
    const invoiceId = await issuedInvoice(env);
    const archiveKo: InvoiceArchivePdfPort = {
      loadIssuedInvoicePdf: async () => ({
        ok: false,
        error: { kind: 'unavailable', service: 'invoice-archive' },
      }),
    };
    const r = await useCase(env, port, archiveKo).execute({ invoiceId });
    expect(!r.ok && r.error.kind).toBe('unavailable');
    expect(orders).toHaveLength(0);
  });

  it('rejouer le MÊME lien (clé identique) se déduplique : deliveryStatus `sent`', async () => {
    const env = makeEnv();
    const { port } = makeOutbox();
    const invoiceId = await issuedInvoice(env);
    // Force un jeton stable pour rejouer la même clé (le port réel rotate à chaque appel).
    const stableCreate = env.publicAccessTokens.create;
    let firstToken: string | null = null;
    env.publicAccessTokens.create = async (input) => {
      const created = await stableCreate(input);
      if (firstToken === null) {
        firstToken = created.token;
        return created;
      }
      return { ...created, token: firstToken };
    };
    const first = await useCase(env, port).execute({ invoiceId });
    const second = await useCase(env, port).execute({ invoiceId });
    expect(first.ok && first.value.deliveryStatus).toBe('queued');
    expect(second.ok && second.value.deliveryStatus).toBe('sent');
  });

  it('clé de dédup : construction et inverse fail-closed', () => {
    const key = invoiceDeliveryDedupeKey('inv-9', 'token-abc');
    expect(invoiceIdOfInvoiceDeliveryDedupeKey(key)).toBe('inv-9');
    expect(invoiceIdOfInvoiceDeliveryDedupeKey('quote:inv-9:delivery:abc')).toBeNull();
    expect(invoiceIdOfInvoiceDeliveryDedupeKey('invoice:inv-9:relance:auto')).toBeNull();
  });

  it('copy e-mail : lien présent, société nommée, numéro cité', () => {
    const message = buildInvoiceDeliveryEmail({
      companyName: 'Fly Services',
      customerName: 'RATP CAP',
      number: 'F-2026-0042',
      viewUrl: 'https://sign.test/d/tok',
    });
    expect(message.subject).toBe('Facture F-2026-0042 — Fly Services');
    expect(message.body).toContain('https://sign.test/d/tok');
    expect(message.body).toContain('RATP CAP');
  });
});
