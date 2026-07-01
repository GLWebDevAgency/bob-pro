import { describe, it, expect } from 'vitest';
import { LocalBobClient } from './local-client';
import { FixtureClock } from './in-memory/services';

function makeClient(): LocalBobClient {
  return new LocalBobClient({ clock: new FixtureClock('2026-06-01') });
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
    expect(issued.ok && issued.value.number).toBe('F-2026-0001');

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
    expect(entries.value).toHaveLength(1);
    expect(entries.value[0]?.sourceId).toBe(gen.value.invoiceId);
    expect(entries.value[0]?.lines.map((line) => line.account)).toEqual(['411', '4191', '44571']);

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
    expect(paidEntries.value).toHaveLength(2);
    expect(paidEntries.value[1]?.sourceType).toBe('payment');
    expect(paidEntries.value[1]?.lines.map((line) => line.account)).toEqual(['512', '411']);

    const replay = await client.registerPayment({
      invoiceId: gen.value.invoiceId,
      amount: 48840,
      method: 'transfer',
      idempotencyKey: 'test:payment:deposit',
    });
    expect(replay.ok && replay.value.paymentId).toBe(paid.ok ? paid.value.paymentId : null);
    const replayEntries = await client.listAccountingEntries();
    expect(replayEntries.ok && replayEntries.value).toHaveLength(2);

    const fec = await client.exportFec({ from: '2026-01-01', to: '2026-12-31' });
    expect(fec.ok).toBe(true);
    if (!fec.ok) return;
    expect(fec.value.filename).toBe('732829320FEC20261231.txt');
    expect(fec.value.descriptionFilename).toBe('732829320FEC20261231-description.txt');
    expect(fec.value.descriptionContent).toContain('Codes journaux');
    expect(fec.value.entryCount).toBe(2);
    expect(fec.value.rowCount).toBe(5);
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
