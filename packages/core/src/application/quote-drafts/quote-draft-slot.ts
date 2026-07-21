import { isVatRate, type VatRate } from '../../domain/billing/shared/vat-rate';
import { type LineCategory } from '../../domain/billing/shared/line-item';

/**
 * Contrat durable du brouillon de devis.
 *
 * Il est volontairement plus petit que l'état React du wizard : aucune proposition IA,
 * mission vocale, signature ou callback ne peut être rejoué après une reprise. PostgreSQL
 * porte l'identité (companyId/ownerUserId), la révision CAS et les timestamps ; le JSON ne
 * contient que la saisie restaurable et une version de schéma explicite.
 */
export const QUOTE_DRAFT_PAYLOAD_SCHEMA = 'bob.quote-draft' as const;
export const QUOTE_DRAFT_PAYLOAD_VERSION = 1 as const;
export const QUOTE_DRAFT_MAX_PAYLOAD_BYTES = 256 * 1024;

const MAX_ID_LENGTH = 200;
const MAX_CUSTOMER_NAME_LENGTH = 300;
const MAX_LINE_LABEL_LENGTH = 500;
const MAX_UNIT_LENGTH = 40;
const MAX_LINES = 200;
const MAX_FORM_VALUE_LENGTH = 500;

const LINE_CATEGORIES: readonly LineCategory[] = [
  'labor',
  'supply',
  'travel',
  'disbursement',
  'subscription',
];

export type QuoteDraftStep = 'client' | 'lignes' | 'tvaMentions' | 'acompte' | 'signature';

export interface QuoteDraftPayloadLine {
  readonly label: string;
  readonly category: LineCategory;
  readonly qty: number;
  readonly unitPriceHT: number;
  readonly vatRate: VatRate;
  readonly unit?: string;
}

export interface QuoteDraftPayloadLineMetadata {
  readonly id: string;
  readonly interaction: 'manual' | 'voice';
  readonly catalogue?: {
    readonly id: string;
    readonly source: 'metier' | 'perso';
    readonly indicative: boolean;
  };
}

export interface QuoteDraftPayloadV1 {
  readonly schema: typeof QUOTE_DRAFT_PAYLOAD_SCHEMA;
  readonly version: typeof QUOTE_DRAFT_PAYLOAD_VERSION;
  readonly draft: {
    readonly sessionId: string;
    readonly contentRevision: number;
    readonly stagingRevision: number;
    readonly step: QuoteDraftStep;
    readonly customer: { readonly id: string; readonly name: string } | null;
    readonly lines: readonly QuoteDraftPayloadLine[];
    readonly lineMetadata: readonly QuoteDraftPayloadLineMetadata[];
    readonly lineForm: {
      readonly label: string;
      readonly quantity: string;
      readonly unitPrice: string;
      readonly category: LineCategory;
    };
    readonly vatDecision: {
      readonly rate: VatRate;
      readonly housingOlderThan2y?: boolean;
      readonly energyRenovation?: boolean;
    } | null;
    readonly depositPct: number;
    readonly signMode: 'onsite' | 'remote' | null;
    /**
     * Exception dépannage urgent (art. L221-10, al. 2 / L221-28, 8° c. conso) : réponse du
     * wizard « intervention urgente expressément sollicitée par le client » — B2C uniquement,
     * reprise à la CRÉATION du devis (CreateQuote horodate serveur). Optionnel : les
     * brouillons antérieurs restent valides (absent = non sollicitée, fail-closed).
     */
    readonly urgentRepairRequested?: boolean;
  };
}

export interface QuoteDraftSlot {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly revision: number;
  readonly payloadVersion: typeof QUOTE_DRAFT_PAYLOAD_VERSION;
  readonly payload: QuoteDraftPayloadV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type QuoteDraftPayloadErrorCode =
  | 'invalid_shape'
  | 'invalid_value'
  | 'unsupported_version'
  | 'payload_too_large';

export interface QuoteDraftPayloadError {
  readonly code: QuoteDraftPayloadErrorCode;
  readonly path: string;
}

export type QuoteDraftPayloadResult =
  | { readonly ok: true; readonly value: QuoteDraftPayloadV1 }
  | { readonly ok: false; readonly error: QuoteDraftPayloadError };

export type QuoteDraftSlotUpsertResult =
  | { readonly status: 'created' | 'updated'; readonly slot: QuoteDraftSlot }
  | { readonly status: 'revision_conflict'; readonly currentRevision: number | null };

export type QuoteDraftSlotDeleteResult =
  | { readonly status: 'deleted' }
  | { readonly status: 'not_found' }
  | { readonly status: 'revision_conflict'; readonly currentRevision: number };

export interface QuoteDraftSlotRepository {
  get(input: { readonly companyId: string; readonly ownerUserId: string }): Promise<QuoteDraftSlot | null>;
  /** expectedRevision=0 crée le slot ; une mise à jour exige la révision exacte observée. */
  upsert(input: {
    readonly companyId: string;
    readonly ownerUserId: string;
    readonly expectedRevision: number;
    readonly payload: QuoteDraftPayloadV1;
  }): Promise<QuoteDraftSlotUpsertResult>;
  /** Suppression CAS : un écran périmé ne peut pas effacer un brouillon plus récent. */
  delete(input: {
    readonly companyId: string;
    readonly ownerUserId: string;
    readonly expectedRevision: number;
  }): Promise<QuoteDraftSlotDeleteResult>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function canonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && value === value.trim()
    && !hasAsciiControlCharacter(value)
  );
}

function canonicalSingleLine(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string'
    && value.length <= max
    && (allowEmpty || value.length > 0)
    && value === value.trim().replace(/\s+/gu, ' ')
    && !hasAsciiControlCharacter(value)
  );
}

function safeRevision(value: unknown, allowZero: boolean): value is number {
  return Number.isSafeInteger(value) && (value as number) >= (allowZero ? 0 : 1);
}

function fail(code: QuoteDraftPayloadErrorCode, path: string): QuoteDraftPayloadResult {
  return { ok: false, error: { code, path } };
}

function parseLine(value: unknown, path: string): QuoteDraftPayloadLine | QuoteDraftPayloadError {
  const line = record(value);
  if (!line || !exactKeys(line, ['label', 'category', 'qty', 'unitPriceHT', 'vatRate'], ['unit'])) {
    return { code: 'invalid_shape', path };
  }
  if (!canonicalSingleLine(line['label'], MAX_LINE_LABEL_LENGTH)) {
    return { code: 'invalid_value', path: `${path}.label` };
  }
  if (!LINE_CATEGORIES.includes(line['category'] as LineCategory)) {
    return { code: 'invalid_value', path: `${path}.category` };
  }
  const qty = line['qty'];
  if (
    typeof qty !== 'number'
    || !Number.isFinite(qty)
    || qty <= 0
    || Math.round(qty * 1_000) !== qty * 1_000
  ) {
    return { code: 'invalid_value', path: `${path}.qty` };
  }
  if (!Number.isSafeInteger(line['unitPriceHT']) || (line['unitPriceHT'] as number) <= 0) {
    return { code: 'invalid_value', path: `${path}.unitPriceHT` };
  }
  if (typeof line['vatRate'] !== 'number' || !isVatRate(line['vatRate'])) {
    return { code: 'invalid_value', path: `${path}.vatRate` };
  }
  if (
    line['unit'] !== undefined
    && !canonicalSingleLine(line['unit'], MAX_UNIT_LENGTH)
  ) {
    return { code: 'invalid_value', path: `${path}.unit` };
  }
  return {
    label: line['label'],
    category: line['category'] as LineCategory,
    qty,
    unitPriceHT: line['unitPriceHT'] as number,
    vatRate: line['vatRate'],
    ...(line['unit'] !== undefined ? { unit: line['unit'] as string } : {}),
  };
}

function parseMetadata(value: unknown, path: string): QuoteDraftPayloadLineMetadata | QuoteDraftPayloadError {
  const metadata = record(value);
  if (!metadata || !exactKeys(metadata, ['id', 'interaction'], ['catalogue'])) {
    return { code: 'invalid_shape', path };
  }
  if (!canonicalIdentifier(metadata['id'])) return { code: 'invalid_value', path: `${path}.id` };
  if (metadata['interaction'] !== 'manual' && metadata['interaction'] !== 'voice') {
    return { code: 'invalid_value', path: `${path}.interaction` };
  }
  if (metadata['catalogue'] === undefined) {
    return { id: metadata['id'], interaction: metadata['interaction'] };
  }
  const catalogue = record(metadata['catalogue']);
  if (!catalogue || !exactKeys(catalogue, ['id', 'source', 'indicative'])) {
    return { code: 'invalid_shape', path: `${path}.catalogue` };
  }
  if (!canonicalIdentifier(catalogue['id'])) {
    return { code: 'invalid_value', path: `${path}.catalogue.id` };
  }
  if (catalogue['source'] !== 'metier' && catalogue['source'] !== 'perso') {
    return { code: 'invalid_value', path: `${path}.catalogue.source` };
  }
  if (typeof catalogue['indicative'] !== 'boolean') {
    return { code: 'invalid_value', path: `${path}.catalogue.indicative` };
  }
  return {
    id: metadata['id'],
    interaction: metadata['interaction'],
    catalogue: {
      id: catalogue['id'],
      source: catalogue['source'],
      indicative: catalogue['indicative'],
    },
  };
}

function isPayloadError(value: QuoteDraftPayloadLine | QuoteDraftPayloadLineMetadata | QuoteDraftPayloadError): value is QuoteDraftPayloadError {
  return 'code' in value;
}

/** Validation exacte et normalisation défensive aux deux frontières : HTTP et réhydratation DB. */
export function parseQuoteDraftPayload(value: unknown): QuoteDraftPayloadResult {
  let byteLength: number;
  try {
    byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return fail('invalid_shape', '$');
  }
  if (byteLength > QUOTE_DRAFT_MAX_PAYLOAD_BYTES) return fail('payload_too_large', '$');

  const root = record(value);
  if (!root || !exactKeys(root, ['schema', 'version', 'draft'])) return fail('invalid_shape', '$');
  if (root['schema'] !== QUOTE_DRAFT_PAYLOAD_SCHEMA) return fail('invalid_value', '$.schema');
  if (root['version'] !== QUOTE_DRAFT_PAYLOAD_VERSION) return fail('unsupported_version', '$.version');

  const draft = record(root['draft']);
  if (
    !draft
    || !exactKeys(
      draft,
      [
        'sessionId',
        'contentRevision',
        'stagingRevision',
        'step',
        'customer',
        'lines',
        'lineMetadata',
        'lineForm',
        'vatDecision',
        'depositPct',
        'signMode',
      ],
      // Additif (exception dépannage urgent) : optionnel — brouillons antérieurs valides.
      ['urgentRepairRequested'],
    )
  ) {
    return fail('invalid_shape', '$.draft');
  }
  if (
    draft['urgentRepairRequested'] !== undefined
    && typeof draft['urgentRepairRequested'] !== 'boolean'
  ) {
    return fail('invalid_value', '$.draft.urgentRepairRequested');
  }
  if (!canonicalIdentifier(draft['sessionId'])) return fail('invalid_value', '$.draft.sessionId');
  if (!safeRevision(draft['contentRevision'], true)) return fail('invalid_value', '$.draft.contentRevision');
  if (!safeRevision(draft['stagingRevision'], true)) return fail('invalid_value', '$.draft.stagingRevision');
  if (!['client', 'lignes', 'tvaMentions', 'acompte', 'signature'].includes(draft['step'] as string)) {
    return fail('invalid_value', '$.draft.step');
  }

  let customer: QuoteDraftPayloadV1['draft']['customer'] = null;
  if (draft['customer'] !== null) {
    const candidate = record(draft['customer']);
    if (!candidate || !exactKeys(candidate, ['id', 'name'])) return fail('invalid_shape', '$.draft.customer');
    if (!canonicalIdentifier(candidate['id'])) return fail('invalid_value', '$.draft.customer.id');
    if (!canonicalSingleLine(candidate['name'], MAX_CUSTOMER_NAME_LENGTH)) {
      return fail('invalid_value', '$.draft.customer.name');
    }
    customer = { id: candidate['id'], name: candidate['name'] };
  }

  if (!Array.isArray(draft['lines']) || draft['lines'].length > MAX_LINES) {
    return fail('invalid_value', '$.draft.lines');
  }
  const lines: QuoteDraftPayloadLine[] = [];
  for (let index = 0; index < draft['lines'].length; index += 1) {
    const parsed = parseLine(draft['lines'][index], `$.draft.lines[${index}]`);
    if (isPayloadError(parsed)) return { ok: false, error: parsed };
    lines.push(parsed);
  }

  if (!Array.isArray(draft['lineMetadata']) || draft['lineMetadata'].length !== lines.length) {
    return fail('invalid_value', '$.draft.lineMetadata');
  }
  const lineMetadata: QuoteDraftPayloadLineMetadata[] = [];
  for (let index = 0; index < draft['lineMetadata'].length; index += 1) {
    const parsed = parseMetadata(draft['lineMetadata'][index], `$.draft.lineMetadata[${index}]`);
    if (isPayloadError(parsed)) return { ok: false, error: parsed };
    lineMetadata.push(parsed);
  }
  if (new Set(lineMetadata.map((entry) => entry.id)).size !== lineMetadata.length) {
    return fail('invalid_value', '$.draft.lineMetadata');
  }

  const lineForm = record(draft['lineForm']);
  if (!lineForm || !exactKeys(lineForm, ['label', 'quantity', 'unitPrice', 'category'])) {
    return fail('invalid_shape', '$.draft.lineForm');
  }
  if (!canonicalSingleLine(lineForm['label'], MAX_FORM_VALUE_LENGTH, true)) {
    return fail('invalid_value', '$.draft.lineForm.label');
  }
  if (!canonicalSingleLine(lineForm['quantity'], 64, true)) {
    return fail('invalid_value', '$.draft.lineForm.quantity');
  }
  if (!canonicalSingleLine(lineForm['unitPrice'], 64, true)) {
    return fail('invalid_value', '$.draft.lineForm.unitPrice');
  }
  if (!LINE_CATEGORIES.includes(lineForm['category'] as LineCategory)) {
    return fail('invalid_value', '$.draft.lineForm.category');
  }

  let vatDecision: QuoteDraftPayloadV1['draft']['vatDecision'] = null;
  if (draft['vatDecision'] !== null) {
    const decision = record(draft['vatDecision']);
    if (
      !decision
      || !exactKeys(decision, ['rate'], ['housingOlderThan2y', 'energyRenovation'])
      || typeof decision['rate'] !== 'number'
      || !isVatRate(decision['rate'])
      || (decision['housingOlderThan2y'] !== undefined && typeof decision['housingOlderThan2y'] !== 'boolean')
      || (decision['energyRenovation'] !== undefined && typeof decision['energyRenovation'] !== 'boolean')
    ) {
      return fail('invalid_value', '$.draft.vatDecision');
    }
    vatDecision = {
      rate: decision['rate'],
      ...(decision['housingOlderThan2y'] !== undefined
        ? { housingOlderThan2y: decision['housingOlderThan2y'] as boolean }
        : {}),
      ...(decision['energyRenovation'] !== undefined
        ? { energyRenovation: decision['energyRenovation'] as boolean }
        : {}),
    };
  }
  if ((vatDecision === null && lines.length > 0) || lines.some((line) => line.vatRate !== vatDecision?.rate)) {
    return fail('invalid_value', '$.draft.vatDecision');
  }
  if (
    typeof draft['depositPct'] !== 'number'
    || !Number.isFinite(draft['depositPct'])
    || draft['depositPct'] < 0
    || draft['depositPct'] > 100
  ) {
    return fail('invalid_value', '$.draft.depositPct');
  }
  if (draft['signMode'] !== null && draft['signMode'] !== 'onsite' && draft['signMode'] !== 'remote') {
    return fail('invalid_value', '$.draft.signMode');
  }
  const step = draft['step'] as QuoteDraftStep;
  if (step !== 'client' && customer === null) return fail('invalid_value', '$.draft.customer');
  if (['tvaMentions', 'acompte', 'signature'].includes(step) && lines.length === 0) {
    return fail('invalid_value', '$.draft.lines');
  }
  if (['acompte', 'signature'].includes(step) && vatDecision === null) {
    return fail('invalid_value', '$.draft.vatDecision');
  }

  return {
    ok: true,
    value: {
      schema: QUOTE_DRAFT_PAYLOAD_SCHEMA,
      version: QUOTE_DRAFT_PAYLOAD_VERSION,
      draft: {
        sessionId: draft['sessionId'],
        contentRevision: draft['contentRevision'],
        stagingRevision: draft['stagingRevision'],
        step,
        customer,
        lines,
        lineMetadata,
        lineForm: {
          label: lineForm['label'] as string,
          quantity: lineForm['quantity'] as string,
          unitPrice: lineForm['unitPrice'] as string,
          category: lineForm['category'] as LineCategory,
        },
        vatDecision,
        depositPct: draft['depositPct'],
        signMode: draft['signMode'] as 'onsite' | 'remote' | null,
        ...(draft['urgentRepairRequested'] !== undefined
          ? { urgentRepairRequested: draft['urgentRepairRequested'] as boolean }
          : {}),
      },
    },
  };
}

export function assertQuoteDraftSlotIdentity(input: {
  readonly companyId: string;
  readonly ownerUserId: string;
}): void {
  if (!canonicalIdentifier(input.companyId) || !canonicalIdentifier(input.ownerUserId)) {
    throw new Error('QUOTE_DRAFT_SLOT_IDENTITY_INVALID');
  }
}

export function assertQuoteDraftExpectedRevision(value: number, allowZero: boolean): void {
  if (!safeRevision(value, allowZero)) throw new Error('QUOTE_DRAFT_SLOT_REVISION_INVALID');
}
