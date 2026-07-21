import { describe, expect, it } from 'vitest';
import { BANK_BALANCE_FRESHNESS_POLICY_V1 } from '../../domain/banking/bank-balance-freshness';
import {
  BankBalanceSnapshot,
  type BankBalanceSnapshotProps,
} from '../../domain/banking/bank-balance-snapshot';
import { type BankBalanceSnapshotRepository } from '../ports/bank-balance-snapshot-repository';
import {
  type CashMovement,
  type CashMovementProjectionPort,
} from '../ports/cash-movement-projection';
import {
  DeriveCashPosition,
  deriveCashPosition,
  type CashPositionObservation,
} from './derive-cash-position';

const OBSERVED_AT = '2026-07-17T08:00:00.000Z';
const EVALUATED_AT = '2026-07-17T18:00:00.000Z';

function observation(patch: Partial<CashPositionObservation> = {}): CashPositionObservation {
  return {
    companyId: 'company-1',
    amountCents: 250_000,
    source: 'manual_confirmed',
    observedAt: OBSERVED_AT,
    ...patch,
  };
}

function encaissement(patch: Partial<CashMovement> = {}): CashMovement {
  return {
    id: 'payment-1',
    companyId: 'company-1',
    source: 'invoice_payment',
    direction: 'in',
    amountCents: 6_000,
    occurredAt: { precision: 'instant', value: '2026-07-17T09:00:00.000Z' },
    ...patch,
  };
}

function decaissement(patch: Partial<CashMovement> = {}): CashMovement {
  return {
    id: 'expense-1',
    companyId: 'company-1',
    source: 'expense_settlement',
    direction: 'out',
    amountCents: 2_500,
    occurredAt: { precision: 'date', value: '2026-07-18' },
    ...patch,
  };
}

function derive(input: {
  movements: readonly CashMovement[];
  observation?: CashPositionObservation | null;
  companyId?: string;
  evaluatedAt?: string;
}) {
  return deriveCashPosition({
    companyId: input.companyId ?? 'company-1',
    evaluatedAt: input.evaluatedAt ?? EVALUATED_AT,
    observation: input.observation === undefined ? observation() : input.observation,
    movements: input.movements,
  });
}

describe('deriveCashPosition — position estimée depuis un fait bancaire observé', () => {
  it('ajoute les encaissements et retranche les décaissements postérieurs à l’observation', () => {
    const result = derive({ movements: [encaissement(), decaissement()] });

    expect(result).toEqual({
      ok: true,
      value: {
        companyId: 'company-1',
        observedBalanceCents: 250_000,
        observedAt: OBSERVED_AT,
        observationSource: 'manual_confirmed',
        estimatedAt: EVALUATED_AT,
        estimatedBalanceCents: 253_500,
        movements: {
          inflowCents: 6_000,
          outflowCents: 2_500,
          netCents: 3_500,
          inflowCount: 1,
          outflowCount: 1,
          ignoredBeforeObservationCount: 0,
        },
      },
    });
  });

  it('reproduit le cas fondateur : la facture de 60 € encaissée bouge enfin le solde', () => {
    const result = derive({
      observation: observation({ amountCents: 0 }),
      movements: [encaissement({ amountCents: 6_000 })],
    });

    expect(result.ok && result.value.estimatedBalanceCents).toBe(6_000);
  });

  it('ignore un mouvement ANTÉRIEUR à l’observation — il est déjà dans le solde constaté', () => {
    const result = derive({
      movements: [
        encaissement({
          id: 'payment-old',
          occurredAt: { precision: 'instant', value: '2026-07-17T07:59:59.999Z' },
        }),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        estimatedBalanceCents: 250_000,
        movements: { inflowCents: 0, inflowCount: 0, ignoredBeforeObservationCount: 1 },
      },
    });
  });

  it('exclut la bordure exacte : un mouvement à l’instant même de l’observation ne compte pas', () => {
    const result = derive({
      movements: [encaissement({ occurredAt: { precision: 'instant', value: OBSERVED_AT } })],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        estimatedBalanceCents: 250_000,
        movements: { inflowCount: 0, ignoredBeforeObservationCount: 1 },
      },
    });
  });

  it('exclut un mouvement DATE SEULE du jour de l’observation : l’heure est inconnue', () => {
    const result = derive({
      movements: [decaissement({ occurredAt: { precision: 'date', value: '2026-07-17' } })],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        estimatedBalanceCents: 250_000,
        movements: { outflowCents: 0, outflowCount: 0, ignoredBeforeObservationCount: 1 },
      },
    });
  });

  it('borne les dates seules sur le jour Europe/Paris, pas sur le jour UTC', () => {
    // 23h00 UTC le 17 = déjà le 18 à Paris : un règlement daté du 18 n’est PAS certainement postérieur.
    const result = derive({
      observation: observation({ observedAt: '2026-07-17T23:00:00.000Z' }),
      evaluatedAt: '2026-07-19T09:00:00.000Z',
      movements: [
        decaissement({ occurredAt: { precision: 'date', value: '2026-07-18' } }),
        decaissement({ id: 'expense-2', occurredAt: { precision: 'date', value: '2026-07-19' } }),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        movements: { outflowCents: 2_500, outflowCount: 1, ignoredBeforeObservationCount: 1 },
      },
    });
  });

  it('n’agrège jamais le mouvement d’un autre tenant', () => {
    const result = derive({
      movements: [encaissement(), encaissement({ id: 'payment-x', companyId: 'company-2' })],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { estimatedBalanceCents: 256_000, movements: { inflowCents: 6_000, inflowCount: 1 } },
    });
  });

  it('refuse fail-closed une observation appartenant à un autre tenant', () => {
    const result = derive({
      observation: observation({ companyId: 'company-2' }),
      movements: [],
    });

    expect(result).toEqual({ ok: false, error: { code: 'OBSERVATION_TENANT_MISMATCH' } });
  });

  it('ne compte qu’une fois un mouvement présent deux fois dans la projection', () => {
    const result = derive({ movements: [encaissement(), encaissement()] });

    expect(result).toMatchObject({
      ok: true,
      value: { estimatedBalanceCents: 256_000, movements: { inflowCents: 6_000, inflowCount: 1 } },
    });
  });

  it('distingue deux mouvements de même identifiant mais de sources différentes', () => {
    const result = derive({
      movements: [encaissement({ id: 'shared-id' }), decaissement({ id: 'shared-id' })],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { movements: { inflowCount: 1, outflowCount: 1 } },
    });
  });

  it('sans observation qualifiée, il n’y a PAS de position — jamais un zéro inventé', () => {
    const result = derive({ observation: null, movements: [encaissement()] });

    expect(result).toEqual({ ok: false, error: { code: 'NO_QUALIFIED_OBSERVATION' } });
  });

  it('refuse un périmètre de tenant vide', () => {
    const result = derive({ companyId: '', movements: [] });

    expect(result).toEqual({ ok: false, error: { code: 'INVALID_SCOPE' } });
  });

  it('refuse une observation dont l’instant n’est pas canonique', () => {
    const result = derive({
      observation: observation({ observedAt: '17/07/2026' }),
      movements: [],
    });

    expect(result).toEqual({ ok: false, error: { code: 'INVALID_OBSERVATION' } });
  });

  it('refuse un instant d’évaluation antérieur à l’observation', () => {
    const result = derive({ evaluatedAt: '2026-07-17T07:00:00.000Z', movements: [] });

    expect(result).toEqual({ ok: false, error: { code: 'INVALID_EVALUATION_INSTANT' } });
  });

  it('refuse un montant de mouvement non entier, nul ou négatif', () => {
    for (const amountCents of [0, -1, 12.5]) {
      expect(derive({ movements: [encaissement({ amountCents })] })).toEqual({
        ok: false,
        error: { code: 'INVALID_MOVEMENT', movementId: 'payment-1' },
      });
    }
  });

  it('refuse un horodatage de mouvement invalide plutôt que de le deviner', () => {
    expect(
      derive({
        movements: [encaissement({ occurredAt: { precision: 'instant', value: 'hier' } })],
      }),
    ).toEqual({ ok: false, error: { code: 'INVALID_MOVEMENT', movementId: 'payment-1' } });

    expect(
      derive({
        movements: [decaissement({ occurredAt: { precision: 'date', value: '2026-02-30' } })],
      }),
    ).toEqual({ ok: false, error: { code: 'INVALID_MOVEMENT', movementId: 'expense-1' } });
  });

  it('signale un dépassement d’agrégat au lieu de rendre un montant faux', () => {
    const result = derive({
      movements: [
        encaissement({ amountCents: Number.MAX_SAFE_INTEGER }),
        encaissement({ id: 'payment-2', amountCents: Number.MAX_SAFE_INTEGER }),
      ],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'AGGREGATE_OVERFLOW', movementId: 'payment-2' },
    });
  });

  it('assume un découvert : la position estimée reste signée', () => {
    const result = derive({
      observation: observation({ amountCents: 1_000 }),
      movements: [decaissement({ amountCents: 4_000 })],
    });

    expect(result.ok && result.value.estimatedBalanceCents).toBe(-3_000);
  });
});

function snapshot(patch: Partial<BankBalanceSnapshotProps> = {}): BankBalanceSnapshot {
  const result = BankBalanceSnapshot.record({
    id: 'balance-1',
    companyId: 'company-1',
    amountCents: 250_000,
    currency: 'EUR',
    source: 'manual_confirmed',
    reconciliationStatus: 'unreconciled',
    observedAt: OBSERVED_AT,
    recordedAt: OBSERVED_AT,
    ...patch,
  });
  if (!result.ok) throw new Error('Donnée de test invalide.');
  return result.value;
}

class BalanceRepository implements BankBalanceSnapshotRepository {
  latest: BankBalanceSnapshot | null = null;

  async append(): Promise<'created'> {
    return 'created';
  }

  async findLatestByCompanyId(): Promise<BankBalanceSnapshot | null> {
    return this.latest;
  }
}

class MovementProjection implements CashMovementProjectionPort {
  calls: { companyId: string; observedAt: string }[] = [];
  movements: readonly CashMovement[] = [];
  failure: Error | null = null;

  async listSinceObservation(input: {
    companyId: string;
    observedAt: string;
  }): Promise<readonly CashMovement[]> {
    this.calls.push({ ...input });
    if (this.failure !== null) throw this.failure;
    return this.movements;
  }
}

function useCase(
  balances: BalanceRepository,
  movements: MovementProjection,
  now = EVALUATED_AT,
): DeriveCashPosition {
  return new DeriveCashPosition({
    balances,
    movements,
    clock: { now: () => now, today: () => now.slice(0, 10) },
    freshnessPolicy: BANK_BALANCE_FRESHNESS_POLICY_V1,
  });
}

describe('DeriveCashPosition — composition avec la politique de fraîcheur', () => {
  it('compose le solde qualifié et les mouvements postérieurs du tenant', async () => {
    const balances = new BalanceRepository();
    balances.latest = snapshot();
    const movements = new MovementProjection();
    movements.movements = [encaissement(), decaissement()];

    const result = await useCase(balances, movements).execute({ companyId: 'company-1' });

    expect(result).toEqual({
      ok: true,
      value: {
        companyId: 'company-1',
        observedBalanceCents: 250_000,
        observedAt: OBSERVED_AT,
        observationSource: 'manual_confirmed',
        estimatedAt: EVALUATED_AT,
        estimatedBalanceCents: 253_500,
        movements: {
          inflowCents: 6_000,
          outflowCents: 2_500,
          netCents: 3_500,
          inflowCount: 1,
          outflowCount: 1,
          ignoredBeforeObservationCount: 0,
        },
      },
    });
    expect(movements.calls).toEqual([{ companyId: 'company-1', observedAt: OBSERVED_AT }]);
  });

  it('n’interroge jamais les mouvements sans observation qualifiée', async () => {
    const balances = new BalanceRepository();
    const movements = new MovementProjection();

    const result = await useCase(balances, movements).execute({ companyId: 'company-1' });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'bank_balance_snapshot', id: 'company-1' },
    });
    expect(movements.calls).toEqual([]);
  });

  it('ne contourne pas la politique de fraîcheur : observation périmée = indisponible', async () => {
    const balances = new BalanceRepository();
    balances.latest = snapshot();
    const movements = new MovementProjection();
    movements.movements = [encaissement()];

    // manual_confirmed : 24 h de validité, dépassées d’une seconde.
    const result = await useCase(balances, movements, '2026-07-18T08:00:01.000Z').execute({
      companyId: 'company-1',
    });

    expect(result).toEqual({ ok: false, error: { kind: 'unavailable', service: 'bank-balance-stale' } });
    expect(movements.calls).toEqual([]);
  });

  it('rend une panne de projection explicite', async () => {
    const balances = new BalanceRepository();
    balances.latest = snapshot();
    const movements = new MovementProjection();
    movements.failure = new Error('projection offline');

    const result = await useCase(balances, movements).execute({ companyId: 'company-1' });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'dependency', port: 'cash-movement-projection', cause: 'projection offline' },
    });
  });

  it('refuse fail-closed une projection qui laisse fuiter un autre tenant', async () => {
    const balances = new BalanceRepository();
    balances.latest = snapshot();
    const movements = new MovementProjection();
    movements.movements = [encaissement({ id: 'payment-x', companyId: 'company-2' })];

    const result = await useCase(balances, movements).execute({ companyId: 'company-1' });

    expect(result).toMatchObject({
      ok: true,
      value: { estimatedBalanceCents: 250_000, movements: { inflowCount: 0 } },
    });
  });

  it('transforme une projection incohérente en indisponibilité, jamais en montant faux', async () => {
    const balances = new BalanceRepository();
    balances.latest = snapshot();
    const movements = new MovementProjection();
    movements.movements = [encaissement({ amountCents: -1 })];

    const result = await useCase(balances, movements).execute({ companyId: 'company-1' });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'cash-position-movements' },
    });
  });
});
