import { buildPaymentAccountingPreviewLines, formatEUR, type PaymentMethod } from '@bob/core';

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

/**
 * Ligne d'écriture comptable (partie double) — exactement 1 débit OU 1 crédit non nul. Même forme que
 * AccountingPreviewLine de @bob/api-client, pour un mapping 1:1 depuis client.invoiceAccountingPreview.
 */
export interface AccountingLine {
  readonly account: string;
  readonly label: string;
  readonly debitCents: number;
  readonly creditCents: number;
}

export interface ActionDiff {
  readonly tool: string;
  readonly title: string;
  readonly fields: readonly ActionDiffField[];
  /** Écriture comptable prévisionnelle (débit/crédit) — optionnelle, fournie via le snapshot. */
  readonly accounting?: readonly AccountingLine[];
}

/** État connu AVANT l'action (sous-ensemble lu via BobActions), passé au calcul du diff. */
export interface DiffSnapshot {
  readonly number?: string | null;
  readonly remainingCents?: number;
  /** Écriture comptable prévisionnelle (via client.invoiceAccountingPreview) — affichée telle quelle. */
  readonly accountingLines?: readonly AccountingLine[];
}

function intOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function paymentMethodOrTransfer(v: unknown): PaymentMethod {
  return v === 'cash' || v === 'card' || v === 'transfer' ? v : 'transfer';
}

/**
 * Construit l'aperçu d'une action à partir de ses arguments et de l'état AVANT. Renvoie null pour les
 * outils sans effet notable (lecture) ou inconnus.
 */
export function buildActionDiff(tool: string, args: Record<string, unknown>, before: DiffSnapshot = {}): ActionDiff | null {
  const num = before.number ?? null;
  let spec: { title: string; fields: ActionDiffField[] } | null = null;
  let generatedAccounting: readonly AccountingLine[] = [];

  if (tool === 'encaisser_facture') {
    const remaining = Math.max(0, intOr(before.remainingCents, 0));
    const amount = Math.max(0, intOr(args.amountCents, 0));
    const after = Math.max(0, remaining - amount);
    const preview = buildPaymentAccountingPreviewLines({
      amountCents: amount,
      method: paymentMethodOrTransfer(args.method),
      reference: num ?? 'facture',
    });
    generatedAccounting = preview.ok ? preview.value : [];
    spec = {
      title: `Encaisser ${formatEUR(amount)}${num ? ` · ${num}` : ''}`,
      fields: [
        { label: 'Reste dû', before: formatEUR(remaining), after: formatEUR(after) },
        { label: 'Statut', before: remaining > 0 ? 'À encaisser' : 'Payée', after: after === 0 ? 'Payée' : 'Partielle' },
      ],
    };
  } else if (tool === 'emettre_facture') {
    spec = {
      title: 'Émettre la facture',
      fields: [
        { label: 'Statut', before: 'Brouillon', after: 'Émise' },
        { label: 'Numéro légal', before: num ?? '—', after: num ?? 'attribué à l’émission' },
      ],
    };
  } else if (tool === 'envoyer_devis') {
    spec = {
      title: `Envoyer le devis${num ? ` ${num}` : ''}`,
      fields: [{ label: 'Statut', before: 'Brouillon', after: 'Envoyé au client' }],
    };
  }

  if (!spec) return null; // lecture / outil sans aperçu d'état
  const accounting = (before.accountingLines ?? generatedAccounting).filter((l) => l.debitCents > 0 || l.creditCents > 0);
  return { tool, title: spec.title, fields: spec.fields, ...(accounting.length ? { accounting } : {}) };
}
