import { describe, expect, it } from 'vitest';
import { formatEUR, type QualifiedBankBalanceWithPosition } from '@bob/core';
import { deriveCashPositionDisplay } from './cash-position-view';

const OBSERVED_AT = '2026-07-19T18:00:00.000Z'; // Paris : 19/07/2026 20:00

function balance(
  position: QualifiedBankBalanceWithPosition['position'],
): QualifiedBankBalanceWithPosition {
  return {
    id: 'balance-1',
    companyId: 'company-owner',
    amountCents: 100_000,
    currency: 'EUR',
    source: 'manual_confirmed',
    reconciliationStatus: 'unreconciled',
    observedAt: OBSERVED_AT,
    recordedAt: OBSERVED_AT,
    freshness: {
      status: 'fresh',
      ageSeconds: 60,
      maximumAgeSeconds: 86_400,
      policyVersion: 'bank-balance-freshness/1',
    },
    position,
  } as QualifiedBankBalanceWithPosition;
}

function position(
  overrides: Partial<NonNullable<QualifiedBankBalanceWithPosition['position']>['movements']> = {},
  estimatedBalanceCents = 106_000,
): NonNullable<QualifiedBankBalanceWithPosition['position']> {
  return {
    companyId: 'company-owner',
    observedBalanceCents: 100_000,
    observedAt: OBSERVED_AT,
    observationSource: 'manual_confirmed',
    estimatedAt: '2026-07-20T10:00:00.000Z',
    estimatedBalanceCents,
    movements: {
      inflowCents: 6_000,
      outflowCents: 0,
      netCents: 6_000,
      inflowCount: 1,
      outflowCount: 0,
      ignoredBeforeObservationCount: 0,
      ...overrides,
    },
  };
}

describe('deriveCashPositionDisplay — les DEUX nombres', () => {
  it('expose l’estimé en principal ET conserve le constaté daté en mention', () => {
    const view = deriveCashPositionDisplay({
      balance: balance(position()),
      personality: 'pote',
    });

    expect(view).not.toBeNull();
    expect(view?.estimatedCents).toBe(106_000);
    expect(view?.observedCents).toBe(100_000);
    // Jour métier Europe/Paris : 18:00 UTC le 19/07 = 20:00 à Paris, toujours le 19.
    expect(view?.observedLabel).toContain('19/07/2026');
    expect(view?.observedLabel).toContain(formatEUR(100_000));
    expect(view?.movementsLabel).toContain(formatEUR(6_000));
  });

  it('date au jour PARIS, jamais au jour UTC (23 h UTC = déjà demain en France)', () => {
    const lateEvening = '2026-07-19T22:30:00.000Z'; // Paris : 20/07/2026 00:30
    const view = deriveCashPositionDisplay({
      balance: balance({ ...position(), observedAt: lateEvening }),
      personality: 'pro',
    });

    expect(view?.observedLabel).toContain('20/07/2026');
  });

  it('décline la copy sur les 3 humeurs', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const view = deriveCashPositionDisplay({ balance: balance(position()), personality });
      expect(view?.observedLabel.length).toBeGreaterThan(0);
      expect(view?.movementsLabel.length).toBeGreaterThan(0);
    }
    expect(
      deriveCashPositionDisplay({ balance: balance(position()), personality: 'direct' })
        ?.observedLabel,
    ).toBe(`Constaté ${formatEUR(100_000)} · 19/07/2026`);
  });

  it('sans observation qualifiée : null — l’invitation à saisir le solde reste inchangée', () => {
    expect(deriveCashPositionDisplay({ balance: undefined, personality: 'pote' })).toBeNull();
  });

  it('position null (projection en panne) : null — jamais un estimé partiel', () => {
    expect(deriveCashPositionDisplay({ balance: balance(null), personality: 'pote' })).toBeNull();
  });

  it('aucun mouvement : null — afficher deux fois le même nombre serait du bruit', () => {
    const view = deriveCashPositionDisplay({
      balance: balance(
        position({ inflowCents: 0, outflowCents: 0, netCents: 0, inflowCount: 0, outflowCount: 0 }, 100_000),
      ),
      personality: 'pote',
    });
    expect(view).toBeNull();
  });

  it('des mouvements qui s’annulent restent AFFICHÉS : net nul ≠ rien ne s’est passé', () => {
    const view = deriveCashPositionDisplay({
      balance: balance(
        position(
          { inflowCents: 6_000, outflowCents: 6_000, netCents: 0, inflowCount: 1, outflowCount: 1 },
          100_000,
        ),
      ),
      personality: 'pote',
    });

    expect(view).not.toBeNull();
    expect(view?.estimatedCents).toBe(100_000);
    expect(view?.movementsLabel).toContain(formatEUR(6_000));
  });
});

describe('deriveCashPositionDisplay — champs bruts pour les écrans', () => {
  it('expose le constaté formaté et sa date séparément (aucun écran ne re-parse une phrase)', () => {
    const view = deriveCashPositionDisplay({
      balance: balance(position()),
      personality: 'pote',
    });

    expect(view?.observedAmount).toBe(formatEUR(100_000));
    expect(view?.observedDate).toBe('19/07/2026');
  });
});
