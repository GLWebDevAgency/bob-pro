import { AsyncLocalStorage } from 'node:async_hooks';

type PostCommitTask = () => void;
export type PostCommitDisposition = 'deferred' | 'absent' | 'closed';

interface PostCommitBoundary {
  readonly tasks: PostCommitTask[];
  state: 'open' | 'flushed';
}

const postCommitStorage = new AsyncLocalStorage<PostCommitBoundary>();

/**
 * Enregistre une projection opportuniste sur le vrai commit HTTP tenant courant.
 *
 * `absent` signifie qu'aucune transaction extérieure n'existe et autorise un lancement immédiat.
 * `closed` désigne une continuation tardive ayant hérité d'une frontière déjà résolue : elle est
 * refusée pour ne jamais produire un geste fantôme après commit ou rollback.
 */
export function deferUntilTenantCommit(task: PostCommitTask): PostCommitDisposition {
  const boundary = postCommitStorage.getStore();
  if (boundary === undefined) return 'absent';
  if (boundary.state !== 'open') return 'closed';
  boundary.tasks.push(task);
  return 'deferred';
}

/** Lance immédiatement uniquement hors frontière ; un contexte fermé reste refusé. */
export function scheduleAfterTenantCommit(
  task: PostCommitTask,
  onTaskError: (cause: unknown) => void = () => undefined,
): PostCommitDisposition {
  const disposition = deferUntilTenantCommit(task);
  if (disposition === 'absent') {
    try {
      task();
    } catch (cause) {
      // Hors frontière HTTP, l'acte métier est déjà committé. Une projection opportuniste ou son
      // diagnostic ne peut jamais transformer ce succès acquis en faux 500.
      try {
        onTaskError(cause);
      } catch {
        // Même plancher que le flush différé : le diagnostic reste strictement best-effort.
      }
    }
  }
  return disposition;
}

/**
 * Enveloppe la transaction tenant racine. Les tâches sont libérées après sa résolution, donc après
 * le commit PostgreSQL. Un rollback ne lance rien et une panne post-commit ne peut plus transformer
 * un acte métier committé en faux échec HTTP.
 */
export async function runWithTenantPostCommitBoundary<T>(
  operation: () => Promise<T>,
  onTaskError: (cause: unknown) => void,
): Promise<T> {
  // Une frontière imbriquée appartient toujours au commit extérieur.
  if (postCommitStorage.getStore() !== undefined) return operation();

  const boundary: PostCommitBoundary = { tasks: [], state: 'open' };
  let result: T;
  try {
    result = await postCommitStorage.run(boundary, operation);
  } catch (cause) {
    boundary.state = 'flushed';
    throw cause;
  }

  // Fermer avant le premier callback : une continuation créée par une tâche ne peut pas réarmer
  // silencieusement la file de la transaction déjà committée.
  boundary.state = 'flushed';
  for (const task of [...boundary.tasks]) {
    try {
      task();
    } catch (cause) {
      try {
        onTaskError(cause);
      } catch {
        // Le commit est acquis ; même une panne du diagnostic n'altère jamais la réponse.
      }
    }
  }
  return result;
}
