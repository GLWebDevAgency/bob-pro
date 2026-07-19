import { type DomainResult, ok, err } from '../shared-kernel/result';
import { assertTransition } from '../domain/billing/shared/state-machines';
import { type LineInput } from '../domain/billing/shared/line-item';
import { type VatRate } from '../domain/billing/shared/vat-rate';

/**
 * Flow Devis (C21, redécoupe 2026-07 — le wizard s'ARRÊTE au devis) — machine à états
 * UI-consommable. PROJECTION pure au-dessus des use-cases billing : le flow séquence les
 * 6 étapes client → lignes/catalogue → TVA/mentions → ACOMPTE (le % contractuel, une
 * clause du devis décidée AVANT la signature) → signature (sur place ou envoi — l'artisan
 * est devant le client, ça reste légitime au wizard) → RÉCAP (statut final du devis, pas
 * de facture). La logique métier (TVA via suggestVatRate, totaux, numérotation, mentions)
 * reste dans CreateQuote/SendQuote/SignQuote — rien n'est dupliqué ici.
 *
 * La FACTURE n'est plus créée par ce flow : elle a son chemin officiel post-signature
 * (QuoteActions côté /devis/[id], 3 états — aucune/acompte/finale). Enchaîner sa création
 * ici doublait ce chemin et créait une pièce que personne n'avait explicitement décidée
 * (constat fondateur 2026-07-16 : « quand je fais un devis, je fais un devis »).
 */
export type DevisStep = 'client' | 'lignes' | 'tvaMentions' | 'acompte' | 'signature' | 'recap';

export const DEVIS_STEPS: readonly DevisStep[] = [
  'client',
  'lignes',
  'tvaMentions',
  'acompte',
  'signature',
  'recap',
];

export const DEVIS_TRANSITIONS: Record<DevisStep, readonly DevisStep[]> = {
  client: ['lignes'],
  lignes: ['client', 'tvaMentions'],
  tvaMentions: ['lignes', 'acompte'],
  acompte: ['tvaMentions', 'signature'],
  signature: ['acompte', 'recap'],
  recap: [],
};

export interface DevisTvaContext {
  housingOlderThan2y?: boolean;
  energyRenovation?: boolean;
}

/** Mode de signature choisi à l'étape signature — détermine la chaîne exécutée (C21 redécoupe). */
export type DevisSignMode = 'onsite' | 'remote';

export interface DevisDraft {
  customerId: string | null;
  lines: LineInput[];
  /** Contexte TVA choisi à l'étape tvaMentions (consommé par suggestVatRate côté use-case). */
  tvaContext: DevisTvaContext | null;
  /** Taux explicitement confirmé pour ce devis. `null` est un état de premier rang. */
  vatRate: VatRate | null;
  /** Acompte du proto : 30 % par défaut — clause CONTRACTUELLE décidée avant la signature. */
  depositPct: number;
  /** Sur place (pad + preuve, signQuote appelé) ou envoi (email avec le lien, signature différée). */
  signMode: DevisSignMode | null;
  signerName: string | null;
  /**
   * Exception dépannage urgent (art. L221-10, al. 2 / L221-28, 8° c. conso) : « travaux
   * d'entretien/réparation à réaliser EN URGENCE au domicile, expressément sollicités par le
   * client » — question posée au wizard quand le client est un PARTICULIER, reprise à la
   * création du devis (CreateQuote horodate serveur et refuse tout client non-b2c).
   * Défaut false : fail-closed, jamais une urgence déduite.
   */
  urgentRepairRequested: boolean;
}

export interface DevisFlowState {
  step: DevisStep;
  draft: DevisDraft;
}

export function startDevis(): DevisFlowState {
  return {
    step: 'client',
    draft: {
      customerId: null,
      lines: [],
      tvaContext: null,
      vatRate: null,
      depositPct: 30,
      signMode: null,
      signerName: null,
      urgentRepairRequested: false,
    },
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
  tvaMentions: (d) =>
    d.tvaContext !== null && d.vatRate !== null
      ? ok(undefined)
      : err({
          code: 'VALIDATION',
          field: 'vatRate',
          message: 'Confirme le taux de TVA avant de continuer',
        }),
  acompte: (d) =>
    d.depositPct >= 0 && d.depositPct <= 100
      ? ok(undefined)
      : err({ code: 'VALIDATION', field: 'depositPct', message: 'Acompte entre 0 et 100 %' }),
  signature: (d) => {
    if (d.signMode === null) {
      return err({ code: 'VALIDATION', field: 'signMode', message: 'Choisis sur place ou envoyer' });
    }
    if (d.signMode === 'remote') return ok(undefined);
    return d.signerName !== null && d.signerName.trim() !== ''
      ? ok(undefined)
      : err({ code: 'VALIDATION', field: 'signerName', message: 'La signature du client est requise' });
  },
  recap: () => err({ code: 'VALIDATION', field: 'step', message: 'Le flow est terminé' }),
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
