import { type BankBalanceFreshnessPolicy } from '../../domain/banking/bank-balance-freshness';
import { type BankBalanceSource } from '../../domain/banking/bank-balance-snapshot';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type Instant, isValidDateOnly, parisDateOnly } from '../../shared-kernel/time';
import { type BankBalanceSnapshotRepository } from '../ports/bank-balance-snapshot-repository';
import {
  type CashMovement,
  type CashMovementProjectionPort,
} from '../ports/cash-movement-projection';
import { type ClockPort } from '../ports/services';
import { type AppError, appUnavailable } from '../result';
import {
  GetLatestQualifiedBankBalance,
  type QualifiedBankBalanceSnapshot,
} from './get-latest-qualified-bank-balance';

/** Projection minimale d'une observation bancaire DÉJÀ qualifiée fraîche par la politique. */
export interface CashPositionObservation {
  readonly companyId: string;
  /** Solde signé en centimes : un découvert observé reste négatif. */
  readonly amountCents: number;
  readonly source: BankBalanceSource;
  readonly observedAt: Instant;
}

export interface CashPositionMovements {
  readonly inflowCents: number;
  readonly outflowCents: number;
  /** Entrées − sorties retenues : l'écart exact entre le constaté et l'estimé. */
  readonly netCents: number;
  readonly inflowCount: number;
  readonly outflowCount: number;
  /**
   * Mouvements écartés parce qu'ils ne sont pas CERTAINEMENT postérieurs à l'observation.
   * Exposé pour que le support puisse expliquer « pourquoi mon encaissement n'apparaît pas ».
   */
  readonly ignoredBeforeObservationCount: number;
}

export interface CashPosition {
  readonly companyId: string;
  /** Le FAIT : ce que la banque ou le propriétaire a réellement vu. */
  readonly observedBalanceCents: number;
  readonly observedAt: Instant;
  readonly observationSource: BankBalanceSource;
  /** Instant auquel l'estimation a été produite — « constaté le X, estimé le Y » sans recalcul. */
  readonly estimatedAt: Instant;
  /** L'ESTIMATION : constaté + entrées − sorties postérieures. Jamais présentée comme un fait. */
  readonly estimatedBalanceCents: number;
  readonly movements: CashPositionMovements;
}

/**
 * Lecture COMPOSÉE exposée par `GET /bank-balance` : le FAIT bancaire qualifié, augmenté — de façon
 * strictement ADDITIVE — de la position estimée qui en découle.
 *
 * `position: null` n'est JAMAIS « pas de mouvement » (ce cas donne une position avec `netCents: 0`) :
 * c'est l'aveu que la projection des mouvements n'a pas pu être lue. Le client doit alors n'afficher
 * que le solde constaté, tel qu'il l'a toujours fait — jamais un estimé partiel qui serait un
 * mensonge silencieux. On dégrade la RICHESSE de la réponse, jamais son honnêteté, et surtout on ne
 * rend pas illisible le solde qui est précisément le chemin de réparation du tenant.
 */
export interface QualifiedBankBalanceWithPosition extends QualifiedBankBalanceSnapshot {
  readonly position: CashPosition | null;
}

export type CashPositionError =
  | { readonly code: 'INVALID_SCOPE' }
  | { readonly code: 'NO_QUALIFIED_OBSERVATION' }
  | { readonly code: 'OBSERVATION_TENANT_MISMATCH' }
  | { readonly code: 'INVALID_OBSERVATION' }
  | { readonly code: 'INVALID_EVALUATION_INSTANT' }
  | { readonly code: 'INVALID_MOVEMENT'; readonly movementId: string }
  | { readonly code: 'AGGREGATE_OVERFLOW'; readonly movementId: string | null };

/** Époque d'un instant ISO canonique (même exigence que BankBalanceSnapshot), sinon null. */
function canonicalEpoch(value: string): number | null {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString() === value ? epoch : null;
}

/**
 * Position de trésorerie ESTIMÉE = solde constaté + Σ encaissements − Σ décaissements postérieurs.
 *
 * POURQUOI ce use case existe : le solde bancaire est un fait ponctuel (`BankBalanceSnapshot`) qui
 * ne bouge pas quand Bob enregistre un encaissement. Affiché seul, il fait mentir tout l'écran
 * Argent (« payé » mais solde figé) et fausse les projections, l'erreur s'aggravant avec le temps.
 *
 * POURQUOI le filtrage par `observedAt` (règle anti-double-comptage) : le solde constaté contient
 * DÉJÀ tout ce qui a été débité/crédité jusqu'à l'instant d'observation. Ré-ajouter un mouvement
 * antérieur le compterait deux fois. Conséquence heureuse : quand l'artisan ressaisit son solde
 * réel une fois les virements passés, les mouvements sortent naturellement du calcul — aucune
 * compensation ni marquage « déjà rapproché » à maintenir.
 *
 * RÈGLE DE BORDURE — on ne retient que les mouvements dont on est CERTAIN qu'ils sont postérieurs :
 * - précision `instant` : comparaison STRICTE (`>`). À l'instant exact de l'observation, rien ne
 *   prouve que la banque ne l'avait pas déjà pris en compte ;
 * - précision `date` (dépenses : `paidOn` est une DATE sans heure) : le jour doit être STRICTEMENT
 *   postérieur au jour Europe/Paris de l'observation. Un règlement daté du jour même a pu avoir
 *   lieu avant comme après l'observation — on ne devine pas une heure absente.
 * Le jour métier est Europe/Paris (cf. `parisDateOnly`), jamais le jour UTC : à 23 h UTC, la France
 * est déjà au lendemain, et comparer en UTC ferait entrer un règlement du jour même.
 *
 * FAIL-CLOSED : sans observation qualifiée, il n'y a PAS de position. On ne dérive jamais depuis un
 * zéro inventé, conformément à la doctrine `bankingSource: 'none'`.
 */
export function deriveCashPosition(input: {
  readonly companyId: string;
  readonly evaluatedAt: Instant;
  readonly observation: CashPositionObservation | null;
  readonly movements: readonly CashMovement[];
}): Result<CashPosition, CashPositionError> {
  if (input.companyId.trim() !== input.companyId || input.companyId.length === 0) {
    return err({ code: 'INVALID_SCOPE' });
  }
  if (input.observation === null) {
    return err({ code: 'NO_QUALIFIED_OBSERVATION' });
  }
  if (input.observation.companyId !== input.companyId) {
    return err({ code: 'OBSERVATION_TENANT_MISMATCH' });
  }

  const observedEpoch = canonicalEpoch(input.observation.observedAt);
  if (observedEpoch === null || !Number.isSafeInteger(input.observation.amountCents)) {
    return err({ code: 'INVALID_OBSERVATION' });
  }
  const evaluatedEpoch = canonicalEpoch(input.evaluatedAt);
  if (evaluatedEpoch === null || evaluatedEpoch < observedEpoch) {
    return err({ code: 'INVALID_EVALUATION_INSTANT' });
  }

  const observedDay = parisDateOnly(input.observation.observedAt);

  let inflowCents = 0;
  let outflowCents = 0;
  let inflowCount = 0;
  let outflowCount = 0;
  let ignoredBeforeObservationCount = 0;
  // Même mouvement présent deux fois dans la projection (union de deux requêtes, retry) : la
  // position doit rester idempotente. La clé porte la source car les identifiants ne sont uniques
  // que par table.
  const seen = new Set<string>();

  for (const movement of input.movements) {
    // Cloisonnement tenant : un mouvement d'une autre société n'entre jamais dans l'agrégat.
    if (movement.companyId !== input.companyId) continue;

    if (
      movement.id.trim().length === 0 ||
      !Number.isSafeInteger(movement.amountCents) ||
      movement.amountCents <= 0
    ) {
      return err({ code: 'INVALID_MOVEMENT', movementId: movement.id });
    }

    let isAfterObservation: boolean;
    if (movement.occurredAt.precision === 'instant') {
      const movementEpoch = canonicalEpoch(movement.occurredAt.value);
      if (movementEpoch === null) {
        return err({ code: 'INVALID_MOVEMENT', movementId: movement.id });
      }
      isAfterObservation = movementEpoch > observedEpoch;
    } else {
      if (!isValidDateOnly(movement.occurredAt.value)) {
        return err({ code: 'INVALID_MOVEMENT', movementId: movement.id });
      }
      isAfterObservation = movement.occurredAt.value > observedDay;
    }

    const key = `${movement.source}:${movement.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!isAfterObservation) {
      ignoredBeforeObservationCount += 1;
      continue;
    }

    if (movement.direction === 'in') {
      const next = inflowCents + movement.amountCents;
      if (!Number.isSafeInteger(next)) {
        return err({ code: 'AGGREGATE_OVERFLOW', movementId: movement.id });
      }
      inflowCents = next;
      inflowCount += 1;
    } else {
      const next = outflowCents + movement.amountCents;
      if (!Number.isSafeInteger(next)) {
        return err({ code: 'AGGREGATE_OVERFLOW', movementId: movement.id });
      }
      outflowCents = next;
      outflowCount += 1;
    }
  }

  const netCents = inflowCents - outflowCents;
  const estimatedBalanceCents = input.observation.amountCents + netCents;
  if (!Number.isSafeInteger(netCents) || !Number.isSafeInteger(estimatedBalanceCents)) {
    return err({ code: 'AGGREGATE_OVERFLOW', movementId: null });
  }

  return ok({
    companyId: input.companyId,
    observedBalanceCents: input.observation.amountCents,
    observedAt: input.observation.observedAt,
    observationSource: input.observation.source,
    estimatedAt: input.evaluatedAt,
    estimatedBalanceCents,
    movements: {
      inflowCents,
      outflowCents,
      netCents,
      inflowCount,
      outflowCount,
      ignoredBeforeObservationCount,
    },
  });
}

export interface DeriveCashPositionDeps {
  readonly balances: BankBalanceSnapshotRepository;
  readonly movements: CashMovementProjectionPort;
  readonly clock: ClockPort;
  /** Obligatoire : la qualification de fraîcheur n'est jamais contournée par ce use case. */
  readonly freshnessPolicy: BankBalanceFreshnessPolicy;
}

function movementError(error: CashPositionError): AppError {
  switch (error.code) {
    case 'INVALID_SCOPE':
    case 'OBSERVATION_TENANT_MISMATCH':
      return appUnavailable('bank-balance-tenant-scope');
    case 'NO_QUALIFIED_OBSERVATION':
      return appUnavailable('cash-position-observation');
    case 'INVALID_OBSERVATION':
    case 'INVALID_EVALUATION_INSTANT':
      return appUnavailable('bank-balance-qualification');
    default:
      return appUnavailable('cash-position-movements');
  }
}

/**
 * Compose l'observation bancaire QUALIFIÉE (fraîcheur incluse) avec les mouvements postérieurs.
 *
 * La politique de fraîcheur est appliquée en amont par `GetLatestQualifiedBankBalance` : une
 * observation absente ou périmée court-circuite la lecture des mouvements. On ne construit jamais
 * une estimation sur une ancre qui n'a pas le droit d'être présentée comme le solde courant.
 */
export class DeriveCashPosition {
  private readonly qualifiedBalance: GetLatestQualifiedBankBalance;

  constructor(private readonly deps: DeriveCashPositionDeps) {
    this.qualifiedBalance = new GetLatestQualifiedBankBalance({
      balances: deps.balances,
      clock: deps.clock,
      freshnessPolicy: deps.freshnessPolicy,
    });
  }

  async execute(input: { companyId: string }): Promise<Result<CashPosition, AppError>> {
    const observation = await this.qualifiedBalance.execute({ companyId: input.companyId });
    if (!observation.ok) return observation;

    let movements: readonly CashMovement[];
    try {
      movements = await this.deps.movements.listSinceObservation({
        companyId: input.companyId,
        observedAt: observation.value.observedAt,
      });
    } catch (cause) {
      return err({
        kind: 'dependency',
        port: 'cash-movement-projection',
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    const position = deriveCashPosition({
      companyId: input.companyId,
      evaluatedAt: this.deps.clock.now(),
      observation: {
        companyId: observation.value.companyId,
        amountCents: observation.value.amountCents,
        source: observation.value.source,
        observedAt: observation.value.observedAt,
      },
      movements,
    });
    if (!position.ok) return err(movementError(position.error));
    return position;
  }
}
