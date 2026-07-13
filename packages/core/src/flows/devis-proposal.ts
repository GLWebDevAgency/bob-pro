import { type DomainResult, ok, err } from '../shared-kernel/result';
import { type LineInput } from '../domain/billing/shared/line-item';
import { formatEUR } from '../format/money';
import { type DevisDraft, type DevisFlowState } from './devis';

/**
 * PROPOSITIONS RÉVISABLES de la machine devis (S2 — réconciliation des concepts
 * mission/diff/accept-reject DANS le cœur, décision d'architecture CLAIMS 13/07).
 *
 * Une PROPOSITION est un patch NON APPLIQUÉ du brouillon, porteur de son DIFF humain
 * (avant → après, montants formatés par le domaine — jamais recalculés ailleurs).
 * La voix PROPOSE, l'humain (voix « je confirme » parsée déterministe, ou tap) ACCEPTE —
 * exactement le même chemin canonique dans les deux modes (parité voix ↔ manuel).
 * Tout est PUR : aucune UI, aucune horloge, testé exhaustivement.
 */

export interface DevisDiffField {
  /** Champ humain (« Ligne 2 · prix unitaire », « Acompte », « Client »). */
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

export interface DevisProposal {
  /** Libellé parlable de l'intention (« Passer la ligne 2 à 450,00 € »). */
  readonly label: string;
  readonly patch: Partial<DevisDraft>;
  readonly diff: readonly DevisDiffField[];
}

export interface DevisFlowStateWithProposal extends DevisFlowState {
  readonly proposal: DevisProposal | null;
}

const fmtLine = (line: LineInput): string =>
  `${line.label} — ${line.qty} × ${formatEUR(line.unitPriceHT)} HT (TVA ${line.vatRate} %)`;

/** DIFF humain entre deux brouillons — seuls les champs réellement modifiés apparaissent. */
export function devisDiff(before: DevisDraft, after: DevisDraft): DevisDiffField[] {
  const fields: DevisDiffField[] = [];
  if (before.customerId !== after.customerId) {
    fields.push({ field: 'Client', before: before.customerId ?? '—', after: after.customerId ?? '—' });
  }
  const max = Math.max(before.lines.length, after.lines.length);
  for (let index = 0; index < max; index += 1) {
    const b = before.lines[index];
    const a = after.lines[index];
    if (b === undefined && a !== undefined) {
      fields.push({ field: `Ligne ${index + 1}`, before: '—', after: fmtLine(a) });
    } else if (b !== undefined && a === undefined) {
      fields.push({ field: `Ligne ${index + 1}`, before: fmtLine(b), after: '— (supprimée)' });
    } else if (b !== undefined && a !== undefined && fmtLine(b) !== fmtLine(a)) {
      fields.push({ field: `Ligne ${index + 1}`, before: fmtLine(b), after: fmtLine(a) });
    }
  }
  if (before.depositPct !== after.depositPct) {
    fields.push({ field: 'Acompte', before: `${before.depositPct} %`, after: `${after.depositPct} %` });
  }
  if (before.signerName !== after.signerName) {
    fields.push({ field: 'Signataire', before: before.signerName ?? '—', after: after.signerName ?? '—' });
  }
  return fields;
}

/** Prépare une proposition (patch NON appliqué + diff). Refusée si le flow est terminé
 * ou si le patch ne change RIEN (une proposition vide serait un consentement sans objet). */
export function devisPropose(
  state: DevisFlowStateWithProposal,
  patch: Partial<DevisDraft>,
  label: string,
): DomainResult<DevisFlowStateWithProposal> {
  if (state.step === 'facture') {
    return err({ code: 'VALIDATION', field: 'step', message: 'Le flow est terminé' });
  }
  const after: DevisDraft = { ...state.draft, ...patch };
  const diff = devisDiff(state.draft, after);
  if (diff.length === 0) {
    return err({ code: 'VALIDATION', field: 'patch', message: 'La proposition ne change rien' });
  }
  return ok({ ...state, proposal: { label, patch, diff } });
}

/** Applique la proposition en attente — le SEUL chemin d'écriture d'une proposition. */
export function devisAcceptProposal(
  state: DevisFlowStateWithProposal,
): DomainResult<DevisFlowStateWithProposal> {
  if (state.proposal === null) {
    return err({ code: 'VALIDATION', field: 'proposal', message: 'Aucune proposition en attente' });
  }
  return ok({
    ...state,
    draft: { ...state.draft, ...state.proposal.patch },
    proposal: null,
  });
}

/** Rejette la proposition — le brouillon reste INTACT (l'inaction est toujours sûre). */
export function devisRejectProposal(state: DevisFlowStateWithProposal): DevisFlowStateWithProposal {
  return { ...state, proposal: null };
}

// ── Patchs de lignes prêts à PROPOSER (édition/suppression d'une ligne quelconque) ──

/** Patch « ligne N modifiée » — index HUMAIN (1-based, l'ordre affiché = l'ordre du draft). */
export function withLineUpdated(
  draft: DevisDraft,
  ordinal: number,
  linePatch: Partial<LineInput>,
): DomainResult<Partial<DevisDraft>> {
  const index = ordinal - 1;
  const line = draft.lines[index];
  if (line === undefined) {
    return err({ code: 'VALIDATION', field: 'lines', message: `Pas de ligne ${ordinal}` });
  }
  const lines = draft.lines.map((existing, i) => (i === index ? { ...existing, ...linePatch } : existing));
  return ok({ lines });
}

/** Patch « ligne N supprimée » — même convention 1-based. */
export function withLineRemoved(draft: DevisDraft, ordinal: number): DomainResult<Partial<DevisDraft>> {
  const index = ordinal - 1;
  if (draft.lines[index] === undefined) {
    return err({ code: 'VALIDATION', field: 'lines', message: `Pas de ligne ${ordinal}` });
  }
  return ok({ lines: draft.lines.filter((_, i) => i !== index) });
}
