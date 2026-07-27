import {
  CreateQuote,
  appConflict,
  err,
  ok,
  type AppError,
  type ClockPort,
  type CreateQuoteInput,
  type CreateQuoteOutput,
  type IdGeneratorPort,
  type Result,
} from '@bob/core';
import {
  InvalidQuoteCreationRequestError,
  quoteCreationFingerprint,
  type QuoteCreationFingerprint,
} from '../persistence/quote-creation-requests';
import type { Persistence } from '../persistence/persistence';

const ROOT_ATTEMPTS = 2;

export interface QuoteCreationCoordinatorInput {
  readonly companyId: string;
  readonly quote: Omit<CreateQuoteInput, 'companyId'>;
}

export type QuoteCreationCoordinatorPersistence = Pick<
  Persistence,
  | 'quotes'
  | 'quoteCreationRequests'
  | 'companies'
  | 'customers'
  | 'chantiers'
  | 'runInTransaction'
  | 'runWithTenant'
>;

export interface QuoteCreationCoordinatorDependencies {
  readonly persistence: QuoteCreationCoordinatorPersistence;
  readonly ids: IdGeneratorPort;
  readonly clock: ClockPort;
}

class QuoteCreationTransactionAborted extends Error {
  constructor(readonly appError: AppError) {
    super('quote-creation-transaction-aborted');
    this.name = 'QuoteCreationTransactionAborted';
  }
}

/** Traverse les deux racines transactionnelles afin de rollback le devis candidat perdant. */
class QuoteCreationClaimLost extends Error {
  constructor() {
    super('quote-creation-claim-lost');
    this.name = 'QuoteCreationClaimLost';
  }
}

function abort(appError: AppError): never {
  throw new QuoteCreationTransactionAborted(appError);
}

function idempotencyDependency(cause: string): AppError {
  return { kind: 'dependency', port: 'quote-creation-idempotency', cause };
}

function invalidIdempotencyKey(): AppError {
  return {
    kind: 'validation',
    issues: [{ field: 'idempotencyKey', message: "Clé d'idempotence invalide (1 à 200 caractères imprimables)." }],
  };
}

function sameOutput(left: CreateQuoteOutput, right: CreateQuoteOutput): boolean {
  const leftRates = Object.entries(left.totals.vatByRate).sort(([a], [b]) => a.localeCompare(b));
  const rightRates = Object.entries(right.totals.vatByRate).sort(([a], [b]) => a.localeCompare(b));
  return left.quoteId === right.quoteId
    && left.totals.ht === right.totals.ht
    && left.totals.vat === right.totals.vat
    && left.totals.ttc === right.totals.ttc
    && left.totals.netToPay === right.totals.netToPay
    && JSON.stringify(leftRates) === JSON.stringify(rightRates);
}

/** Autorité serveur unique des créations de devis, y compris après perte de réponse HTTP. */
export class QuoteCreationCoordinator {
  constructor(private readonly deps: QuoteCreationCoordinatorDependencies) {}

  async execute(input: QuoteCreationCoordinatorInput): Promise<Result<CreateQuoteOutput, AppError>> {
    let fingerprint: QuoteCreationFingerprint | null;
    try {
      fingerprint = quoteCreationFingerprint(input.companyId, input.quote);
    } catch (error) {
      if (error instanceof InvalidQuoteCreationRequestError) return err(invalidIdempotencyKey());
      throw error;
    }

    for (let attempt = 0; attempt < ROOT_ATTEMPTS; attempt += 1) {
      try {
        return ok(await this.runRoot(input, fingerprint));
      } catch (error) {
        if (error instanceof QuoteCreationClaimLost) {
          if (attempt + 1 < ROOT_ATTEMPTS) continue;
          return err(idempotencyDependency(
            "La création concurrente n'a pas convergé après une nouvelle tentative transactionnelle.",
          ));
        }
        if (error instanceof QuoteCreationTransactionAborted) return err(error.appError);
        if (error instanceof InvalidQuoteCreationRequestError) {
          return err(idempotencyDependency(`Publication idempotente invalide (${error.field}).`));
        }
        throw error;
      }
    }
    return err(idempotencyDependency('La création du devis n’a pas pu converger.'));
  }

  private runRoot(
    input: QuoteCreationCoordinatorInput,
    fingerprint: QuoteCreationFingerprint | null,
  ): Promise<CreateQuoteOutput> {
    const { persistence } = this.deps;
    return persistence.runWithTenant(
      input.companyId,
      () => persistence.runInTransaction(() => this.runTransaction(input, fingerprint)),
    );
  }

  private async runTransaction(
    input: QuoteCreationCoordinatorInput,
    fingerprint: QuoteCreationFingerprint | null,
  ): Promise<CreateQuoteOutput> {
    const replay = await this.findReplay(input.companyId, fingerprint);
    if (replay) return replay;

    const created = await new CreateQuote({
      quotes: this.deps.persistence.quotes,
      companies: this.deps.persistence.companies,
      customers: this.deps.persistence.customers,
      ids: this.deps.ids,
      clock: this.deps.clock,
      // PR-08 — preuve tenant-scoped du chantier visé (anti-IDOR fail-closed du use case).
      // On est DÉJÀ sous runWithTenant + transaction : la lecture est RLS-scopée ; le port ne
      // distingue jamais « absent » d'« autre tenant » (false dans les deux cas).
      chantierTargets: {
        exists: async ({ companyId, linkedEntityId }) => {
          const chantier = await this.deps.persistence.chantiers.findById(linkedEntityId);
          return chantier !== null && chantier.companyId === companyId;
        },
      },
    }).execute({
      ...input.quote,
      // L'identité serveur gagne sur tout objet runtime élargi.
      companyId: input.companyId,
    });
    if (!created.ok) abort(created.error);

    const quote = await this.deps.persistence.quotes.findById(created.value.quoteId);
    if (!quote || quote.companyId !== input.companyId) {
      abort(idempotencyDependency('Le devis créé est devenu illisible dans sa transaction.'));
    }

    if (fingerprint) await this.publishClaim(input.companyId, created.value, fingerprint);
    return created.value;
  }

  private async findReplay(
    companyId: string,
    fingerprint: QuoteCreationFingerprint | null,
  ): Promise<CreateQuoteOutput | null> {
    if (!fingerprint) return null;
    const published = await this.deps.persistence.quoteCreationRequests.find({
      companyId,
      keyHash: fingerprint.keyHash,
    });
    if (!published) return null;
    if (published.companyId !== companyId || published.keyHash !== fingerprint.keyHash) {
      abort(idempotencyDependency('La publication relue ne correspond pas à la clé tenant demandée.'));
    }
    if (published.payloadHash !== fingerprint.payloadHash) {
      abort(appConflict(
        'quote_creation',
        "Cette clé d'idempotence a déjà été utilisée pour un autre devis.",
      ));
    }
    const quote = await this.deps.persistence.quotes.findById(published.output.quoteId);
    if (!quote || quote.companyId !== companyId) {
      abort(idempotencyDependency('La création publiée ne référence plus un devis lisible.'));
    }
    return published.output;
  }

  private async publishClaim(
    companyId: string,
    output: CreateQuoteOutput,
    fingerprint: QuoteCreationFingerprint,
  ): Promise<void> {
    const winner = await this.deps.persistence.quoteCreationRequests.putIfAbsent({
      companyId,
      keyHash: fingerprint.keyHash,
      payloadHash: fingerprint.payloadHash,
      output,
      createdAt: this.deps.clock.now(),
    });
    if (winner.companyId !== companyId || winner.keyHash !== fingerprint.keyHash) {
      abort(idempotencyDependency('Le stockage a publié une clé hors du périmètre tenant demandé.'));
    }
    if (winner.payloadHash !== fingerprint.payloadHash || !sameOutput(winner.output, output)) {
      throw new QuoteCreationClaimLost();
    }
  }
}
