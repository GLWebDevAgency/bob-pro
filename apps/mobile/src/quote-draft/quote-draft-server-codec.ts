import {
  QUOTE_DRAFT_PAYLOAD_SCHEMA,
  QUOTE_DRAFT_PAYLOAD_VERSION,
  parseQuoteDraftPayload,
  type DevisTvaContext,
  type QuoteDraftPayloadV1,
} from '@bob/core';
import type { QuoteDraftSlotView } from '@bob/api-client';
import type { QuoteDraftLineFormState, QuoteDraftState } from './quote-draft-model';

/**
 * Frontière pure entre l'état React V2 du wizard et le contrat durable V1 du serveur.
 *
 * Le payload ne porte volontairement aucune identité, proposition IA, mission vocale,
 * signature manuscrite ou callback. Ces données éphémères ne doivent jamais être rejouées après
 * une reprise. L'identité propriétaire est exclusivement dérivée du JWT côté serveur.
 */
export class QuoteDraftServerCodecError extends Error {
  constructor(
    readonly code: 'unsafe_state' | 'invalid_payload' | 'invalid_timestamp',
  ) {
    super(`QUOTE_DRAFT_SERVER_CODEC_${code.toUpperCase()}`);
    this.name = 'QuoteDraftServerCodecError';
  }
}

function canonicalFormValue(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function canonicalLineForm(form: QuoteDraftLineFormState): QuoteDraftLineFormState {
  return {
    label: canonicalFormValue(form.label),
    quantity: canonicalFormValue(form.quantity),
    unitPrice: canonicalFormValue(form.unitPrice),
    category: form.category,
  };
}

function vatDecisionOf(state: QuoteDraftState): QuoteDraftPayloadV1['draft']['vatDecision'] {
  const { tvaContext, vatRate } = state.flow.draft;
  if (vatRate === null) {
    if (tvaContext !== null || state.flow.draft.lines.length > 0) {
      throw new QuoteDraftServerCodecError('unsafe_state');
    }
    return null;
  }
  return {
    rate: vatRate,
    ...(tvaContext?.housingOlderThan2y !== undefined
      ? { housingOlderThan2y: tvaContext.housingOlderThan2y }
      : {}),
    ...(tvaContext?.energyRenovation !== undefined
      ? { energyRenovation: tvaContext.energyRenovation }
      : {}),
  };
}

/** Encode un état restaurable et le repasse dans le parseur exact du core (fail closed). */
export function encodeQuoteDraftServerPayload(state: QuoteDraftState): QuoteDraftPayloadV1 {
  if (state.flow.step === 'recap') throw new QuoteDraftServerCodecError('unsafe_state');
  if ((state.customer?.id ?? null) !== state.flow.draft.customerId) {
    throw new QuoteDraftServerCodecError('unsafe_state');
  }

  const candidate: QuoteDraftPayloadV1 = {
    schema: QUOTE_DRAFT_PAYLOAD_SCHEMA,
    version: QUOTE_DRAFT_PAYLOAD_VERSION,
    draft: {
      sessionId: state.sessionId,
      contentRevision: state.revision,
      stagingRevision: state.stagingRevision,
      step: state.flow.step,
      customer: state.customer === null ? null : { ...state.customer },
      lines: state.flow.draft.lines.map((line) => ({
        label: line.label,
        category: line.category,
        qty: line.qty,
        unitPriceHT: line.unitPriceHT,
        vatRate: line.vatRate,
        ...(line.unit === undefined ? {} : { unit: line.unit }),
      })),
      lineMetadata: state.lineMetadata.map((metadata) => ({
        id: metadata.id,
        interaction: metadata.interaction,
        ...(metadata.catalogue === undefined
          ? {}
          : { catalogue: { ...metadata.catalogue } }),
      })),
      lineForm: canonicalLineForm(state.lineForm),
      vatDecision: vatDecisionOf(state),
      depositPct: state.flow.draft.depositPct,
      signMode: state.flow.draft.signMode,
      // Exception dépannage urgent : encodée uniquement quand déclarée (payload minimal,
      // brouillons antérieurs inchangés — absent = non sollicitée, fail-closed).
      ...(state.flow.draft.urgentRepairRequested === true
        ? { urgentRepairRequested: true }
        : {}),
    },
  };
  const parsed = parseQuoteDraftPayload(candidate);
  if (!parsed.ok) throw new QuoteDraftServerCodecError('invalid_payload');
  return parsed.value;
}

function contextOf(
  decision: QuoteDraftPayloadV1['draft']['vatDecision'],
): DevisTvaContext | null {
  if (decision === null) return null;
  return {
    ...(decision.housingOlderThan2y === undefined
      ? {}
      : { housingOlderThan2y: decision.housingOlderThan2y }),
    ...(decision.energyRenovation === undefined
      ? {}
      : { energyRenovation: decision.energyRenovation }),
  };
}

/**
 * Réhydrate uniquement les champs durables. Toute autorité éphémère repart dans son état sûr :
 * proposition absente, mission inactive, signature non rejouée et callbacks de création vides.
 */
export function decodeQuoteDraftServerSlot(slot: QuoteDraftSlotView): QuoteDraftState {
  const parsed = parseQuoteDraftPayload(slot.payload);
  if (!parsed.ok || slot.payloadVersion !== QUOTE_DRAFT_PAYLOAD_VERSION) {
    throw new QuoteDraftServerCodecError('invalid_payload');
  }
  const savedAt = Date.parse(slot.updatedAt);
  if (!Number.isFinite(savedAt)) throw new QuoteDraftServerCodecError('invalid_timestamp');
  const { draft } = parsed.value;
  return {
    sessionId: draft.sessionId,
    revision: draft.contentRevision,
    flow: {
      step: draft.step,
      draft: {
        customerId: draft.customer?.id ?? null,
        lines: draft.lines.map((line) => ({ ...line })),
        tvaContext: contextOf(draft.vatDecision),
        vatRate: draft.vatDecision?.rate ?? null,
        depositPct: draft.depositPct,
        signMode: draft.signMode,
        signerName: null,
        // Exception dépannage urgent : reprise fidèle — absent = non sollicitée (fail-closed).
        urgentRepairRequested: draft.urgentRepairRequested === true,
      },
    },
    customer: draft.customer === null ? null : { ...draft.customer },
    lineMetadata: draft.lineMetadata.map((metadata) => ({
      ...metadata,
      ...(metadata.catalogue === undefined ? {} : { catalogue: { ...metadata.catalogue } }),
    })),
    lineForm: { ...draft.lineForm },
    stagingRevision: draft.stagingRevision,
    saved: {
      contentRevision: draft.contentRevision,
      stagingRevision: draft.stagingRevision,
      at: savedAt,
    },
    completedArtifactIds: Object.freeze([]),
    proposal: null,
    lastProposalDecision: null,
    mission: { status: 'idle' },
  };
}
