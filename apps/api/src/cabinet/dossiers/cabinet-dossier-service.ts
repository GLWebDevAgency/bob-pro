import type { CabinetRole } from '@bob/core';
import {
  CABINET_DOSSIER_PAGE_MAX,
  cabinetDossierAnalysisSha256,
  cabinetDossierUpsertInputSchema,
  deriveCabinetDossierFinancialSummary,
  normalizeCabinetDossierSiren,
  type CabinetDossier,
  type CabinetDossierSummary,
  type CabinetDossierUpsertInput,
} from './cabinet-dossier-contract';
import type { CabinetDossierRepository } from './cabinet-dossier-repository';

export type CabinetDossierServiceErrorCode =
  | 'CABINET_DOSSIER_FORBIDDEN'
  | 'CABINET_DOSSIER_INVALID'
  | 'CABINET_DOSSIER_NOT_FOUND'
  | 'CABINET_DOSSIER_CONFLICT'
  | 'CABINET_DOSSIER_INTEGRITY';

export class CabinetDossierServiceError extends Error {
  constructor(
    readonly code: CabinetDossierServiceErrorCode,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.name = 'CabinetDossierServiceError';
  }
}

export interface CabinetDossierActor {
  userId: string;
  cabinetId: string;
  role: CabinetRole;
}

export interface CabinetDossierActorResolver {
  resolveActiveActor(cabinetId: string, userId: string): Promise<CabinetDossierActor | null>;
}

export interface CabinetDossierServiceDependencies {
  dossiers: CabinetDossierRepository;
  actors: CabinetDossierActorResolver;
  ids: { newId(): string };
  clock: { now(): string };
}

function requirePortfolioRead(actor: CabinetDossierActor | null): CabinetDossierActor {
  // Les assignations collaborateur ne sont pas encore matérialisées : aucun accès portefeuille
  // implicite ne lui est accordé. Admin et manager voient le portefeuille entier selon l'ADR RBAC.
  if (actor === null) {
    throw new CabinetDossierServiceError('CABINET_DOSSIER_FORBIDDEN', { reason: 'membership' });
  }
  if (actor.role === 'collaborator') {
    throw new CabinetDossierServiceError('CABINET_DOSSIER_FORBIDDEN', { reason: 'role' });
  }
  return actor;
}

function requireMutation(actor: CabinetDossierActor | null): CabinetDossierActor {
  return requirePortfolioRead(actor);
}

function requireDelete(actor: CabinetDossierActor | null): CabinetDossierActor {
  if (actor === null || actor.role !== 'admin') {
    throw new CabinetDossierServiceError('CABINET_DOSSIER_FORBIDDEN', {
      reason: actor === null ? 'membership' : 'role',
    });
  }
  return actor;
}

export class CabinetDossierService {
  constructor(private readonly dependencies: CabinetDossierServiceDependencies) {}

  async list(input: {
    cabinetId: string;
    actorUserId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: CabinetDossierSummary[]; nextCursor: string | null; hasMore: boolean }> {
    requirePortfolioRead(await this.dependencies.actors.resolveActiveActor(input.cabinetId, input.actorUserId));
    const limit = Math.max(1, Math.min(input.limit ?? 50, CABINET_DOSSIER_PAGE_MAX));
    const page = await this.dependencies.dossiers.listSummaries({
      cabinetId: input.cabinetId,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit,
    });
    return { ...page, hasMore: page.nextCursor !== null };
  }

  async get(input: {
    cabinetId: string;
    actorUserId: string;
    siren: string;
  }): Promise<CabinetDossier> {
    requirePortfolioRead(await this.dependencies.actors.resolveActiveActor(input.cabinetId, input.actorUserId));
    const siren = normalizeCabinetDossierSiren(input.siren);
    if (siren === null) throw new CabinetDossierServiceError('CABINET_DOSSIER_NOT_FOUND');
    const dossier = await this.dependencies.dossiers.findBySiren(input.cabinetId, siren);
    if (dossier === null) throw new CabinetDossierServiceError('CABINET_DOSSIER_NOT_FOUND');
    if (cabinetDossierAnalysisSha256(dossier.analysis) !== dossier.analysisSha256) {
      // Une corruption DB n'est jamais rendue au navigateur comme une analyse comptable fiable.
      throw new CabinetDossierServiceError('CABINET_DOSSIER_INTEGRITY');
    }
    return dossier;
  }

  async upsert(input: {
    cabinetId: string;
    actorUserId: string;
    dossier: unknown;
  }): Promise<CabinetDossier> {
    const actor = requireMutation(
      await this.dependencies.actors.resolveActiveActor(input.cabinetId, input.actorUserId),
    );
    const parsed = cabinetDossierUpsertInputSchema.safeParse(input.dossier);
    if (!parsed.success) {
      throw new CabinetDossierServiceError('CABINET_DOSSIER_INVALID', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.message })),
      });
    }
    const now = this.dependencies.clock.now();
    const data = this.mutationData(parsed.data, now);
    const outcome = parsed.data.expectedRevision === null
      ? await this.dependencies.dossiers.create({
          id: this.dependencies.ids.newId(),
          cabinetId: input.cabinetId,
          actorUserId: actor.userId,
          data,
          now,
        })
      : await this.dependencies.dossiers.replace({
          cabinetId: input.cabinetId,
          actorUserId: actor.userId,
          expectedRevision: parsed.data.expectedRevision,
          data,
          now,
        });
    if (outcome.kind === 'saved') return outcome.dossier;
    if (outcome.kind === 'not_found') {
      throw new CabinetDossierServiceError('CABINET_DOSSIER_NOT_FOUND');
    }
    throw new CabinetDossierServiceError('CABINET_DOSSIER_CONFLICT');
  }

  async delete(input: {
    cabinetId: string;
    actorUserId: string;
    siren: string;
    expectedRevision: number;
  }): Promise<void> {
    const actor = requireDelete(
      await this.dependencies.actors.resolveActiveActor(input.cabinetId, input.actorUserId),
    );
    const siren = normalizeCabinetDossierSiren(input.siren);
    if (siren === null || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new CabinetDossierServiceError('CABINET_DOSSIER_NOT_FOUND');
    }
    const outcome = await this.dependencies.dossiers.delete({
      cabinetId: input.cabinetId,
      siren,
      actorUserId: actor.userId,
      expectedRevision: input.expectedRevision,
      now: this.dependencies.clock.now(),
    });
    if (outcome === 'deleted') return;
    if (outcome === 'not_found') throw new CabinetDossierServiceError('CABINET_DOSSIER_NOT_FOUND');
    throw new CabinetDossierServiceError('CABINET_DOSSIER_CONFLICT');
  }

  private mutationData(input: CabinetDossierUpsertInput, now: string) {
    return {
      siren: input.siren,
      clientName: input.clientName,
      sourceFileName: input.sourceFileName,
      entryCount: input.entryCount,
      rowCount: input.rowCount,
      period: input.period,
      financial: deriveCabinetDossierFinancialSummary(input.analysis),
      analysis: input.analysis,
      analysisSha256: cabinetDossierAnalysisSha256(input.analysis),
      review: input.review,
      fiscal: input.fiscal,
      lastImportedAt: now,
    };
  }
}
