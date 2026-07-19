import { type DomainResult, ok, err } from '../../shared-kernel/result';

/**
 * B2 — Proposition d'une situation de travaux depuis l'avancement du chantier.
 *
 * Règle PURE et STRICTEMENT CONSULTATIVE : les tâches cochées du chantier produisent un
 * POURCENTAGE PROPOSÉ, JAMAIS IMPOSÉ — l'artisan reste seul maître du montant réellement
 * facturé (philosophie « conseiller, jamais contraindre »). Le use case de génération
 * (GenerateInvoiceFromQuote, mode 'situation') reçoit toujours le montant/pourcentage CHOISI,
 * jamais cette proposition directement.
 */
export interface ChantierTaskProgress {
  /** Tâche cochée (terminée) — fait déclaré par l'artisan, jamais déduit. */
  done: boolean;
  /**
   * Poids relatif de la tâche dans l'avancement (> 0). Absent = 1 : toutes les tâches pèsent
   * pareil tant que l'artisan n'a pas pondéré (honnête, jamais une pondération inventée).
   */
  weight?: number;
}

export interface SituationProposal {
  /** Avancement proposé, entier 0..100 (arrondi commercial). */
  percent: number;
  doneCount: number;
  totalCount: number;
}

/**
 * Tâches cochées → % d'avancement proposé. `null` quand il n'y a AUCUNE tâche : Bob ne propose
 * rien plutôt que d'inventer un avancement (données honnêtes, proposition jamais imposée).
 */
export function proposeSituationFromChantier(input: {
  tasks: readonly ChantierTaskProgress[];
}): DomainResult<SituationProposal | null> {
  if (!Array.isArray(input.tasks))
    return err({ code: 'VALIDATION', field: 'tasks', message: 'Liste de tâches invalide.' });
  if (input.tasks.length === 0) return ok(null);
  let doneWeight = 0;
  let totalWeight = 0;
  let doneCount = 0;
  for (const task of input.tasks) {
    const weight = task.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0)
      return err({ code: 'VALIDATION', field: 'tasks', message: 'Poids de tâche invalide (> 0 requis).' });
    totalWeight += weight;
    if (task.done === true) {
      doneWeight += weight;
      doneCount += 1;
    }
  }
  const percent = Math.min(100, Math.max(0, Math.round((doneWeight / totalWeight) * 100)));
  return ok({ percent, doneCount, totalCount: input.tasks.length });
}
