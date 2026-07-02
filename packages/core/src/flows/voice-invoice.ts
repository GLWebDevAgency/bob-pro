import { type DomainResult, ok, err } from '../shared-kernel/result';
import { assertTransition } from '../domain/billing/shared/state-machines';
import { type LineInput } from '../domain/billing/shared/line-item';

/**
 * Flow Facture à la voix (C20) — 3 étapes : écoute (onde) → revue pré-remplie → terminée.
 * PROJECTION pure : la reconnaissance vocale et la création de facture restent hors du
 * flow (STT + IssueInvoice/RegisterPayment côté app). Garde-fou charte : PRÉPARER ≠
 * ENVOYER — l'issue (encaissée/envoyée) exige une confirmation explicite depuis la revue.
 */
export type VoiceInvoiceStep = 'ecoute' | 'revue' | 'terminee';
export type VoiceInvoiceOutcome = 'encaissee' | 'envoyee';

export const VOICE_INVOICE_TRANSITIONS: Record<VoiceInvoiceStep, readonly VoiceInvoiceStep[]> = {
  ecoute: ['revue'],
  revue: ['ecoute', 'terminee'],
  terminee: [],
};

export interface VoiceInvoiceDraft {
  transcript: string | null;
  customerId: string | null;
  lines: LineInput[];
}

export interface VoiceInvoiceState {
  step: VoiceInvoiceStep;
  draft: VoiceInvoiceDraft;
  outcome: VoiceInvoiceOutcome | null;
}

export function startVoiceInvoice(): VoiceInvoiceState {
  return {
    step: 'ecoute',
    draft: { transcript: null, customerId: null, lines: [] },
    outcome: null,
  };
}

/** L'écoute a produit une proposition exploitable : passe en revue. */
export function voiceCaptured(
  state: VoiceInvoiceState,
  draft: VoiceInvoiceDraft,
): DomainResult<VoiceInvoiceState> {
  const allowed = assertTransition(VOICE_INVOICE_TRANSITIONS, state.step, 'revue');
  if (!allowed.ok) return allowed;
  if (draft.lines.length === 0)
    return err({
      code: 'VALIDATION',
      field: 'lines',
      message: "Je n'ai pas entendu de prestation — on réessaie ?",
    });
  return ok({ step: 'revue', draft, outcome: null });
}

/** Corriger : retour à l'écoute — le brouillon est conservé pour être complété. */
export function voiceRetry(state: VoiceInvoiceState): DomainResult<VoiceInvoiceState> {
  const allowed = assertTransition(VOICE_INVOICE_TRANSITIONS, state.step, 'ecoute');
  if (!allowed.ok) return allowed;
  return ok({ ...state, step: 'ecoute' });
}

/** Confirmation EXPLICITE de l'issue depuis la revue (garde-fou préparer ≠ envoyer). */
export function voiceConfirm(
  state: VoiceInvoiceState,
  outcome: VoiceInvoiceOutcome,
): DomainResult<VoiceInvoiceState> {
  const allowed = assertTransition(VOICE_INVOICE_TRANSITIONS, state.step, 'terminee');
  if (!allowed.ok) return allowed;
  if (state.draft.customerId === null)
    return err({
      code: 'VALIDATION',
      field: 'customerId',
      message: 'Il me faut le client avant de facturer',
    });
  return ok({ ...state, step: 'terminee', outcome });
}
