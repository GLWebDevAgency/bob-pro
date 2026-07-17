import type { AccountingPreviewLine, BobClient } from '@bob/api-client';
import type { AppError } from '@bob/core';

export type CollectAccountingPreviewResolution =
  | { kind: 'ready'; lines: readonly AccountingPreviewLine[] }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'stale' }
  | { kind: 'invalid_contract' }
  | { kind: 'error'; error: AppError };

/**
 * Charge la preuve comptable qui sera montrée avant un encaissement.
 *
 * Aucun repli local n'est permis : si le serveur ne confirme pas exactement le reste dû
 * actuellement affiché, l'UI doit bloquer la confirmation et demander une actualisation.
 */
export async function resolveCollectAccountingPreview(
  client: Pick<BobClient, 'paymentAccountingPreview'>,
  input: { invoiceId: string; expectedRemainingCents: number },
): Promise<CollectAccountingPreviewResolution> {
  let result: Awaited<ReturnType<BobClient['paymentAccountingPreview']>>;
  try {
    result = await client.paymentAccountingPreview({
      invoiceId: input.invoiceId,
      amountCents: input.expectedRemainingCents,
      method: 'transfer',
    });
  } catch (cause) {
    return {
      kind: 'error',
      error: {
        kind: 'dependency',
        port: 'payment-accounting-preview',
        cause: cause instanceof Error ? cause.message : 'Échec inattendu.',
      },
    };
  }
  if (!result.ok) return { kind: 'error', error: result.error };
  if (result.value.invoiceId !== input.invoiceId) return { kind: 'invalid_contract' };
  if (!result.value.available) {
    return { kind: 'unavailable', reason: result.value.reason };
  }
  if (
    result.value.invoiceId !== input.invoiceId
    || result.value.method !== 'transfer'
    || result.value.amountCents !== input.expectedRemainingCents
    || result.value.remainingCents !== input.expectedRemainingCents
  )
    return { kind: 'stale' };
  if (
    result.value.lines.length < 2
    || result.value.totalDebitCents !== input.expectedRemainingCents
    || result.value.totalCreditCents !== input.expectedRemainingCents
  )
    return { kind: 'invalid_contract' };
  return { kind: 'ready', lines: result.value.lines };
}
