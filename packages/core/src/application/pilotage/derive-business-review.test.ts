import { describe, it, expect } from 'vitest';
import {
  deriveBusinessReview,
  type BusinessReviewEntryData,
  type BusinessReviewExpenseData,
  type BusinessReviewInput,
} from './derive-business-review';
import { type AgedBalanceInvoiceData } from '../clients/derive-aged-balance';
import { type Totals } from '../../domain/billing/shared/totals';

const TODAY = '2026-06-15';

/** Écriture de facture réaliste : D 411 TTC ; C 70x HT + C 44571 TVA. */
function invoiceEntry(entryDate: string, htCents: number, vatCents: number, account = '706'): BusinessReviewEntryData {
  return {
    entryDate,
    sourceType: 'invoice',
    lines: [
      { account: '411', debitCents: htCents + vatCents, creditCents: 0 },
      { account, debitCents: 0, creditCents: htCents },
      { account: '44571', debitCents: 0, creditCents: vatCents },
    ],
  };
}

/** Écriture d'acompte : D 411 ; C 4191 + C 44571 — AUCUN compte 70x (pas de CA). */
function depositEntry(entryDate: string, advanceCents: number, vatCents: number): BusinessReviewEntryData {
  return {
    entryDate,
    sourceType: 'invoice',
    lines: [
      { account: '411', debitCents: advanceCents + vatCents, creditCents: 0 },
      { account: '4191', debitCents: 0, creditCents: advanceCents },
      { account: '44571', debitCents: 0, creditCents: vatCents },
    ],
  };
}

/** Écriture d'avoir : inverse d'une facture. */
function creditNoteEntry(entryDate: string, htCents: number, vatCents: number): BusinessReviewEntryData {
  return {
    entryDate,
    sourceType: 'invoice',
    lines: [
      { account: '411', debitCents: 0, creditCents: htCents + vatCents },
      { account: '706', debitCents: htCents, creditCents: 0 },
      { account: '44571', debitCents: vatCents, creditCents: 0 },
    ],
  };
}

/** Écriture d'encaissement : D 512 ; C 411 — doit rester HORS du dénominateur DSO. */
function paymentEntry(entryDate: string, amountCents: number): BusinessReviewEntryData {
  return {
    entryDate,
    sourceType: 'payment',
    lines: [
      { account: '512', debitCents: amountCents, creditCents: 0 },
      { account: '411', debitCents: 0, creditCents: amountCents },
    ],
  };
}

function totals(ttc: number, opts?: { netToPay?: number; vat?: number }): Totals {
  const vat = opts?.vat ?? Math.round(ttc / 11); // TVA 10 % par défaut
  return { ht: ttc - vat, vatByRate: { '10': vat }, vat, ttc, netToPay: opts?.netToPay ?? ttc };
}

function invoice(customerId: string, ttc: number, opts?: Partial<AgedBalanceInvoiceData> & { netToPay?: number }): AgedBalanceInvoiceData {
  return {
    kind: 'final',
    status: 'issued',
    totals: totals(ttc, { netToPay: opts?.netToPay ?? ttc }),
    paid: 0,
    dueAt: '2026-06-01',
    customerId,
    ...opts,
  };
}

function baseInput(overrides?: Partial<BusinessReviewInput>): BusinessReviewInput {
  return {
    entries: [],
    payments: [],
    invoices: [],
    customers: [],
    expenses: [],
    vatRegime: 'reel_normal',
    today: TODAY,
    ...overrides,
  };
}

describe('deriveBusinessReview — séries et honnêteté temporelle', () => {
  it('construit une série dense depuis le premier mouvement, zéros explicites, jamais avant', () => {
    const review = deriveBusinessReview(
      baseInput({
        entries: [invoiceEntry('2026-03-10', 500_000, 50_000), invoiceEntry('2026-05-20', 800_000, 80_000)],
        payments: [{ amountCents: 550_000, receivedAt: '2026-04-02T09:00:00.000Z' }],
      }),
    );
    // Avril sans facturation = 0 EXPLICITE (le creux se voit) ; rien avant mars.
    expect(review.coverage).toEqual({ firstMonth: '2026-03', monthsObserved: 4, completeMonths: 3 });
    expect(review.series).toEqual([
      { month: '2026-03', invoicedHtCents: 500_000, collectedTtcCents: 0 },
      { month: '2026-04', invoicedHtCents: 0, collectedTtcCents: 550_000 },
      { month: '2026-05', invoicedHtCents: 800_000, collectedTtcCents: 0 },
      { month: '2026-06', invoicedHtCents: 0, collectedTtcCents: 0 },
    ]);
  });

  it('compte le chantier UNE fois : l acompte (4191) ne fait pas de CA, la finale porte tout, l avoir déduit', () => {
    const review = deriveBusinessReview(
      baseInput({
        entries: [
          depositEntry('2026-04-05', 44_400, 4_440),
          invoiceEntry('2026-05-12', 148_000, 14_800),
          creditNoteEntry('2026-05-28', 20_000, 2_000),
        ],
        payments: [{ amountCents: 48_840, receivedAt: '2026-04-06T10:00:00.000Z' }],
      }),
    );
    const april = review.series.find((point) => point.month === '2026-04')!;
    const may = review.series.find((point) => point.month === '2026-05')!;
    // Avril : encaissé > 0 avec facturé = 0 — c'est précisément l'information (acompte).
    expect(april.invoicedHtCents).toBe(0);
    expect(april.collectedTtcCents).toBe(48_840);
    expect(may.invoicedHtCents).toBe(128_000); // 148 000 − 20 000, au mois d'émission
  });

  it('ne compare jamais le mois courant en plein-mois : isopérimètre de jours typé atDay', () => {
    const review = deriveBusinessReview(
      baseInput({
        entries: [
          invoiceEntry('2026-05-10', 600_000, 60_000), // mois précédent, jour ≤ 15 → inclus
          invoiceEntry('2026-05-25', 900_000, 90_000), // mois précédent, jour > 15 → EXCLU de l'iso
          invoiceEntry('2026-06-08', 450_000, 45_000),
        ],
      }),
    );
    expect(review.currentMonth.atDay).toBe(15);
    expect(review.currentMonth.invoicedHtCents).toBe(450_000);
    expect(review.currentMonth.previousInvoicedHtCents).toBe(600_000);
    expect(review.currentMonth.invoicedDeltaBps).toBe(-2_500); // −25 % à isopérimètre
  });

  it('émet le comparatif mois clos dès 2 mois clos, mais aucun % sous le plancher de base', () => {
    const review = deriveBusinessReview(
      baseInput({
        entries: [invoiceEntry('2026-04-10', 80_000, 8_000), invoiceEntry('2026-05-10', 272_000, 27_200)],
      }),
    );
    expect(review.lastClosedComparison).not.toBeNull();
    expect(review.lastClosedComparison!.deltaCents).toBe(192_000);
    // Base 800 € < plancher 3 000 € : le « +240 % » serait un mensonge visuel → null.
    expect(review.lastClosedComparison!.deltaBps).toBeNull();
  });

  it('refuse le N vs N-1 sans couverture complète de la période miroir, l émet sinon', () => {
    const thisYearOnly = deriveBusinessReview(
      baseInput({ entries: [invoiceEntry('2026-02-10', 500_000, 50_000)] }),
    );
    expect(thisYearOnly.ytd).toBeNull();

    const twoYears = deriveBusinessReview(
      baseInput({
        entries: [
          invoiceEntry('2025-01-20', 400_000, 40_000),
          invoiceEntry('2025-06-10', 300_000, 30_000), // 10 juin ≤ miroir (15 juin) → inclus
          invoiceEntry('2025-06-20', 999_999, 99_999), // après le miroir → EXCLU
          invoiceEntry('2026-02-10', 900_000, 90_000),
        ],
      }),
    );
    expect(twoYears.ytd).toEqual({
      invoicedHtCents: 900_000,
      previousYearInvoicedHtCents: 700_000,
      deltaCents: 200_000,
      deltaBps: 2_857, // +28,57 %
    });
  });
});

describe('deriveBusinessReview — DSO', () => {
  const customers = [{ id: 'c1', name: 'Sarl Martin' }];

  it('assume un null honnête sous 3 mois d historique de facturation', () => {
    const review = deriveBusinessReview(
      baseInput({
        entries: [invoiceEntry('2026-05-10', 500_000, 50_000)],
        invoices: [invoice('c1', 550_000)],
        customers,
      }),
    );
    expect(review.dso.days).toBeNull();
    expect(review.dso.reason).toBe('insufficient_history');
  });

  it('calcule encours × 90 / facturé TTC 90 j — les encaissements (journal bank) exclus du dénominateur', () => {
    const review = deriveBusinessReview(
      baseInput({
        entries: [
          invoiceEntry('2026-01-10', 500_000, 50_000), // ancre l'historique (> 90 j)
          invoiceEntry('2026-04-20', 400_000, 40_000), // dans la fenêtre : 440 000 TTC
          invoiceEntry('2026-05-15', 400_000, 40_000), // dans la fenêtre : 440 000 TTC
          paymentEntry('2026-05-20', 550_000), // crédite 411 — ne doit PAS réduire le facturé
        ],
        invoices: [invoice('c1', 440_000, { paid: 220_000, status: 'partially_paid' })],
        customers,
      }),
    );
    expect(review.dso.invoicedTtc90dCents).toBe(880_000);
    expect(review.dso.receivablesCents).toBe(220_000);
    expect(review.dso.days).toBe(Math.round((220_000 * 90) / 880_000)); // 23 j
    expect(review.dso.reason).toBe('ok');
  });

  it('dit « tout est encaissé » (0 j) plutôt qu un null quand l encours est nul avec de la facturation', () => {
    const review = deriveBusinessReview(
      baseInput({
        entries: [invoiceEntry('2026-01-10', 500_000, 50_000), invoiceEntry('2026-05-10', 400_000, 40_000)],
        invoices: [invoice('c1', 440_000, { paid: 440_000, status: 'paid' })],
        customers,
      }),
    );
    expect(review.dso.days).toBe(0);
    expect(review.dso.reason).toBe('all_collected');
  });
});

describe('deriveBusinessReview — tops', () => {
  it('classe le top 5 clients, sépare les avoirs nets, et totalise au centime', () => {
    const customers = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `c${i}`, name: `Client ${i}` }));
    const invoices = [
      invoice('c1', 900_000),
      invoice('c2', 700_000),
      invoice('c3', 500_000),
      invoice('c4', 300_000),
      invoice('c5', 200_000),
      invoice('c6', 100_000),
      // c7 : avoir net (facture 100 000 puis avoir 150 000) → ligne séparée, pas dans « Autres ».
      invoice('c7', 100_000),
      invoice('c7', 150_000, { kind: 'credit_note' }),
    ];
    const review = deriveBusinessReview(baseInput({ invoices, customers }));

    expect(review.topClients.lines.map((line) => line.customerId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(review.topClients.othersCount).toBe(1);
    expect(review.topClients.othersCents).toBe(100_000);
    expect(review.topClients.creditNetCount).toBe(1);
    expect(review.topClients.creditNetCents).toBe(-50_000);
    // INVARIANT : top 5 + Autres + Avoirs nets = total, au centime.
    const sum = review.topClients.lines.reduce((acc, line) => acc + line.invoicedTtc12mCents, 0);
    expect(sum + review.topClients.othersCents + review.topClients.creditNetCents).toBe(review.topClients.totalCents);
    // 900 000 / 2 650 000 (total net des avoirs) = 33,96 % ≥ 30 % → alerte dépendance.
    expect(review.topClients.top1ShareBps).toBe(3_396);
    expect(review.topClients.concentrationAlert).toBe(true);
  });

  it('mesure la charge COMPTABILISÉE des dépenses : TTC − TVA mentionnée au réel, TTC en franchise', () => {
    const expenses: BusinessReviewExpenseData[] = [
      { category: 'materiel', totalTtcCents: 120_000, vatCents: 20_000, documentDate: '2026-05-10', status: 'paid' },
      { category: 'carburant', totalTtcCents: 60_000, vatCents: null, documentDate: '2026-05-12', status: 'to_pay' },
    ];
    const reel = deriveBusinessReview(baseInput({ expenses, vatRegime: 'reel_simpl' }));
    expect(reel.topExpenses.lines).toEqual([
      { category: 'materiel', chargeCents: 100_000, previousChargeCents: 0, deltaBps: null },
      { category: 'carburant', chargeCents: 60_000, previousChargeCents: 0, deltaBps: null }, // TVA absente → prudence TTC
    ]);

    const franchise = deriveBusinessReview(baseInput({ expenses, vatRegime: 'franchise' }));
    expect(franchise.topExpenses.lines[0]).toEqual({ category: 'materiel', chargeCents: 120_000, previousChargeCents: 0, deltaBps: null });
  });
});

describe('deriveBusinessReview — SIG, ratios et TVA', () => {
  it('calcule les ratios en bps sur l exercice à date, null honnête sans CA', () => {
    const review = deriveBusinessReview(
      baseInput({
        entries: [
          invoiceEntry('2025-11-10', 999_999, 99_999), // exercice précédent : HORS ratios
          invoiceEntry('2026-03-10', 1_000_000, 100_000),
          { entryDate: '2026-04-02', sourceType: 'expense', lines: [{ account: '606', debitCents: 250_000, creditCents: 0 }, { account: '401', debitCents: 0, creditCents: 250_000 }] },
          { entryDate: '2026-04-15', sourceType: 'expense', lines: [{ account: '611', debitCents: 150_000, creditCents: 0 }, { account: '401', debitCents: 0, creditCents: 150_000 }] },
        ],
      }),
    );
    expect(review.ratios.caCents).toBe(1_000_000);
    expect(review.ratios.chargesExternesBps).toBe(4_000); // 40 % du CA
    expect(review.ratios.ebeBps).toBe(6_000);
    expect(review.ratios.rexBps).toBe(6_000);
    expect(review.sig.resultatExploitationCents).toBe(600_000);
    // Gates : pas de 607 mouvementé → pas de marge matériaux ; pas de 64 → pas de ratio personnel.
    expect(review.ratios.margeMateriauxBps).toBeNull();
    expect(review.ratios.personnelVaBps).toBeNull();

    const vide = deriveBusinessReview(baseInput());
    expect(vide.ratios.caCents).toBe(0);
    expect(vide.ratios.ebeBps).toBeNull();
    expect(vide.coverage.firstMonth).toBeNull();
    expect(vide.series).toEqual([]);
  });

  it('réutilise deriveVatPosition (TVA sur encaissements) au lieu de recalculer le grand livre', () => {
    const review = deriveBusinessReview(
      baseInput({
        invoices: [invoice('c1', 110_000, { paid: 110_000, status: 'paid', totals: totals(110_000, { vat: 10_000 }) })],
        customers: [{ id: 'c1', name: 'Client' }],
        expenses: [{ category: 'materiel', totalTtcCents: 24_000, vatCents: 4_000, documentDate: '2026-05-01', status: 'paid' }],
      }),
    );
    expect(review.vat.collectedCents).toBe(10_000);
    expect(review.vat.deductibleCents).toBe(4_000);
    expect(review.vat.netDueCents).toBe(6_000);
  });
});
