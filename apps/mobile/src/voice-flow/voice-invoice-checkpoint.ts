import type { QuoteView } from '@bob/api-client';
import type { LineCategory, PaymentMethod, VoiceInvoiceDraft, VoiceInvoiceOutcome } from '@bob/core';

/**
 * Checkpoint local du flux « facture à la voix ».
 *
 * Chaque checkpoint neuf possède désormais une clé createQuote stable : une réponse perdue
 * se rejoue au serveur avec la même intention, sans heuristique. `baselineQuoteIds` et la
 * réconciliation restent uniquement pour reprendre sans perte les checkpoints historiques
 * créés avant ce contrat serveur.
 */

export const VOICE_INVOICE_CHECKPOINT_VERSION = 1 as const;

export type VoiceInvoiceCheckpointPhase =
  | 'prepared'
  | 'quote_created'
  | 'quote_sent'
  | 'quote_signed'
  | 'invoice_generated'
  | 'invoice_issued'
  | 'payment_registered';

export type VoiceInvoiceExecutionAction =
  'create_quote' | 'send_quote' | 'sign_quote' | 'generate_invoice' | 'issue_invoice' | 'register_payment' | 'complete';

export interface VoiceInvoiceCheckpoint {
  readonly version: typeof VOICE_INVOICE_CHECKPOINT_VERSION;
  readonly phase: VoiceInvoiceCheckpointPhase;
  readonly draft: VoiceInvoiceDraft & { customerId: string };
  readonly outcome: VoiceInvoiceOutcome;
  readonly method: PaymentMethod;
  readonly baselineQuoteIds: readonly string[];
  /** Null uniquement lors de la lecture d'un checkpoint historique antérieur au contrat serveur. */
  readonly quoteCreationIdempotencyKey: string | null;
  /** Vrai dès que POST /quotes a été tenté, même si sa réponse n'est jamais arrivée. */
  readonly createAttempted: boolean;
  readonly quoteId: string | null;
  readonly invoiceId: string | null;
  readonly issuedNumber: string | null;
}

export type VoiceInvoiceCheckpointEvent =
  | { readonly type: 'quote_creation_started' }
  | { readonly type: 'quote_created'; readonly quoteId: string }
  | { readonly type: 'quote_sent' }
  | { readonly type: 'quote_signed' }
  | { readonly type: 'invoice_generated'; readonly invoiceId: string }
  | { readonly type: 'invoice_issued'; readonly number: string }
  | { readonly type: 'payment_registered' };

const PAYMENT_METHODS: readonly PaymentMethod[] = ['card', 'transfer', 'cash'];
const OUTCOMES: readonly VoiceInvoiceOutcome[] = ['encaissee', 'envoyee'];
const PHASES: readonly VoiceInvoiceCheckpointPhase[] = [
  'prepared',
  'quote_created',
  'quote_sent',
  'quote_signed',
  'invoice_generated',
  'invoice_issued',
  'payment_registered',
];
const LINE_CATEGORIES: readonly LineCategory[] = ['labor', 'supply', 'travel', 'disbursement', 'subscription'];
const VAT_RATES = [0, 2.1, 5.5, 10, 20] as const;

function isNonEmptyString(value: unknown, max = 240): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isNullableString(value: unknown, max = 500): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value, 240);
}

function isIdempotencyKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isLine(value: unknown): value is VoiceInvoiceDraft['lines'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Record<string, unknown>;
  return (
    isNonEmptyString(line['label'], 500) &&
    LINE_CATEGORIES.includes(line['category'] as LineCategory) &&
    typeof line['qty'] === 'number' &&
    Number.isFinite(line['qty']) &&
    line['qty'] > 0 &&
    (line['unit'] === undefined || isNonEmptyString(line['unit'], 80)) &&
    typeof line['unitPriceHT'] === 'number' &&
    Number.isSafeInteger(line['unitPriceHT']) &&
    line['unitPriceHT'] > 0 &&
    typeof line['vatRate'] === 'number' &&
    VAT_RATES.includes(line['vatRate'] as (typeof VAT_RATES)[number])
  );
}

function hasPhaseCoherence(checkpoint: VoiceInvoiceCheckpoint): boolean {
  const quoteRequired = checkpoint.phase !== 'prepared';
  const invoiceRequired =
    checkpoint.phase === 'invoice_generated' ||
    checkpoint.phase === 'invoice_issued' ||
    checkpoint.phase === 'payment_registered';
  const issueRequired = checkpoint.phase === 'invoice_issued' || checkpoint.phase === 'payment_registered';

  if (quoteRequired !== (checkpoint.quoteId !== null)) return false;
  if (invoiceRequired !== (checkpoint.invoiceId !== null)) return false;
  if (issueRequired !== (checkpoint.issuedNumber !== null)) return false;
  if (checkpoint.phase === 'payment_registered' && checkpoint.outcome !== 'encaissee') return false;
  // Toute phase postérieure à « prepared » prouve nécessairement qu'une création a été
  // tentée ; prepared accepte les deux états (avant appel / réponse encore inconnue).
  return checkpoint.phase === 'prepared' || checkpoint.createAttempted;
}

export function createVoiceInvoiceCheckpoint(input: {
  readonly draft: VoiceInvoiceDraft;
  readonly outcome: VoiceInvoiceOutcome;
  readonly method: PaymentMethod;
  readonly baselineQuoteIds: readonly string[];
  readonly quoteCreationIdempotencyKey: string;
}): VoiceInvoiceCheckpoint {
  if (input.draft.customerId === null) throw new Error('VOICE_CHECKPOINT_CUSTOMER_REQUIRED');
  if (input.draft.lines.length === 0) throw new Error('VOICE_CHECKPOINT_LINES_REQUIRED');
  const baselineQuoteIds = [...new Set(input.baselineQuoteIds)];
  if (baselineQuoteIds.length > 5_000 || !baselineQuoteIds.every((id) => isNonEmptyString(id, 240))) {
    throw new Error('VOICE_CHECKPOINT_BASELINE_INVALID');
  }
  if (!isIdempotencyKey(input.quoteCreationIdempotencyKey)) {
    throw new Error('VOICE_CHECKPOINT_IDEMPOTENCY_KEY_INVALID');
  }
  return {
    version: VOICE_INVOICE_CHECKPOINT_VERSION,
    phase: 'prepared',
    draft: {
      transcript: input.draft.transcript,
      customerId: input.draft.customerId,
      lines: input.draft.lines.map((line) => ({ ...line })),
    },
    outcome: input.outcome,
    method: input.method,
    baselineQuoteIds,
    quoteCreationIdempotencyKey: input.quoteCreationIdempotencyKey,
    createAttempted: false,
    quoteId: null,
    invoiceId: null,
    issuedNumber: null,
  };
}

export function advanceVoiceInvoiceCheckpoint(
  checkpoint: VoiceInvoiceCheckpoint,
  event: VoiceInvoiceCheckpointEvent,
): VoiceInvoiceCheckpoint {
  switch (event.type) {
    case 'quote_creation_started':
      if (checkpoint.phase !== 'prepared') throw new Error('VOICE_CHECKPOINT_INVALID_TRANSITION');
      return { ...checkpoint, createAttempted: true };
    case 'quote_created':
      if (checkpoint.phase !== 'prepared' || !isNonEmptyString(event.quoteId)) {
        throw new Error('VOICE_CHECKPOINT_INVALID_TRANSITION');
      }
      return {
        ...checkpoint,
        phase: 'quote_created',
        createAttempted: true,
        quoteId: event.quoteId,
      };
    case 'quote_sent':
      if (checkpoint.phase !== 'quote_created') throw new Error('VOICE_CHECKPOINT_INVALID_TRANSITION');
      return { ...checkpoint, phase: 'quote_sent' };
    case 'quote_signed':
      if (checkpoint.phase !== 'quote_sent') throw new Error('VOICE_CHECKPOINT_INVALID_TRANSITION');
      return { ...checkpoint, phase: 'quote_signed' };
    case 'invoice_generated':
      if (checkpoint.phase !== 'quote_signed' || !isNonEmptyString(event.invoiceId)) {
        throw new Error('VOICE_CHECKPOINT_INVALID_TRANSITION');
      }
      return { ...checkpoint, phase: 'invoice_generated', invoiceId: event.invoiceId };
    case 'invoice_issued':
      if (checkpoint.phase !== 'invoice_generated' || !isNonEmptyString(event.number)) {
        throw new Error('VOICE_CHECKPOINT_INVALID_TRANSITION');
      }
      return { ...checkpoint, phase: 'invoice_issued', issuedNumber: event.number };
    case 'payment_registered':
      if (checkpoint.phase !== 'invoice_issued' || checkpoint.outcome !== 'encaissee') {
        throw new Error('VOICE_CHECKPOINT_INVALID_TRANSITION');
      }
      return { ...checkpoint, phase: 'payment_registered' };
  }
}

export function nextVoiceInvoiceExecutionAction(checkpoint: VoiceInvoiceCheckpoint): VoiceInvoiceExecutionAction {
  switch (checkpoint.phase) {
    case 'prepared':
      return 'create_quote';
    case 'quote_created':
      return 'send_quote';
    case 'quote_sent':
      return 'sign_quote';
    case 'quote_signed':
      return 'generate_invoice';
    case 'invoice_generated':
      return 'issue_invoice';
    case 'invoice_issued':
      return checkpoint.outcome === 'encaissee' ? 'register_payment' : 'complete';
    case 'payment_registered':
      return 'complete';
  }
}

export function voiceInvoiceCheckpointProgress(checkpoint: VoiceInvoiceCheckpoint): {
  readonly completed: number;
  readonly total: number;
} {
  const completedByPhase: Record<VoiceInvoiceCheckpointPhase, number> = {
    prepared: 0,
    quote_created: 1,
    quote_sent: 2,
    quote_signed: 3,
    invoice_generated: 4,
    invoice_issued: 5,
    payment_registered: 6,
  };
  return {
    completed: completedByPhase[checkpoint.phase],
    total: checkpoint.outcome === 'encaissee' ? 6 : 5,
  };
}

function normalizedLine(line: VoiceInvoiceDraft['lines'][number] | QuoteView['lines'][number]): string {
  return JSON.stringify([
    line.label.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR'),
    line.category,
    line.qty,
    line.unit?.trim().toLocaleLowerCase('fr-FR') ?? null,
    line.unitPriceHT,
    line.vatRate,
  ]);
}

export function quoteMatchesVoiceInvoiceDraft(quote: QuoteView, draft: VoiceInvoiceCheckpoint['draft']): boolean {
  return (
    quote.customerId === draft.customerId &&
    quote.lines.length === draft.lines.length &&
    quote.lines.every((line, index) => {
      const draftLine = draft.lines[index];
      return draftLine !== undefined && normalizedLine(line) === normalizedLine(draftLine);
    })
  );
}

export type VoiceQuoteReconciliation =
  { readonly kind: 'found'; readonly quoteId: string } | { readonly kind: 'not_found' } | { readonly kind: 'ambiguous' };

export function reconcileVoiceInvoiceQuote(
  checkpoint: VoiceInvoiceCheckpoint,
  quotes: readonly QuoteView[],
): VoiceQuoteReconciliation {
  if (checkpoint.quoteId !== null) {
    return quotes.some((quote) => quote.id === checkpoint.quoteId)
      ? { kind: 'found', quoteId: checkpoint.quoteId }
      : { kind: 'not_found' };
  }
  const baseline = new Set(checkpoint.baselineQuoteIds);
  const candidates = quotes.filter(
    (quote) => !baseline.has(quote.id) && quoteMatchesVoiceInvoiceDraft(quote, checkpoint.draft),
  );
  if (candidates.length === 1) return { kind: 'found', quoteId: candidates[0]!.id };
  if (candidates.length === 0) return { kind: 'not_found' };
  return { kind: 'ambiguous' };
}

export function voiceInvoicePaymentIdempotencyKey(input: {
  readonly invoiceId: string;
  readonly amount: number;
  readonly method: PaymentMethod;
}): string {
  return `mobile-voice:payment:${input.invoiceId}:${input.amount}:${input.method}`;
}

/** Sérialise le minimum nécessaire à la reprise, sans conserver le transcript vocal brut. */
export function serializeVoiceInvoiceCheckpoint(checkpoint: VoiceInvoiceCheckpoint): string {
  return JSON.stringify({
    ...checkpoint,
    draft: { ...checkpoint.draft, transcript: null },
  });
}

export function parseVoiceInvoiceCheckpoint(raw: string | null): VoiceInvoiceCheckpoint | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const draft = candidate['draft'];
  if (typeof draft !== 'object' || draft === null) return null;
  const draftValue = draft as Record<string, unknown>;
  const lines = draftValue['lines'];
  const baselineQuoteIds = candidate['baselineQuoteIds'];
  const rawQuoteCreationIdempotencyKey = candidate['quoteCreationIdempotencyKey'];
  if (
    candidate['version'] !== VOICE_INVOICE_CHECKPOINT_VERSION ||
    !PHASES.includes(candidate['phase'] as VoiceInvoiceCheckpointPhase) ||
    !OUTCOMES.includes(candidate['outcome'] as VoiceInvoiceOutcome) ||
    !PAYMENT_METHODS.includes(candidate['method'] as PaymentMethod) ||
    !isNullableString(draftValue['transcript'], 20_000) ||
    !isNonEmptyString(draftValue['customerId'], 240) ||
    !Array.isArray(lines) ||
    lines.length === 0 ||
    lines.length > 100 ||
    !lines.every(isLine) ||
    !Array.isArray(baselineQuoteIds) ||
    baselineQuoteIds.length > 5_000 ||
    !baselineQuoteIds.every((id) => isNonEmptyString(id, 240)) ||
    (
      rawQuoteCreationIdempotencyKey !== undefined
      && rawQuoteCreationIdempotencyKey !== null
      && !isIdempotencyKey(rawQuoteCreationIdempotencyKey)
    ) ||
    typeof candidate['createAttempted'] !== 'boolean' ||
    !isNullableIdentifier(candidate['quoteId']) ||
    !isNullableIdentifier(candidate['invoiceId']) ||
    !isNullableIdentifier(candidate['issuedNumber'])
  ) {
    return null;
  }

  const checkpoint: VoiceInvoiceCheckpoint = {
    version: VOICE_INVOICE_CHECKPOINT_VERSION,
    phase: candidate['phase'] as VoiceInvoiceCheckpointPhase,
    draft: {
      transcript: draftValue['transcript'] as string | null,
      customerId: draftValue['customerId'] as string,
      lines: lines as VoiceInvoiceDraft['lines'],
    },
    outcome: candidate['outcome'] as VoiceInvoiceOutcome,
    method: candidate['method'] as PaymentMethod,
    baselineQuoteIds: [...new Set(baselineQuoteIds as string[])],
    // Compatibilité de reprise : un ancien checkpoint garde son chemin de réconciliation
    // fail-closed, tandis que toute nouvelle création reçoit une clé non nulle.
    quoteCreationIdempotencyKey:
      typeof rawQuoteCreationIdempotencyKey === 'string' ? rawQuoteCreationIdempotencyKey : null,
    createAttempted: candidate['createAttempted'],
    quoteId: candidate['quoteId'] as string | null,
    invoiceId: candidate['invoiceId'] as string | null,
    issuedNumber: candidate['issuedNumber'] as string | null,
  };
  return hasPhaseCoherence(checkpoint) ? checkpoint : null;
}
