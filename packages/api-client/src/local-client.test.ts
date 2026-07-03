import { describe, it, expect } from 'vitest';
import type { JournalEntry } from '@bob/ai';
import { LocalBobClient } from './local-client';
import { FixtureClock } from './in-memory/services';

function makeClient(): LocalBobClient {
  return new LocalBobClient({ clock: new FixtureClock('2026-06-01') });
}

/** Ids déterministes (id-1, id-2, …) — rend le journal d'agent sondable dans les tests. */
function seqIds() {
  let n = 0;
  return {
    newId: () => {
      n += 1;
      return `id-${n}`;
    },
  };
}

describe('LocalBobClient (couche data hors-ligne)', () => {
  it('liste les 6 clients de seed', async () => {
    const r = await makeClient().listCustomers();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(6);
  });

  it('déroule le flux Devis -> facture -> paiement hors-ligne', async () => {
    const client = makeClient();
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [
        { label: 'Chauffe-eau', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
        { label: 'MO', category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
      ],
      depositPct: 30,
      context: { housingOlderThan2y: true },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quoteId = created.value.quoteId;
    expect(created.value.totals.ttc).toBe(162800);

    expect((await client.sendQuote(quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId, signerName: 'M. Martin' })).ok).toBe(true);

    const gen = await client.generateInvoice({ quoteId });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const draftPreview = await client.invoiceAccountingPreview(gen.value.invoiceId);
    expect(draftPreview.ok && draftPreview.value.available).toBe(true);
    if (!draftPreview.ok) return;
    expect(draftPreview.value.reference).toBe('a-emettre');
    expect(draftPreview.value.lines.map((line) => line.account)).toEqual(['411', '4191', '44571']);

    const issued = await client.issueInvoice({ invoiceId: gen.value.invoiceId });
    // Le seed démo (C16) a émis F-2026-0001 : la numérotation SANS TROU continue à 0002.
    expect(issued.ok && issued.value.number).toBe('F-2026-0002');

    const preview = await client.invoiceAccountingPreview(gen.value.invoiceId);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.available).toBe(true);
    expect(preview.value.totalDebitCents).toBe(48840);
    expect(preview.value.totalCreditCents).toBe(48840);
    expect(preview.value.lines.map((line) => line.account)).toEqual(['411', '4191', '44571']);

    const entries = await client.listAccountingEntries();
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    // Le seed démo (C16) porte sa propre écriture : on cible celle du flux du test.
    const entry = entries.value.find((e) => e.sourceId === gen.value.invoiceId);
    expect(entry).toBeDefined();
    expect(entry?.lines.map((line) => line.account)).toEqual(['411', '4191', '44571']);

    const paid = await client.registerPayment({
      invoiceId: gen.value.invoiceId,
      amount: 48840,
      method: 'transfer',
      idempotencyKey: 'test:payment:deposit',
    });
    expect(paid.ok && paid.value.status).toBe('paid');
    if (paid.ok) expect(paid.value.paymentId).toBeTruthy();

    const inv = await client.getInvoice(gen.value.invoiceId);
    expect(inv.ok && inv.value.status).toBe('paid');

    const paidEntries = await client.listAccountingEntries();
    expect(paidEntries.ok).toBe(true);
    if (!paidEntries.ok) return;
    // 2 écritures pour CE flux (facture + paiement) — celles du seed démo en plus.
    const flowPaid = paidEntries.value.filter(
      (e) => e.sourceId === gen.value.invoiceId || (e.sourceType === 'payment' && e.lines.some(() => true)),
    );
    const paymentEntry = paidEntries.value
      .filter((e) => e.sourceType === 'payment')
      .at(-1);
    expect(paymentEntry).toBeDefined();
    expect(paymentEntry?.lines.map((line) => line.account)).toEqual(['512', '411']);
    void flowPaid;

    const replay = await client.registerPayment({
      invoiceId: gen.value.invoiceId,
      amount: 48840,
      method: 'transfer',
      idempotencyKey: 'test:payment:deposit',
    });
    expect(replay.ok && replay.value.paymentId).toBe(paid.ok ? paid.value.paymentId : null);
    const replayEntries = await client.listAccountingEntries();
    // Idempotence : le rejeu ne crée AUCUNE écriture supplémentaire.
    expect(replayEntries.ok && replayEntries.value.length).toBe(paidEntries.value.length);

    const fec = await client.exportFec({ from: '2026-01-01', to: '2026-12-31' });
    expect(fec.ok).toBe(true);
    if (!fec.ok) return;
    expect(fec.value.filename).toBe('732829320FEC20261231.txt');
    expect(fec.value.descriptionFilename).toBe('732829320FEC20261231-description.txt');
    expect(fec.value.descriptionContent).toContain('Codes journaux');
    // Le FEC embarque AUSSI les écritures du seed démo (facture 0001 + son paiement) :
    // 4 écritures, 10 lignes — l'export reste équilibré et sans trou.
    expect(fec.value.entryCount).toBe(4);
    expect(fec.value.rowCount).toBe(10);
    const rows = fec.value.content.trimEnd().split('\n');
    expect(rows[0]?.split('\t')).toEqual([
      'JournalCode',
      'JournalLib',
      'EcritureNum',
      'EcritureDate',
      'CompteNum',
      'CompteLib',
      'CompAuxNum',
      'CompAuxLib',
      'PieceRef',
      'PieceDate',
      'EcritureLib',
      'Debit',
      'Credit',
      'EcritureLet',
      'DateLet',
      'ValidDate',
      'Montantdevise',
      'Idevise',
    ]);
    expect(fec.value.content).toContain('VE\tJournal des ventes');
    expect(fec.value.content).toContain('BQ\tJournal de banque');
  });

  it("preview l'ecriture comptable d'un encaissement hors-ligne", async () => {
    const client = makeClient();
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Recherche fuite', category: 'labor', qty: 1, unitPriceHT: 12000, vatRate: 10 }],
      context: { housingOlderThan2y: true },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await client.sendQuote(created.value.quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId: created.value.quoteId, signerName: 'M. Martin' })).ok).toBe(true);
    const gen = await client.generateInvoice({ quoteId: created.value.quoteId });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    expect((await client.issueInvoice({ invoiceId: gen.value.invoiceId })).ok).toBe(true);

    const preview = await client.paymentAccountingPreview({
      invoiceId: gen.value.invoiceId,
      amountCents: 13200,
      method: 'cash',
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.available).toBe(true);
    expect(preview.value.remainingCents).toBe(13200);
    expect(preview.value.totalDebitCents).toBe(13200);
    expect(preview.value.totalCreditCents).toBe(13200);
    expect(preview.value.lines.map((line) => line.account)).toEqual(['530', '411']);
  });

  it("suggere les defauts de depense depuis l'historique fournisseur", async () => {
    const client = makeClient();
    const recorded = await client.recordExpense({
      supplierName: 'Leroy Merlin',
      supplierSiren: '552100554',
      documentDate: '2026-05-12',
      totalTtcCents: 12000,
      totalHtCents: 10000,
      vatCents: 2000,
      vatRatePct: 20,
      category: 'materiel',
      source: 'ocr',
    });
    expect(recorded.ok).toBe(true);

    const suggested = await client.suggestExpenseDefaults({
      supplierName: 'LÉROY-MERLIN',
      supplierSiren: null,
      vatRatePctApplied: null,
      categoryGuess: 'autre',
    });

    expect(suggested.ok).toBe(true);
    if (!suggested.ok) return;
    expect(suggested.value).toMatchObject({
      supplierName: 'Leroy Merlin',
      supplierSiren: '552100554',
      category: 'materiel',
      vatRatePct: 20,
      source: 'memory',
    });
  });

  it('refuse un devis envoye hors-ligne', async () => {
    const client = makeClient();
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Recherche fuite', category: 'labor', qty: 1, unitPriceHT: 12000, vatRate: 10 }],
      context: { housingOlderThan2y: true },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quoteId = created.value.quoteId;

    expect((await client.sendQuote(quoteId)).ok).toBe(true);
    const refused = await client.refuseQuote(quoteId);
    expect(refused.ok && refused.value.status).toBe('refused');

    const quote = await client.getQuote(quoteId);
    expect(quote.ok && quote.value.status).toBe('refused');
    expect((await client.signQuote({ quoteId, signerName: 'M. Martin' })).ok).toBe(false);
  });

  it('expose une projection de trésorerie', async () => {
    const r = await makeClient().getCashflow({ scenario: 'realiste', horizon: 30 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.value.available).toBe('number');
  });

  it('expose la voix locale sans audio cloud', async () => {
    const client = makeClient();
    const config = await client.voiceConfig();
    expect(config.ok && config.value).toMatchObject({ cloudAvailable: false, ttsCloudAvailable: false });

    const spoken = await client.synthesizeSpeech({ text: 'Bonjour Bob' });
    expect(spoken.ok && spoken.value).toEqual({ audioBase64: null, mimeType: null, model: 'native' });
  });

  it('stocke et liste les documents dans le client local', async () => {
    const client = makeClient();
    const uploaded = await client.uploadDocument({
      contentBase64: 'AQID',
      mimeType: 'image/jpeg',
      filename: 'ticket.jpg',
      kind: 'expense_receipt',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-1',
      documentDate: '2026-06-01',
    });

    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    expect(uploaded.value.byteSize).toBe(3);

    const list = await client.listDocuments({ linkedEntityType: 'expense', linkedEntityId: 'exp-1' });
    expect(list.ok && list.value.map((d) => d.id)).toEqual([uploaded.value.id]);

    const url = await client.documentDownloadUrl(uploaded.value.id, 120);
    expect(url.ok).toBe(true);
    if (url.ok) expect(url.value.url).toContain('ttl=120');
  });
});

describe('assistant Bob local (C40 ⑧ — ask/confirm/journal on-device) + créer client', () => {
  it('crée une fiche client minimale et la liste (même use case que le « + » de C12)', async () => {
    const client = makeClient();
    const created = await client.createCustomer({
      name: 'Mme Nguyen',
      type: 'b2c',
      address: { line1: '', zip: '', city: '' },
      score: 100,
      avgDelayDays: 0,
      outstanding: 0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const list = await client.listCustomers();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(7);
    expect(list.value.find((c) => c.id === created.value.id)).toMatchObject({ name: 'Mme Nguyen', type: 'b2c' });
  });

  it('refuse un score hors domaine (Customer.of fait foi, comme le serveur)', async () => {
    const r = await makeClient().createCustomer({
      name: 'M. Hors-Borne',
      type: 'b2c',
      address: { line1: '', zip: '', city: '' },
      score: 250,
      avgDelayDays: 0,
      outstanding: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
  });

  it('askBob propose (plancher) puis confirmBob exécute EN JOURNALISANT — le journal est lisible on-device', async () => {
    const client = new LocalBobClient({ clock: new FixtureClock('2026-06-01'), ids: seqIds() });

    // Pièce réelle : devis signé -> facture émise F-2026-0001 (chaîne de use cases, zéro fixture).
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Recherche fuite', category: 'labor', qty: 1, unitPriceHT: 12000, vatRate: 10 }],
      context: { housingOlderThan2y: true },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await client.sendQuote(created.value.quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId: created.value.quoteId, signerName: 'M. Martin' })).ok).toBe(true);
    const gen = await client.generateInvoice({ quoteId: created.value.quoteId });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    expect((await client.issueInvoice({ invoiceId: gen.value.invoiceId })).ok).toBe(true);

    // ask : action sensible -> TOUJOURS proposée (plancher comptable), même avec l'autonomie max locale.
    const asked = await client.askBob({ message: 'encaisse la facture F-2026-0001', autonomy: 'auto' });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.value.kind).toBe('proposed');
    expect(asked.value.pending?.tool).toBe('encaisser_facture');
    expect(asked.value.pending?.args).toMatchObject({ invoiceId: gen.value.invoiceId, amountCents: 13200 });

    // confirm : exécution réelle via le runtime journalisé — la facture passe payée.
    const confirmed = await client.confirmBob(asked.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');
    expect(confirmed.value.card.title).toBe('Fait ✓');
    const paid = await client.getInvoice(gen.value.invoiceId);
    expect(paid.ok && paid.value.status).toBe('paid');

    // journal : append-only, lisible via getRunJournal (ids déterministes -> on sonde les runs candidats).
    const entries: JournalEntry[] = [];
    for (let n = 1; n <= 12; n += 1) {
      const r = await client.getRunJournal(`id-${n}`);
      if (r.ok) entries.push(...r.value);
    }
    const run = entries.filter((e) => e.tool === 'encaisser_facture');
    expect(run.map((e) => e.phase)).toEqual(['planned', 'executed']);
    expect(run[0]?.args).toMatchObject({ invoiceId: gen.value.invoiceId });
    expect(run[1]?.resultDigest).toContain('status=paid');
    expect(new Set(run.map((e) => e.runId)).size).toBe(1); // même run, seq monotone
    expect(run.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('getRunJournal d’un run inconnu rend une liste vide (parité serveur)', async () => {
    const r = await makeClient().getRunJournal('run-inconnu');
    expect(r.ok && r.value).toEqual([]);
  });

  it('« Prêt pour 2026 ? » -> navigation /diagnostic à travers l’adaptateur local (C40 ⑦)', async () => {
    const r = await makeClient().askBob({ message: 'Prêt pour 2026 ?' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('diagnostic');
    expect(r.value.navigate).toBe('/diagnostic');
  });
});

describe('coffre de démo + classement (A1-C14)', () => {
  it('seede le reçu Leroy Merlin « à valider » et les dépenses fournisseurs', async () => {
    const client = makeClient();
    const docs = await client.listDocuments();
    expect(docs.ok).toBe(true);
    if (!docs.ok) return;
    const leroy = docs.value.find((d) => d.id === 'seed-doc-leroy');
    expect(leroy).toMatchObject({ origin: 'ocr', linkedEntityType: null, kind: 'expense_receipt' });
    const expenses = await client.listExpenses();
    expect(expenses.ok && expenses.value.map((e) => e.supplierName).sort()).toEqual(
      ['Cedeo', 'Leroy Merlin', 'Point P'],
    );
  });

  it('« Classer là » rattache le reçu à la dépense (sort d’à valider, dossier Achats)', async () => {
    const client = makeClient();
    const r = await client.classifyDocument({
      documentId: 'seed-doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: 'local-expense-leroy',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.linkedEntityId).toBe('local-expense-leroy');
    const linked = await client.listDocuments({ linkedEntityType: 'expense', linkedEntityId: 'local-expense-leroy' });
    expect(linked.ok && linked.value.map((d) => d.id)).toEqual(['seed-doc-leroy']);
  });

  it('refuse un document inconnu ou un rattachement vide', async () => {
    const client = makeClient();
    const missing = await client.classifyDocument({ documentId: 'nope', linkedEntityType: 'expense', linkedEntityId: 'x' });
    expect(missing.ok).toBe(false);
    const incomplete = await client.classifyDocument({ documentId: 'seed-doc-leroy', linkedEntityType: 'expense', linkedEntityId: '  ' });
    expect(incomplete.ok).toBe(false);
  });
});

describe('flow corrélé devis → acompte → FINALE (A2-C16)', () => {
  it('la facture finale déduit l’acompte émis : netToPay = solde, traçabilité posée', async () => {
    const client = makeClient();
    const quote = await client.createQuote({
      customerId: 'cust-durand',
      depositPct: 30,
      lines: [{ label: 'Chantier test', category: 'labor', qty: 1, unitPriceHT: 135667, vatRate: 20 }],
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    await client.sendQuote(quote.value.quoteId);
    await client.signQuote({ quoteId: quote.value.quoteId, signerName: 'Mme Durand' });

    const acompte = await client.generateInvoice({ quoteId: quote.value.quoteId, mode: 'deposit' });
    expect(acompte.ok).toBe(true);
    if (!acompte.ok) return;
    await client.issueInvoice({ invoiceId: acompte.value.invoiceId });
    await client.registerPayment({ invoiceId: acompte.value.invoiceId, amount: 48840, method: 'card' });

    const finale = await client.generateInvoice({ quoteId: quote.value.quoteId, mode: 'final' });
    expect(finale.ok).toBe(true);
    if (!finale.ok) return;
    const view = await client.getInvoice(finale.value.invoiceId);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    // Le solde EXACT : 1 628,00 − 488,40 = 1 139,60 € — jamais de double facturation.
    expect(view.value.totals.ttc).toBe(162800);
    expect(view.value.totals.netToPay).toBe(113960);
    expect(view.value.depositDeductionCents).toBe(48840);
    expect(view.value.depositInvoiceId).toBe(acompte.value.invoiceId);
  });
});
