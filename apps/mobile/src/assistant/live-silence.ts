/**
 * S4 — CONTINUITÉ MAINS-LIBRES : fin d'écoute SANS transcript dans la boucle live de
 * l'onglet Assistant. La reco native se termine seule sur silence, sans onIssue — avant ce
 * plan, l'orbe retombait muettement en « prêt » et la conversation mourait sans un mot.
 *
 * Décision PURE (aucun timer, aucun état React) :
 * · 1er silence → UNE relance parlée (agent.global.heardNothing) + UNE ré-écoute ;
 * · 2e silence d'affilée → repos SILENCIEUX (un tap relance) — Bob ne harcèle jamais ;
 * · le flag `alreadyRetried` suit le même patron que les relances choice/consent (retried).
 *
 * Garde-fous fail-safe — on ne réagit qu'à une fermeture RÉELLE de l'oreille :
 * · `earWasOpen` : l'oreille a été observée OUVERTE puis fermée (transition), jamais la
 *   latence d'ouverture (permission, vérification du modèle local) prise pour un silence ;
 * · `echoRelistenInFlight` : la ré-écoute post-écho traverse la grâce du lease natif —
 *   parler pendant cette fenêtre répondrait à son propre écho ;
 * · tout futur moteur non local reste fail-closed ici : aucune relance parlée ne doit piétiner
 *   un transcript encore en vol.
 */

export interface LiveSilenceInput {
  /** Le mode vocal mains-libres est actif. */
  readonly live: boolean;
  /** État affiché de la boucle live ('listening' attendu pour un silence). */
  readonly state: string;
  /** L'oreille est-elle réellement ouverte en ce moment ? */
  readonly voiceListening: boolean;
  /** L'oreille était OUVERTE au constat précédent (transition réelle ouverte→fermée). */
  readonly earWasOpen: boolean;
  /** Une ré-écoute post-écho est en cours d'acquisition (grâce du lease natif). */
  readonly echoRelistenInFlight: boolean;
  /** Reco native sur l'appareil (les silences auto-terminés n'existent qu'en natif). */
  readonly nativeRecognition: boolean;
  /** Une relance a déjà été jouée depuis le dernier transcript. */
  readonly alreadyRetried: boolean;
}

export type LiveSilencePlan =
  /** Rien à faire : pas de fermeture réelle d'oreille à traiter. */
  | { readonly kind: 'none' }
  /** Repos silencieux : l'orbe retombe en « prêt », un tap relance. */
  | { readonly kind: 'rest' }
  /** UNE relance parlée (heardNothing) puis UNE ré-écoute — jamais deux d'affilée. */
  | { readonly kind: 'relaunch' };

export function planLiveSilenceRecovery(input: LiveSilenceInput): LiveSilencePlan {
  if (!input.live || input.state !== 'listening' || input.voiceListening) return { kind: 'none' };
  if (!input.earWasOpen) return { kind: 'none' };
  if (input.echoRelistenInFlight) return { kind: 'none' };
  if (!input.nativeRecognition) return { kind: 'rest' };
  return input.alreadyRetried ? { kind: 'rest' } : { kind: 'relaunch' };
}
