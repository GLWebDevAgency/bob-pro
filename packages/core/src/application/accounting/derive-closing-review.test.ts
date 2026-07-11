import { describe, it, expect } from 'vitest';
import { formatEUR } from '../../format/money';
import { deriveClosingReview, filterClosingPeriodEntries, type ClosingReviewEntryData } from './derive-closing-review';

/** Écriture équilibrée à deux pattes (D compte1 / C compte2). */
function mv(debitAccount: string, creditAccount: string, cents: number, entryDate?: string): ClosingReviewEntryData {
  return {
    ...(entryDate !== undefined ? { entryDate } : {}),
    lines: [
      { account: debitAccount, debitCents: cents, creditCents: 0 },
      { account: creditAccount, debitCents: 0, creditCents: cents },
    ],
  };
}

function control(review: ReturnType<typeof deriveClosingReview>, id: string) {
  const found = review.controls.find((c) => c.id === id);
  if (!found) throw new Error(`contrôle ${id} absent`);
  return found;
}

/** Dossier sain : vente encaissée, dépense payée — tout se tient. */
const HEALTHY: ClosingReviewEntryData[] = [
  mv('411', '706', 100_000, '2026-06-05'),
  mv('512', '411', 100_000, '2026-06-10'),
  mv('606', '401', 40_000, '2026-06-12'),
  mv('401', '512', 40_000, '2026-06-20'),
];

describe('deriveClosingReview — verdict', () => {
  it('dossier sain : prêt pour la revue, zéro anomalie, les info hors compteur de réussite', () => {
    const review = deriveClosingReview({ entries: HEALTHY, period: { from: '2026-06-01', to: '2026-06-30' } });
    expect(review.anomalieCount).toBe(0);
    expect(review.readyToSign).toBe(true);
    expect(review.hasReserves).toBe(false);
    // justificatifs non fournis → limitation d'étendue en info, jamais compté « réussi ».
    expect(control(review, 'justificatifs').status).toBe('info');
    expect(control(review, 'tva').status).toBe('info');
    expect(review.okCount + review.attentionCount + review.anomalieCount + review.infoCount).toBe(review.controls.length);
    expect(review.controls.filter((c) => c.status === 'info').length).toBe(review.infoCount);
  });

  it('un dossier VIDE n’est pas « tout vert » : anomalie dédiée, non signable', () => {
    const review = deriveClosingReview({ entries: [] });
    expect(control(review, 'dossier_vide').status).toBe('anomalie');
    expect(review.readyToSign).toBe(false);
  });

  it('écriture déséquilibrée : anomalie qui IDENTIFIE la fautive (index + date)', () => {
    const bad: ClosingReviewEntryData = {
      entryDate: '2026-06-15',
      lines: [
        { account: '606', debitCents: 10_000, creditCents: 0 },
        { account: '401', debitCents: 0, creditCents: 9_000 },
      ],
    };
    const review = deriveClosingReview({ entries: [...HEALTHY, bad] });
    const c = control(review, 'ecritures_equilibrees');
    expect(c.status).toBe('anomalie');
    expect(c.detail).toContain('n°5 du 2026-06-15');
    expect(review.readyToSign).toBe(false);
  });
});

describe('deriveClosingReview — contrôles compte par compte (jamais de compensation)', () => {
  it('471 débiteur et 472 créditeur NE se compensent PAS : attention avec les deux comptes signés', () => {
    const review = deriveClosingReview({
      entries: [...HEALTHY, mv('471', '472', 50_000, '2026-06-18')],
    });
    const c = control(review, 'comptes_attente');
    expect(c.status).toBe('attention');
    expect(c.detail).toContain(`471 : ${formatEUR(50_000)} débiteur`);
    expect(c.detail).toContain(`472 : ${formatEUR(50_000)} créditeur`);
    expect(review.hasReserves).toBe(true);
  });

  it('caisses multi-comptes : 531 débitrice ne blanchit pas 532 créditrice — anomalie nominative', () => {
    const review = deriveClosingReview({
      entries: [...HEALTHY, mv('531', '706', 10_000, '2026-06-19'), mv('606', '532', 4_000, '2026-06-19')],
    });
    const c = control(review, 'caisse');
    expect(c.status).toBe('anomalie');
    expect(c.detail).toContain(`532 : ${formatEUR(4_000)} créditeur`);
    expect(c.detail).not.toContain('531');
  });

  it('tiers à contre-sens : client créditeur et fournisseur débiteur flagués, 4191 créditeur épargné', () => {
    const review = deriveClosingReview({
      entries: [
        ...HEALTHY,
        mv('512', '411', 20_000, '2026-06-21'), // encaissement de trop → 411 créditeur
        mv('401', '512', 5_000, '2026-06-22'), // paiement de trop → 401 débiteur
        mv('512', '4191', 30_000, '2026-06-23'), // acompte reçu : 4191 créditeur NORMAL
      ],
    });
    const c = control(review, 'tiers_contresens');
    expect(c.status).toBe('attention');
    expect(c.detail).toContain(`411 : ${formatEUR(20_000)} créditeur`);
    expect(c.detail).toContain(`401 : ${formatEUR(5_000)} débiteur`);
    // Le 4191 créditeur (normal) n'est jamais LISTÉ comme fautif — « 4191 : … » absent
    // (le libellé pédagogique « à reclasser en 4191 » est, lui, légitime).
    expect(c.detail).not.toContain('4191 :');
  });

  it('avances 4191 : créditrices = info en mensuel, attention en clôture d’exercice, débitrices = anomalie', () => {
    const withAdvance = [...HEALTHY, mv('512', '4191', 30_000, '2026-06-23')];
    expect(control(deriveClosingReview({ entries: withAdvance }), 'avances_4191').status).toBe('info');
    expect(control(deriveClosingReview({ entries: withAdvance, yearEnd: true }), 'avances_4191').status).toBe('attention');

    const corrupted = [...HEALTHY, mv('4191', '512', 1_000, '2026-06-24')];
    const c = control(deriveClosingReview({ entries: corrupted }), 'avances_4191');
    expect(c.status).toBe('anomalie');
    expect(c.detail).toContain('DÉBITRICE');
  });

  it('banque : 512 créditrice = attention (découvert), 5186 créditeur JAMAIS flagué', () => {
    const review = deriveClosingReview({
      entries: [
        mv('606', '512', 80_000, '2026-06-05'), // banque à découvert
        { entryDate: '2026-06-30', lines: [{ account: '661', debitCents: 500, creditCents: 0 }, { account: '5186', debitCents: 0, creditCents: 500 }] },
      ],
    });
    const c = control(review, 'banque_crediteur');
    expect(c.status).toBe('attention');
    expect(c.detail).toContain(`512 : ${formatEUR(80_000)} créditeur`);
    expect(c.detail).not.toContain('5186');
  });
});

describe('deriveClosingReview — TVA (information, jamais un « à payer »)', () => {
  it('exclut le 44567 (crédit reporté) du cumul déductible et l’affiche à part', () => {
    const review = deriveClosingReview({
      entries: [
        { entryDate: '2026-06-05', lines: [{ account: '411', debitCents: 12_000, creditCents: 0 }, { account: '706', debitCents: 0, creditCents: 10_000 }, { account: '44571', debitCents: 0, creditCents: 2_000 }] },
        { entryDate: '2026-06-06', lines: [{ account: '606', debitCents: 5_000, creditCents: 0 }, { account: '44566', debitCents: 1_000, creditCents: 0 }, { account: '401', debitCents: 0, creditCents: 6_000 }] },
        mv('44567', '44566', 30_000, '2026-06-01'), // report de crédit N-1 — HORS cumul
      ],
    });
    const c = control(review, 'tva');
    expect(c.status).toBe('info');
    // Déductible de période : 1 000 − 30 000 (44566 crédité par le report) = à part du 44567.
    expect(c.detail).toContain(`dont crédit de TVA reporté : ${formatEUR(30_000)}`);
    expect(c.detail).toContain('se référer à la position de TVA de Bob');
    expect(c.detail).not.toContain('à décaisser');
  });

  it('période avec seul avoir : collectée négative dite telle quelle, sans mensonge « déductible > collectée »', () => {
    const review = deriveClosingReview({
      entries: [
        { entryDate: '2026-06-05', lines: [{ account: '706', debitCents: 10_000, creditCents: 0 }, { account: '44571', debitCents: 2_000, creditCents: 0 }, { account: '411', debitCents: 0, creditCents: 12_000 }] },
      ],
    });
    expect(control(review, 'tva').detail).toContain('TVA collectée négative (avoirs nets)');
  });
});

describe('deriveClosingReview — périmètre de période', () => {
  it('les écritures datées hors période sont EXCLUES des états et signalées ; les non datées restent', () => {
    const entries = [
      ...HEALTHY,
      mv('411', '706', 999_999, '2026-07-15'), // hors période : ne doit PAS gonfler le CA
      mv('411', '706', 5_000), // non datée : reste dans les états + signalée
    ];
    const period = { from: '2026-06-01', to: '2026-06-30' };
    const review = deriveClosingReview({ entries, period });

    expect(control(review, 'hors_periode').status).toBe('attention');
    expect(control(review, 'hors_periode').detail).toContain('1 écriture(s) hors de la période');
    expect(control(review, 'ecritures_non_datees').status).toBe('attention');

    const scoped = filterClosingPeriodEntries(entries, period);
    expect(scoped).toHaveLength(entries.length - 1); // seule la datée hors période sort
    // La partie double se contrôle sur le jeu COMPLET (une corruption hors période reste vue).
    const corrupted = [...entries, { entryDate: '2026-08-01', lines: [{ account: '606', debitCents: 100, creditCents: 0 }] }];
    expect(control(deriveClosingReview({ entries: corrupted, period }), 'ecritures_equilibrees').status).toBe('anomalie');
  });

  it('sans période fournie : limitation d’étendue visible (info), jamais un contrôle disparu', () => {
    const review = deriveClosingReview({ entries: HEALTHY });
    expect(control(review, 'hors_periode').status).toBe('info');
    expect(control(review, 'hors_periode').detail).toContain('Non contrôlé');
  });
});

describe('deriveClosingReview — justificatifs', () => {
  it('manquants = attention, proportion significative (> 25 %) dite, incohérence de comptage signalée', () => {
    const base = { entries: HEALTHY };
    expect(control(deriveClosingReview({ ...base, justificatifs: { expected: 10, provided: 10 } }), 'justificatifs').status).toBe('ok');

    const some = control(deriveClosingReview({ ...base, justificatifs: { expected: 10, provided: 9 } }), 'justificatifs');
    expect(some.status).toBe('attention');
    expect(some.detail).not.toContain('significative');

    const many = control(deriveClosingReview({ ...base, justificatifs: { expected: 10, provided: 6 } }), 'justificatifs');
    expect(many.detail).toContain('proportion significative');

    const incoherent = control(deriveClosingReview({ ...base, justificatifs: { expected: 3, provided: 5 } }), 'justificatifs');
    expect(incoherent.status).toBe('attention');
    expect(incoherent.detail).toContain('Comptage incohérent');
  });
});
