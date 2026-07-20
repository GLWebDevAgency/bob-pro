import { type Result, err, ok } from '../../shared-kernel/result';
import { type ClockPort, type IdGeneratorPort } from '../ports/services';
import { type AppError, appConflict, appNotFound } from '../result';
import {
  type CatalogueDeleteWriteResult,
  type CatalogueItemRecord,
  type CatalogueItemReplacement,
  type CatalogueRepository,
  type CatalogueUpdateWriteResult,
} from './catalogue-repository';
import {
  parseCustomPrestation,
  isCustomPrestationId,
  type CatalogueCategory,
  type CustomPrestation,
} from './derive-catalogue';
import { type VatRate } from '../../domain/billing/shared/vat-rate';

export interface CatalogueItemWriteInput {
  readonly label: string;
  readonly category: CatalogueCategory;
  readonly unit: string | null;
  /** Prix unitaire HT en centimes, obligatoire et fourni par le propriétaire. */
  readonly unitPriceHT: number;
  readonly vatRate: VatRate;
}

/** Vue JSON-safe exposable par les adapters HTTP sans objet ORM. */
export interface CatalogueItemView extends CustomPrestation {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CatalogueDeletionView {
  readonly id: string;
  readonly deleted: true;
}

type CatalogueDeps = {
  catalogue: CatalogueRepository;
};

const CATALOGUE_ITEM_WRITE_KEYS = ['label', 'category', 'unit', 'unitPriceHT', 'vatRate'] as const;

function invalid(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

function validTenantId(companyId: unknown): companyId is string {
  return typeof companyId === 'string' && companyId.trim().length > 0;
}

function validRevision(revision: unknown): revision is number {
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 1;
}

function incrementableRevision(revision: unknown): revision is number {
  return validRevision(revision) && revision < Number.MAX_SAFE_INTEGER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactWriteKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...CATALOGUE_ITEM_WRITE_KEYS].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalFields(
  id: string,
  input: CatalogueItemWriteInput,
): Result<CustomPrestation, AppError> {
  const parsed = parseCustomPrestation({
    id,
    label: input.label,
    category: input.category,
    unit: input.unit,
    unitPriceHT: input.unitPriceHT,
    vatRate: input.vatRate,
  });
  return parsed === null
    ? err(invalid('item', 'La prestation du catalogue est invalide.'))
    : ok(parsed);
}

function canonicalWriteInput(id: string, input: unknown): Result<CustomPrestation, AppError> {
  if (!isRecord(input) || !hasExactWriteKeys(input)) {
    return err(invalid('item', 'La prestation du catalogue est invalide.'));
  }
  return canonicalFields(id, input as unknown as CatalogueItemWriteInput);
}

function toView(record: CatalogueItemRecord): CatalogueItemView {
  return {
    id: record.id,
    label: record.label,
    category: record.category,
    unit: record.unit,
    unitPriceHT: record.unitPriceHT,
    vatRate: record.vatRate,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function tenantScopedRecord(
  record: CatalogueItemRecord,
  expectedCompanyId: string,
): Result<CatalogueItemRecord, AppError> {
  if (record.companyId !== expectedCompanyId) {
    return err({
      kind: 'dependency',
      port: 'catalogue',
      cause: 'tenant_scope_violation',
    });
  }
  const parsed = canonicalFields(record.id, record);
  if (
    !parsed.ok ||
    !validRevision(record.revision) ||
    typeof record.createdAt !== 'string' ||
    record.createdAt.length === 0 ||
    typeof record.updatedAt !== 'string' ||
    record.updatedAt.length === 0
  ) {
    return err({ kind: 'dependency', port: 'catalogue', cause: 'invalid_persisted_record' });
  }
  return ok({
    ...parsed.value,
    companyId: record.companyId,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function updateError(
  id: string,
  result: Exclude<CatalogueUpdateWriteResult, { status: 'updated' }>,
): AppError {
  return result.status === 'not_found'
    ? appNotFound('catalogue_item', id)
    : appConflict('catalogue_item', 'stale_revision');
}

function deleteError(
  id: string,
  result: Exclude<CatalogueDeleteWriteResult, { status: 'deleted' }>,
): AppError {
  return result.status === 'not_found'
    ? appNotFound('catalogue_item', id)
    : appConflict('catalogue_item', 'stale_revision');
}

/** Lecture exclusivement issue du repository tenant-scoped, sans catalogue ni prix implicite. */
export class ListCatalogueItems {
  constructor(private readonly deps: CatalogueDeps) {}

  async execute(input: {
    readonly companyId: string;
  }): Promise<Result<readonly CatalogueItemView[], AppError>> {
    if (!validTenantId(input.companyId)) {
      return err(invalid('companyId', 'Tenant requis.'));
    }
    const records = await this.deps.catalogue.listByCompany(input.companyId);
    const views: CatalogueItemView[] = [];
    for (const record of records) {
      const scoped = tenantScopedRecord(record, input.companyId);
      if (!scoped.ok) return scoped;
      views.push(toView(scoped.value));
    }
    return ok(views);
  }
}

export class CreateCatalogueItem {
  constructor(
    private readonly deps: CatalogueDeps & {
      ids: IdGeneratorPort;
      clock: ClockPort;
    },
  ) {}

  async execute(input: {
    readonly companyId: string;
    readonly item: CatalogueItemWriteInput;
  }): Promise<Result<CatalogueItemView, AppError>> {
    if (!validTenantId(input.companyId)) {
      return err(invalid('companyId', 'Tenant requis.'));
    }

    // Valide les données utilisateur avant de faire confiance à l'identifiant d'infrastructure.
    const validatedInput = canonicalWriteInput('validation-probe', input.item);
    if (!validatedInput.ok) return validatedInput;

    const id = this.deps.ids.newId();
    const prestation = canonicalWriteInput(id, input.item);
    if (!prestation.ok) {
      return err({ kind: 'dependency', port: 'id_generator', cause: 'invalid_catalogue_item_id' });
    }
    const now = this.deps.clock.now();
    const record: CatalogueItemRecord = {
      ...prestation.value,
      companyId: input.companyId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.deps.catalogue.create(record);
    if (created.status === 'id_conflict') {
      return err(appConflict('catalogue_item', 'id_conflict'));
    }
    const persisted = tenantScopedRecord(created.item, input.companyId);
    if (!persisted.ok) return persisted;
    if (
      persisted.value.id !== record.id ||
      persisted.value.revision !== record.revision ||
      persisted.value.label !== record.label ||
      persisted.value.category !== record.category ||
      persisted.value.unit !== record.unit ||
      persisted.value.unitPriceHT !== record.unitPriceHT ||
      persisted.value.vatRate !== record.vatRate ||
      persisted.value.createdAt !== record.createdAt ||
      persisted.value.updatedAt !== record.updatedAt
    ) {
      return err({ kind: 'dependency', port: 'catalogue', cause: 'unexpected_create_result' });
    }
    return ok(toView(persisted.value));
  }
}

export class UpdateCatalogueItem {
  constructor(
    private readonly deps: CatalogueDeps & {
      clock: ClockPort;
    },
  ) {}

  async execute(input: {
    readonly companyId: string;
    readonly itemId: string;
    readonly expectedRevision: number;
    readonly item: CatalogueItemWriteInput;
  }): Promise<Result<CatalogueItemView, AppError>> {
    if (!validTenantId(input.companyId)) {
      return err(invalid('companyId', 'Tenant requis.'));
    }
    if (!incrementableRevision(input.expectedRevision)) {
      return err(invalid('expectedRevision', 'Révision invalide.'));
    }
    const prestation = canonicalWriteInput(input.itemId, input.item);
    if (!prestation.ok) return prestation;

    const next: CatalogueItemReplacement = {
      ...prestation.value,
      companyId: input.companyId,
      revision: input.expectedRevision + 1,
      updatedAt: this.deps.clock.now(),
    };
    const updated = await this.deps.catalogue.update({
      companyId: input.companyId,
      id: input.itemId,
      expectedRevision: input.expectedRevision,
      item: next,
    });
    if (updated.status !== 'updated') return err(updateError(input.itemId, updated));
    const persisted = tenantScopedRecord(updated.item, input.companyId);
    if (!persisted.ok) return persisted;
    if (
      persisted.value.id !== next.id ||
      persisted.value.revision !== next.revision ||
      persisted.value.label !== next.label ||
      persisted.value.category !== next.category ||
      persisted.value.unit !== next.unit ||
      persisted.value.unitPriceHT !== next.unitPriceHT ||
      persisted.value.vatRate !== next.vatRate ||
      persisted.value.updatedAt !== next.updatedAt
    ) {
      return err({ kind: 'dependency', port: 'catalogue', cause: 'unexpected_update_result' });
    }
    return ok(toView(persisted.value));
  }
}

export class DeleteCatalogueItem {
  constructor(private readonly deps: CatalogueDeps) {}

  async execute(input: {
    readonly companyId: string;
    readonly itemId: string;
    readonly expectedRevision: number;
  }): Promise<Result<CatalogueDeletionView, AppError>> {
    if (!validTenantId(input.companyId)) {
      return err(invalid('companyId', 'Tenant requis.'));
    }
    if (!isCustomPrestationId(input.itemId)) {
      return err(invalid('itemId', 'Identifiant de prestation invalide.'));
    }
    if (!validRevision(input.expectedRevision)) {
      return err(invalid('expectedRevision', 'Révision invalide.'));
    }
    const deleted = await this.deps.catalogue.delete({
      companyId: input.companyId,
      id: input.itemId,
      expectedRevision: input.expectedRevision,
    });
    if (deleted.status !== 'deleted') return err(deleteError(input.itemId, deleted));
    return ok({ id: input.itemId, deleted: true });
  }
}
