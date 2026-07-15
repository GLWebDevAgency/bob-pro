import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { BobAgent, type JournalEntry } from '@bob/ai';
import { buildFacturXBasicXml, type FacturXInvoiceData } from '@bob/core';
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

  it('C24b : registerCompany renvoie l’id de la société seedée (parité de contrat — id serveur, jamais client)', async () => {
    const client = makeClient();
    const r = await client.registerCompany({
      name: 'Durand Élec',
      legalForm: 'EI',
      siren: '732829320',
      siret: '73282932000074',
      trade: 'electricien',
      vatRegime: 'franchise',
      address: { line1: '4 rue du Forgeron', zip: '92310', city: 'Sèvres' },
    });
    expect(r.ok && r.value.companyId).toBe(client.companyId);

    // SIRET incohérent avec le SIREN : refus du domaine (Company.of), pas d'écriture fantôme.
    const bad = await client.registerCompany({
      name: 'Bancal SARL',
      legalForm: 'SARL',
      siren: '732829320',
      siret: '99999999900011',
      trade: 'autre',
      vatRegime: 'franchise',
      address: { line1: '1 rue Test', zip: '75001', city: 'Paris' },
    });
    expect(!bad.ok && bad.error.kind).toBe('domain');
  });

  it('C26b : getSubscription = early-access HONNÊTE aligné sur le seed (business actif, 0 € facturé)', async () => {
    const r = await makeClient().getSubscription();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Même vérité que le serveur : aucun billing — l'écran Compte dérive l'état accès anticipé.
    expect(r.value.earlyAccess).toBe(true);
    expect(r.value.priceCents).toBe(0);
    expect(r.value.tier).toBe('business');
    expect(r.value.status).toBe('active');
    expect(r.value.currentPeriodEnd).toBeNull();
    expect(r.value.features).toContain('ai_assistant');
  });

  it('BOB EXPERT FISCAL (Phase 1A) : getFiscalProfile dérive par hypothèses (EI/plombier → réel IR/TNS)', async () => {
    const client = makeClient();
    const r = await client.getFiscalProfile();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.companyId).toBe(client.companyId);
    expect(r.value.legalForm).toMatchObject({ status: 'source_fiable', value: 'EI', source: 'insee_siret' });
    expect(r.value.taxRegime).toMatchObject({ status: 'hypothese', value: 'reel_ir' });
    expect(r.value.socialStatus).toMatchObject({ status: 'hypothese', value: 'tns' });

    // Une deuxième lecture relit la MÊME ligne persistée en mémoire, ne re-dérive pas.
    const second = await client.getFiscalProfile();
    expect(second.ok && second.value).toEqual(r.value);
  });

  it('BOB EXPERT FISCAL (Phase 1A) : updateFiscalProfileField confirme un champ, rejette une incohérence', async () => {
    const client = makeClient();

    const confirmed = await client.updateFiscalProfileField('vatRegime', 'reel_normal');
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.value.vatRegime).toMatchObject({ status: 'confirme_utilisateur', value: 'reel_normal', source: 'user_form' });
    }

    // EI (seed) impose TNS : forcer assimilé salarié viole l'invariant — erreur domaine, rien n'est modifié.
    const rejected = await client.updateFiscalProfileField('socialStatus', 'assimile_salarie');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toMatchObject({
        kind: 'domain',
        error: { code: 'FISCAL_PROFILE_INCONSISTENT', rule: 'tns_requires_ei_micro_eurl' },
      });
    }
  });

  it('C-EXP5b : getFiscalCalendar dérive l’échéancier de la société du seed (EI au réel simplifié)', async () => {
    const r = await makeClient().getFiscalCalendar();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Horloge fixe 2026-06-01, fenêtre 90 j → 2026-08-30 : acompte CFE du 15/6 (hypothèse
    // CFE N-1 ≥ 3 000 €) puis acompte TVA de juillet posé au 24 — rien d'autre pour une EI au
    // réel simplifié (pas d'URSSAF micro, pas d'IS, pas de rituel des comptes).
    expect(r.value.map((d) => ({ id: d.id, date: d.date, kind: d.kind, confidence: d.confidence }))).toEqual([
      { id: 'cfe-acompte-2026', date: '2026-06-15', kind: 'cfe', confidence: 'assumed' },
      { id: 'tva-acompte-juillet-2026', date: '2026-07-24', kind: 'tva', confidence: 'assumed' },
    ]);
    // v1 honnête : aucun montant inventé — P03/P23 brancheront les provisions plus tard.
    for (const d of r.value) expect(d.amountHint).toBeNull();
  });

  it('C-EXP5b : Bob local répond aux échéances fiscales via le MÊME use case (parité humain↔Bob)', async () => {
    const r = await makeClient().askBob({ message: 'quelles sont mes prochaines échéances fiscales ?' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('echeances');
    expect(r.value.kind).toBe('answer'); // lecture pure : jamais de confirmation
    expect(r.value.card.body).toContain('15/06/2026 — CFE : acompte (si CFE N-1 ≥ 3 000 €) (à confirmer)');
    expect(r.value.card.body).toContain('24/07/2026 — TVA : acompte de juillet (55 %) (à confirmer)');
  });

  it('askBob transmet au BobAgent local le même historique, ton et contexte que le transport HTTP', async () => {
    const client = makeClient();
    const history = [
      { role: 'user', text: 'Montre-moi la facture Martin.' },
      { role: 'bob', text: 'La facture F-2026-014 est affichée.' },
    ] as const;
    const context = {
      screen: { name: '/facture/[id]', instanceId: 'invoice:inv-seed-late' },
      entities: [{ type: 'invoice', id: 'inv-seed-late', label: 'Facture F-2026-0001' }],
      capabilities: ['invoice.read', 'invoice.collect'],
    } as const;
    const ask = vi.spyOn(BobAgent.prototype, 'ask');

    try {
      const result = await client.askBob({
        message: 'et celle-ci ?',
        autonomy: 'confirm_all',
        history,
        tone: 'direct',
        context,
      });

      expect(result.ok).toBe(true);
      expect(ask).toHaveBeenCalledWith('et celle-ci ?', {
        autonomy: 'confirm_all',
        history,
        tone: 'direct',
        context,
      });
    } finally {
      ask.mockRestore();
    }
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

    const sent = await client.sendQuote(quoteId);
    expect(sent.ok).toBe(true);
    expect(sent.ok && sent.value.deliveryStatus).toBe('skipped');
    expect((await client.signQuote({ quoteId, signerName: 'M. Martin' })).ok).toBe(true);

    const gen = await client.generateInvoice({ quoteId, mode: 'deposit' });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const draftPreview = await client.invoiceAccountingPreview(gen.value.invoiceId);
    expect(draftPreview.ok && draftPreview.value.available).toBe(true);
    if (!draftPreview.ok) return;
    expect(draftPreview.value.reference).toBe('a-emettre');
    expect(draftPreview.value.lines.map((line) => line.account)).toEqual(['411', '4191', '44571']);

    const issued = await client.issueInvoice({ invoiceId: gen.value.invoiceId });
    // Le seed démo a émis F-2026-0001 (mairie ÉCHUE, A2-C10) puis F-2026-0002 (acompte
    // Martin) : la numérotation SANS TROU continue à 0003.
    expect(issued.ok && issued.value.number).toBe('F-2026-0003');

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
    // Le FEC embarque AUSSI les écritures du seed démo : facture échue 0001 (mairie),
    // acompte 0002 + son paiement, ET le cycle achats (3 achats AC + 2 décaissements BQ
    // des dépenses payées — expertise chantier 1) : 10 écritures, 26 lignes.
    expect(fec.value.entryCount).toBe(10);
    expect(fec.value.rowCount).toBe(26);
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
    // Le journal des ACHATS n'est plus un chemin mort : les dépenses postent 6xx/44566/401.
    expect(fec.value.content).toContain('AC\tJournal des achats');
    expect(fec.value.content).toContain('44566');
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
    const gen = await client.generateInvoice({ quoteId: created.value.quoteId, mode: 'final' });
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

  it('rend recordExpense idempotent en concurrence et après une réponse perdue', async () => {
    const client = makeClient();
    const before = await client.listExpenses();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const request = {
      supplierName: 'Cedeo',
      documentDate: '2026-06-01',
      totalTtcCents: 18_490,
      vatCents: 3_082,
      vatRatePct: 20,
      category: 'fournitures' as const,
      source: 'ocr' as const,
      idempotencyKey: 'scan-expense-response-lost-1',
    };

    const [first, concurrent] = await Promise.all([
      client.recordExpense(request),
      client.recordExpense(request),
    ]);
    expect(first.ok).toBe(true);
    expect(concurrent.ok).toBe(true);
    if (!first.ok || !concurrent.ok) return;
    expect(concurrent.value.id).toBe(first.value.id);

    // Le premier commit a réussi mais sa réponse peut avoir été perdue : le retry recharge
    // exactement la même Expense sans doubler ni la charge ni son écriture AC.
    const retry = await client.recordExpense(request);
    expect(retry).toEqual(first);
    const expenses = await client.listExpenses();
    expect(expenses.ok && expenses.value).toHaveLength(before.value.length + 1);
    expect(expenses.ok && expenses.value.filter((expense) => expense.id === first.value.id)).toHaveLength(1);
    const entries = await client.listAccountingEntries();
    expect(entries.ok && entries.value.filter((entry) => entry.sourceId === first.value.id)).toHaveLength(1);

    const conflict = await client.recordExpense({ ...request, totalTtcCents: 18_491 });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.kind).toBe('conflict');
    const afterConflict = await client.listExpenses();
    expect(afterConflict.ok && afterConflict.value).toHaveLength(before.value.length + 1);
  });

  it('rend createQuote idempotent en concurrence et après une réponse perdue', async () => {
    const client = makeClient();
    const before = await client.listQuotes();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const request = {
      customerId: 'cust-martin',
      idempotencyKey: 'mobile-voice:quote:response-loss-local-1',
      lines: [
        { label: 'Pose ballon', category: 'labor' as const, qty: 2, unit: 'h', unitPriceHT: 8_000, vatRate: 10 as const },
      ],
      context: { housingOlderThan2y: true },
    };

    const [first, concurrent] = await Promise.all([
      client.createQuote(request),
      client.createQuote(request),
    ]);
    expect(first.ok).toBe(true);
    expect(concurrent).toEqual(first);
    const retry = await client.createQuote(request);
    expect(retry).toEqual(first);
    const after = await client.listQuotes();
    expect(after.ok && after.value).toHaveLength(before.value.length + 1);

    const conflict = await client.createQuote({
      ...request,
      lines: [{ ...request.lines[0]!, unitPriceHT: 8_001 }],
    });
    expect(conflict).toMatchObject({ ok: false, error: { kind: 'conflict', entity: 'quote_creation' } });
    const afterConflict = await client.listQuotes();
    expect(afterConflict.ok && afterConflict.value).toHaveLength(before.value.length + 1);
  });

  it('refuse une clé createQuote invalide avant toute création locale', async () => {
    const client = makeClient();
    const before = await client.listQuotes();
    if (!before.ok) throw new Error('fixture quotes required');
    const result = await client.createQuote({
      customerId: 'cust-martin',
      idempotencyKey: 'bad\nkey',
      lines: [{ label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 100, vatRate: 20 }],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'idempotencyKey' }] },
    });
    const after = await client.listQuotes();
    expect(after.ok && after.value).toHaveLength(before.value.length);
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

  it('P0 R4 : createQuoteSignatureLink prépare/rotate le lien SANS sortant ; la signature le tue', async () => {
    const client = makeClient();
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Recherche fuite', category: 'labor', qty: 1, unitPriceHT: 12000, vatRate: 10 }],
      context: { housingOlderThan2y: true },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quoteId = created.value.quoteId;

    // Un brouillon n'a pas de lien partageable (même règle core que l'API).
    expect((await client.createQuoteSignatureLink(quoteId)).ok).toBe(false);

    expect((await client.sendQuote(quoteId)).ok).toBe(true);
    const first = await client.createQuoteSignatureLink(quoteId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.signatureUrl).toMatch(/^https:\/\/demo\.bobpro\.fr\/sign\//);
    expect(first.value.expiresAt > '2026-06-01').toBe(true);

    // Rotation : chaque préparation émet un jeton NEUF (l'ancien est révoqué par le use case).
    const second = await client.createQuoteSignatureLink(quoteId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.signatureUrl).not.toBe(first.value.signatureUrl);

    // R4 : le tracé du pad (dataURL) accompagne la signature — haché côté use case, jamais stocké.
    const signed = await client.signQuote({
      quoteId,
      signerName: 'M. Martin',
      proofDataUrl: 'data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E',
    });
    expect(signed.ok && signed.value.status).toBe('signed');

    // Devis signé : plus jamais de nouveau lien (le lien mort ne renaît pas).
    expect((await client.createQuoteSignatureLink(quoteId)).ok).toBe(false);
  });

  it('R6 : édite et supprime une ligne de devis BROUILLON (draft only, même use case core que l’API)', async () => {
    const client = makeClient();
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [
        { label: 'Recherche fuite', category: 'labor', qty: 1, unitPriceHT: 12000, vatRate: 10 },
        { label: 'Pièce', category: 'supply', qty: 1, unitPriceHT: 3000, vatRate: 10 },
      ],
      context: { housingOlderThan2y: true },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quoteId = created.value.quoteId;
    const before = await client.getQuote(quoteId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const [line1, line2] = before.value.lines;
    expect(line1).toBeDefined();
    expect(line2).toBeDefined();

    const updated = await client.updateQuoteLine({ quoteId, lineId: line1!.id, patch: { qty: 2, unitPriceHT: 15000 } });
    expect(updated.ok && updated.value.status).toBe('draft');
    const afterUpdate = await client.getQuote(quoteId);
    expect(afterUpdate.ok && afterUpdate.value.lines.find((l) => l.id === line1!.id)).toMatchObject({ qty: 2, unitPriceHT: 15000 });

    const removed = await client.removeQuoteLine({ quoteId, lineId: line2!.id });
    expect(removed.ok && removed.value.status).toBe('draft');
    const afterRemove = await client.getQuote(quoteId);
    expect(afterRemove.ok && afterRemove.value.lines.map((l) => l.id)).toEqual([line1!.id]);

    // Un devis signé est un contrat : plus d'édition de lignes (assertDraft) — l'UI n'affiche
    // pas ce que le domaine interdit, mais la couche data doit refuser explicitement aussi.
    expect((await client.sendQuote(quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId, signerName: 'M. Martin' })).ok).toBe(true);
    const afterSign = await client.updateQuoteLine({ quoteId, lineId: line1!.id, patch: { qty: 5 } });
    expect(afterSign.ok).toBe(false);
    if (!afterSign.ok) expect(afterSign.error.kind).toBe('domain');
  });

  it('R6 : supprime une facture BROUILLON (erreur détectée après génération) ; refuse une facture émise', async () => {
    const client = makeClient();
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Dépannage', category: 'labor', qty: 1, unitPriceHT: 20000, vatRate: 10 }],
      context: { housingOlderThan2y: true },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quoteId = created.value.quoteId;
    expect((await client.sendQuote(quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId, signerName: 'M. Martin' })).ok).toBe(true);
    const gen = await client.generateInvoice({ quoteId, mode: 'final' });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const deleted = await client.deleteDraftInvoice(gen.value.invoiceId);
    expect(deleted.ok && deleted.value).toEqual({ deleted: true });
    const afterDelete = await client.getInvoice(gen.value.invoiceId);
    expect(afterDelete.ok).toBe(false);
    if (!afterDelete.ok) expect(afterDelete.error.kind).toBe('not_found');

    // Regénère puis émet — une facture ÉMISE n'est plus supprimable (conflict).
    const gen2 = await client.generateInvoice({ quoteId, mode: 'final' });
    expect(gen2.ok).toBe(true);
    if (!gen2.ok) return;
    expect((await client.issueInvoice({ invoiceId: gen2.value.invoiceId })).ok).toBe(true);
    const conflict = await client.deleteDraftInvoice(gen2.value.invoiceId);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toEqual({ kind: 'conflict', entity: 'invoice', reason: 'Seule une facture brouillon peut être supprimée.' });
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
      contentBase64: '/9j/2Q==',
      mimeType: 'image/jpeg',
      filename: 'ticket.jpg',
      kind: 'expense_receipt',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-1',
      documentDate: '2026-06-01',
    });

    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    expect(uploaded.value.byteSize).toBe(4);
    expect(uploaded.value.sha256).toBe('32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af');

    const list = await client.listDocuments({ linkedEntityType: 'expense', linkedEntityId: 'exp-1' });
    expect(list.ok && list.value.map((d) => d.id)).toEqual([uploaded.value.id]);

    const url = await client.documentDownloadUrl(uploaded.value.id, 120);
    expect(url.ok).toBe(true);
    if (url.ok) {
      expect(url.value.url).toBe('data:image/jpeg;base64,/9j/2Q==');
      expect(url.value.expiresInSeconds).toBe(120);
    }
  });

  it('rejette un contenu dont la signature ne correspond pas au MIME annoncé', async () => {
    const uploaded = await makeClient().uploadDocument({
      contentBase64: 'AQID',
      mimeType: 'image/jpeg',
      filename: 'faux-ticket.jpg',
    });

    expect(uploaded).toMatchObject({
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'mimeType' }] },
    });
  });

  it('sert chaque original de démonstration avec une empreinte calculée sur ses octets', async () => {
    const client = makeClient();
    const documents = await client.listDocuments();
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;

    for (const document of documents.value) {
      const download = await client.documentDownloadUrl(document.id);
      expect(download.ok).toBe(true);
      if (!download.ok) continue;
      const contentBase64 = download.value.url.split(',', 2)[1] ?? '';
      const bytes = Buffer.from(contentBase64, 'base64');
      expect(bytes.byteLength).toBe(document.byteSize);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(document.sha256);
    }
  });

  it('rend des snapshots documentaires immuables aux appelants', async () => {
    const client = makeClient();
    const listed = await client.listDocuments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const before = listed.value.find((document) => document.id === 'seed-doc-leroy');
    expect(before).toBeDefined();
    if (!before) return;
    before.tags.push('injection-ui');

    const classified = await client.classifyDocument({
      documentId: before.id,
      linkedEntityType: 'expense',
      linkedEntityId: 'local-expense-leroy',
      expectedRevision: before.revision,
    });
    expect(classified.ok).toBe(true);
    expect(before.linkedEntityId).toBeNull();

    const after = await client.getDocument(before.id);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.linkedEntityId).toBe('local-expense-leroy');
      expect(after.value.tags).not.toContain('injection-ui');
    }
  });

  it('crée la dépense, son écriture et le lien document en un geste local rejouable', async () => {
    const client = makeClient();
    const folders = await client.listDocumentFolders({ parentId: null, limit: 100 });
    expect(folders.ok).toBe(true);
    if (!folders.ok) return;
    const purchases = folders.value.items.find((folder) => folder.systemKey === 'purchases');
    expect(purchases).toBeDefined();
    if (!purchases) return;
    const uploaded = await client.uploadDocument({
      contentBase64: '/9j/2Q==',
      mimeType: 'image/jpeg',
      filename: 'facture-atomique.jpg',
      kind: 'expense_receipt',
      documentDate: '2026-06-01',
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    const expensesBefore = await client.listExpenses();
    const entriesBefore = await client.listAccountingEntries();
    expect(expensesBefore.ok && entriesBefore.ok).toBe(true);
    if (!expensesBefore.ok || !entriesBefore.ok) return;
    const request = {
      documentId: uploaded.value.id,
      expectedRevision: uploaded.value.revision,
      targetFolderId: purchases.id,
      expense: {
        supplierName: 'Quincaillerie Test',
        documentDate: '2026-06-01',
        totalTtcCents: 1_200,
        totalHtCents: 1_000,
        vatCents: 200,
        vatRatePct: 20,
        category: 'fournitures' as const,
      },
    };

    const created = await client.recordDocumentExpense(request);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.document).toMatchObject({
      id: uploaded.value.id,
      folderId: purchases.id,
      linkedEntityType: 'expense',
      linkedEntityId: created.value.expenseId,
      revision: uploaded.value.revision + 2,
    });

    // Simule une réponse HTTP perdue : la révision d'origine reste acceptée uniquement parce
    // que le registre et le document prouvent que le même geste a déjà été commité.
    const replay = await client.recordDocumentExpense(request);
    expect(replay).toEqual(created);
    const expensesAfter = await client.listExpenses();
    const entriesAfter = await client.listAccountingEntries();
    expect(expensesAfter.ok && expensesAfter.value).toHaveLength(expensesBefore.value.length + 1);
    expect(entriesAfter.ok && entriesAfter.value).toHaveLength(entriesBefore.value.length + 1);

    const conflictingPayload = await client.recordDocumentExpense({
      ...request,
      expense: { ...request.expense, totalTtcCents: 1_201 },
    });
    expect(conflictingPayload).toMatchObject({ ok: false, error: { kind: 'conflict' } });
  });

  it('transfère les originaux via un plan opaque avant de supprimer un dossier personnalisé', async () => {
    const client = makeClient();
    const source = await client.createDocumentFolder({ name: 'Archives temporaires' });
    const target = await client.createDocumentFolder({ name: 'Archives définitives' });
    expect(source.ok && target.ok).toBe(true);
    if (!source.ok || !target.ok) return;
    const uploaded = await client.uploadDocument({
      contentBase64: '/9j/2Q==',
      mimeType: 'image/jpeg',
      filename: 'preuve.jpg',
      folderId: source.value.id,
    });
    expect(uploaded.ok).toBe(true);

    const preview = await client.previewDocumentFolderDeletion(source.value.id);
    expect(preview.ok && preview.value).toMatchObject({ documentCount: 1, canDeleteEmpty: false });
    if (!preview.ok) return;
    expect(preview.value).not.toHaveProperty('snapshot');
    const executed = await client.executeDocumentFolderDeletion({
      planId: preview.value.planId,
      strategy: {
        kind: 'transfer',
        targetFolderId: target.value.id,
        targetExpectedRevision: target.value.revision,
      },
    });
    expect(executed).toEqual({
      ok: true,
      value: { folderId: source.value.id, transferredDocuments: 1, transferredChildren: 0 },
    });
    const inTarget = await client.listDocuments({ folderId: target.value.id });
    expect(inTarget.ok && inTarget.value.map((document) => document.filename)).toEqual(['preuve.jpg']);
    const replay = await client.executeDocumentFolderDeletion({
      planId: preview.value.planId,
      strategy: { kind: 'empty' },
    });
    expect(replay.ok).toBe(false);
  });

  it('invalide le plan de suppression si un descendant apparaît après l’aperçu', async () => {
    const client = makeClient();
    const source = await client.createDocumentFolder({ name: 'Dossier source' });
    const target = await client.createDocumentFolder({ name: 'Dossier cible' });
    expect(source.ok && target.ok).toBe(true);
    if (!source.ok || !target.ok) return;
    const knownChild = await client.createDocumentFolder({ name: 'Connu', parentId: source.value.id });
    expect(knownChild.ok).toBe(true);

    const preview = await client.previewDocumentFolderDeletion(source.value.id);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const lateChild = await client.createDocumentFolder({
      name: 'Ajout concurrent',
      parentId: knownChild.ok ? knownChild.value.id : source.value.id,
    });
    expect(lateChild.ok).toBe(true);
    if (!lateChild.ok) return;
    const lateDocument = await client.uploadDocument({
      contentBase64: '/9j/2Q==',
      mimeType: 'image/jpeg',
      filename: 'ajout-concurrent.jpg',
      folderId: lateChild.value.id,
    });
    expect(lateDocument.ok).toBe(true);

    const executed = await client.executeDocumentFolderDeletion({
      planId: preview.value.planId,
      strategy: {
        kind: 'transfer',
        targetFolderId: target.value.id,
        targetExpectedRevision: target.value.revision,
      },
    });
    expect(executed).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect((await client.getDocumentFolder(source.value.id)).ok).toBe(true);
    expect((await client.getDocumentFolder(lateChild.value.id)).ok).toBe(true);
    const unmoved = await client.listDocuments({ folderId: lateChild.value.id });
    expect(unmoved.ok && unmoved.value.map((document) => document.id)).toEqual(
      lateDocument.ok ? [lateDocument.value.id] : [],
    );
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

    // Pièce réelle : devis signé -> facture émise F-2026-0003 (le seed occupe 0001-0002).
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Recherche fuite', category: 'labor', qty: 1, unitPriceHT: 12000, vatRate: 10 }],
      context: { housingOlderThan2y: true },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await client.sendQuote(created.value.quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId: created.value.quoteId, signerName: 'M. Martin' })).ok).toBe(true);
    const gen = await client.generateInvoice({ quoteId: created.value.quoteId, mode: 'final' });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    expect((await client.issueInvoice({ invoiceId: gen.value.invoiceId })).ok).toBe(true);

    // ask : action sensible -> TOUJOURS proposée (plancher comptable), même avec l'autonomie max locale.
    const asked = await client.askBob({ message: 'encaisse la facture F-2026-0003', autonomy: 'auto' });
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

    // journal : append-only, lisible via getRunJournal (ids déterministes -> on sonde les runs
    // candidats ; borne large — le seed consomme aussi des ids, dont les devis en attente ASK-1).
    const entries: JournalEntry[] = [];
    for (let n = 1; n <= 24; n += 1) {
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
      expectedRevision: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.linkedEntityId).toBe('local-expense-leroy');
    const linked = await client.listDocuments({ linkedEntityType: 'expense', linkedEntityId: 'local-expense-leroy' });
    expect(linked.ok && linked.value.map((d) => d.id)).toEqual(['seed-doc-leroy']);
  });

  it('refuse un document inconnu ou un rattachement vide', async () => {
    const client = makeClient();
    const missing = await client.classifyDocument({
      documentId: 'nope',
      linkedEntityType: 'expense',
      linkedEntityId: 'x',
      expectedRevision: 1,
    });
    expect(missing.ok).toBe(false);
    const incomplete = await client.classifyDocument({
      documentId: 'seed-doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: '  ',
      expectedRevision: 1,
    });
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

describe('LocalBobClient — C25 relances réelles + fil de notifications (adaptateur démo)', () => {
  /** Horloge mobile : la démo doit pouvoir « vieillir » une facture pour exercer le plan. */
  class MovableClock {
    constructor(public day: string) {}
    now(): string {
      return `${this.day}T09:00:00.000Z`;
    }
    today(): string {
      return this.day;
    }
  }

  it('sendRelance : refus avant échéance, envoi journalisé au ton du plan, dédup, lu/non-lu, device', async () => {
    const clock = new MovableClock('2026-06-01');
    const client = new LocalBobClient({ clock });
    const quote = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Intervention', category: 'labor', qty: 1, unitPriceHT: 50000, vatRate: 20 }],
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    await client.sendQuote(quote.value.quoteId);
    await client.signQuote({ quoteId: quote.value.quoteId, signerName: 'SARL Martin Rénovation' });
    const finale = await client.generateInvoice({ quoteId: quote.value.quoteId, mode: 'final' });
    expect(finale.ok).toBe(true);
    if (!finale.ok) return;
    await client.issueInvoice({ invoiceId: finale.value.invoiceId });

    // Pas encore échue (émise à J, échéance +30 j) : refus honnête, rien de journalisé.
    const early = await client.sendRelance(finale.value.invoiceId);
    expect(!early.ok && early.error.kind).toBe('validation');
    const emptyFeed = await client.listNotifications();
    expect(emptyFeed.ok && emptyFeed.value).toHaveLength(0);

    // 12 jours de retard → ton NEUTRE du plan @bob/core (J+10), journalisé dans le fil local.
    clock.day = '2026-07-13';
    const sent = await client.sendRelance(finale.value.invoiceId);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value).toMatchObject({ status: 'done', tone: 'neutre' });

    // Dédup quotidienne : même jobId, pas de doublon dans le fil.
    const again = await client.sendRelance(finale.value.invoiceId);
    expect(again.ok && again.value.jobId).toBe(sent.value.jobId);

    const feed = await client.listNotifications();
    expect(feed.ok).toBe(true);
    if (!feed.ok) return;
    expect(feed.value).toHaveLength(1);
    expect(feed.value[0]).toMatchObject({
      kind: 'invoice-relance',
      route: `/facture/${finale.value.invoiceId}`,
      status: 'done',
      readAt: null,
    });

    // L'aperçu fige une portée non paginée ; la commande atomique est idempotente.
    const preview = await client.previewUnreadNotifications();
    expect(preview.ok && preview.value).toEqual({
      unreadCount: 1,
      throughCreatedAt: '2026-07-13T09:00:00.001Z',
    });
    const allRead = await client.markNotificationsReadThrough({
      throughCreatedAt: preview.ok ? preview.value.throughCreatedAt : '',
    });
    expect(allRead.ok && allRead.value).toEqual({
      updatedCount: 1,
      readAt: '2026-07-13T09:00:00.000Z',
    });
    const replay = await client.markNotificationsReadThrough({
      throughCreatedAt: preview.ok ? preview.value.throughCreatedAt : '',
    });
    expect(replay.ok && replay.value.updatedCount).toBe(0);

    // Lecture individuelle idempotente après le batch, inconnu → not_found.
    const read = await client.markNotificationRead(feed.value[0]!.id);
    expect(read.ok && read.value.readAt).toBe('2026-07-13T09:00:00.000Z');
    const ghost = await client.markNotificationRead('notif-ghost');
    expect(!ghost.ok && ghost.error.kind).toBe('not_found');

    // Device push : enregistrement idempotent par token (aucun push sortant en démo).
    const d1 = await client.registerDevice({ expoPushToken: 'ExponentPushToken[demo]', platform: 'ios' });
    const d2 = await client.registerDevice({ expoPushToken: 'ExponentPushToken[demo]' });
    expect(d1.ok && d2.ok && d1.value.id === (d2.ok ? d2.value.id : '')).toBe(true);
  });
});

describe('C-EXP6b — réception e-facture (adaptateur démo, parité serveur)', () => {
  const MY_SIREN = '732829320'; // Mercier (seed)
  const SUPPLIER_SIREN = '552100554';

  const facturxData = (): FacturXInvoiceData => ({
    number: 'FC-2026-118',
    typeCode: '380',
    issueDate: '2026-06-20',
    dueDate: '2026-07-20',
    currency: 'EUR',
    seller: {
      name: 'Sanit Chauffe SAS',
      legalId: SUPPLIER_SIREN,
      address: { line1: '4 rue des Forges', postcode: '69007', city: 'Lyon', countryCode: 'FR' },
    },
    buyer: {
      name: 'Mercier Plomberie',
      legalId: MY_SIREN,
      address: { line1: '12 rue des Artisans', postcode: '92000', city: 'Nanterre', countryCode: 'FR' },
    },
    lines: [
      { id: '1', name: 'Chauffe-eau 200 L', qty: 1, unitCode: 'C62', unitPriceHTCents: 41000, netAmountCents: 41000, vatCategory: 'S', vatRatePct: 20 },
      { id: '2', name: 'Abonnement entretien', qty: 1, unitCode: 'C62', unitPriceHTCents: 6000, netAmountCents: 6000, vatCategory: 'S', vatRatePct: 10 },
    ],
    vatBreakdown: [
      { category: 'S', ratePct: 10, basisCents: 6000, vatCents: 600 },
      { category: 'S', ratePct: 20, basisCents: 41000, vatCents: 8200 },
    ],
    lineTotalHTCents: 47000,
    taxBasisTotalCents: 47000,
    taxTotalCents: 8800,
    grandTotalCents: 55800,
    prepaidCents: 0,
    duePayableCents: 55800,
  });

  const autoliquidationData = (): FacturXInvoiceData => ({
    number: 'ST-2026-007',
    typeCode: '380',
    issueDate: '2026-06-25',
    currency: 'EUR',
    seller: {
      name: 'Bâti Sous-Traitance SARL',
      legalId: SUPPLIER_SIREN,
      address: { line1: '9 rue Haute', postcode: '59000', city: 'Lille', countryCode: 'FR' },
    },
    buyer: {
      name: 'Mercier Plomberie',
      legalId: MY_SIREN,
      address: { line1: '12 rue des Artisans', postcode: '92000', city: 'Nanterre', countryCode: 'FR' },
    },
    lines: [
      { id: '1', name: 'Sous-traitance pose réseau cuivre', qty: 1, unitCode: 'C62', unitPriceHTCents: 100000, netAmountCents: 100000, vatCategory: 'AE', vatRatePct: 0 },
    ],
    vatBreakdown: [
      { category: 'AE', ratePct: 0, basisCents: 100000, vatCents: 0, exemptionReason: 'Autoliquidation, art. 283-2 nonies CGI' },
    ],
    lineTotalHTCents: 100000,
    taxBasisTotalCents: 100000,
    taxTotalCents: 0,
    grandTotalCents: 100000,
    prepaidCents: 0,
    duePayableCents: 100000,
  });

  it('import → brouillon (multi-taux au centime, BT-9 → dueAt) puis APPROVE → dépense + écritures E1 + XML archivé, réimport = doublon', async () => {
    const client = new LocalBobClient({ clock: new FixtureClock('2026-07-01') });
    const xml = buildFacturXBasicXml(facturxData());

    const review = await client.importFacturXExpense({ xml });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.controls).toEqual(['destinataire', 'coherence_en16931', 'doublon']);
    expect(review.value.draft).toMatchObject({
      supplierSiren: SUPPLIER_SIREN,
      supplierInvoiceNumber: 'FC-2026-118',
      dueAt: '2026-07-20',
      vatCents: 8800, // somme exacte 600 + 8200
      vatRatePct: null,
      vatNonDeductible: false,
      source: 'facturx',
    });

    const outcome = await client.confirmFacturXExpense({ xml, decision: { action: 'approve', category: 'materiel' } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.value.status !== 'approved') return;
    const expenseId = outcome.value.expenseId;

    const expenses = await client.listExpenses();
    expect(expenses.ok).toBe(true);
    if (!expenses.ok) return;
    expect(expenses.value.find((e) => e.id === expenseId)).toMatchObject({
      supplierInvoiceNumber: 'FC-2026-118',
      dueAt: '2026-07-20',
      category: 'materiel',
      source: 'facturx',
      totalTtcCents: 55800,
      vatCents: 8800,
    });

    // Écritures du cycle achats parties AUTOMATIQUEMENT (E1) : 6xx / 44566 / 401.
    const entries = await client.listAccountingEntries();
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    const purchase = entries.value.find((e) => e.id === `expense:${expenseId}:recorded`);
    expect(purchase?.lines).toEqual([
      expect.objectContaining({ account: '606', debitCents: 47000, creditCents: 0 }),
      expect.objectContaining({ account: '44566', debitCents: 8800, creditCents: 0 }),
      expect.objectContaining({ account: '401', debitCents: 0, creditCents: 55800 }),
    ]);

    // XML archivé au coffre local, lié à l'Expense (kind facturx_xml).
    const docs = await client.listDocuments({ kind: 'facturx_xml', linkedEntityType: 'expense', linkedEntityId: expenseId });
    expect(docs.ok).toBe(true);
    if (!docs.ok) return;
    expect(docs.value).toHaveLength(1);
    expect(docs.value[0]?.id).toBe(outcome.value.xmlDocumentId);

    // Réimporter LA MÊME facture = doublon (anti double-paiement) — contrôle bloquant.
    const again = await client.importFacturXExpense({ xml });
    expect(again.ok).toBe(false);
    if (!again.ok && again.error.kind === 'validation') {
      expect(again.error.issues[0]?.field).toBe('facturx.doublon');
    }
  });

  it('AUTOLIQUIDATION approuvée → ZÉRO 44566 ; refus sans motif impossible ; mal adressée bloquée avec les 2 SIREN', async () => {
    const client = new LocalBobClient({ clock: new FixtureClock('2026-07-01') });

    // Autoliquidation : TVA non déductible, catégorie sous-traitance proposée, zéro 44566 posté.
    const aeXml = buildFacturXBasicXml(autoliquidationData());
    const aeReview = await client.importFacturXExpense({ xml: aeXml });
    expect(aeReview.ok).toBe(true);
    if (!aeReview.ok) return;
    expect(aeReview.value.draft.vatNonDeductible).toBe(true);
    expect(aeReview.value.draft.categoryGuess).toBe('sous_traitance');
    const aeOutcome = await client.confirmFacturXExpense({ xml: aeXml, decision: { action: 'approve' } });
    expect(aeOutcome.ok).toBe(true);
    if (!aeOutcome.ok || aeOutcome.value.status !== 'approved') return;
    const aeExpenseId = aeOutcome.value.expenseId;
    const entries = await client.listAccountingEntries();
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    const purchase = entries.value.find((e) => e.id === `expense:${aeExpenseId}:recorded`);
    expect(purchase).toBeDefined();
    expect(purchase?.lines.some((l) => l.account === '44566')).toBe(false); // le piège P21 neutralisé

    // Refus sans motif = IMPOSSIBLE (machine InboundEinvoice).
    const sansMotif = await client.confirmFacturXExpense({
      xml: aeXml,
      decision: { action: 'refuse', afnorStatus: 210, reason: '  ' },
    });
    expect(sansMotif.ok).toBe(false);
    if (!sansMotif.ok) expect(sansMotif.error.kind).toBe('domain');

    // Mal adressée : import bloqué (les 2 SIREN dans le message), mais le REFUS 210 reste possible.
    const wrong = facturxData();
    wrong.buyer = { ...wrong.buyer, legalId: '900123456' };
    const wrongXml = buildFacturXBasicXml(wrong);
    const blocked = await client.importFacturXExpense({ xml: wrongXml });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok && blocked.error.kind === 'validation') {
      expect(blocked.error.issues[0]?.field).toBe('facturx.mal_adressee');
      expect(blocked.error.issues[0]?.message).toContain('900123456');
      expect(blocked.error.issues[0]?.message).toContain(MY_SIREN);
    }
    const refused = await client.confirmFacturXExpense({
      xml: wrongXml,
      decision: { action: 'refuse', afnorStatus: 210, reason: 'Facture mal adressée : SIREN acheteur ≠ ma société.' },
    });
    expect(refused.ok).toBe(true);
    if (refused.ok && refused.value.status === 'refused') {
      expect(refused.value.afnorStatus).toBe(210);
      expect(refused.value.invoiceKey).toBe(`${SUPPLIER_SIREN}|FC-2026-118`);
    }
  });
});
