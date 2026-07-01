import { formatEUR } from '@bob/core';

/**
 * Aperçu AVANT/APRÈS d'une action sensible — la « preuve » montrée à la confirmation : l'utilisateur voit
 * précisément ce qui va changer (reste dû, statut, numéro…) avant d'autoriser. PUR et déterministe : le
 * `before` (état lu via BobActions) est fourni par l'appelant ; aucune I/O ici -> entièrement testable.
 * Les montants viennent du domaine (jamais inventés).
 */
export interface ActionDiffField {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}
export interface ActionDiff {
  readonly tool: string;
  readonly title: string;
  readonly fields: readonly ActionDiffField[];
}

/** État connu AVANT l'action (sous-ensemble lu via BobActions), passé au calcul du diff. */
export interface DiffSnapshot {
  readonly number?: string | null;
  readonly remainingCents?: number;
}

function intOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Construit l'aperçu d'une action à partir de ses arguments et de l'état AVANT. Renvoie null pour les
 * outils sans effet notable (lecture) ou inconnus.
 */
export function buildActionDiff(tool: string, args: Record<string, unknown>, before: DiffSnapshot = {}): ActionDiff | null {
  const num = before.number ?? null;

  if (tool === 'encaisser_facture') {
    const remaining = Math.max(0, intOr(before.remainingCents, 0));
    const amount = Math.max(0, intOr(args.amountCents, 0));
    const after = Math.max(0, remaining - amount);
    return {
      tool,
      title: `Encaisser ${formatEUR(amount)}${num ? ` · ${num}` : ''}`,
      fields: [
        { label: 'Reste dû', before: formatEUR(remaining), after: formatEUR(after) },
        { label: 'Statut', before: remaining > 0 ? 'À encaisser' : 'Payée', after: after === 0 ? 'Payée' : 'Partielle' },
      ],
    };
  }

  if (tool === 'emettre_facture') {
    return {
      tool,
      title: 'Émettre la facture',
      fields: [
        { label: 'Statut', before: 'Brouillon', after: 'Émise' },
        { label: 'Numéro légal', before: num ?? '—', after: num ?? 'attribué à l’émission' },
      ],
    };
  }

  if (tool === 'envoyer_devis') {
    return {
      tool,
      title: `Envoyer le devis${num ? ` ${num}` : ''}`,
      fields: [{ label: 'Statut', before: 'Brouillon', after: 'Envoyé au client' }],
    };
  }

  return null; // lecture / outil sans aperçu d'état
}
