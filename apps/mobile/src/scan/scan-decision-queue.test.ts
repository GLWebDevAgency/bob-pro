/**
 * Tests de la file de décisions du scan — tous les scénarios du diagnostic :
 * chevauchement t0/t1/t2 (analyse → extraction → réponse catégorie), ré-arm du
 * rangement après un classement réussi, « Plus tard » strictement sans effet de bord,
 * anti-flip, handshake de sortie (une seule feuille visible à tout instant).
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_SCAN_DECISION_QUEUE,
  NEUTRAL_SCAN_SIGNALS,
  reduceScanDecisionQueue,
  visibleScanSheet,
  type ScanDecisionQueueEvent,
  type ScanDecisionQueueState,
  type ScanDecisionSignals,
} from './scan-decision-queue';

function signals(over: Partial<ScanDecisionSignals> = {}): ScanDecisionSignals {
  return { ...NEUTRAL_SCAN_SIGNALS, ...over };
}

function run(
  events: readonly ScanDecisionQueueEvent[],
  from: ScanDecisionQueueState = INITIAL_SCAN_DECISION_QUEUE,
): ScanDecisionQueueState {
  return events.reduce(reduceScanDecisionQueue, from);
}

describe('scan-decision-queue — séquence du diagnostic (t0 / t1 / t2)', () => {
  it('t0 : l’analyse seule (dossiers prêts, destination suggérée ou non) n’ouvre JAMAIS le rangement', () => {
    const state = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
    ]);
    expect(state.presented).toBeNull();
    expect(visibleScanSheet(state)).toBeNull();
  });

  it('t1 : l’extraction arrive → la catégorie s’ouvre SEULE (jamais le rangement en parallèle)', () => {
    const state = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'signals-changed', signals: signals({ filingReady: true, categoryPending: true, settlementPending: true }) },
    ]);
    expect(visibleScanSheet(state)).toBe('category');
  });

  it('t2 : réponse catégorie → sortie animée (AUCUNE feuille visible) PUIS règlement au sheet-closed', () => {
    const answered = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ filingReady: true, categoryPending: true, settlementPending: true }) },
      { type: 'signals-changed', signals: signals({ filingReady: true, settlementPending: true }) },
    ]);
    // Pendant les ~220 ms de sortie : rien d'autre n'est visible — zéro chevauchement.
    expect(answered.presented).toBe('category');
    expect(answered.dismissing).toBe(true);
    expect(visibleScanSheet(answered)).toBeNull();

    const next = reduceScanDecisionQueue(answered, { type: 'sheet-closed', sheet: 'category' });
    expect(visibleScanSheet(next)).toBe('settlement');
  });

  it('après réponse catégorie, la feuille de rangement NE REVIENT PAS (bug historique)', () => {
    const state = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'signals-changed', signals: signals({ filingReady: true, categoryPending: true }) },
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'sheet-closed', sheet: 'category' },
    ]);
    expect(visibleScanSheet(state)).toBeNull();
    expect(state.presented).toBeNull();
  });

  it('la sortie en cours attend sheet-closed même si le signal redevient vrai (pas de ré-ouverture en plein vol)', () => {
    const dismissing = run([
      { type: 'signals-changed', signals: signals({ categoryPending: true }) },
      { type: 'signals-changed', signals: signals() },
    ]);
    expect(dismissing.dismissing).toBe(true);
    const during = reduceScanDecisionQueue(dismissing, {
      type: 'signals-changed',
      signals: signals({ categoryPending: true }),
    });
    expect(visibleScanSheet(during)).toBeNull();
    const after = reduceScanDecisionQueue(during, { type: 'sheet-closed', sheet: 'category' });
    expect(visibleScanSheet(after)).toBe('category');
  });
});

describe('scan-decision-queue — ordre déterministe et anti-flip', () => {
  it('catégorie tardive : le règlement déjà présenté N’EST PAS interrompu, la catégorie passe après', () => {
    const settlementShown = run([
      { type: 'signals-changed', signals: signals({ settlementPending: true }) },
    ]);
    expect(visibleScanSheet(settlementShown)).toBe('settlement');

    const categoryArrives = reduceScanDecisionQueue(settlementShown, {
      type: 'signals-changed',
      signals: signals({ settlementPending: true, categoryPending: true }),
    });
    expect(visibleScanSheet(categoryArrives)).toBe('settlement');

    const settlementAnswered = run([
      { type: 'signals-changed', signals: signals({ categoryPending: true }) },
      { type: 'sheet-closed', sheet: 'settlement' },
    ], categoryArrives);
    expect(visibleScanSheet(settlementAnswered)).toBe('category');
  });

  it('geste de rangement pendant la catégorie : pas de flip — le rangement attend la fin de la question', () => {
    const state = run([
      { type: 'signals-changed', signals: signals({ filingReady: true, categoryPending: true }) },
      { type: 'filing-requested' },
    ]);
    expect(visibleScanSheet(state)).toBe('category');

    const afterAnswer = run([
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'sheet-closed', sheet: 'category' },
    ], state);
    expect(visibleScanSheet(afterAnswer)).toBe('filing');
  });
});

describe('scan-decision-queue — invite de rangement (geste humain uniquement)', () => {
  it('filing-requested présente le rangement quand il est actionnable', () => {
    const state = run([
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
    ]);
    expect(visibleScanSheet(state)).toBe('filing');
  });

  it('document déjà rangé (folderId non nul) : jamais re-sollicité, même sur invite', () => {
    const state = run([
      { type: 'signals-changed', signals: signals({ filingReady: true, documentFiled: true }) },
      { type: 'filing-requested' },
    ]);
    expect(visibleScanSheet(state)).toBeNull();
  });

  it('dossiers pas prêts : l’invite humaine attend, puis se présente dès que le rangement est actionnable', () => {
    const waiting = run([
      { type: 'filing-requested' },
    ]);
    expect(visibleScanSheet(waiting)).toBeNull();
    const ready = reduceScanDecisionQueue(waiting, {
      type: 'signals-changed',
      signals: signals({ filingReady: true }),
    });
    expect(visibleScanSheet(ready)).toBe('filing');
  });

  it('classement réussi : invite CONSOMMÉE — aucun signal ultérieur ne ré-ouvre la feuille (bug du ré-arm)', () => {
    const classified = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
      { type: 'filing-selected' },
      { type: 'sheet-closed', sheet: 'filing' },
      { type: 'filing-classified' },
    ]);
    expect(classified.filingInvite).toBe('consumed');
    expect(visibleScanSheet(classified)).toBeNull();

    // Churn de signaux post-classement (analyse re-render, dossiers rafraîchis…) : rien ne s'ouvre.
    const churned = run([
      { type: 'signals-changed', signals: signals({ filingReady: true, documentFiled: true }) },
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
    ], classified);
    expect(visibleScanSheet(churned)).toBeNull();
    expect(churned.presented).toBeNull();
  });

  it('« Plus tard » : invite consommée, STRICTEMENT aucun autre effet (signaux et document intacts)', () => {
    const before = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ filingReady: true, settlementPending: false }) },
      { type: 'filing-requested' },
    ]);
    const deferred = reduceScanDecisionQueue(before, { type: 'filing-deferred' });
    expect(deferred.filingInvite).toBe('consumed');
    expect(deferred.signals).toBe(before.signals);
    expect(deferred.documentId).toBe(before.documentId);
    expect(deferred.folderEditorRequested).toBe(false);
    expect(visibleScanSheet(deferred)).toBeNull();

    // Plus aucune ré-ouverture automatique ensuite.
    const after = run([
      { type: 'sheet-closed', sheet: 'filing' },
      { type: 'signals-changed', signals: signals({ filingReady: true, categoryPending: false }) },
    ], deferred);
    expect(visibleScanSheet(after)).toBeNull();
  });

  it('un NOUVEAU geste humain ré-ouvre après « Plus tard » (la consommation ne bloque que l’automatique)', () => {
    const state = run([
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
      { type: 'filing-deferred' },
      { type: 'sheet-closed', sheet: 'filing' },
      { type: 'filing-requested' },
    ]);
    expect(visibleScanSheet(state)).toBe('filing');
  });

  it('échec du classement : le geste de reprise (filing-requested) ré-ouvre la feuille', () => {
    const state = run([
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
      { type: 'filing-selected' },
      { type: 'sheet-closed', sheet: 'filing' },
      { type: 'filing-requested' },
    ]);
    expect(visibleScanSheet(state)).toBe('filing');
  });
});

describe('scan-decision-queue — éditeur de dossier', () => {
  it('« Créer un dossier » : l’éditeur s’ouvre APRÈS la sortie du rangement, jamais superposé', () => {
    const selecting = run([
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
      { type: 'filing-selected' },
      { type: 'folder-editor-requested' },
    ]);
    expect(visibleScanSheet(selecting)).toBeNull();
    expect(selecting.presented).toBe('filing');

    const editor = reduceScanDecisionQueue(selecting, { type: 'sheet-closed', sheet: 'filing' });
    expect(visibleScanSheet(editor)).toBe('folderEditor');
  });

  it('éditeur refermé « Plus tard » : invite consommée, plus de ré-ouverture automatique', () => {
    const state = run([
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
      { type: 'filing-selected' },
      { type: 'folder-editor-requested' },
      { type: 'sheet-closed', sheet: 'filing' },
      { type: 'folder-editor-deferred' },
      { type: 'sheet-closed', sheet: 'folderEditor' },
      { type: 'signals-changed', signals: signals({ filingReady: true, categoryPending: false }) },
    ]);
    expect(state.filingInvite).toBe('consumed');
    expect(visibleScanSheet(state)).toBeNull();
  });

  it('création lancée puis classement réussi : l’éditeur se ferme et l’invite est consommée', () => {
    const state = run([
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
      { type: 'filing-selected' },
      { type: 'folder-editor-requested' },
      { type: 'sheet-closed', sheet: 'filing' },
      { type: 'folder-editor-completed' },
      { type: 'sheet-closed', sheet: 'folderEditor' },
      { type: 'filing-classified' },
    ]);
    expect(state.filingInvite).toBe('consumed');
    expect(visibleScanSheet(state)).toBeNull();
  });
});

describe('scan-decision-queue — cycle de vie du document et stabilité', () => {
  it('nouveau document : remise à zéro complète (l’invite consommée du précédent ne fuit pas)', () => {
    const state = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
      { type: 'filing-deferred' },
      { type: 'document-changed', documentId: 'doc-2' },
    ]);
    expect(state.documentId).toBe('doc-2');
    expect(state.filingInvite).toBe('idle');
    expect(state.presented).toBeNull();

    const gesture = run([
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
    ], state);
    expect(visibleScanSheet(gesture)).toBe('filing');
  });

  it('reset document-changed pendant une feuille montée : le handshake est respecté — une feuille DIFFÉRENTE attend le sheet-closed', () => {
    const presenting = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ settlementPending: true }) },
    ]);
    expect(visibleScanSheet(presenting)).toBe('settlement');

    // Nouveau document : la feuille du précédent joue sa sortie — rien ne se superpose.
    const reset = reduceScanDecisionQueue(presenting, { type: 'document-changed', documentId: 'doc-2' });
    expect(visibleScanSheet(reset)).toBeNull();
    expect(reset.presented).toBeNull();

    // Les signaux du nouveau document arrivent pendant l'animation : la catégorie ATTEND.
    const during = reduceScanDecisionQueue(reset, {
      type: 'signals-changed',
      signals: signals({ categoryPending: true }),
    });
    expect(visibleScanSheet(during)).toBeNull();

    // Sortie confirmée (onDidClose) : la feuille du nouveau document se présente enfin.
    const after = reduceScanDecisionQueue(during, { type: 'sheet-closed', sheet: 'settlement' });
    expect(visibleScanSheet(after)).toBe('category');
  });

  it('reset document-changed pendant une sortie déjà en cours : la garde persiste jusqu’au sheet-closed', () => {
    const dismissing = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ categoryPending: true }) },
      { type: 'signals-changed', signals: signals() },
    ]);
    expect(dismissing.dismissing).toBe(true);

    const reset = run([
      { type: 'document-changed', documentId: 'doc-2' },
      { type: 'signals-changed', signals: signals({ settlementPending: true }) },
    ], dismissing);
    expect(visibleScanSheet(reset)).toBeNull();

    const after = reduceScanDecisionQueue(reset, { type: 'sheet-closed', sheet: 'category' });
    expect(visibleScanSheet(after)).toBe('settlement');
  });

  it('la MÊME feuille peut se re-présenter pendant sa propre sortie post-reset (même Modal, zéro chevauchement)', () => {
    const reset = run([
      { type: 'document-changed', documentId: 'doc-1' },
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
      { type: 'document-changed', documentId: 'doc-2' },
      { type: 'signals-changed', signals: signals({ filingReady: true }) },
      { type: 'filing-requested' },
    ]);
    expect(visibleScanSheet(reset)).toBe('filing');
    expect(reset.closingSheet).toBeNull();
  });

  it('document-changed idempotent : même id → même référence d’état', () => {
    const state = run([{ type: 'document-changed', documentId: 'doc-1' }]);
    expect(reduceScanDecisionQueue(state, { type: 'document-changed', documentId: 'doc-1' })).toBe(state);
  });

  it('signaux identiques : même référence d’état (aucun churn de rendu)', () => {
    const first = run([{ type: 'signals-changed', signals: signals({ filingReady: true }) }]);
    const second = reduceScanDecisionQueue(first, {
      type: 'signals-changed',
      signals: signals({ filingReady: true }),
    });
    expect(second).toBe(first);
  });

  it('sheet-closed étranger ou tardif : ignoré (fermetures d’un autre document ou d’une autre feuille)', () => {
    const presenting = run([{ type: 'signals-changed', signals: signals({ categoryPending: true }) }]);
    expect(reduceScanDecisionQueue(presenting, { type: 'sheet-closed', sheet: 'settlement' })).toBe(presenting);

    const idle = INITIAL_SCAN_DECISION_QUEUE;
    expect(reduceScanDecisionQueue(idle, { type: 'sheet-closed', sheet: 'category' })).toBe(idle);
  });
});
