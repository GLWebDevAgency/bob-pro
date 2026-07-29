import { describe, expect, it } from 'vitest';
import {
  clampedAnniversary,
  currentPeriod,
  currentPeriodIndex,
  deriveAnnualBillingDue,
  deriveContractLifecycleFacts,
  deriveRenewalAlerts,
  periodAt,
  periodCoverage,
  type ContractInvoiceProjection,
  type ContractScheduleData,
} from './derive-contract-schedule';

function contract(overrides: Partial<ContractScheduleData> = {}): ContractScheduleData {
  return {
    status: 'active',
    anniversaryDate: '2025-10-12',
    tacitRenewal: true,
    importCoveredUntil: null,
    terminationEffectiveDate: null,
    ...overrides,
  };
}

/** Facture émise couvrant EXACTEMENT la période n — bornes de service HUMAINES (fin
 * INCLUSIVE = veille de la borne exclusive, écrans amélioration 5 : « 12 oct. 2025 →
 * 11 oct. 2026 »). Une fin posée sur la borne exclusive mordrait la période suivante. */
function issuedFor(n: number, anniversary = '2025-10-12', number = `F-202${5 + n}-0791`): ContractInvoiceProjection {
  const period = periodAt(anniversary, n);
  const endExclusive = clampedAnniversary(anniversary, n + 1);
  const lastDay = new Date(Date.parse(`${endExclusive}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    id: `invoice-${n}`,
    number,
    kind: 'final',
    status: 'issued',
    servicePeriodStart: period.start,
    servicePeriodEnd: lastDay,
  };
}

describe('période arithmétique — encadrement clampé (annexe erratum n° 5)', () => {
  it('années 1..5 : aucun trou, aucun chevauchement, bornes exclusives', () => {
    for (let n = 0; n < 5; n += 1) {
      const period = periodAt('2025-10-12', n);
      const next = periodAt('2025-10-12', n + 1);
      expect(period.end).toBe(next.start);
      // Dernier jour de la période n : index encore n ; premier jour de n+1 : index n+1.
      expect(currentPeriodIndex('2025-10-12', `${2025 + n + 1}-10-11`)).toBe(n);
      expect(currentPeriodIndex('2025-10-12', period.end)).toBe(n + 1);
    }
  });

  it('contrat au 29/02/2028 : au jour anniversaire clampé 28/02/2029, N passe à 1 — ni trou ni chevauchement', () => {
    expect(clampedAnniversary('2028-02-29', 1)).toBe('2029-02-28');
    // Veille du clamp : encore la période initiale.
    expect(currentPeriodIndex('2028-02-29', '2029-02-27')).toBe(0);
    // Jour anniversaire CLAMPÉ d'une année non bissextile : période suivante (un floor d'années
    // séparé rendrait 0 et laisserait le 28/02 hors de toute période — le trou d'un jour).
    expect(currentPeriodIndex('2028-02-29', '2029-02-28')).toBe(1);
    expect(periodAt('2028-02-29', 0)).toEqual({ start: '2028-02-29', end: '2029-02-28' });
    // Le 29/02 RESSURGIT à l'année bissextile suivante (calcul depuis la date ORIGINELLE).
    expect(clampedAnniversary('2028-02-29', 4)).toBe('2032-02-29');
  });

  it('avant anniversaryDate : la première période est retournée (contrats migrés à départ futur)', () => {
    expect(currentPeriod(contract(), '2025-09-20')).toEqual({ start: '2025-10-12', end: '2026-10-12' });
  });

  it('non-tacite : il n’existe QUE la période initiale, puis null + fait expired (P14)', () => {
    const nonTacit = contract({ tacitRenewal: false });
    expect(currentPeriod(nonTacit, '2026-05-01')).toEqual({ start: '2025-10-12', end: '2026-10-12' });
    expect(currentPeriod(nonTacit, '2026-10-12')).toBeNull();
    const facts = deriveContractLifecycleFacts(nonTacit, '2026-11-01');
    expect(facts.expired).toEqual({ since: '2026-10-12' });
    expect(facts.renewals).toEqual([]);
  });

  it('résilié : les périodes s’arrêtent à terminationEffectiveDate (fin clippée puis null)', () => {
    const terminated = contract({ status: 'terminated', terminationEffectiveDate: '2026-06-01' });
    expect(currentPeriod(terminated, '2026-05-01')).toEqual({ start: '2025-10-12', end: '2026-06-01' });
    expect(currentPeriod(terminated, '2026-06-01')).toBeNull();
    expect(deriveContractLifecycleFacts(terminated, '2026-07-01').terminatedCoverage).toEqual({
      until: '2026-06-01',
    });
  });

  it('reconductions tacites DÉRIVÉES : un anniversaire passé par an, jamais après la résiliation', () => {
    expect(deriveContractLifecycleFacts(contract(), '2028-01-05').renewals).toEqual([
      '2026-10-12',
      '2027-10-12',
    ]);
    const terminated = contract({ status: 'terminated', terminationEffectiveDate: '2027-01-01' });
    expect(deriveContractLifecycleFacts(terminated, '2028-01-05').renewals).toEqual(['2026-10-12']);
  });
});

describe('couverture dérivée des factures réelles (direction 1)', () => {
  const period = periodAt('2025-10-12', 0);

  it('une facture ÉMISE qui chevauche couvre ; un BROUILLON ne couvre rien', () => {
    expect(periodCoverage(contract(), period, [issuedFor(0)])).toEqual({
      kind: 'covered',
      by: 'invoice',
      number: 'F-2025-0791',
    });
    expect(
      periodCoverage(contract(), period, [{ ...issuedFor(0), status: 'draft' }]).kind,
    ).toBe('uncovered');
  });

  it('une facture ANNULÉE ne couvre plus — réallumage avec le numéro cité', () => {
    const coverage = periodCoverage(contract(), period, [{ ...issuedFor(0), status: 'cancelled' }]);
    expect(coverage).toEqual({ kind: 'uncovered', cancelledCoveringNumber: 'F-2025-0791' });
  });

  it('un AVOIR ne couvre jamais (il rectifie, il ne facture pas)', () => {
    expect(
      periodCoverage(contract(), period, [{ ...issuedFor(0), kind: 'credit_note' }]).kind,
    ).toBe('uncovered');
  });

  it('chevauchement partiel/à cheval : une pièce qui mord la période la couvre', () => {
    const straddling: ContractInvoiceProjection = {
      id: 'inv-straddle',
      number: 'F-2026-0001',
      kind: 'final',
      status: 'issued',
      servicePeriodStart: '2026-09-01',
      servicePeriodEnd: '2027-01-31',
    };
    expect(periodCoverage(contract(), period, [straddling]).kind).toBe('covered');
    // Adjacente SANS chevauchement (commence le jour de fin EXCLUSIVE) : ne couvre pas.
    const adjacent: ContractInvoiceProjection = {
      ...straddling,
      id: 'inv-adjacent',
      servicePeriodStart: '2026-10-12',
      servicePeriodEnd: '2027-10-11',
    };
    expect(periodCoverage(contract(), period, [adjacent]).kind).toBe('uncovered');
  });

  it('projection MUETTE (statut ou période non transportés) → unknown, jamais une alerte', () => {
    expect(periodCoverage(contract(), period, [{ id: 'x' }]).kind).toBe('unknown');
    expect(
      periodCoverage(contract(), period, [{ id: 'x', status: 'issued' }]).kind,
    ).toBe('unknown');
    expect(
      deriveAnnualBillingDue(contract(), [{ id: 'x' }], '2026-01-05'),
    ).toBeNull();
  });

  it('[P13] importCoveredUntil EXCLUSIF éteint les périodes migrées, pas la suivante', () => {
    const migrated = contract({ importCoveredUntil: '2026-10-12' });
    expect(periodCoverage(migrated, periodAt('2025-10-12', 0), []).kind).toBe('covered');
    expect(periodCoverage(migrated, periodAt('2025-10-12', 1), []).kind).toBe('uncovered');
  });
});

describe('deriveAnnualBillingDue — fenêtre −30 j VIVANTE toutes les années (erratum n° 3)', () => {
  it('année 1 : due dès J−30 du début, pas avant', () => {
    expect(deriveAnnualBillingDue(contract(), [], '2025-09-11')).toBeNull();
    expect(deriveAnnualBillingDue(contract(), [], '2025-09-12')).toEqual({
      period: { start: '2025-10-12', end: '2026-10-12' },
      cancelledCoveringNumber: null,
    });
  });

  it('années 2..5 : à J−30 de chaque anniversaire, la période SUIVANTE devient proposable', () => {
    for (let year = 1; year <= 4; year += 1) {
      const invoices = Array.from({ length: year }, (_, n) => issuedFor(n));
      const nextStart = clampedAnniversary('2025-10-12', year);
      const windowOpen = `${2025 + year}-09-12`; // J−30 exact de l'anniversaire 12/10
      const beforeWindow = `${2025 + year}-09-11`;
      expect(deriveAnnualBillingDue(contract(), invoices, beforeWindow)).toBeNull();
      const due = deriveAnnualBillingDue(contract(), invoices, windowOpen);
      expect(due).not.toBeNull();
      expect(due!.period.start).toBe(nextStart);
    }
  });

  it('période courante couverte + suivante déjà facturée → rien (extinction par l’état réel)', () => {
    expect(
      deriveAnnualBillingDue(contract(), [issuedFor(0), issuedFor(1)], '2026-09-20'),
    ).toBeNull();
  });

  it('réallumage : la facture couvrante annulée rend la période courante due, numéro cité', () => {
    const due = deriveAnnualBillingDue(
      contract(),
      [{ ...issuedFor(0), status: 'cancelled' }],
      '2026-01-05',
    );
    expect(due).toEqual({
      period: { start: '2025-10-12', end: '2026-10-12' },
      cancelledCoveringNumber: 'F-2025-0791',
    });
  });

  it('non-tacite : jamais de période suivante proposée ; résilié/brouillon : null', () => {
    expect(
      deriveAnnualBillingDue(contract({ tacitRenewal: false }), [issuedFor(0)], '2026-09-20'),
    ).toBeNull();
    expect(
      deriveAnnualBillingDue(
        contract({ status: 'terminated', terminationEffectiveDate: '2026-06-01' }),
        [],
        '2026-05-01',
      ),
    ).toBeNull();
    expect(deriveAnnualBillingDue(contract({ status: 'draft' }), [], '2026-01-05')).toBeNull();
  });
});

describe('deriveRenewalAlerts — J-60/J-30, palier le plus récent seulement (amélioration 14)', () => {
  it('fenêtres : J-60 → j60, J-30 → j30, passé/lointain → null', () => {
    // Anniversaire suivant : 2026-10-12. À J−61 : trop tôt ; à J−60 exact : palier j60.
    expect(deriveRenewalAlerts(contract(), '2026-08-12')).toBeNull();
    expect(deriveRenewalAlerts(contract(), '2026-08-13')).toMatchObject({ palier: 'j60', daysUntil: 60 });
    expect(deriveRenewalAlerts(contract(), '2026-09-15')).toMatchObject({
      palier: 'j30',
      anniversary: '2026-10-12',
      tacit: true,
    });
    expect(deriveRenewalAlerts(contract(), '2026-06-01')).toBeNull();
    expect(deriveRenewalAlerts(contract(), '2026-10-12')).toBeNull();
  });

  it('rattrapage : à J-25 après une panne, SEUL j30 est pertinent (jamais j60 ET j30)', () => {
    const alert = deriveRenewalAlerts(contract(), '2026-09-17');
    expect(alert?.palier).toBe('j30');
  });

  it('la fenêtre vit TOUTES les années (année 3 : alerte sur l’anniversaire 2028)', () => {
    expect(deriveRenewalAlerts(contract(), '2028-09-20')).toMatchObject({
      palier: 'j30',
      anniversary: '2028-10-12',
    });
  });

  it('non-tacite : « arrive à échéance » avant l’échéance unique, puis extinction', () => {
    const nonTacit = contract({ tacitRenewal: false });
    expect(deriveRenewalAlerts(nonTacit, '2026-09-15')).toMatchObject({
      palier: 'j30',
      anniversary: '2026-10-12',
      tacit: false,
    });
    // Après l'échéance : plus d'alerte de palier — le fait expired prend le relais.
    expect(deriveRenewalAlerts(nonTacit, '2026-10-13')).toBeNull();
  });

  it('extinction si résilié', () => {
    expect(
      deriveRenewalAlerts(
        contract({ status: 'terminated', terminationEffectiveDate: '2026-10-12' }),
        '2026-09-15',
      ),
    ).toBeNull();
  });
});
