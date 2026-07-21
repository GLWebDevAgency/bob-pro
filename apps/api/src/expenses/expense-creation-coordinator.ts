import {
  RecordExpense,
  RecordExpenseAccountingEntries,
  appConflict,
  err,
  ok,
  type AppError,
  type ClockPort,
  type DocumentLinkTargetPort,
  type ExpenseProps,
  type IdGeneratorPort,
  type RecordExpenseAccountingEntriesOutput,
  type RecordExpenseInput,
  type Result,
} from '@bob/core';
import { DuplicateExpenseInvoiceError } from '../persistence/expense-duplicate-error';
import {
  expenseCreationFingerprint,
  InvalidExpenseCreationRequestError,
  type ExpenseCreationFingerprint,
} from '../persistence/expense-creation-requests';
import type { Persistence } from '../persistence/persistence';

const ROOT_ATTEMPTS = 2;

export interface ExpenseCreationCoordinatorInput {
  readonly companyId: string;
  readonly expense: Omit<RecordExpenseInput, 'companyId'>;
}

export interface ExpenseCreationTransactionContext {
  readonly companyId: string;
  readonly expenseId: string;
  /** Snapshot normalisé de l'agrégat, relu dans la transaction courante. */
  readonly expense: ExpenseProps;
  readonly accounting: RecordExpenseAccountingEntriesOutput;
}

/**
 * Le callback participe à la même transaction que la dépense et ses écritures.
 *
 * Il est aussi exécuté lors d'un replay idempotent : il DOIT donc converger de façon idempotente
 * (par exemple : déjà lié à cette dépense => succès, autre lien => conflit, sinon CAS).
 */
export type ExpenseCreationAtomicFollowUp<T> = (
  context: ExpenseCreationTransactionContext,
) => Promise<Result<T, AppError>>;

export interface ExpenseCreationCoordinatorOutput<T> {
  readonly expenseId: string;
  /** Métadonnée post-commit : false sur replay, afin de ne pas doubler audit et apprentissage. */
  readonly created: boolean;
  readonly accounting: RecordExpenseAccountingEntriesOutput;
  readonly followUp: T;
}

export type ExpenseCreationCoordinatorPersistence = Pick<
  Persistence,
  | 'companies'
  | 'expenses'
  | 'expenseCreationRequests'
  | 'accountingEntries'
  | 'chartOfAccounts'
  | 'runInTransaction'
  | 'runWithTenant'
>;

export interface ExpenseCreationCoordinatorDependencies {
  readonly persistence: ExpenseCreationCoordinatorPersistence;
  readonly ids: IdGeneratorPort;
  readonly clock: ClockPort;
  /**
   * Preuve d'existence tenant-scoped d'un chantier visé (anti-IDOR, même port que le coffre).
   * REQUISE dès qu'une création porte un `chantierId` : sans port, RecordExpense (@bob/core)
   * refuse la création en `dependency` (fail-closed — jamais un lien non vérifié en base).
   */
  readonly chantierTargets?: DocumentLinkTargetPort;
}

class ExpenseCreationTransactionAborted extends Error {
  constructor(readonly appError: AppError) {
    super('expense-creation-transaction-aborted');
    this.name = 'ExpenseCreationTransactionAborted';
  }
}

/** Doit traverser runInTransaction ET runWithTenant pour garantir le rollback du candidat. */
class ExpenseCreationClaimLost extends Error {
  constructor() {
    super('expense-creation-claim-lost');
    this.name = 'ExpenseCreationClaimLost';
  }
}

function abort(appError: AppError): never {
  throw new ExpenseCreationTransactionAborted(appError);
}

function idempotencyDependency(cause: string): AppError {
  return { kind: 'dependency', port: 'expense-creation-idempotency', cause };
}

function invalidIdempotencyKey(): AppError {
  return {
    kind: 'validation',
    issues: [{ field: 'idempotencyKey', message: "Clé d'idempotence invalide (1 à 200 caractères imprimables)." }],
  };
}

function duplicateInvoice(error: DuplicateExpenseInvoiceError): AppError {
  return {
    kind: 'validation',
    issues: [{ field: 'facturx.doublon', message: error.message }],
  };
}

/**
 * Autorité serveur unique de création d'une dépense.
 *
 * La racine tenant englobe explicitement la transaction. Un conflit de publication idempotente
 * ressort entièrement de cette racine, puis le workflow complet est rejoué une seule fois afin
 * que le callback atomique converge lui aussi sur la dépense gagnante.
 */
export class ExpenseCreationCoordinator {
  constructor(private readonly deps: ExpenseCreationCoordinatorDependencies) {}

  async execute<T = undefined>(
    input: ExpenseCreationCoordinatorInput,
    followUp?: ExpenseCreationAtomicFollowUp<T>,
  ): Promise<Result<ExpenseCreationCoordinatorOutput<T>, AppError>> {
    let fingerprint: ExpenseCreationFingerprint | null;
    try {
      fingerprint = expenseCreationFingerprint(input.companyId, input.expense);
    } catch (error) {
      if (error instanceof InvalidExpenseCreationRequestError) return err(invalidIdempotencyKey());
      throw error;
    }

    for (let attempt = 0; attempt < ROOT_ATTEMPTS; attempt += 1) {
      try {
        return ok(await this.runRoot(input, fingerprint, followUp));
      } catch (error) {
        if (error instanceof ExpenseCreationClaimLost) {
          if (attempt + 1 < ROOT_ATTEMPTS) continue;
          return err(idempotencyDependency(
            "La création concurrente n'a pas convergé après une nouvelle tentative transactionnelle.",
          ));
        }
        if (error instanceof ExpenseCreationTransactionAborted) return err(error.appError);
        if (error instanceof DuplicateExpenseInvoiceError) {
          // Sous PostgreSQL, le perdant peut recevoir P2002 après le commit du gagnant mais avant
          // d'avoir observé sa publication idempotente. Une nouvelle racine voit alors la claim et
          // exécute le follow-up sur le bon agrégat. Sans fingerprint (ou au 2e échec), c'est bien
          // un doublon fonctionnel et non un retry réseau.
          if (fingerprint && attempt + 1 < ROOT_ATTEMPTS) continue;
          return err(duplicateInvoice(error));
        }
        if (error instanceof InvalidExpenseCreationRequestError) {
          return err(idempotencyDependency(`Publication idempotente invalide (${error.field}).`));
        }
        throw error;
      }
    }

    return err(idempotencyDependency('La création n’a pas pu converger.'));
  }

  private runRoot<T>(
    input: ExpenseCreationCoordinatorInput,
    fingerprint: ExpenseCreationFingerprint | null,
    followUp: ExpenseCreationAtomicFollowUp<T> | undefined,
  ): Promise<ExpenseCreationCoordinatorOutput<T>> {
    const { persistence } = this.deps;
    return persistence.runWithTenant(
      input.companyId,
      () => persistence.runInTransaction(() => this.runTransaction(input, fingerprint, followUp)),
    );
  }

  private async runTransaction<T>(
    input: ExpenseCreationCoordinatorInput,
    fingerprint: ExpenseCreationFingerprint | null,
    followUp: ExpenseCreationAtomicFollowUp<T> | undefined,
  ): Promise<ExpenseCreationCoordinatorOutput<T>> {
    const replay = await this.findReplay(input.companyId, fingerprint);
    const created = replay === null;
    const expense = replay ?? await this.record(input);
    const accounting = await this.recordAccounting(expense.id);

    if (created && fingerprint) {
      await this.publishClaim(input.companyId, expense.id, fingerprint);
    }

    const context: ExpenseCreationTransactionContext = {
      companyId: input.companyId,
      expenseId: expense.id,
      expense,
      accounting,
    };
    const followed = followUp ? await followUp(context) : ok(undefined as T);
    if (!followed.ok) abort(followed.error);

    return {
      expenseId: expense.id,
      created,
      accounting,
      followUp: followed.value,
    };
  }

  private async findReplay(
    companyId: string,
    fingerprint: ExpenseCreationFingerprint | null,
  ): Promise<ExpenseProps | null> {
    if (!fingerprint) return null;
    const { persistence } = this.deps;
    const published = await persistence.expenseCreationRequests.find({
      companyId,
      keyHash: fingerprint.keyHash,
    });
    if (!published) return null;
    if (published.companyId !== companyId || published.keyHash !== fingerprint.keyHash) {
      abort(idempotencyDependency('La publication relue ne correspond pas à la clé tenant demandée.'));
    }
    if (published.payloadHash !== fingerprint.payloadHash) {
      abort(appConflict(
        'expense_creation',
        "Cette clé d'idempotence a déjà été utilisée pour une autre dépense.",
      ));
    }

    const expense = await persistence.expenses.findById(published.expenseId);
    if (!expense || expense.companyId !== companyId) {
      abort(idempotencyDependency('La création publiée ne référence plus une dépense lisible.'));
    }
    return expense.toProps();
  }

  private async record(input: ExpenseCreationCoordinatorInput): Promise<ExpenseProps> {
    const { persistence } = this.deps;
    const recorded = await new RecordExpense({
      expenses: persistence.expenses,
      companies: persistence.companies,
      ids: this.deps.ids,
      clock: this.deps.clock,
      ...(this.deps.chantierTargets ? { chantierTargets: this.deps.chantierTargets } : {}),
    }).execute({
      ...input.expense,
      // L'identité serveur gagne sur tout champ surnuméraire forgé à l'exécution.
      companyId: input.companyId,
    });
    if (!recorded.ok) abort(recorded.error);

    const expense = await persistence.expenses.findById(recorded.value.id);
    if (!expense || expense.companyId !== input.companyId) {
      abort(idempotencyDependency('La dépense créée est devenue illisible dans sa transaction.'));
    }
    return expense.toProps();
  }

  private async recordAccounting(expenseId: string): Promise<RecordExpenseAccountingEntriesOutput> {
    const { persistence } = this.deps;
    const accounting = await new RecordExpenseAccountingEntries({
      expenses: persistence.expenses,
      entries: persistence.accountingEntries,
      companies: persistence.companies,
      charts: persistence.chartOfAccounts,
    }).execute({ expenseId });
    if (!accounting.ok) abort(accounting.error);
    return accounting.value;
  }

  private async publishClaim(
    companyId: string,
    expenseId: string,
    fingerprint: ExpenseCreationFingerprint,
  ): Promise<void> {
    const winner = await this.deps.persistence.expenseCreationRequests.putIfAbsent({
      companyId,
      keyHash: fingerprint.keyHash,
      payloadHash: fingerprint.payloadHash,
      expenseId,
      createdAt: this.deps.clock.now(),
    });
    if (winner.companyId !== companyId || winner.keyHash !== fingerprint.keyHash) {
      abort(idempotencyDependency('Le stockage a publié une clé hors du périmètre tenant demandé.'));
    }
    if (winner.payloadHash !== fingerprint.payloadHash || winner.expenseId !== expenseId) {
      throw new ExpenseCreationClaimLost();
    }
  }
}
