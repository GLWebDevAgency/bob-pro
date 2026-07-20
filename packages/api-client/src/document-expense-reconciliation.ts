import type { AppError, DocumentView } from '@bob/core';
import type {
  BobClient,
  RecordDocumentExpenseClientInput,
  RecordDocumentExpenseClientOutput,
} from './client';

type DocumentExpenseRecoveryClient = Pick<BobClient, 'getDocument' | 'recordDocumentExpense'>;

export type DocumentExpenseReconciliation =
  | { kind: 'verified'; value: RecordDocumentExpenseClientOutput }
  | {
      kind: 'stale';
      command: RecordDocumentExpenseClientInput;
      current: DocumentView | null;
      readError: AppError | null;
    }
  | { kind: 'rejected'; command: RecordDocumentExpenseClientInput; error: AppError }
  | { kind: 'unresolved'; command: RecordDocumentExpenseClientInput; error: AppError };

async function staleState(
  client: DocumentExpenseRecoveryClient,
  command: RecordDocumentExpenseClientInput,
): Promise<DocumentExpenseReconciliation> {
  const current = await client.getDocument(command.documentId);
  return current.ok
    ? { kind: 'stale', command, current: current.value, readError: null }
    : { kind: 'stale', command, current: null, readError: current.error };
}

/**
 * Réconcilie une réponse perdue sans affaiblir le compare-and-swap documentaire.
 *
 * Seule une erreur de dépendance est ambiguë : la même commande est alors rejouée telle quelle,
 * avec son ancienne `expectedRevision`, pour demander au registre serveur si CE geste a déjà été
 * commité. Un conflit n'est jamais « réparé » avec une révision rechargée : l'état courant est
 * seulement rendu à l'UI, qui devra obtenir une nouvelle confirmation humaine.
 */
export async function reconcileDocumentExpenseCommand(
  client: DocumentExpenseRecoveryClient,
  command: RecordDocumentExpenseClientInput,
  initialError: AppError,
): Promise<DocumentExpenseReconciliation> {
  if (initialError.kind === 'conflict') return staleState(client, command);
  if (initialError.kind !== 'dependency') return { kind: 'rejected', command, error: initialError };

  const replay = await client.recordDocumentExpense(command);
  if (replay.ok) return { kind: 'verified', value: replay.value };
  if (replay.error.kind === 'conflict') return staleState(client, command);
  if (replay.error.kind === 'dependency') {
    return { kind: 'unresolved', command, error: replay.error };
  }
  return { kind: 'rejected', command, error: replay.error };
}
