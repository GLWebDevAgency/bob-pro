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
    const persisted = await client.getCompanyMe();
    expect(persisted.ok && persisted.value.name).toBe('Mercier Plomberie');

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

  it('C24b : un retry local après clôture reste refusé et ne ressuscite jamais la société', async () => {
    const client = makeClient();
    const closed = await client.closeAccount({ confirmationText: 'Mercier Plomberie' });
    expect(closed.ok).toBe(true);

    const retried = await client.registerCompany({
      name: 'Société réouverte',
      legalForm: 'EI',
      siren: '732829320',
      siret: '73282932000074',
      trade: 'electricien',
      vatRegime: 'franchise',
      address: { line1: '4 rue du Forgeron', zip: '92310', city: 'Sèvres' },
    });

    expect(retried).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
    const persisted = await client.getCompanyMe();
    expect(persisted.ok && persisted.value.closedAt).toBeTruthy();
    expect(persisted.ok && persisted.value.name).toBe('Mercier Plomberie');

    const profile = await client.updateCompanyProfile({
      trade: 'electricien',
      vatRegime: 'reel_simpl',
    });
    const billing = await client.updateCompanyBilling({
      iban: 'FR7630006000011234567890189',
    });
    const legal = await client.updateCompanyLegal({
      mediateurConso: { nom: 'CM2C', coordonnees: 'cm2c.net' },
    });
    const settings = await client.updateCompanyBillingSettings({
      expectedRevision: 1,
      patch: { defaultDepositPercent: 42 },
    });
    for (const mutation of [profile, billing, legal, settings]) {
      expect(mutation).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
    }
  });

  it('A2/A6 (adaptateur démo) : médiateur conso écrit/effacé, capital refusé pour l’EI seedée', async () => {
    const client = makeClient();

    const written = await client.updateCompanyLegal({
      mediateurConso: { nom: 'CM2C', coordonnees: '14 rue Saint-Jean, 75017 Paris — cm2c.net' },
    });
    expect(written.ok && written.value.mediateurConso?.nom).toBe('CM2C');
    const reread = await client.getCompanyMe();
    expect(reread.ok && reread.value.mediateurConso?.coordonnees).toBe(
      '14 rue Saint-Jean, 75017 Paris — cm2c.net',
    );

    // A6 fail-closed : Mercier Plomberie est une EI — pas de capital social hors société
    // (art. R123-238 c. com. ne vise que les sociétés). Mêmes règles que le serveur.
    const rejected = await client.updateCompanyLegal({ capitalSocialCents: 500_000 });
    expect(rejected).toMatchObject({ ok: false, error: { kind: 'domain' } });

    // Effacement explicite (null) ; un champ omis reste inchangé.
    const erased = await client.updateCompanyLegal({ mediateurConso: null });
    expect(erased.ok && erased.value.mediateurConso).toBeUndefined();

    const vat = await client.updateCompanyLegal({ tvaIntracom: ' fr44 732829320 ' });
    expect(vat.ok && vat.value.tvaIntracom).toBe('FR44732829320');
  });

  it('A7 (adaptateur démo) : période de prestation + adresse de chantier figées à l’émission', async () => {
    const client = makeClient();
    const quotes = await client.listQuotes();
    expect(quotes.ok).toBe(true);
    if (!quotes.ok) return;
    const signed = quotes.value.find((quote) => quote.status === 'signed');
    expect(signed).toBeTruthy();
    if (!signed) return;

    const generated = await client.generateInvoice({ quoteId: signed.id, mode: 'final' });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const issued = await client.issueInvoice({
      invoiceId: generated.value.invoiceId,
      servicePeriod: { start: '2026-06-02', end: '2026-06-13' },
      deliveryAddress: 'Chantier — 8 allée des Roses, 92190 Meudon',
    });
    expect(issued.ok).toBe(true);
  });

  it('BT-23 local vertical : question → choix manuel/voix → proposition → émission réelle', async () => {
    const client = makeClient();
    const quotes = await client.listQuotes();
    expect(quotes.ok).toBe(true);
    if (!quotes.ok) return;
    const mixedSigned = quotes.value.find((quote) =>
      quote.status === 'signed'
      && quote.lines.some((line) => line.category === 'supply')
      && quote.lines.some((line) => line.category === 'labor'));
    expect(mixedSigned).toBeTruthy();
    if (!mixedSigned) return;
    const generated = await client.generateInvoice({ quoteId: mixedSigned.id, mode: 'final' });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const question = await client.askBob({
      message: `Émets la facture ${generated.value.invoiceId}`,
    });
    expect(question.ok && question.value.kind).toBe('answer');
    expect(question.ok && question.value.ask?.[0]?.id).toBe(
      'emettre_facture.operationCategory',
    );
    const followUp = question.ok ? question.value.ask?.[0]?.options[0]?.followUp : undefined;
    expect(followUp).toBeTruthy();
    if (!followUp) return;

    const proposal = await client.askBob({ message: followUp });
    expect(proposal.ok && proposal.value.kind).toBe('proposed');
    expect(proposal.ok && proposal.value.pending?.args).toMatchObject({
      invoiceId: generated.value.invoiceId,
      operationCategory: 'services',
    });
    if (!proposal.ok || !proposal.value.pending) return;

    const confirmed = await client.confirmBob(proposal.value.pending);
    expect(confirmed.ok && confirmed.value.kind).toBe('done');
    const invoices = await client.listInvoices();
    expect(invoices.ok).toBe(true);
    expect(
      invoices.ok
        ? invoices.value.find((invoice) => invoice.id === generated.value.invoiceId)?.status
        : null,
    ).toBe('issued');
  });

  it('DELETE /account (démo) : confirmationText EXACT (nom de la société seedée) → clôture, mêmes règles que le serveur', async () => {
    const client = makeClient();
    const r = await client.closeAccount({ confirmationText: 'Mercier Plomberie' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.value.closedAt).toBe('string');
  });

  it('DELETE /account (démo) : confirmationText erroné → AppError validation, jamais de clôture', async () => {
    const client = makeClient();
    const r = await client.closeAccount({ confirmationText: 'pas le bon nom' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('validation');
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

  it('rejoue localement une facture émise après suppression des conditions courantes', async () => {
    const client = makeClient();
    const invoices = await client.listInvoices();
    expect(invoices.ok).toBe(true);
    if (!invoices.ok) return;
    const issued = invoices.value.find((invoice) => invoice.number !== null);
    expect(issued?.number).toBeTruthy();
    if (!issued?.number) return;

    const settings = await client.getCompanyBillingSettings();
    expect(settings.ok).toBe(true);
    if (!settings.ok) return;
    const cleared = await client.updateCompanyBillingSettings({
      expectedRevision: settings.value.revision,
      patch: { defaultInvoicePaymentTermsDays: null },
    });
    expect(cleared.ok).toBe(true);

    await expect(client.issueInvoice({ invoiceId: issued.id })).resolves.toEqual({
      ok: true,
      value: { number: issued.number },
    });
  });

  it('BOB EXPERT FISCAL (Phase 1A) : getFiscalProfile dérive EI/plombier → réel IR (hypothèse) + TNS (certitude juridique)', async () => {
    const client = makeClient();
    const r = await client.getFiscalProfile();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.companyId).toBe(client.companyId);
    expect(r.value.legalForm).toMatchObject({ status: 'source_fiable', value: 'EI', source: 'insee_siret' });
    expect(r.value.taxRegime).toMatchObject({ status: 'hypothese', value: 'reel_ir' });
    // TNS en SOURCE_FIABLE, pas en hypothèse : l'entrepreneur individuel est TOUJOURS travailleur
    // indépendant (art. L611-1/L613-1 CSS) — certitude juridique dérivée de la forme
    // (buildInitialFiscalProfile, @bob/core), même statut que la dérivation testée côté core.
    expect(r.value.socialStatus).toMatchObject({ status: 'source_fiable', value: 'tns', source: 'derived_legal_form' });

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

  it('déroule le flux Devis -> facture finale -> paiement hors-ligne', async () => {
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

    // Le profil Factur-X EN16931 ne sait pas reprendre un acompte professionnel sans le profil
    // Extended : le flux générique certifié utilise donc ici la finale, sans contourner la garde.
    const gen = await client.generateInvoice({ quoteId, mode: 'final' });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const draftPreview = await client.invoiceAccountingPreview(gen.value.invoiceId);
    expect(draftPreview.ok && draftPreview.value.available).toBe(true);
    if (!draftPreview.ok || !draftPreview.value.available) return;
    expect(draftPreview.value.reference).toBe('a-emettre');
    expect(draftPreview.value.lines.map((line) => line.account)).toEqual(['411', '707', '706', '44571']);

    const issued = await client.issueInvoice({
      invoiceId: gen.value.invoiceId,
      operationCategory: 'services',
    });
    // Le seed démo n'invente plus d'acompte professionnel incompatible avec le profil Standard :
    // seule la mairie occupe 0001, la numérotation sans trou continue donc à 0002.
    expect(issued.ok && issued.value.number).toBe('F-2026-0002');

    const preview = await client.invoiceAccountingPreview(gen.value.invoiceId);
    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.value.available) return;
    expect(preview.value.available).toBe(true);
    expect(preview.value.totalDebitCents).toBe(162800);
    expect(preview.value.totalCreditCents).toBe(162800);
    expect(preview.value.lines.map((line) => line.account)).toEqual(['411', '707', '706', '44571']);

    const entries = await client.listAccountingEntries();
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    // Le seed démo (C16) porte sa propre écriture : on cible celle du flux du test.
    const entry = entries.value.find((e) => e.sourceId === gen.value.invoiceId);
    expect(entry).toBeDefined();
    expect(entry?.lines.map((line) => line.account)).toEqual(['411', '707', '706', '44571']);

    const paid = await client.registerPayment({
      invoiceId: gen.value.invoiceId,
      amount: 162800,
      method: 'transfer',
      idempotencyKey: 'test:payment:final',
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
      amount: 162800,
      method: 'transfer',
      idempotencyKey: 'test:payment:final',
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
    // Le FEC embarque AUSSI les écritures du seed démo : facture échue 0001 (mairie) et le
    // cycle achats (4 achats AC + 2 décaissements BQ des dépenses justifiées — la ligne
    // HISTORIQUE Brico Dépôt reste sans décaissement tant qu'elle n'est pas régularisée).
    // L'ancien acompte B2B de démonstration a disparu : le seed ne contourne plus le plancher
    // Factur-X Standard. Avec la facture finale du test : 9 écritures, 25 lignes réelles.
    expect(fec.value.entryCount).toBe(9);
    expect(fec.value.rowCount).toBe(25);
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
    expect((await client.issueInvoice({
      invoiceId: gen.value.invoiceId,
      operationCategory: 'services',
    })).ok).toBe(true);

    const preview = await client.paymentAccountingPreview({
      invoiceId: gen.value.invoiceId,
      amountCents: 13200,
      method: 'cash',
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.value.available) return;
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

  it('renomme le libellé d’affichage avec révision optimiste, sans toucher au filename d’archive', async () => {
    const client = makeClient();
    const before = await client.getDocument('seed-doc-leroy');
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.displayName).toBe(before.value.filename);

    const renamed = await client.renameDocument({
      documentId: before.value.id,
      displayName: 'Reçu Leroy Merlin — 184,90 €',
      expectedRevision: before.value.revision,
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.displayName).toBe('Reçu Leroy Merlin — 184,90 €');
    expect(renamed.value.filename).toBe(before.value.filename);
    expect(renamed.value.revision).toBe(before.value.revision + 1);

    // Révision périmée ⇒ conflit (parité serveur), et le libellé courant reste inchangé.
    const stale = await client.renameDocument({
      documentId: before.value.id,
      displayName: 'Autre nom',
      expectedRevision: before.value.revision,
    });
    expect(stale).toMatchObject({ ok: false, error: { kind: 'conflict' } });

    // Libellé identique ⇒ idempotent, aucune révision brûlée.
    const unchanged = await client.renameDocument({
      documentId: before.value.id,
      displayName: 'Reçu Leroy Merlin — 184,90 €',
      expectedRevision: renamed.value.revision,
    });
    expect(unchanged.ok).toBe(true);
    if (unchanged.ok) expect(unchanged.value.revision).toBe(renamed.value.revision);
  });

  it('acknowledgeDocument : pose reviewedAt SANS déplacer ni lier, latch idempotent (parité serveur)', async () => {
    const client = makeClient();
    const before = await client.getDocument('seed-doc-leroy');
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    // Ligne jamais validée : le scan seul ne vaut pas confirmation.
    expect(before.value.reviewedAt).toBeNull();

    const acknowledged = await client.acknowledgeDocument({
      documentId: before.value.id,
      expectedRevision: before.value.revision,
    });
    expect(acknowledged.ok).toBe(true);
    if (!acknowledged.ok) return;
    // Seule la confirmation change : ni rangement, ni lien métier, ni archive.
    expect(acknowledged.value).toMatchObject({
      id: before.value.id,
      folderId: before.value.folderId,
      linkedEntityType: before.value.linkedEntityType,
      filename: before.value.filename,
      revision: before.value.revision + 1,
    });
    expect(acknowledged.value.reviewedAt).not.toBeNull();

    // Latch : re-valider ne réécrit rien — même horodatage, même révision.
    const replay = await client.acknowledgeDocument({
      documentId: before.value.id,
      expectedRevision: acknowledged.value.revision,
    });
    expect(replay.ok && replay.value.reviewedAt).toBe(acknowledged.value.reviewedAt);
    expect(replay.ok && replay.value.revision).toBe(acknowledged.value.revision);

    // Révision périmée ⇒ conflit explicite (parité serveur).
    const stale = await client.acknowledgeDocument({
      documentId: before.value.id,
      expectedRevision: before.value.revision,
    });
    expect(stale).toMatchObject({ ok: false, error: { kind: 'conflict' } });
  });

  it('ranger vaut validation humaine (latch), sortir d’un dossier n’invalide jamais (parité core)', async () => {
    const client = makeClient();
    const folders = await client.listDocumentFolders({ parentId: null, limit: 100 });
    const purchases = folders.ok
      ? folders.value.items.find((folder) => folder.systemKey === 'purchases')
      : undefined;
    expect(purchases).toBeDefined();
    if (!purchases) return;
    const before = await client.getDocument('seed-doc-leroy');
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.reviewedAt).toBeNull();

    // Ranger DANS un dossier : déplacement (+1) + validation posée par le geste (+1).
    const moved = await client.moveDocumentToFolder({
      documentId: before.value.id,
      folderId: purchases.id,
      expectedRevision: before.value.revision,
    });
    expect(moved.ok && moved.value.revision).toBe(before.value.revision + 2);
    const confirmed = await client.getDocument(before.value.id);
    expect(confirmed.ok && confirmed.value.reviewedAt).not.toBeNull();
    if (!confirmed.ok) return;

    // Sortir du dossier n'est PAS un classement : la confirmation reste intacte.
    const movedOut = await client.moveDocumentToFolder({
      documentId: before.value.id,
      folderId: null,
      expectedRevision: confirmed.value.revision,
    });
    expect(movedOut.ok && movedOut.value.revision).toBe(confirmed.value.revision + 1);
    const afterOut = await client.getDocument(before.value.id);
    expect(afterOut.ok && afterOut.value.reviewedAt).toBe(confirmed.value.reviewedAt);
    if (!afterOut.ok) return;

    // Re-ranger un document déjà validé : +1 seulement, le latch n'est jamais réécrit.
    const movedBack = await client.moveDocumentToFolder({
      documentId: before.value.id,
      folderId: purchases.id,
      expectedRevision: afterOut.value.revision,
    });
    expect(movedBack.ok && movedBack.value.revision).toBe(afterOut.value.revision + 1);
    const afterBack = await client.getDocument(before.value.id);
    expect(afterBack.ok && afterBack.value.reviewedAt).toBe(confirmed.value.reviewedAt);
  });

  it('getDocument rend le MÊME shape enrichi que la liste (parité GET /documents/:id serveur)', async () => {
    const client = makeClient();
    const bare = await client.getDocument('seed-doc-leroy');
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    // Pas encore analysé : résumés null, jamais inventés.
    expect(bare.value.analysis).toBeNull();
    expect(bare.value.extraction).toBeNull();

    const analyzed = await client.analyzeDocument('seed-doc-leroy');
    expect(analyzed.ok).toBe(true);
    if (!analyzed.ok) return;
    const enriched = await client.getDocument('seed-doc-leroy');
    expect(enriched.ok).toBe(true);
    if (!enriched.ok) return;
    expect(enriched.value.analysis).toEqual({
      type: analyzed.value.type,
      typeConfidence: analyzed.value.typeConfidence,
      suggestedDisplayName: analyzed.value.suggestedDisplayName,
      suggestedDestination: analyzed.value.suggestedDestination,
      requiresHumanReview: analyzed.value.requiresHumanReview,
      // La carte du détail = la carte du scan : résumé, #tags et warnings persistés.
      summary: analyzed.value.summary,
      suggestedTags: analyzed.value.suggestedTags,
      warnings: analyzed.value.warnings,
    });

    // Parité stricte item de liste ↔ lecture unitaire.
    const list = await client.listDocuments();
    const item = list.ok ? list.value.find((document) => document.id === 'seed-doc-leroy') : undefined;
    expect(item).toEqual(enriched.value);
  });

  it('LOT 3 — applique suggestedDisplayName au record si le libellé vaut encore le filename, jamais sur un renommage humain', async () => {
    const client = makeClient();
    const folders = await client.listDocumentFolders({ parentId: null, limit: 100 });
    const purchases = folders.ok
      ? folders.value.items.find((folder) => folder.systemKey === 'purchases')
      : undefined;
    expect(purchases).toBeDefined();
    if (!purchases) return;

    // ① displayName encore = filename ⇒ la suggestion de l'analyse EN CACHE s'applique.
    const analyzed = await client.analyzeDocument('seed-doc-leroy');
    expect(analyzed.ok).toBe(true);
    if (!analyzed.ok) return;
    const before = await client.getDocument('seed-doc-leroy');
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.displayName).toBe(before.value.filename);
    expect(analyzed.value.suggestedDisplayName).not.toBe(before.value.displayName);
    const recorded = await client.recordDocumentExpense({
      documentId: before.value.id,
      expectedRevision: before.value.revision,
      targetFolderId: purchases.id,
      expense: {
        supplierName: 'Leroy Merlin',
        documentDate: '2026-06-01',
        totalTtcCents: 18_490,
        category: 'fournitures' as const,
      },
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    // move(+1) + validation(+1) + classify(+1) + nom intelligent (+1) — parité serveur.
    expect(recorded.value.document).toMatchObject({
      displayName: analyzed.value.suggestedDisplayName,
      filename: before.value.filename, // l'archive reste IMMUABLE
      revision: before.value.revision + 4,
    });

    // ② un renommage HUMAIN antérieur n'est JAMAIS écrasé par la suggestion.
    const analyzedSecond = await client.analyzeDocument('seed-doc-f104');
    expect(analyzedSecond.ok).toBe(true);
    const second = await client.getDocument('seed-doc-f104');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const humanRename = await client.renameDocument({
      documentId: second.value.id,
      displayName: 'Mon reçu perso',
      expectedRevision: second.value.revision,
    });
    expect(humanRename.ok).toBe(true);
    if (!humanRename.ok) return;
    const recordedSecond = await client.recordDocumentExpense({
      documentId: second.value.id,
      expectedRevision: humanRename.value.revision,
      targetFolderId: purchases.id,
      expense: {
        supplierName: 'Cedeo',
        documentDate: '2026-06-01',
        totalTtcCents: 22_000,
        category: 'fournitures' as const,
      },
    });
    expect(recordedSecond.ok).toBe(true);
    if (!recordedSecond.ok) return;
    expect(recordedSecond.value.document.displayName).toBe('Mon reçu perso');
  });

  it('embarque le résumé d’analyse dans la liste après analyzeDocument (parité cache serveur)', async () => {
    const client = makeClient();
    const initial = await client.listDocuments();
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const pending = initial.value.find((document) => document.id === 'seed-doc-leroy');
    // Avant analyse : aucun résumé inventé.
    expect(pending?.analysis).toBeNull();
    expect(pending?.extraction).toBeNull();

    const analyzed = await client.analyzeDocument('seed-doc-leroy');
    expect(analyzed.ok).toBe(true);
    if (!analyzed.ok) return;

    const enriched = await client.listDocuments();
    expect(enriched.ok).toBe(true);
    if (!enriched.ok) return;
    const item = enriched.value.find((document) => document.id === 'seed-doc-leroy');
    expect(item?.analysis).toEqual({
      type: analyzed.value.type,
      typeConfidence: analyzed.value.typeConfidence,
      suggestedDisplayName: analyzed.value.suggestedDisplayName,
      suggestedDestination: analyzed.value.suggestedDestination,
      requiresHumanReview: analyzed.value.requiresHumanReview,
      // Parité cache serveur : le résumé persisté porte aussi résumé/#tags/warnings.
      summary: analyzed.value.summary,
      suggestedTags: analyzed.value.suggestedTags,
      warnings: analyzed.value.warnings,
    });
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
    // +3 : rangement (+1), validation humaine posée par le geste (reviewedAt, +1), lien (+1).
    expect(created.value.document).toMatchObject({
      id: uploaded.value.id,
      folderId: purchases.id,
      linkedEntityType: 'expense',
      linkedEntityId: created.value.expenseId,
      revision: uploaded.value.revision + 3,
    });
    expect(created.value.document.reviewedAt).not.toBeNull();

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

  it('ticket déjà payé : dépense locale PAYÉE d’emblée, le scan devient la preuve (autorité adaptateur)', async () => {
    const client = makeClient();
    const folders = await client.listDocumentFolders({ parentId: null, limit: 100 });
    expect(folders.ok).toBe(true);
    if (!folders.ok) return;
    const purchases = folders.value.items.find((folder) => folder.systemKey === 'purchases');
    if (!purchases) return;
    const uploaded = await client.uploadDocument({
      contentBase64: '/9j/4AAQSkZJRg==',
      mimeType: 'image/jpeg',
      filename: 'ticket-leroy-merlin.jpg',
      kind: 'expense_receipt',
      documentDate: '2026-06-01',
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const created = await client.recordDocumentExpense({
      documentId: uploaded.value.id,
      expectedRevision: uploaded.value.revision,
      targetFolderId: purchases.id,
      expense: {
        supplierName: 'Leroy Merlin',
        documentDate: '2026-06-01',
        totalTtcCents: 18_490,
        category: 'fournitures' as const,
        // Le client ne déclare QUE date + moyen : la preuve est imposée par l'adaptateur.
        payment: { paidOn: '2026-06-01', method: 'card' as const },
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const expenses = await client.listExpenses();
    expect(expenses.ok).toBe(true);
    if (!expenses.ok) return;
    const paid = expenses.value.find((expense) => expense.id === created.value.expenseId);
    // Badge « Payée » + preuve liée : AUCUN bouton Payer possible sur cette ligne.
    expect(paid).toMatchObject({
      status: 'paid',
      paymentEvidence: {
        paidOn: '2026-06-01',
        method: 'card',
        reference: null,
        proofDocumentId: uploaded.value.id,
      },
    });
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
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const list = await client.listCustomers();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(7);
    expect(list.value.find((c) => c.id === created.value.id)).toMatchObject({ name: 'Mme Nguyen', type: 'b2c' });
  });

  it('ne porte aucune métrique synthétique sur une nouvelle fiche', async () => {
    const client = makeClient();
    const created = await client.createCustomer({
      name: 'M. Sans historique',
      type: 'b2c',
      address: { line1: '', zip: '', city: '' },
    });
    expect(created.ok).toBe(true);
    const list = await client.listCustomers();
    expect(list.ok).toBe(true);
    if (!list.ok || !created.ok) return;
    expect(list.value.find((entry) => entry.id === created.value.id)).toMatchObject({
      score: null,
      scoreBand: null,
      outstandingCents: 0,
      avgDelayDays: null,
      paymentHistoryStatus: 'insufficient_history',
    });
  });

  it('édite une fiche post-création (C13/C40 TODO partagé) — complète adresse/SIREN/contact', async () => {
    const client = makeClient();
    const created = await client.createCustomer({
      name: 'Mme Petit',
      type: 'b2c',
      address: { line1: '', zip: '', city: '' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await client.updateCustomer(created.value.id, {
      name: 'SARL Petit & Fils',
      type: 'b2b',
      siren: '732829320',
      tvaIntracom: 'FR44732829320',
      contactName: 'Mme Petit',
      email: 'contact@petit.fr',
      address: { line1: '4 rue du Test', zip: '75001', city: 'Paris' },
    });
    expect(updated.ok).toBe(true);

    const list = await client.listCustomers();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.find((c) => c.id === created.value.id)).toMatchObject({
      name: 'SARL Petit & Fils',
      type: 'b2b',
      siren: '732829320',
      tvaIntracom: 'FR44732829320',
      contactName: 'Mme Petit',
      address: { line1: '4 rue du Test', zip: '75001', city: 'Paris' },
    });
  });

  it('refuse d’éditer une fiche introuvable', async () => {
    const client = makeClient();
    const r = await client.updateCustomer('ghost', {
      name: 'Fantôme',
      type: 'b2c',
      address: { line1: '', zip: '', city: '' },
    });
    expect(r.ok).toBe(false);
  });

  it('crée un chantier rattaché au client, avec adresse et note (fiche client — onglet Chantiers)', async () => {
    const client = makeClient();
    const created = await client.createCustomer({
      name: 'M. Terrain',
      type: 'b2c',
      address: { line1: '8 rue Haute', zip: '69001', city: 'Lyon' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const chantier = await client.createChantier({
      name: 'Rénovation cuisine',
      customerId: created.value.id,
      address: '8 rue Haute, 69001 Lyon',
      notes: 'Code portail 1234, chien dans le jardin.',
    });
    expect(chantier.ok).toBe(true);

    const list = await client.listChantiers();
    expect(list.ok).toBe(true);
    if (!list.ok || !chantier.ok) return;
    expect(list.value.find((c) => c.id === chantier.value.id)).toMatchObject({
      name: 'Rénovation cuisine',
      customerId: created.value.id,
      notes: 'Code portail 1234, chien dans le jardin.',
    });
  });

  it('fiche chantier — journal de notes horodatées et photos (grille de vignettes, extension V1)', async () => {
    const client = makeClient();
    const chantier = await client.createChantier({ name: 'Villa Durand' });
    expect(chantier.ok).toBe(true);
    if (!chantier.ok) return;

    const note = await client.addChantierNote(chantier.value.id, {
      text: 'Fuite réparée, reste le joint du ballon.',
    });
    expect(note.ok).toBe(true);

    const notes = await client.listChantierNotes(chantier.value.id);
    expect(notes.ok).toBe(true);
    if (!notes.ok) return;
    expect(notes.value).toHaveLength(1);
    expect(notes.value[0]).toMatchObject({ text: 'Fuite réparée, reste le joint du ballon.' });
    expect(typeof notes.value[0]?.authorLabel).toBe('string');

    const photo = await client.uploadWorksitePhoto(chantier.value.id, {
      contentBase64: Buffer.from('fake-jpeg-bytes').toString('base64'),
      mimeType: 'image/jpeg',
      filename: 'chantier.jpg',
    });
    expect(photo.ok).toBe(true);
    if (!photo.ok) return;

    const photos = await client.listWorksitePhotos(chantier.value.id);
    expect(photos.ok).toBe(true);
    if (!photos.ok) return;
    expect(photos.value).toHaveLength(1);
    expect(photos.value[0]?.id).toBe(photo.value.id);

    const viewUrl = await client.worksitePhotoViewUrl(photo.value.id);
    expect(viewUrl.ok).toBe(true);
    if (viewUrl.ok) expect(viewUrl.value.url).toMatch(/^data:image\/jpeg;base64,/);

    // Compteurs de rangée (liste des chantiers) : 1 note + 1 photo à ce stade.
    const listWithCounts = await client.listChantiers();
    expect(listWithCounts.ok).toBe(true);
    if (listWithCounts.ok) {
      expect(listWithCounts.value.find((c) => c.id === chantier.value.id)).toMatchObject({
        noteCount: 1,
        photoCount: 1,
      });
    }

    const deleted = await client.deleteWorksitePhoto(photo.value.id);
    expect(deleted.ok).toBe(true);
    const photosAfter = await client.listWorksitePhotos(chantier.value.id);
    expect(photosAfter.ok && photosAfter.value).toEqual([]);

    // La photo supprimée sort du compteur ; la note reste (append-only, jamais supprimée).
    const listAfterDelete = await client.listChantiers();
    expect(listAfterDelete.ok).toBe(true);
    if (listAfterDelete.ok) {
      expect(listAfterDelete.value.find((c) => c.id === chantier.value.id)).toMatchObject({
        noteCount: 1,
        photoCount: 0,
      });
    }
  });

  it('refuse une note ou une photo sur un chantier introuvable', async () => {
    const client = makeClient();
    const note = await client.addChantierNote('ghost', { text: 'x' });
    expect(note.ok).toBe(false);
    const photo = await client.uploadWorksitePhoto('ghost', {
      contentBase64: Buffer.from('x').toString('base64'),
      mimeType: 'image/jpeg',
      filename: 'x.jpg',
    });
    expect(photo.ok).toBe(false);
  });

  it('askBob propose (plancher) puis confirmBob exécute EN JOURNALISANT — le journal est lisible on-device', async () => {
    const client = new LocalBobClient({ clock: new FixtureClock('2026-06-01'), ids: seqIds() });

    // Pièce réelle : devis signé -> facture émise ; le test parle avec son numéro réellement
    // alloué, sans dépendre du nombre de pièces seedées.
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
    const issued = await client.issueInvoice({
      invoiceId: gen.value.invoiceId,
      operationCategory: 'services',
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    // ask : action sensible -> TOUJOURS proposée (plancher comptable), même avec l'autonomie max locale.
    const asked = await client.askBob({
      message: `encaisse la facture ${issued.value.number}`,
      autonomy: 'auto',
    });
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

  it('B8 : lier_bon_commande à la voix — attache RÉELLEMENT le numéro puis confirmBob rend l’ENCHAÎNEMENT facture (parité serveur)', async () => {
    const client = new LocalBobClient({ clock: new FixtureClock('2026-06-01'), ids: seqIds() });

    // Décor réel : client grand compte + devis signé (le seed Martin/Sèvres reste hors jeu).
    const ratp = await client.createCustomer({
      name: 'RATP',
      type: 'b2g',
      address: { line1: '54 quai de la Rapée', zip: '75012', city: 'Paris' },
    });
    expect(ratp.ok).toBe(true);
    if (!ratp.ok) return;
    const created = await client.createQuote({
      customerId: ratp.value.id,
      lines: [{ label: 'Rénovation local technique', category: 'labor', qty: 1, unitPriceHT: 1_000_000, vatRate: 20 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await client.sendQuote(created.value.quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId: created.value.quoteId, signerName: 'Mme Achats' })).ok).toBe(true);

    // La voix propose (plancher de consentement) — rien n'est attaché avant confirmation.
    const asked = await client.askBob({ message: 'La RATP m’a envoyé un bon de commande n° 4500123', autonomy: 'auto' });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.value.kind).toBe('proposed');
    expect(asked.value.pending?.tool).toBe('lier_bon_commande');
    expect(asked.value.pending?.args).toMatchObject({ quoteId: created.value.quoteId, number: '4500123' });

    // confirmBob rend le MÊME enchaînement B8 que le serveur : carte + choix verbatim + voix.
    const confirmed = await client.confirmBob(asked.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');
    expect(confirmed.value.intent).toBe('lier_bon_commande');
    expect(confirmed.value.card.title).toBe('Bon de commande lié ✓');
    expect(confirmed.value.card.body).toContain('avec ce bon de commande ?');
    expect(confirmed.value.choices?.[0]?.value).toMatch(/^Fais la facture du devis /);
    expect(confirmed.value.spokenPrompt).toContain('Je crée la facture');

    // Le lien est RÉEL : le devis porte le numéro d'engagement (même use case que l'écran).
    const quotes = await client.listQuotes();
    expect(quotes.ok).toBe(true);
    if (!quotes.ok) return;
    expect(quotes.value.find((q) => q.id === created.value.quoteId)?.purchaseOrder?.number).toBe('4500123');
  });

  it('M3 : lier_depense_chantier à la voix — propose (plancher) puis confirmBob impute RÉELLEMENT via le MÊME use case (parité serveur)', async () => {
    const client = new LocalBobClient({ clock: new FixtureClock('2026-06-01'), ids: seqIds() });
    const chantier = await client.createChantier({ name: 'Villa Durand' });
    expect(chantier.ok).toBe(true);
    if (!chantier.ok) return;
    // Fournisseur DISTINCT des dépenses seedées (Leroy Merlin/Cedeo/Point P/Brico Dépôt).
    const created = await client.recordExpense({
      supplierName: 'Aldi',
      documentDate: '2026-05-30',
      totalTtcCents: 4500,
      category: 'repas',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Même en autonomie max : l'imputation est PROPOSÉE, jamais posée sans confirmation (M3).
    const asked = await client.askBob({ message: 'Mets la dépense Aldi sur le chantier Villa Durand', autonomy: 'auto' });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.value.intent).toBe('lier_depense_chantier');
    expect(asked.value.kind).toBe('proposed');
    expect(asked.value.pending?.tool).toBe('lier_depense_chantier');
    expect(asked.value.pending?.args).toEqual({ expenseId: created.value.id, chantierId: chantier.value.id });

    const confirmed = await client.confirmBob(asked.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');
    expect(confirmed.value.intent).toBe('lier_depense_chantier');

    // Le lien est RÉEL (AssignExpenseToChantier @bob/core) : la dépense porte le chantier.
    const expenses = await client.listExpenses();
    expect(expenses.ok).toBe(true);
    if (!expenses.ok) return;
    expect(expenses.value.find((e) => e.id === created.value.id)?.chantierId).toBe(chantier.value.id);
  });

  it('M4 : dépense dictée — propose (plancher comptable) puis confirmBob crée la dépense NÉE PAYÉE, imputée au chantier dit', async () => {
    const client = new LocalBobClient({ clock: new FixtureClock('2026-06-01'), ids: seqIds() });
    const chantier = await client.createChantier({ name: 'Villa Durand' });
    expect(chantier.ok).toBe(true);
    if (!chantier.ok) return;

    const asked = await client.askBob({
      message: 'J’ai dépensé 89 € chez Bricomarché par carte (catégorie matériel) pour le chantier Villa Durand',
      autonomy: 'auto',
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.value.intent).toBe('depense_dictee');
    expect(asked.value.kind).toBe('proposed');
    expect(asked.value.pending?.tool).toBe('scan_depense');
    expect(asked.value.pending?.args).toEqual({
      supplierName: 'Bricomarché',
      totalTtcCents: 8900,
      category: 'materiel',
      documentDate: '2026-06-01', // aujourd'hui (horloge fixture), jamais deviné ailleurs
      chantierId: chantier.value.id,
      payment: { paidOn: '2026-06-01', method: 'card' },
    });

    const confirmed = await client.confirmBob(asked.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');

    // La dépense est RÉELLE (RecordExpense @bob/core) : née payée avec sa preuve, liée au chantier.
    const expenses = await client.listExpenses();
    expect(expenses.ok).toBe(true);
    if (!expenses.ok) return;
    const dictated = expenses.value.find((e) => e.supplierName === 'Bricomarché');
    expect(dictated).toBeDefined();
    expect(dictated?.status).toBe('paid');
    expect(dictated?.paymentEvidence).toMatchObject({ paidOn: '2026-06-01', method: 'card' });
    expect(dictated?.chantierId).toBe(chantier.value.id);
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
      ['Brico Dépôt', 'Cedeo', 'Leroy Merlin', 'Point P'],
    );
    // La ligne HISTORIQUE de démo est honnêtement « payée sans preuve » (état régularisable).
    expect(
      expenses.ok
        && expenses.value.find((e) => e.id === 'local-expense-brico'),
    ).toMatchObject({ status: 'paid', paymentEvidence: null });
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
  /** Horloge mobile déplaçable : le flow légal b2c « sur place » impose d'attendre la fin de
   *  l'embargo de paiement de 7 jours (art. L221-10 c. conso) avant toute pièce exigible. */
  class FlowClock {
    constructor(public day: string) {}
    now(): string {
      return `${this.day}T09:00:00.000Z`;
    }
    today(): string {
      return this.day;
    }
  }

  it('la facture finale déduit l’acompte émis : netToPay = solde, traçabilité posée', async () => {
    const clock = new FlowClock('2026-06-01');
    const client = new LocalBobClient({ clock });
    const quote = await client.createQuote({
      customerId: 'cust-durand',
      depositPct: 30,
      lines: [{ label: 'Chantier test', category: 'labor', qty: 1, unitPriceHT: 135667, vatRate: 20 }],
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    await client.sendQuote(quote.value.quoteId);
    // A3 — cust-durand est un PARTICULIER signé SUR PLACE (contrat hors établissement) : le
    // client demande l'exécution anticipée (L221-25) pour lever le gel de rétractation de la
    // finale — mais AUCUN paiement ne peut être demandé avant 7 jours (art. L221-10, acompte
    // compris) : la facturation attend la fin de l'embargo (signé le 01/06 → libre le 09/06).
    await client.signQuote({
      quoteId: quote.value.quoteId,
      signerName: 'Mme Durand',
      earlyExecutionRequested: true,
    });
    clock.day = '2026-06-10';

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

  it('A3 : b2c signé SANS exécution anticipée → finale GELÉE 14 jours (parité stricte avec le serveur), acompte possible après l’embargo L221-10', async () => {
    const clock = new FlowClock('2026-06-01');
    const client = new LocalBobClient({ clock });
    const quote = await client.createQuote({
      customerId: 'cust-durand',
      depositPct: 30,
      lines: [{ label: 'Chantier test', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 }],
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    await client.sendQuote(quote.value.quoteId);
    await client.signQuote({ quoteId: quote.value.quoteId, signerName: 'Mme Durand' });
    // Embargo L221-10 écoulé (7 jours après le 01/06) — le délai de rétractation court encore.
    clock.day = '2026-06-10';

    const finale = await client.generateInvoice({ quoteId: quote.value.quoteId, mode: 'final' });
    expect(finale.ok).toBe(false);
    if (finale.ok) return;
    expect(finale.error.kind).toBe('domain');
    if (finale.error.kind !== 'domain') return;
    expect(finale.error.error.code).toBe('RETRACTATION_PERIOD_ACTIVE');
    if (finale.error.error.code !== 'RETRACTATION_PERIOD_ACTIVE') return;
    expect(finale.error.error.message).toContain('rétractation');
    expect(finale.error.error.message).toContain('L221-18');

    const acompte = await client.generateInvoice({ quoteId: quote.value.quoteId, mode: 'deposit' });
    expect(acompte.ok).toBe(true);
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

    // Device push v2 : binding idempotent et fence monotone, sans push sortant en démo.
    const bindingV1 = {
      installationId: '11111111-1111-4111-8111-111111111111',
      bindingId: '22222222-2222-4222-8222-222222222222',
      bindingGeneration: 1,
      revocationSecret: 'a'.repeat(64),
    };
    const registrationV1 = {
      ...bindingV1,
      expoPushToken: 'ExponentPushToken[demo]',
      platform: 'ios' as const,
    };
    const d1 = await client.registerDevice(registrationV1);
    const d2 = await client.registerDevice(registrationV1);
    expect(d1).toEqual({ ok: true, value: { status: 'bound' } });
    expect(d2).toEqual({ ok: true, value: { status: 'bound' } });
    await expect(client.registerDevice({
      ...registrationV1,
      expoPushToken: 'ExponentPushToken[stale-equal-generation]',
    })).resolves.toEqual({ ok: true, value: { status: 'superseded' } });
    await expect(client.revokeDeviceBinding({
      installationId: bindingV1.installationId,
      throughGeneration: bindingV1.bindingGeneration,
      revocationSecret: bindingV1.revocationSecret,
    })).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    });
    await expect(client.registerDevice(registrationV1)).resolves.toEqual({
      ok: true,
      value: { status: 'superseded' },
    });
    const bindingV2 = {
      ...bindingV1,
      bindingId: '33333333-3333-4333-8333-333333333333',
      bindingGeneration: 2,
    };
    await expect(client.registerDevice({
      ...bindingV2,
      expoPushToken: 'ExponentPushToken[demo]',
    })).resolves.toEqual({ ok: true, value: { status: 'bound' } });
    await expect(client.replayPushRevocation({
      installationId: bindingV2.installationId,
      throughGeneration: bindingV2.bindingGeneration,
      revocationSecret: bindingV2.revocationSecret,
    })).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    });
    await expect(
      client.unregisterDevice({ expoPushToken: 'ExponentPushToken[demo]' }),
    ).resolves.toEqual({ ok: true, value: { unregistered: true } });
    // Révocation et ré-enregistrement restent idempotents dans l'adaptateur local.
    await expect(
      client.unregisterDevice({ expoPushToken: 'ExponentPushToken[demo]' }),
    ).resolves.toEqual({ ok: true, value: { unregistered: true } });
    const d3 = await client.registerDevice({
      ...bindingV2,
      bindingId: '44444444-4444-4444-8444-444444444444',
      bindingGeneration: 3,
      expoPushToken: 'ExponentPushToken[demo]',
    });
    expect(d3).toEqual({ ok: true, value: { status: 'bound' } });
  });
});

describe('PR-01 — sendInvoice (adaptateur démo) : destinataire explicite, parité serveur', () => {
  async function issuedInvoice(client: LocalBobClient): Promise<string> {
    const quote = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Intervention', category: 'labor', qty: 1, unitPriceHT: 50000, vatRate: 20 }],
    });
    if (!quote.ok) throw new Error('fixture: devis');
    await client.sendQuote(quote.value.quoteId);
    await client.signQuote({ quoteId: quote.value.quoteId, signerName: 'SARL Martin Rénovation' });
    const finale = await client.generateInvoice({ quoteId: quote.value.quoteId, mode: 'final' });
    if (!finale.ok) throw new Error('fixture: finale');
    await client.issueInvoice({ invoiceId: finale.value.invoiceId });
    return finale.value.invoiceId;
  }

  it('recipientEmail invalide ou vide : REFUSÉ du même motif que le serveur — jamais un repli silencieux fiche client', async () => {
    const client = makeClient();
    const invoiceId = await issuedInvoice(client);

    for (const recipientEmail of ['pas-un-email', '   ', 'a@b']) {
      const refused = await client.sendInvoice({ invoiceId, recipientEmail });
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error).toEqual({
        kind: 'validation',
        issues: [
          { field: 'recipientEmail', message: 'Adresse e-mail du destinataire invalide.' },
        ],
      });
    }
    // Rien n'a été « envoyé » : le fil local reste vierge de toute livraison.
    const feed = await client.listNotifications();
    expect(feed.ok && feed.value).toHaveLength(0);
  });

  it('sans recipientEmail : repli fiche client (normalisé), l’envoi démo est journalisé', async () => {
    const client = makeClient();
    const invoiceId = await issuedInvoice(client);

    const sent = await client.sendInvoice({ invoiceId });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.recipient).toBe('contact@martin-renov.fr');

    const explicit = await client.sendInvoice({
      invoiceId,
      recipientEmail: '  Compta@Martin-Renov.fr ',
    });
    // Adresse explicite valide : normalisée (trim + minuscules) — même règle que le serveur.
    expect(explicit.ok && explicit.value.recipient).toBe('compta@martin-renov.fr');
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

  it('AUTOLIQUIDATION fail-closed ; refus sans motif impossible ; mal adressée bloquée avec les 2 SIREN', async () => {
    const client = new LocalBobClient({ clock: new FixtureClock('2026-07-01') });

    // Autoliquidation : le moteur d'écritures miroir n'est pas encore complet. Import ET
    // approbation restent donc fermés — jamais une fausse dépense « sans TVA » qui perdrait la
    // dette/créance d'autoliquidation.
    const aeXml = buildFacturXBasicXml(autoliquidationData());
    const aeReview = await client.importFacturXExpense({ xml: aeXml });
    expect(aeReview.ok).toBe(false);
    if (!aeReview.ok && aeReview.error.kind === 'validation') {
      expect(aeReview.error.issues[0]?.field).toBe('facturx.autoliquidation_non_geree');
    }
    const aeOutcome = await client.confirmFacturXExpense({ xml: aeXml, decision: { action: 'approve' } });
    expect(aeOutcome.ok).toBe(false);

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

describe('LocalBobClient B9 — searchSalesDocuments / suggestSalesDocuments (pendant hors-ligne du port core)', () => {
  it('« sevres » sans accent retrouve le devis du client de seed « Mairie de Sèvres »', async () => {
    const client = makeClient();
    const created = await client.createQuote({
      customerId: 'cust-sevres',
      lines: [{ label: 'Réfection toiture mairie', category: 'labor', qty: 1, unitPriceHT: 500000, vatRate: 20 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await client.searchSalesDocuments({ query: 'sevres', scope: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.map((h) => h.id)).toContain(created.value.quoteId);
    expect(result.value.hits.find((h) => h.id === created.value.quoteId)?.customerName).toBe('Mairie de Sèvres');
  });

  it('scope="invoice" exclut les devis (le seed démo porte déjà une facture Sèvres, mais jamais le devis créé ici)', async () => {
    const client = makeClient();
    const created = await client.createQuote({
      customerId: 'cust-sevres',
      lines: [{ label: 'Réfection toiture mairie', category: 'labor', qty: 1, unitPriceHT: 500000, vatRate: 20 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await client.searchSalesDocuments({ query: 'sevres', scope: 'invoice' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.every((h) => h.source === 'invoice')).toBe(true);
    expect(result.value.hits.map((h) => h.id)).not.toContain(created.value.quoteId);
  });

  it('scope par défaut ("all" si omis) : un devis matche même sans préciser scope', async () => {
    const client = makeClient();
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Peinture façade', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await client.searchSalesDocuments({ query: 'martin' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hits.map((h) => h.id)).toContain(created.value.quoteId);
  });

  it('suggestSalesDocuments : suggestion typée "customer" pour un client de seed, count = nb de pièces (incrémenté par un nouveau devis)', async () => {
    const client = makeClient();
    const before = await client.suggestSalesDocuments('sevres');
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const countBefore = before.value.suggestions.find((s) => s.kind === 'customer')?.count ?? 0;

    const created = await client.createQuote({
      customerId: 'cust-sevres',
      lines: [{ label: 'Réfection toiture mairie', category: 'labor', qty: 1, unitPriceHT: 500000, vatRate: 20 }],
    });
    expect(created.ok).toBe(true);

    const after = await client.suggestSalesDocuments('sevres');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.suggestions).toContainEqual({ kind: 'customer', value: 'Mairie de Sèvres', count: countBefore + 1 });
  });

  it('suggestSalesDocuments : requête vide -> aucune suggestion (les récentes restent un concern écran)', async () => {
    const result = await makeClient().suggestSalesDocuments('');
    expect(result).toEqual({ ok: true, value: { suggestions: [] } });
  });
});

describe('LocalBobClient — régularisation d’une ligne historique payée sans preuve', () => {
  const evidence = {
    expenseId: 'local-expense-brico',
    paidOn: '2026-05-03',
    method: 'card' as const,
    reference: 'CB-BRICO-0503',
  };

  it('attache la preuve, pose l’écriture 401/512 manquante et sort la ligne de l’état legacy', async () => {
    const client = makeClient();
    const r = await client.regularizeExpensePayment(evidence);
    expect(r).toEqual({
      ok: true,
      value: {
        status: 'paid',
        alreadyRegularized: false,
        paymentEntryId: 'expense:local-expense-brico:paid',
      },
    });
    const expenses = await client.listExpenses();
    expect(
      expenses.ok && expenses.value.find((e) => e.id === 'local-expense-brico'),
    ).toMatchObject({
      status: 'paid',
      paymentEvidence: {
        paidOn: '2026-05-03',
        method: 'card',
        reference: 'CB-BRICO-0503',
        proofDocumentId: null,
      },
    });
    const entries = await client.listAccountingEntries();
    const entry = entries.ok
      ? entries.value.find((e) => e.id === 'expense:local-expense-brico:paid')
      : undefined;
    expect(entry).toBeDefined();
    expect(entry?.entryDate).toBe('2026-05-03');
  });

  it('retry identique idempotent ; une ligne déjà justifiée ou à payer est refusée', async () => {
    const client = makeClient();
    await client.regularizeExpensePayment(evidence);
    const replay = await client.regularizeExpensePayment(evidence);
    expect(replay.ok && replay.value.alreadyRegularized).toBe(true);

    // Cedeo est justifiée (preuve seedée) : une régularisation différente est un conflit.
    const alreadyJustified = await client.regularizeExpensePayment({
      ...evidence,
      expenseId: 'local-expense-cedeo',
    });
    expect(!alreadyJustified.ok && alreadyJustified.error.kind).toBe('conflict');

    // Leroy Merlin est à payer : c'est un règlement (payExpense), pas une régularisation.
    const stillUnpaid = await client.regularizeExpensePayment({
      ...evidence,
      expenseId: 'local-expense-leroy',
    });
    expect(!stillUnpaid.ok && stillUnpaid.error.kind).toBe('conflict');
  });

  it('payExpense sur la ligne legacy renvoie le conflit dédié qui route vers la régularisation', async () => {
    const client = makeClient();
    const r = await client.payExpense(evidence);
    expect(!r.ok && r.error.kind).toBe('conflict');
    if (r.ok || r.error.kind !== 'conflict') return;
    expect(r.error.entity).toBe('expense_payment_legacy');
  });
});

describe('LocalBobClient — embargo L221-10 : override responsabilisé + exception dépannage urgent (parité serveur)', () => {
  class FlowClock {
    constructor(public day: string) {}
    now(): string {
      return `${this.day}T09:00:00.000Z`;
    }
    today(): string {
      return this.day;
    }
  }

  it('pendant l’embargo : refus par défaut (overridable + risque concret), puis override EXPLICITE journalisé', async () => {
    const clock = new FlowClock('2026-06-01');
    const client = new LocalBobClient({ clock });
    const quote = await client.createQuote({
      customerId: 'cust-durand', // b2c, signé SUR PLACE ci-dessous (hors établissement)
      depositPct: 30,
      lines: [{ label: 'Chantier test', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 }],
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    await client.sendQuote(quote.value.quoteId);
    await client.signQuote({ quoteId: quote.value.quoteId, signerName: 'Mme Durand' });
    clock.day = '2026-06-03'; // en pleine fenêtre L221-10 (libre le 09/06)

    const refused = await client.generateInvoice({ quoteId: quote.value.quoteId, mode: 'deposit' });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== 'domain') throw new Error('erreur domaine attendue');
    expect(refused.error.error).toMatchObject({
      code: 'OFF_PREMISES_PAYMENT_EMBARGO',
      overridable: true,
    });
    if (refused.error.error.code === 'OFF_PREMISES_PAYMENT_EMBARGO') {
      expect(refused.error.error.overrideRisk).toContain('L242-1');
    }
    expect(client.embargoOverrideEvents).toHaveLength(0);

    // Override responsabilisé : flag EXPLICITE → pièce produite + payment.embargo_overridden.
    const overridden = await client.generateInvoice({
      quoteId: quote.value.quoteId,
      mode: 'deposit',
      embargoOverride: true,
    });
    expect(overridden.ok).toBe(true);
    expect(client.embargoOverrideEvents).toHaveLength(1);
    expect(client.embargoOverrideEvents[0]).toMatchObject({
      type: 'payment.embargo_overridden',
      quoteId: quote.value.quoteId,
      invoiceKind: 'deposit',
      occurredAt: '2026-06-03T09:00:00.000Z',
    });
  });

  it('dépannage urgent TRACÉ à la création : pas d’embargo — acompte immédiat SANS override, vue exposée', async () => {
    const clock = new FlowClock('2026-06-01');
    const client = new LocalBobClient({ clock });
    const quote = await client.createQuote({
      customerId: 'cust-durand',
      depositPct: 30,
      urgentRepairRequested: true,
      lines: [{ label: 'Fuite urgente', category: 'labor', qty: 1, unitPriceHT: 45000, vatRate: 20 }],
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    await client.sendQuote(quote.value.quoteId);
    await client.signQuote({ quoteId: quote.value.quoteId, signerName: 'Mme Durand' });
    clock.day = '2026-06-03'; // pendant la fenêtre : l'exception L221-10, al. 2 s'applique

    const view = await client.getQuote(quote.value.quoteId);
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.value.urgentRepair).toEqual({ requestedAt: '2026-06-01T09:00:00.000Z' });

    const acompte = await client.generateInvoice({ quoteId: quote.value.quoteId, mode: 'deposit' });
    expect(acompte.ok).toBe(true);
    expect(client.embargoOverrideEvents).toHaveLength(0); // exception légale, pas un override
  });

  it('dépannage urgent refusé pour un client PROFESSIONNEL (l’exception ne vise que le consommateur)', async () => {
    const client = new LocalBobClient();
    const quote = await client.createQuote({
      customerId: 'cust-martin', // b2b
      urgentRepairRequested: true,
      lines: [{ label: 'Dépannage', category: 'labor', qty: 1, unitPriceHT: 45000, vatRate: 20 }],
    });
    expect(quote.ok).toBe(false);
    if (quote.ok || quote.error.kind !== 'domain') throw new Error('erreur domaine attendue');
    expect(quote.error.error).toMatchObject({ code: 'VALIDATION', field: 'urgentRepairRequested' });
  });
});
