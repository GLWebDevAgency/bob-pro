import {
  isVatRate,
  type DevisFlowState,
  type DevisSignMode,
  type DevisTvaContext,
  type LineCategory,
  type LineInput,
} from '@bob/core';
import {
  markQuoteDraftSaved,
  validateQuoteDraftLine,
  type QuoteDraftCustomer,
  type QuoteDraftLineFormState,
  type QuoteDraftLineMetadata,
  type QuoteDraftState,
} from './quote-draft-model';

/**
 * Contrat disque volontairement plus petit que `QuoteDraftState`.
 *
 * Les propositions Bob, missions, fences de création et traces de signature sont éphémères :
 * elles ne doivent jamais pouvoir être rejouées après un redémarrage de processus.
 */
export const QUOTE_DRAFT_SNAPSHOT_SCHEMA = 'bob.quote-draft' as const;
export const QUOTE_DRAFT_SNAPSHOT_VERSION = 1 as const;

const MAX_ID_LENGTH = 200;
const MAX_CUSTOMER_NAME_LENGTH = 300;
const MAX_LINES = 200;
const MAX_FORM_VALUE_LENGTH = 500;
const LINE_CATEGORIES: readonly LineCategory[] = [
  'labor',
  'supply',
  'travel',
  'disbursement',
  'subscription',
];

export interface QuoteDraftStorageIdentity {
  readonly mode: 'authenticated' | 'demo';
  readonly userId: string;
  readonly companyId: string;
}

export type QuoteDraftSnapshotCodecErrorCode =
  | 'invalid_identity'
  | 'unsafe_state'
  | 'invalid_json'
  | 'invalid_snapshot'
  | 'unsupported_version'
  | 'identity_mismatch';

export class QuoteDraftSnapshotCodecError extends Error {
  readonly code: QuoteDraftSnapshotCodecErrorCode;

  constructor(code: QuoteDraftSnapshotCodecErrorCode) {
    super(`quote_draft_snapshot_${code}`);
    this.name = 'QuoteDraftSnapshotCodecError';
    this.code = code;
  }
}

interface PersistedQuoteDraftV1 {
  readonly schema: typeof QUOTE_DRAFT_SNAPSHOT_SCHEMA;
  readonly version: typeof QUOTE_DRAFT_SNAPSHOT_VERSION;
  readonly identity: QuoteDraftStorageIdentity;
  readonly savedAt: number;
  readonly draft: {
    readonly sessionId: string;
    readonly revision: number;
    readonly flow: DevisFlowState;
    readonly customer: QuoteDraftCustomer | null;
    readonly lineMetadata: readonly QuoteDraftLineMetadata[];
    readonly lineForm: QuoteDraftLineFormState;
    readonly stagingRevision: number;
    readonly saved: {
      readonly contentRevision: number;
      readonly stagingRevision: number;
      readonly at: number;
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function canonicalIdentifier(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return (
    boundedString(value, maxLength) &&
    value === value.trim() &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

function canonicalSingleLine(value: unknown, maxLength: number): value is string {
  return boundedString(value, maxLength) && value === value.trim().replace(/\s+/g, ' ');
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function assertQuoteDraftStorageIdentity(identity: QuoteDraftStorageIdentity): void {
  if (
    (identity.mode !== 'authenticated' && identity.mode !== 'demo') ||
    !canonicalIdentifier(identity.userId) ||
    !canonicalIdentifier(identity.companyId)
  ) {
    throw new QuoteDraftSnapshotCodecError('invalid_identity');
  }
}

function sameIdentity(left: QuoteDraftStorageIdentity, right: QuoteDraftStorageIdentity): boolean {
  return (
    left.mode === right.mode && left.userId === right.userId && left.companyId === right.companyId
  );
}

function cloneTvaContext(context: DevisTvaContext | null): DevisTvaContext | null {
  return context === null ? null : { ...context };
}

function cloneLine(line: LineInput): LineInput {
  return {
    label: line.label,
    category: line.category,
    qty: line.qty,
    unitPriceHT: line.unitPriceHT,
    vatRate: line.vatRate,
    ...(line.unit !== undefined ? { unit: line.unit } : {}),
  };
}

function cloneMetadata(metadata: QuoteDraftLineMetadata): QuoteDraftLineMetadata {
  return {
    id: metadata.id,
    interaction: metadata.interaction,
    ...(metadata.catalogue !== undefined ? { catalogue: { ...metadata.catalogue } } : {}),
  };
}

function parseIdentity(value: unknown): QuoteDraftStorageIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ['mode', 'userId', 'companyId'])) return null;
  const mode = value['mode'];
  const userId = value['userId'];
  const companyId = value['companyId'];
  if (
    (mode !== 'authenticated' && mode !== 'demo') ||
    !canonicalIdentifier(userId) ||
    !canonicalIdentifier(companyId)
  )
    return null;
  return { mode, userId, companyId };
}

function parseTvaContext(value: unknown): DevisTvaContext | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const allowed = ['housingOlderThan2y', 'energyRenovation'] as const;
  if (Object.keys(value).some((key) => !allowed.includes(key as (typeof allowed)[number]))) {
    return undefined;
  }
  const housingOlderThan2y = value['housingOlderThan2y'];
  const energyRenovation = value['energyRenovation'];
  if (housingOlderThan2y !== undefined && typeof housingOlderThan2y !== 'boolean') return undefined;
  if (energyRenovation !== undefined && typeof energyRenovation !== 'boolean') return undefined;
  return {
    ...(housingOlderThan2y !== undefined ? { housingOlderThan2y } : {}),
    ...(energyRenovation !== undefined ? { energyRenovation } : {}),
  };
}

function parseLine(value: unknown): LineInput | null {
  if (!isRecord(value)) return null;
  const allowedKeys = ['label', 'category', 'qty', 'unitPriceHT', 'vatRate', 'unit'];
  const requiredKeys = ['label', 'category', 'qty', 'unitPriceHT', 'vatRate'];
  if (
    Object.keys(value).some((key) => !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !(key in value))
  )
    return null;
  const category = value['category'];
  const vatRate = value['vatRate'];
  const candidate: LineInput = {
    label: typeof value['label'] === 'string' ? value['label'] : '',
    category: category as LineCategory,
    qty: typeof value['qty'] === 'number' ? value['qty'] : Number.NaN,
    unitPriceHT: typeof value['unitPriceHT'] === 'number' ? value['unitPriceHT'] : Number.NaN,
    vatRate: vatRate as LineInput['vatRate'],
    ...(typeof value['unit'] === 'string' ? { unit: value['unit'] } : {}),
  };
  if (value['unit'] !== undefined && typeof value['unit'] !== 'string') return null;
  if (
    !(LINE_CATEGORIES as readonly unknown[]).includes(category) ||
    typeof vatRate !== 'number' ||
    !isVatRate(vatRate)
  )
    return null;
  const validated = validateQuoteDraftLine(candidate);
  if (!validated.ok) return null;
  const normalized = validated.value;
  if (
    normalized.label !== candidate.label ||
    normalized.category !== candidate.category ||
    normalized.qty !== candidate.qty ||
    normalized.unitPriceHT !== candidate.unitPriceHT ||
    normalized.vatRate !== candidate.vatRate ||
    normalized.unit !== candidate.unit
  )
    return null;
  return cloneLine(normalized);
}

function parseCustomer(value: unknown): QuoteDraftCustomer | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'name'])) return undefined;
  const id = value['id'];
  const name = value['name'];
  if (!canonicalIdentifier(id) || !canonicalSingleLine(name, MAX_CUSTOMER_NAME_LENGTH)) {
    return undefined;
  }
  return { id, name };
}

function parseMetadata(value: unknown): QuoteDraftLineMetadata | null {
  if (!isRecord(value)) return null;
  const hasCatalogue = 'catalogue' in value;
  if (
    !hasExactKeys(value, hasCatalogue ? ['id', 'interaction', 'catalogue'] : ['id', 'interaction'])
  ) {
    return null;
  }
  const id = value['id'];
  const interaction = value['interaction'];
  if (!canonicalIdentifier(id) || (interaction !== 'manual' && interaction !== 'voice')) {
    return null;
  }
  if (!hasCatalogue) return { id, interaction };
  const catalogue = value['catalogue'];
  if (!isRecord(catalogue) || !hasExactKeys(catalogue, ['id', 'source', 'indicative'])) return null;
  const catalogueId = catalogue['id'];
  const source = catalogue['source'];
  const indicative = catalogue['indicative'];
  if (
    !canonicalIdentifier(catalogueId) ||
    (source !== 'metier' && source !== 'perso') ||
    typeof indicative !== 'boolean'
  )
    return null;
  return { id, interaction, catalogue: { id: catalogueId, source, indicative } };
}

function parseLineForm(value: unknown): QuoteDraftLineFormState | null {
  if (!isRecord(value) || !hasExactKeys(value, ['label', 'quantity', 'unitPrice', 'category']))
    return null;
  const label = value['label'];
  const quantity = value['quantity'];
  const unitPrice = value['unitPrice'];
  const category = value['category'];
  if (
    !boundedString(label, MAX_FORM_VALUE_LENGTH, true) ||
    !boundedString(quantity, 64, true) ||
    !boundedString(unitPrice, 64, true) ||
    !(LINE_CATEGORIES as readonly unknown[]).includes(category)
  )
    return null;
  return { label, quantity, unitPrice, category: category as LineCategory };
}

function parseSignMode(value: unknown): DevisSignMode | null | undefined {
  if (value === null) return null;
  if (value === 'onsite' || value === 'remote') return value;
  return undefined;
}

function parseFlow(value: unknown): DevisFlowState | null {
  if (!isRecord(value) || !hasExactKeys(value, ['step', 'draft'])) return null;
  const step = value['step'];
  // Le recap suit un devis déjà créé/envoyé/signé pour de vrai côté serveur : jamais résumable
  // depuis un brouillon local (l'identifiant réel de la pièce n'est pas persisté ici).
  if (
    step !== 'client' &&
    step !== 'lignes' &&
    step !== 'tvaMentions' &&
    step !== 'acompte' &&
    step !== 'signature'
  ) {
    return null;
  }
  const draft = value['draft'];
  if (
    !isRecord(draft) ||
    !hasExactKeys(draft, ['customerId', 'lines', 'tvaContext', 'depositPct', 'signMode', 'signerName'])
  )
    return null;
  const customerId = draft['customerId'];
  if (customerId !== null && !canonicalIdentifier(customerId)) return null;
  const rawLines = draft['lines'];
  if (!Array.isArray(rawLines) || rawLines.length > MAX_LINES) return null;
  const lines = rawLines.map(parseLine);
  if (lines.some((line) => line === null)) return null;
  const tvaContext = parseTvaContext(draft['tvaContext']);
  if (tvaContext === undefined) return null;
  const depositPct = draft['depositPct'];
  if (
    typeof depositPct !== 'number' ||
    !Number.isFinite(depositPct) ||
    depositPct < 0 ||
    depositPct > 100
  ) {
    return null;
  }
  const signMode = parseSignMode(draft['signMode']);
  if (signMode === undefined) return null;
  // Le nom seul n'est pas une preuve : le codec refuse même un snapshot fabriqué qui le contient.
  if (draft['signerName'] !== null) return null;
  if (step !== 'client' && customerId === null) return null;
  if ((step === 'tvaMentions' || step === 'acompte' || step === 'signature') && lines.length === 0)
    return null;
  return {
    step,
    draft: {
      customerId,
      lines: lines as LineInput[],
      tvaContext,
      depositPct,
      signMode,
      signerName: null,
    },
  };
}

/**
 * Prépare le seul état autorisé sur disque. Le recap suit une chaîne déjà exécutée pour de vrai
 * (devis créé, envoyé, parfois signé côté serveur) : jamais persistable. Le nom du signataire est
 * toujours supprimé, quelle que soit l'étape : le tracé graphique devra être refait, donc son
 * dérivé textuel ne doit pas survivre à une reprise.
 */
export function prepareQuoteDraftForPersistence(
  state: QuoteDraftState,
  savedAt: number,
): QuoteDraftState {
  if (!Number.isFinite(savedAt) || savedAt < 0 || state.flow.step === 'recap') {
    throw new QuoteDraftSnapshotCodecError('unsafe_state');
  }
  const safeState: QuoteDraftState = {
    ...state,
    flow: {
      step: state.flow.step,
      draft: {
        ...state.flow.draft,
        lines: state.flow.draft.lines.map(cloneLine),
        tvaContext: cloneTvaContext(state.flow.draft.tvaContext),
        signerName: null,
      },
    },
    customer: state.customer === null ? null : { ...state.customer },
    lineMetadata: state.lineMetadata.map(cloneMetadata),
    lineForm: { ...state.lineForm },
    proposal: null,
    lastProposalDecision: null,
    mission: { status: 'idle' },
  };
  return markQuoteDraftSaved(safeState, savedAt);
}

export function encodeQuoteDraftSnapshot(
  state: QuoteDraftState,
  identity: QuoteDraftStorageIdentity,
  savedAt: number,
): { readonly serialized: string; readonly state: QuoteDraftState } {
  assertQuoteDraftStorageIdentity(identity);
  const safeState = prepareQuoteDraftForPersistence(state, savedAt);
  // Encode puis redécode : l'écriture est fail-closed face à toute nouvelle forme de state que le
  // contrat disque n'aurait pas encore explicitement acceptée.
  const snapshot: PersistedQuoteDraftV1 = {
    schema: QUOTE_DRAFT_SNAPSHOT_SCHEMA,
    version: QUOTE_DRAFT_SNAPSHOT_VERSION,
    identity: { ...identity },
    savedAt,
    draft: {
      sessionId: safeState.sessionId,
      revision: safeState.revision,
      flow: safeState.flow,
      customer: safeState.customer,
      lineMetadata: safeState.lineMetadata,
      lineForm: safeState.lineForm,
      stagingRevision: safeState.stagingRevision,
      saved: safeState.saved!,
    },
  };
  const serialized = JSON.stringify(snapshot);
  decodeQuoteDraftSnapshot(serialized, identity);
  return { serialized, state: safeState };
}

export function decodeQuoteDraftSnapshot(
  serialized: string,
  expectedIdentity: QuoteDraftStorageIdentity,
): QuoteDraftState {
  assertQuoteDraftStorageIdentity(expectedIdentity);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new QuoteDraftSnapshotCodecError('invalid_json');
  }
  if (!isRecord(parsed)) throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  if (parsed['version'] !== QUOTE_DRAFT_SNAPSHOT_VERSION) {
    throw new QuoteDraftSnapshotCodecError('unsupported_version');
  }
  if (!hasExactKeys(parsed, ['schema', 'version', 'identity', 'savedAt', 'draft'])) {
    throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  }
  if (parsed['schema'] !== QUOTE_DRAFT_SNAPSHOT_SCHEMA) {
    throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  }
  const identity = parseIdentity(parsed['identity']);
  if (identity === null) throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  if (!sameIdentity(identity, expectedIdentity)) {
    throw new QuoteDraftSnapshotCodecError('identity_mismatch');
  }
  const savedAt = parsed['savedAt'];
  if (!nonNegativeSafeInteger(savedAt)) throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  const draft = parsed['draft'];
  if (
    !isRecord(draft) ||
    !hasExactKeys(draft, [
      'sessionId',
      'revision',
      'flow',
      'customer',
      'lineMetadata',
      'lineForm',
      'stagingRevision',
      'saved',
    ])
  )
    throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  const sessionId = draft['sessionId'];
  const revision = draft['revision'];
  const stagingRevision = draft['stagingRevision'];
  if (
    !canonicalIdentifier(sessionId) ||
    !nonNegativeSafeInteger(revision) ||
    !nonNegativeSafeInteger(stagingRevision)
  )
    throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  const flow = parseFlow(draft['flow']);
  const customer = parseCustomer(draft['customer']);
  const lineForm = parseLineForm(draft['lineForm']);
  const rawMetadata = draft['lineMetadata'];
  if (
    flow === null ||
    customer === undefined ||
    lineForm === null ||
    !Array.isArray(rawMetadata) ||
    rawMetadata.length > MAX_LINES
  )
    throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  const lineMetadata = rawMetadata.map(parseMetadata);
  if (
    lineMetadata.some((metadata) => metadata === null) ||
    lineMetadata.length !== flow.draft.lines.length
  )
    throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  const ids = (lineMetadata as QuoteDraftLineMetadata[]).map((metadata) => metadata.id);
  if (new Set(ids).size !== ids.length) throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  if (
    (flow.draft.customerId === null) !== (customer === null) ||
    (customer !== null && customer.id !== flow.draft.customerId)
  )
    throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  const saved = draft['saved'];
  if (!isRecord(saved) || !hasExactKeys(saved, ['contentRevision', 'stagingRevision', 'at'])) {
    throw new QuoteDraftSnapshotCodecError('invalid_snapshot');
  }
  if (
    saved['contentRevision'] !== revision ||
    saved['stagingRevision'] !== stagingRevision ||
    saved['at'] !== savedAt
  )
    throw new QuoteDraftSnapshotCodecError('invalid_snapshot');

  return {
    sessionId,
    revision,
    flow,
    customer,
    lineMetadata: (lineMetadata as QuoteDraftLineMetadata[]).map(cloneMetadata),
    lineForm: { ...lineForm },
    stagingRevision,
    saved: { contentRevision: revision, stagingRevision, at: savedAt },
    completedArtifactIds: Object.freeze([]),
    proposal: null,
    lastProposalDecision: null,
    mission: { status: 'idle' },
  };
}
