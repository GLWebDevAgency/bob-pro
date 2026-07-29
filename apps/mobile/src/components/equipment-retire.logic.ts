import { equipmentContractCoverageWarning } from '@bob/core';

/**
 * [Amélioration 4, écrans §2.1] — message de la ConfirmSheet de retrait : l'avertissement de
 * couverture contractuelle du DOMAINE (une seule copy, @bob/core) est DIT AVANT la
 * confirmation, jamais seulement après le geste. `labels: null` = couverture ILLISIBLE
 * (lecture échouée/capacité absente) : la feuille s'affiche sans avertissement (info jamais
 * bloquante — la réalité du terrain prime) et le filet post-ACK du use case reprend la main.
 */
export function retireConfirmMessage(
  base: string,
  labels: readonly string[] | null,
): { message: string; warningShown: boolean } {
  const warning = labels === null ? null : equipmentContractCoverageWarning(labels);
  if (warning === null) return { message: base, warningShown: false };
  return { message: `${base}\n\n${warning}`, warningShown: true };
}
