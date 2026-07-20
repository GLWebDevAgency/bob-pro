import type { BobClient, ExpenseDefaultsView, SuggestExpenseDefaultsInput } from '@bob/api-client';

/**
 * Clé privée bornée par le tenant authentifié.
 *
 * La purge synchrone du QueryClient à chaque changement d'identité reste la barrière principale.
 * Inclure aussi le `companyId` ici évite qu'une réponse fournisseur ne puisse être réutilisée par
 * un autre dossier si une future navigation multi-sociétés partage le même cache React Query.
 */
export function supplierExpenseDefaultsKey(
  companyId: string | null,
  input: SuggestExpenseDefaultsInput | null,
) {
  return [
    'supplier-memory',
    companyId,
    input?.supplierName.trim() ?? null,
    input?.supplierSiren ?? null,
    input?.vatRatePctApplied ?? null,
    input?.categoryGuess ?? null,
  ] as const;
}

/** Charge exclusivement le profil fournisseur durable exposé par l'API tenant-scoped. */
export async function loadSupplierExpenseDefaults(
  client: Pick<BobClient, 'suggestExpenseDefaults'>,
  input: SuggestExpenseDefaultsInput,
): Promise<ExpenseDefaultsView> {
  const result = await client.suggestExpenseDefaults(input);
  if (!result.ok) throw result.error;
  return result.value;
}

export type SupplierExpenseDefaultsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: ExpenseDefaultsView }
  | { readonly kind: 'unavailable' };

export interface SupplierExpenseDefaultsQuerySnapshot {
  readonly data: ExpenseDefaultsView | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

/**
 * État fail-closed consommé par le scan : une erreur de mémoire serveur ne signifie jamais
 * « fournisseur inconnu ». Elle reste explicitement indisponible et interdit d'enregistrer des
 * valeurs qui auraient été recalculées depuis un cache ou l'historique local.
 */
export function deriveSupplierExpenseDefaultsState(input: {
  readonly hasExtraction: boolean;
  readonly companyId: string | null;
  readonly query: SupplierExpenseDefaultsQuerySnapshot;
}): SupplierExpenseDefaultsState {
  if (!input.hasExtraction) return { kind: 'idle' };
  if (input.companyId === null || input.query.isError) return { kind: 'unavailable' };
  if (input.query.data !== undefined) return { kind: 'ready', value: input.query.data };
  if (input.query.isPending) return { kind: 'loading' };
  return { kind: 'unavailable' };
}
