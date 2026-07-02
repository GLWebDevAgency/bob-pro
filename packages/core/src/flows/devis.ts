import { type DomainResult, ok, err } from '../shared-kernel/result';
import { assertTransition } from '../domain/billing/shared/state-machines';
import { type LineInput } from '../domain/billing/shared/line-item';

/**
 * Flow Devis → signature → facture (C21) — machine à états UI-consommable.
 * PROJECTION pure au-dessus des use-cases billing : le flow séquence les 6 étapes
 * du proto (client → lignes/catalogue → TVA/mentions → signature → acompte → facture)
 * et porte les garde-fous d'avancement. La logique métier (TVA via suggestVatRate,
 * totaux, numérotation, mentions) reste dans CreateQuote/SendQuote/SignQuote/
 * GenerateInvoiceFromQuote — rien n'est dupliqué ici.
 */
export type DevisStep = 'client' | 'lignes' | 'tvaMentions' | 'signature' | 'acompte' | 'facture';

export const DEVIS_STEPS: readonly DevisStep[] = [
  'client',
  'lignes',
  'tvaMentions',
  'signature',
  'acompte',
  'facture',
];

export const DEVIS_TRANSITIONS: Record<DevisStep, readonly DevisStep[]> = {
  client: ['lignes'],
  lignes: ['client', 'tvaMentions'],
  tvaMentions: ['lignes', 'signature'],
  signature: ['tvaMentions', 'acompte'],
  acompte: ['signature', 'facture'],
  facture: [],
};

export interface DevisTvaContext {
  housingOlderThan2y?: boolean;
  energyRenovation?: boolean;
}

export interface DevisDraft {
  customerId: string | null;
  lines: LineInput[];
  /** Contexte TVA choisi à l'étape tvaMentions (consommé par suggestVatRate côté use-case). */
  tvaContext: DevisTvaContext | null;
  /** Acompte du proto : 30 % par défaut. */
  depositPct: number;
  signerName: string | null;
}

export interface DevisFlowState {
  step: DevisStep;
  draft: DevisDraft;
}

export function startDevis(): DevisFlowState {
  return {
    step: 'client',
    draft: { customerId: null, lines: [], tvaContext: null, depositPct: 30, signerName: null },
  };
}

/** Garde d'AVANCEMENT par étape : ce qui doit être vrai pour quitter l'étape vers l'avant. */
const ADVANCE_GUARDS: Record<DevisStep, (d: DevisDraft) => DomainResult<void>> = {
  client: (d) =>
    d.customerId !== null
      ? ok(undefined)
      : err({ code: 'VALIDATION', field: 'customerId', message: 'Choisis un client avant de continuer' }),
  lignes: (d) =>
    d.lines.length > 0
      ? ok(undefined)
      : err({ code: 'VALIDATION', field: 'lines', message: 'Ajoute au moins une prestation' }),
  tvaMentions: () => ok(undefined),
  signature: (d) =>
    d.signerName !== null && d.signerName.trim() !== ''
      ? ok(undefined)
      : err({ code: 'VALIDATION', field: 'signerName', message: 'La signature du client est requise' }),
  acompte: (d) =>
    d.depositPct >= 0 && d.depositPct <= 100
      ? ok(undefined)
      : err({ code: 'VALIDATION', field: 'depositPct', message: 'Acompte entre 0 et 100 %' }),
  facture: () => err({ code: 'VALIDATION', field: 'step', message: 'Le flow est terminé' }),
};

/** Saisie d'étape : applique un patch au brouillon sans changer d'étape. */
export function devisEdit(state: DevisFlowState, patch: Partial<DevisDraft>): DevisFlowState {
  return { ...state, draft: { ...state.draft, ...patch } };
}

/** Avance d'une étape si la garde de l'étape courante passe. */
export function devisNext(state: DevisFlowState): DomainResult<DevisFlowState> {
  const guard = ADVANCE_GUARDS[state.step](state.draft);
  if (!guard.ok) return guard;
  const to = DEVIS_STEPS[DEVIS_STEPS.indexOf(state.step) + 1];
  if (to === undefined) return err({ code: 'INVALID_TRANSITION', from: state.step, to: '(fin)' });
  const allowed = assertTransition(DEVIS_TRANSITIONS, state.step, to);
  if (!allowed.ok) return allowed;
  return ok({ ...state, step: to });
}

/** Recule d'une étape (correction) si la table l'autorise — 'facture' est terminal. */
export function devisBack(state: DevisFlowState): DomainResult<DevisFlowState> {
  const to = DEVIS_STEPS[DEVIS_STEPS.indexOf(state.step) - 1];
  if (to === undefined) return err({ code: 'INVALID_TRANSITION', from: state.step, to: '(début)' });
  const allowed = assertTransition(DEVIS_TRANSITIONS, state.step, to);
  if (!allowed.ok) return allowed;
  return ok({ ...state, step: to });
}
