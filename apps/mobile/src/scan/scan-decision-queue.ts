/**
 * FILE DE DÉCISIONS DU SCAN — machine à états PURE (zéro import React/React Native).
 *
 * Trois garanties produit, toutes vérifiées par les tests :
 * 1. AU PLUS UNE feuille visible : une feuille qui se ferme joue d'abord sa sortie
 *    (`dismissing`) et la suivante n'est présentée qu'à `sheet-closed` (handshake
 *    `onDidClose` du composant Sheet) — plus jamais deux bottom-sheets superposées
 *    pendant les ~220 ms d'animation de sortie.
 * 2. ORDRE DÉTERMINISTE : catégorie → règlement. Une feuille déjà présentée n'est
 *    JAMAIS remplacée en plein vol par une autre devenue prioritaire (anti-flip) ;
 *    la priorité ne s'applique qu'au choix de la PROCHAINE feuille.
 * 3. RANGEMENT JAMAIS AUTO-OUVERT : la feuille de rangement n'apparaît que sur un
 *    geste humain explicite (`filing-requested`). Après un classement réussi
 *    (`filing-classified`) ou un « Plus tard » (`filing-deferred`), l'invite est
 *    CONSOMMÉE : aucun signal automatique ne peut la ré-ouvrir — seul un nouveau
 *    geste humain le peut — et un document déjà rangé (`documentFiled`) n'est
 *    jamais re-sollicité.
 */

export type ScanSheetKind = 'category' | 'settlement' | 'filing' | 'folderEditor';

/** Signaux dérivés de l'écran (OCR, mémoire fournisseur, dossiers du coffre). */
export interface ScanDecisionSignals {
  /** Question de catégorie prête et non répondue (ASK-3). */
  readonly categoryPending: boolean;
  /** Question payé / à payer prête et non répondue. */
  readonly settlementPending: boolean;
  /** Rangement actionnable : dossiers chargés, options présentes, pas de reprise en cours. */
  readonly filingReady: boolean;
  /** Document déjà rangé (folderId non nul) — garde absolue contre toute re-sollicitation. */
  readonly documentFiled: boolean;
}

export const NEUTRAL_SCAN_SIGNALS: ScanDecisionSignals = {
  categoryPending: false,
  settlementPending: false,
  filingReady: false,
  documentFiled: false,
};

/**
 * Cycle de vie de l'invite de rangement :
 * `idle` → aucune demande ; `requested` → geste humain en attente de présentation ;
 * `consumed` → classement réussi ou « Plus tard » : plus aucune ré-ouverture automatique.
 */
export type FilingInviteStatus = 'idle' | 'requested' | 'consumed';

export interface ScanDecisionQueueState {
  /** Document archivé auquel la file est liée — tout changement remet la file à zéro. */
  readonly documentId: string | null;
  readonly signals: ScanDecisionSignals;
  readonly filingInvite: FilingInviteStatus;
  /** Création de dossier demandée depuis la feuille de rangement. */
  readonly folderEditorRequested: boolean;
  /** Feuille en cours de présentation — au plus UNE. */
  readonly presented: ScanSheetKind | null;
  /** true : la feuille `presented` joue sa sortie ; rien ne s'ouvre avant `sheet-closed`. */
  readonly dismissing: boolean;
  /**
   * Feuille du document PRÉCÉDENT dont la sortie animée n'est pas encore confirmée
   * (reset `document-changed` pendant qu'elle était montée). Garde de présentation :
   * aucune AUTRE feuille ne s'ouvre avant son `sheet-closed` — seule la MÊME feuille
   * (même Modal natif, ré-entrée animée) peut se re-présenter sans chevauchement.
   */
  readonly closingSheet: ScanSheetKind | null;
}

export const INITIAL_SCAN_DECISION_QUEUE: ScanDecisionQueueState = {
  documentId: null,
  signals: NEUTRAL_SCAN_SIGNALS,
  filingInvite: 'idle',
  folderEditorRequested: false,
  presented: null,
  dismissing: false,
  closingSheet: null,
};

export type ScanDecisionQueueEvent =
  /** Le document archivé a changé (ou a été réinitialisé) : file remise à zéro. */
  | { readonly type: 'document-changed'; readonly documentId: string | null }
  /** Les signaux dérivés de l'écran ont été recalculés. */
  | { readonly type: 'signals-changed'; readonly signals: ScanDecisionSignals }
  /** GESTE HUMAIN : « Choisir un (autre) dossier », reprise après erreur, re-demande avant dépense. */
  | { readonly type: 'filing-requested' }
  /** Une option de rangement vient d'être choisie : la feuille se ferme, la mutation part. */
  | { readonly type: 'filing-selected' }
  /** Classement réussi (classifyInFolder / applyDestination) : invite consommée. */
  | { readonly type: 'filing-classified' }
  /** « Plus tard » ou fermeture : invite consommée, STRICTEMENT aucun autre effet. */
  | { readonly type: 'filing-deferred' }
  /** Option « créer un dossier » choisie : l'éditeur prendra la place du rangement. */
  | { readonly type: 'folder-editor-requested' }
  /** Éditeur refermé sans créer (« Plus tard ») : même consommation que le rangement. */
  | { readonly type: 'folder-editor-deferred' }
  /** Création lancée : l'éditeur se ferme, le classement suivra (`filing-classified`). */
  | { readonly type: 'folder-editor-completed' }
  /** Fin de l'animation de sortie d'une feuille (onDidClose) : la suivante peut se présenter. */
  | { readonly type: 'sheet-closed'; readonly sheet: ScanSheetKind };

/** Feuille actuellement visible — null pendant une sortie (aucun chevauchement possible). */
export function visibleScanSheet(state: ScanDecisionQueueState): ScanSheetKind | null {
  return state.dismissing ? null : state.presented;
}

function sameSignals(a: ScanDecisionSignals, b: ScanDecisionSignals): boolean {
  return (
    a.categoryPending === b.categoryPending
    && a.settlementPending === b.settlementPending
    && a.filingReady === b.filingReady
    && a.documentFiled === b.documentFiled
  );
}

/** Le rangement n'est présentable QUE sur invite humaine, actionnable, document non rangé. */
function filingPresentable(state: ScanDecisionQueueState): boolean {
  return state.filingInvite === 'requested' && state.signals.filingReady && !state.signals.documentFiled;
}

/** Prochaine feuille à présenter — priorité : éditeur > rangement (invité) > catégorie > règlement. */
function desiredScanSheet(state: ScanDecisionQueueState): ScanSheetKind | null {
  if (state.folderEditorRequested) return 'folderEditor';
  if (filingPresentable(state)) return 'filing';
  if (state.signals.categoryPending) return 'category';
  if (state.signals.settlementPending) return 'settlement';
  return null;
}

/** La feuille déjà présentée garde-t-elle sa raison d'être ? (anti-flip : elle n'est jamais remplacée.) */
function sheetStillWanted(state: ScanDecisionQueueState, sheet: ScanSheetKind): boolean {
  switch (sheet) {
    case 'folderEditor':
      return state.folderEditorRequested;
    case 'filing':
      return filingPresentable(state);
    case 'category':
      return state.signals.categoryPending;
    case 'settlement':
      return state.signals.settlementPending;
  }
}

/**
 * Réconcilie la présentation avec l'état : ferme une feuille devenue injustifiée
 * (sortie animée), ou présente la prioritaire quand la scène est libre. Ne remplace
 * JAMAIS une feuille encore justifiée, n'ouvre JAMAIS pendant une sortie.
 */
function presentNext(state: ScanDecisionQueueState): ScanDecisionQueueState {
  if (state.presented !== null) {
    if (state.dismissing) return state;
    if (sheetStillWanted(state, state.presented)) return state;
    return { ...state, dismissing: true };
  }
  const next = desiredScanSheet(state);
  if (next === null) return state;
  // Handshake du reset : la feuille du document précédent joue encore sa sortie — une
  // feuille DIFFÉRENTE attend son sheet-closed (jamais deux Modals superposés) ; la même
  // feuille peut se re-présenter (ré-entrée du même Modal, sortie interrompue sans risque).
  if (state.closingSheet !== null && next !== state.closingSheet) return state;
  return { ...state, presented: next, dismissing: false, closingSheet: null };
}

export function reduceScanDecisionQueue(
  state: ScanDecisionQueueState,
  event: ScanDecisionQueueEvent,
): ScanDecisionQueueState {
  switch (event.type) {
    case 'document-changed': {
      if (event.documentId === state.documentId) return state;
      // Nouveau document : rien ne fuit (l'invite consommée du précédent en particulier).
      // Une feuille encore montée joue sa sortie animée : elle reste mémorisée dans
      // `closingSheet` — le handshake sheet-closed n'est JAMAIS contourné par le reset.
      return {
        ...INITIAL_SCAN_DECISION_QUEUE,
        documentId: event.documentId,
        closingSheet: state.presented ?? state.closingSheet,
      };
    }
    case 'signals-changed': {
      if (sameSignals(state.signals, event.signals)) return state;
      return presentNext({ ...state, signals: event.signals });
    }
    case 'filing-requested':
      // Un geste humain explicite ré-ouvre TOUJOURS, même après consommation.
      return presentNext(
        state.filingInvite === 'requested' ? state : { ...state, filingInvite: 'requested' },
      );
    case 'filing-selected':
      return presentNext(
        state.filingInvite === 'idle' ? state : { ...state, filingInvite: 'idle' },
      );
    case 'filing-classified':
    case 'filing-deferred':
      return presentNext(
        state.filingInvite === 'consumed' ? state : { ...state, filingInvite: 'consumed' },
      );
    case 'folder-editor-requested':
      return presentNext({ ...state, filingInvite: 'idle', folderEditorRequested: true });
    case 'folder-editor-deferred':
      return presentNext({ ...state, folderEditorRequested: false, filingInvite: 'consumed' });
    case 'folder-editor-completed':
      return presentNext({ ...state, folderEditorRequested: false });
    case 'sheet-closed': {
      // Sortie confirmée de la feuille du document précédent : la garde se lève, la
      // prochaine feuille du nouveau document peut se présenter.
      if (state.closingSheet !== null && event.sheet === state.closingSheet) {
        return presentNext({ ...state, closingSheet: null });
      }
      // Fermeture tardive ou étrangère (autre feuille, document précédent) : ignorée.
      if (state.presented === null || event.sheet !== state.presented) return state;
      return presentNext({ ...state, presented: null, dismissing: false });
    }
  }
}
