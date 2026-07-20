import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';

export const BANK_BALANCE_SOURCES = [
  'manual_confirmed',
  'bank_statement',
  'bank_connector',
] as const;

export type BankBalanceSource = (typeof BANK_BALANCE_SOURCES)[number];

export const BANK_BALANCE_RECONCILIATION_STATUSES = [
  'unreconciled',
  'partially_reconciled',
  'reconciled',
] as const;

export type BankBalanceReconciliationStatus = (typeof BANK_BALANCE_RECONCILIATION_STATUSES)[number];

export interface BankBalanceSnapshotProps {
  readonly id: string;
  readonly companyId: string;
  /** Solde bancaire signé en centimes. Un découvert est donc négatif. */
  readonly amountCents: number;
  readonly currency: 'EUR';
  readonly source: BankBalanceSource;
  readonly reconciliationStatus: BankBalanceReconciliationStatus;
  /** Instant auquel la banque ou le propriétaire a effectivement observé ce solde. */
  readonly observedAt: Instant;
  /** Instant d'enregistrement immuable côté Bob, fourni par l'horloge serveur. */
  readonly recordedAt: Instant;
}

function validation(field: string, message: string): DomainResult<never> {
  return err({ code: 'VALIDATION', field, message });
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 128 &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  );
}

function instantEpoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString() === value ? epoch : null;
}

/**
 * Capture append-only d'un solde bancaire réellement observé pour un tenant.
 *
 * La fraîcheur n'est volontairement pas stockée : elle dépend de l'instant de lecture et de la
 * politique versionnée appliquée. `observedAt` ne peut jamais être remplacé par `recordedAt`, sous
 * peine de rendre artificiellement récent un relevé ancien importé aujourd'hui.
 */
export class BankBalanceSnapshot {
  private constructor(private readonly props: BankBalanceSnapshotProps) {}

  static record(props: BankBalanceSnapshotProps): DomainResult<BankBalanceSnapshot> {
    if (!isIdentifier(props.id)) {
      return validation('id', 'Identifiant de snapshot bancaire invalide.');
    }
    if (!isIdentifier(props.companyId)) {
      return validation('companyId', 'Identifiant de société invalide.');
    }
    if (!Number.isSafeInteger(props.amountCents)) {
      return validation('amountCents', 'Le solde doit être un entier signé de centimes sûr.');
    }
    if (props.currency !== 'EUR') {
      return validation('currency', 'Seuls les soldes bancaires en EUR sont acceptés.');
    }
    if (!(BANK_BALANCE_SOURCES as readonly unknown[]).includes(props.source)) {
      return validation('source', 'Source du solde bancaire invalide.');
    }
    if (
      !(BANK_BALANCE_RECONCILIATION_STATUSES as readonly unknown[]).includes(
        props.reconciliationStatus,
      )
    ) {
      return validation('reconciliationStatus', 'Statut de rapprochement bancaire invalide.');
    }

    const observedEpoch = instantEpoch(props.observedAt);
    if (observedEpoch === null) {
      return validation('observedAt', 'Instant d’observation invalide ou non canonique.');
    }
    const recordedEpoch = instantEpoch(props.recordedAt);
    if (recordedEpoch === null) {
      return validation('recordedAt', 'Instant d’enregistrement invalide ou non canonique.');
    }
    if (observedEpoch > recordedEpoch) {
      return validation('observedAt', 'Le solde ne peut pas être observé dans le futur.');
    }

    return ok(new BankBalanceSnapshot({ ...props }));
  }

  get id(): string {
    return this.props.id;
  }

  get companyId(): string {
    return this.props.companyId;
  }

  get source(): BankBalanceSource {
    return this.props.source;
  }

  get observedAt(): Instant {
    return this.props.observedAt;
  }

  toProps(): BankBalanceSnapshotProps {
    return { ...this.props };
  }
}
