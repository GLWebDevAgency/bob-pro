import { describe, expect, it } from 'vitest';
import { STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE } from '@bob/core';
import { LocalBobClient } from './local-client';
import { FixtureClock } from './in-memory/services';

/**
 * B1/B2/B4 — PARITÉ LOCALE de la facturation terrain vocale : le client hors-ligne exécute les
 * MÊMES use cases core que le serveur (ComposeStandaloneInvoice, GenerateInvoiceFromQuote mode
 * 'situation', UpdateCustomer) via les MÊMES outils (@bob/ai). Les gardes du domaine (urgence
 * b2c A3bis, cumul de situations, plafond L441-10) rendent les MÊMES messages qu'à l'écran et
 * qu'au serveur — vérité unique, jamais reformulée.
 */

function seqIds() {
  let n = 0;
  return {
    newId: () => {
      n += 1;
      return `terrain-${n}`;
    },
  };
}

function makeClient(): LocalBobClient {
  return new LocalBobClient({ clock: new FixtureClock('2026-06-01'), ids: seqIds() });
}

async function createKerbrat(client: LocalBobClient): Promise<string> {
  const created = await client.createCustomer({
    name: 'Kerbrat SARL',
    type: 'b2b',
    // L'émission française exige l'identifiant BT-49 réel d'un client professionnel. Le test
    // de conditions de paiement ne doit pas contourner ce prérequis avec une fiche incomplète.
    siren: '732829320',
    address: { line1: '4 rue du Port', zip: '29200', city: 'Brest' },
  });
  if (!created.ok) throw new Error('fixage du décor : createCustomer KO');
  return created.value.id;
}

describe('B1 — facture_directe à la voix (LocalBobClient, parité serveur)', () => {
  it('b2b : propose (plancher fiscal même en auto) puis confirmBob crée le brouillon STANDALONE via le MÊME use case', async () => {
    const client = makeClient();
    const kerbratId = await createKerbrat(client);
    const before = await client.listInvoices();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const asked = await client.askBob({
      message: 'Facture 500 € HT à Kerbrat pour la maintenance de la chaufferie (TVA 20 %)',
      autonomy: 'auto',
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.value.kind).toBe('proposed');
    expect(asked.value.intent).toBe('facture_directe');
    expect(asked.value.pending?.tool).toBe('facture_directe');
    expect(asked.value.pending?.args).toMatchObject({
      customerId: kerbratId,
      lines: [
        { label: 'Maintenance de la chaufferie', category: 'labor', qty: 1, unitPriceHT: 50000, vatRate: 20 },
      ],
    });

    const confirmed = await client.confirmBob(asked.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');
    expect(confirmed.value.intent).toBe('facture_directe');
    expect(confirmed.value.card.title).toBe('Facture directe créée ✓');
    // Le total annoncé est CELUI du domaine : 500 € HT + TVA 20 % = 600 € TTC.
    expect(confirmed.value.card.body).toContain('600,00');

    const after = await client.listInvoices();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const created = after.value.find(
      (invoice) => !before.value.some((existing) => existing.id === invoice.id),
    );
    expect(created).toMatchObject({
      kind: 'final',
      status: 'draft',
      parentQuoteId: null,
      customerId: kerbratId,
    });
    expect(created?.totals.ttc).toBe(60000);
  });

  it('b2c SANS urgence : le MESSAGE DU DOMAINE verbatim (mêmes mots que le serveur et l’écran), rien n’est créé', async () => {
    const client = makeClient();
    const quiviger = await client.createCustomer({
      name: 'Mme Quiviger',
      type: 'b2c',
      address: { line1: '9 rue Haute', zip: '29200', city: 'Brest' },
    });
    expect(quiviger.ok).toBe(true);
    const before = await client.listInvoices();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const r = await client.askBob({
      message: 'Facture 380 € TTC à Quiviger pour dépannage de la chaudière (TVA 20 %) — sans urgence',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toBe(STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE);

    const after = await client.listInvoices();
    expect(after.ok && after.value).toHaveLength(before.value.length);
  });
});

describe('B2 — facturer_situation à la voix (LocalBobClient, parité serveur)', () => {
  it('situation de 40 % : propose puis crée la situation n° 1 ; le CUMUL dépassé (40 + 80 %) est restitué VERBATIM', async () => {
    const client = makeClient();
    const kerbratId = await createKerbrat(client);
    const quote = await client.createQuote({
      customerId: kerbratId,
      lines: [{ label: 'Rénovation chaufferie', category: 'labor', qty: 1, unitPriceHT: 1_000_000, vatRate: 20 }],
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    expect((await client.sendQuote(quote.value.quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId: quote.value.quoteId, signerName: 'M. Kerbrat' })).ok).toBe(true);
    const quotes = await client.listQuotes();
    expect(quotes.ok).toBe(true);
    if (!quotes.ok) return;
    const number = quotes.value.find((q) => q.id === quote.value.quoteId)?.number;
    expect(typeof number).toBe('string');

    const asked = await client.askBob({
      message: `Facture une situation de 40 % sur le devis ${number}`,
      autonomy: 'auto',
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.value.kind).toBe('proposed');
    expect(asked.value.intent).toBe('facturer_situation');
    expect(asked.value.pending?.args).toMatchObject({
      quoteId: quote.value.quoteId,
      situation: { percent: 40 },
    });

    const confirmed = await client.confirmBob(asked.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');
    expect(confirmed.value.card.title).toBe('Situation générée ✓');
    const invoices = await client.listInvoices();
    expect(invoices.ok).toBe(true);
    if (!invoices.ok) return;
    const situation = invoices.value.find(
      (invoice) => invoice.parentQuoteId === quote.value.quoteId && invoice.kind === 'situation',
    );
    // 40 % du marché HT (10 000 €) → 4 000 € HT, n° d'ordre 1 (fait du domaine).
    expect(situation?.situationOrder).toBe(1);
    expect(situation?.totals.ht).toBe(400000);

    // 40 + 80 > 100 : la garde de CUMUL du domaine refuse à la CONFIRMATION — même message
    // que l'UI et que le serveur, et rien n'est créé.
    const over = await client.askBob({ message: `Facture une situation de 80 % sur le devis ${number}` });
    expect(over.ok).toBe(true);
    if (!over.ok) return;
    expect(over.value.kind).toBe('proposed');
    const refused = await client.confirmBob(over.value.pending!);
    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.value.kind).toBe('answer');
    expect(refused.value.card.title).toBe('Refusé — rien n’a été modifié');
    expect(refused.value.card.body).toContain('Cumul acompte + situations supérieur au marché');
    const afterRefusal = await client.listInvoices();
    expect(afterRefusal.ok).toBe(true);
    if (!afterRefusal.ok) return;
    expect(
      afterRefusal.value.filter(
        (invoice) => invoice.parentQuoteId === quote.value.quoteId && invoice.kind === 'situation',
      ),
    ).toHaveLength(1);
  });
});

describe('B4 — definir_conditions_paiement à la voix (LocalBobClient, parité serveur)', () => {
  it('« Kerbrat paie à 45 jours fin de mois » : confirmé, les conditions du CLIENT pilotent l’échéance de la facture émise (IssueInvoice, priorité 2)', async () => {
    const client = makeClient();
    // Sans défaut société (réglage null), l'échéance dérive des conditions du CLIENT — la
    // preuve OBSERVABLE que le geste vocal a bien écrit Customer.paymentTerms.
    const settings = await client.getCompanyBillingSettings();
    expect(settings.ok).toBe(true);
    if (!settings.ok) return;
    const patched = await client.updateCompanyBillingSettings({
      expectedRevision: settings.value.revision,
      patch: { defaultInvoicePaymentTermsDays: null },
    });
    expect(patched.ok).toBe(true);
    const kerbratId = await createKerbrat(client);

    const asked = await client.askBob({ message: 'Le client Kerbrat paie à 45 jours fin de mois' });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.value.kind).toBe('proposed');
    expect(asked.value.intent).toBe('conditions_paiement');
    expect(asked.value.pending?.args).toEqual({
      customerId: kerbratId,
      days: 45,
      endOfMonth: true,
      label: '45 jours fin de mois',
    });
    const confirmed = await client.confirmBob(asked.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');
    expect(confirmed.value.card.title).toBe('Conditions enregistrées ✓');

    // Devis signé → facture finale → émission SANS conditions explicites : l'échéance vient de
    // la fiche client posée à la voix (2026-06-01 + 45 j = 16/07 → fin de mois = 31/07).
    const quote = await client.createQuote({
      customerId: kerbratId,
      lines: [{ label: 'Entretien annuel', category: 'labor', qty: 1, unitPriceHT: 50000, vatRate: 20 }],
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    expect((await client.sendQuote(quote.value.quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId: quote.value.quoteId, signerName: 'M. Kerbrat' })).ok).toBe(true);
    const generated = await client.generateInvoice({ quoteId: quote.value.quoteId, mode: 'final' });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const issued = await client.issueInvoice({ invoiceId: generated.value.invoiceId });
    expect(issued.ok).toBe(true);
    const invoices = await client.listInvoices();
    expect(invoices.ok).toBe(true);
    if (!invoices.ok) return;
    expect(invoices.value.find((invoice) => invoice.id === generated.value.invoiceId)?.dueAt).toBe('2026-07-31');
  });

  it('plafond L441-10 (pro, 90 jours) : refus AVANT proposition — même message pur que le domaine, fiche intacte', async () => {
    const client = makeClient();
    await createKerbrat(client);
    const r = await client.askBob({ message: 'Kerbrat paie à 90 jours' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Refusé — rien n’a été modifié');
    expect(r.value.card.body).toContain('L441-10');
  });
});
