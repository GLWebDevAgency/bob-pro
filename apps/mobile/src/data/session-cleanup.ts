/**
 * Nettoyages best-effort exécutés AVANT la destruction de la session Supabase.
 *
 * Un adapter (push aujourd'hui, uploads chiffrés demain) s'inscrit sans créer de dépendance
 * circulaire Auth → BobClient → Auth. La déconnexion reste bornée : un réseau en panne ne peut
 * ni la bloquer ni faire remonter une erreur technique à l'utilisateur.
 */

export type BeforeSignOutCleanup = () => Promise<void>;

const beforeSignOutCleanups = new Set<BeforeSignOutCleanup>();

export function registerBeforeSignOutCleanup(cleanup: BeforeSignOutCleanup): () => void {
  beforeSignOutCleanups.add(cleanup);
  return () => beforeSignOutCleanups.delete(cleanup);
}

export interface SignOutCleanupReport {
  readonly completed: number;
  readonly failed: number;
  readonly timedOut: boolean;
}

export async function runBeforeSignOutCleanups(timeoutMs = 1_500): Promise<SignOutCleanupReport> {
  const cleanups = [...beforeSignOutCleanups];
  if (cleanups.length === 0) return { completed: 0, failed: 0, timedOut: false };

  const settled = Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
  });
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);

  if (result === null) {
    // `settled` conserve ses handlers : une fin tardive ne produira jamais de rejection non gérée.
    return { completed: 0, failed: 0, timedOut: true };
  }
  return {
    completed: result.filter((entry) => entry.status === 'fulfilled').length,
    failed: result.filter((entry) => entry.status === 'rejected').length,
    timedOut: false,
  };
}

/** Test uniquement : isole les registres entre cas sans exposer cette primitive à l'UI. */
export function clearBeforeSignOutCleanupsForTests(): void {
  beforeSignOutCleanups.clear();
}
