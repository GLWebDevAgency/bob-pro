import {
  Quantity,
  computeTotals,
  devisBack,
  devisEdit,
  devisNext,
  formatEUR,
  isVatRate,
  startDevis,
  type CataloguePrestation,
  type DevisTvaContext,
  type DevisFlowState,
  type DevisSignMode,
  type DomainError,
  type LineCategory,
  type LineInput,
  type VatRate,
} from '@bob/core';

/**
 * Brouillon partagé du wizard devis.
 *
 * Le modèle enveloppe volontairement `DevisFlowState` au lieu de recréer une seconde
 * machine à états. L'écran manuel et Bob appliquent les mêmes commandes pures ; seule
 * leur origine change. Une proposition IA ne modifie jamais le brouillon avant son
 * acceptation explicite.
 */

export type QuoteDraftInteraction = 'manual' | 'voice';
export type QuoteDraftStage = 'client' | 'lignes' | 'revue';

/**
 * Saisie encore non validée dans le formulaire de ligne.
 *
 * Elle reste distincte du contenu financier : Bob peut la préparer, mais elle n'entre dans le
 * devis qu'après le même geste de validation que la saisie manuelle. Elle vit néanmoins dans le
 * provider racine afin qu'un aller-retour de route ne détruise pas silencieusement le travail.
 */
export interface QuoteDraftLineFormState {
  readonly label: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly category: LineCategory;
}

export const EMPTY_QUOTE_DRAFT_LINE_FORM: QuoteDraftLineFormState = Object.freeze({
  label: '',
  quantity: '1',
  unitPrice: '',
  category: 'labor',
});

export interface QuoteDraftCustomer {
  readonly id: string;
  readonly name: string;
}

export interface QuoteDraftLineMetadata {
  /** Identifiant local stable : une modification vocale ne dépend jamais d'un index d'écran. */
  readonly id: string;
  readonly interaction: QuoteDraftInteraction;
  readonly catalogue?: {
    readonly id: string;
    readonly source: CataloguePrestation['source'];
    readonly indicative: boolean;
  };
}

export type QuoteDraftMissionStopReason = 'user' | 'home_navigation' | 'voice_unavailable';

export type QuoteDraftMission =
  | { readonly status: 'idle' }
  | {
      readonly status: 'active';
      readonly id: string;
      readonly mode: 'manual' | 'guided_voice';
      readonly startedFrom: string;
      readonly startedAt: number;
    }
  | {
      readonly status: 'stopped';
      readonly id: string;
      readonly reason: QuoteDraftMissionStopReason;
      readonly stoppedAt: number;
    }
  | {
      readonly status: 'completed';
      readonly id: string;
      readonly completedAt: number;
    };

export type QuoteDraftCommand =
  | { readonly type: 'select_customer'; readonly customer: QuoteDraftCustomer }
  | { readonly type: 'clear_customer' }
  | {
      readonly type: 'add_line';
      readonly lineId: string;
      readonly line: LineInput;
      readonly interaction: QuoteDraftInteraction;
      readonly catalogue?: QuoteDraftLineMetadata['catalogue'];
    }
  | { readonly type: 'update_line'; readonly lineId: string; readonly patch: Partial<LineInput> }
  | { readonly type: 'remove_line'; readonly lineId: string }
  | {
      readonly type: 'set_vat';
      readonly context: DevisTvaContext | null;
      readonly vatRate: VatRate;
    }
  | { readonly type: 'set_signer_name'; readonly signerName: string | null }
  | { readonly type: 'set_deposit_pct'; readonly depositPct: number }
  | { readonly type: 'set_sign_mode'; readonly signMode: DevisSignMode | null }
  | { readonly type: 'next_step' }
  | { readonly type: 'previous_step' };

export interface QuoteDraftDiffField {
  readonly key: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly kind: 'change' | 'add' | 'remove';
}

export interface QuoteDraftProposal {
  readonly id: string;
  readonly source: 'bob_voice' | 'bob_text';
  readonly title: string;
  readonly explanation: string | null;
  readonly commands: readonly QuoteDraftCommand[];
  /** Fence optimiste : une proposition calculée sur un ancien brouillon est inexécutable. */
  readonly baseRevision: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly diff: readonly QuoteDraftDiffField[];
  readonly spokenPrompt: string;
}

export interface QuoteDraftProposalDecision {
  readonly proposalId: string;
  readonly decision: 'accepted' | 'rejected' | 'expired' | 'superseded';
  readonly at: number;
}

export interface QuoteDraftState {
  readonly sessionId: string;
  /** Révision du contenu financier uniquement ; mission et guidance n'invalident pas un diff. */
  readonly revision: number;
  readonly flow: DevisFlowState;
  readonly customer: QuoteDraftCustomer | null;
  /** Même ordre que `flow.draft.lines`. */
  readonly lineMetadata: readonly QuoteDraftLineMetadata[];
  readonly lineForm: QuoteDraftLineFormState;
  /** Révision de la saisie non validée, indépendante des diffs financiers de Bob. */
  readonly stagingRevision: number;
  readonly saved: {
    readonly contentRevision: number;
    readonly stagingRevision: number;
    readonly at: number;
  } | null;
  /** Fence de session : un ACK de création rejoué ne peut pas effacer le brouillon suivant. */
  readonly completedArtifactIds: readonly string[];
  readonly proposal: QuoteDraftProposal | null;
  readonly lastProposalDecision: QuoteDraftProposalDecision | null;
  readonly mission: QuoteDraftMission;
}

export type QuoteDraftErrorCode =
  | 'validation'
  | 'not_found'
  | 'invalid_transition'
  | 'proposal_missing'
  | 'proposal_mismatch'
  | 'proposal_stale'
  | 'proposal_expired'
  | 'revision_conflict';

export interface QuoteDraftError {
  readonly code: QuoteDraftErrorCode;
  readonly field?: string;
  readonly message: string;
}

export type QuoteDraftResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: QuoteDraftError };

const ok = <T>(value: T): QuoteDraftResult<T> => ({ ok: true, value });
const fail = (error: QuoteDraftError): QuoteDraftResult<never> => ({ ok: false, error });

const LINE_CATEGORIES: readonly LineCategory[] = [
  'labor',
  'supply',
  'travel',
  'disbursement',
  'subscription',
];

const CATEGORY_LABEL: Readonly<Record<LineCategory, string>> = {
  labor: "Main-d'œuvre",
  supply: 'Fourniture',
  travel: 'Déplacement',
  disbursement: 'Débours',
  subscription: 'Abonnement',
};

function cloneLine(line: LineInput): LineInput {
  return {
    label: line.label,
    category: line.category,
    qty: line.qty,
    unitPriceHT: line.unitPriceHT,
    vatRate: line.vatRate,
    ...(line.unit !== undefined ? { unit: line.unit } : {}),
  };
}

function cloneFlow(flow: DevisFlowState): DevisFlowState {
  return {
    step: flow.step,
    draft: {
      ...flow.draft,
      lines: flow.draft.lines.map(cloneLine),
      tvaContext: flow.draft.tvaContext === null ? null : { ...flow.draft.tvaContext },
      vatRate: flow.draft.vatRate,
    },
  };
}

function normalizeSingleLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function validateCustomer(customer: QuoteDraftCustomer): QuoteDraftResult<QuoteDraftCustomer> {
  const id = customer.id.trim();
  const name = normalizeSingleLine(customer.name);
  if (id === '')
    return fail({ code: 'validation', field: 'customerId', message: 'Client invalide.' });
  if (name === '')
    return fail({ code: 'validation', field: 'customerName', message: 'Nom du client requis.' });
  return ok({ id, name });
}

export function validateQuoteDraftLine(line: LineInput): QuoteDraftResult<LineInput> {
  const label = normalizeSingleLine(line.label);
  if (label === '') return fail({ code: 'validation', field: 'label', message: 'Libellé requis.' });
  if (label.length > 500) {
    return fail({
      code: 'validation',
      field: 'label',
      message: 'Libellé trop long (500 caractères maximum).',
    });
  }
  if (!(LINE_CATEGORIES as readonly unknown[]).includes(line.category)) {
    return fail({ code: 'validation', field: 'category', message: 'Catégorie de ligne invalide.' });
  }
  const quantity = Quantity.of(line.qty);
  if (!quantity.ok) return fail(fromDomainError(quantity.error));
  if (!Number.isSafeInteger(line.unitPriceHT) || line.unitPriceHT <= 0) {
    return fail({
      code: 'validation',
      field: 'unitPriceHT',
      message: 'Prix unitaire HT positif en centimes requis.',
    });
  }
  if (!isVatRate(line.vatRate)) {
    return fail({ code: 'validation', field: 'vatRate', message: 'Taux de TVA non autorisé.' });
  }
  const unit = line.unit === undefined ? null : normalizeSingleLine(line.unit);
  if (unit !== null && unit.length > 40) {
    return fail({
      code: 'validation',
      field: 'unit',
      message: 'Unité trop longue (40 caractères maximum).',
    });
  }
  return ok({
    label,
    category: line.category,
    qty: quantity.value.value,
    unitPriceHT: line.unitPriceHT,
    vatRate: line.vatRate,
    ...(unit !== null && unit !== '' ? { unit } : {}),
  });
}

function fromDomainError(error: DomainError): QuoteDraftError {
  if (error.code === 'VALIDATION') {
    return { code: 'validation', field: error.field, message: error.message };
  }
  if (error.code === 'INVALID_TRANSITION') {
    return {
      code: 'invalid_transition',
      field: 'step',
      message: `Transition impossible de ${error.from} vers ${error.to}.`,
    };
  }
  return { code: 'validation', message: 'Le brouillon ne respecte pas les règles du devis.' };
}

function ensureMetadataInvariant(state: QuoteDraftState): QuoteDraftResult<void> {
  if (state.flow.draft.lines.length !== state.lineMetadata.length) {
    return fail({
      code: 'validation',
      field: 'lineMetadata',
      message: 'Le brouillon et ses identifiants de lignes sont désynchronisés.',
    });
  }
  if (
    new Set(state.lineMetadata.map((metadata) => metadata.id)).size !== state.lineMetadata.length
  ) {
    return fail({ code: 'validation', field: 'lineId', message: 'Identifiant de ligne dupliqué.' });
  }
  return ok(undefined);
}

function requireStep(
  state: QuoteDraftState,
  allowed: readonly DevisFlowState['step'][],
  action: string,
): QuoteDraftResult<void> {
  if (allowed.includes(state.flow.step)) return ok(undefined);
  return fail({
    code: 'invalid_transition',
    field: 'step',
    message: `${action} n’est pas disponible à l’étape ${state.flow.step}.`,
  });
}

export function createQuoteDraft(sessionId: string): QuoteDraftState {
  const normalizedId = sessionId.trim();
  if (normalizedId === '') throw new Error('createQuoteDraft: sessionId requis');
  return {
    sessionId: normalizedId,
    revision: 0,
    flow: startDevis(),
    customer: null,
    lineMetadata: [],
    lineForm: EMPTY_QUOTE_DRAFT_LINE_FORM,
    stagingRevision: 0,
    saved: null,
    completedArtifactIds: Object.freeze([]),
    proposal: null,
    lastProposalDecision: null,
    mission: { status: 'idle' },
  };
}

function lineFormEquals(left: QuoteDraftLineFormState, right: QuoteDraftLineFormState): boolean {
  return (
    left.label === right.label &&
    left.quantity === right.quantity &&
    left.unitPrice === right.unitPrice &&
    left.category === right.category
  );
}

export function hasStagedQuoteDraftLine(state: QuoteDraftState): boolean {
  const form = state.lineForm;
  return form.label.trim() !== '' || form.unitPrice.trim() !== '' || form.quantity.trim() !== '1';
}

/** Un choix TVA est une décision explicite et doit survivre à la reprise du brouillon. */
export function hasMeaningfulQuoteDraft(state: QuoteDraftState): boolean {
  const draft = state.flow.draft;
  return (
    state.flow.step !== 'client' ||
    draft.customerId !== null ||
    draft.lines.length > 0 ||
    draft.tvaContext !== null ||
    draft.vatRate !== null ||
    draft.signerName !== null ||
    draft.signMode !== null ||
    draft.depositPct !== 30 ||
    hasStagedQuoteDraftLine(state)
  );
}

export function hasUnsavedQuoteDraftChanges(state: QuoteDraftState): boolean {
  if (!hasMeaningfulQuoteDraft(state)) return false;
  return (
    state.saved === null ||
    state.saved.contentRevision !== state.revision ||
    state.saved.stagingRevision !== state.stagingRevision
  );
}

/** Fence optimiste commune aux gestes UI : un événement rejoué sur une ancienne vue est refusé. */
export function requireQuoteDraftRevision(
  state: QuoteDraftState,
  expectedRevision: number,
): QuoteDraftResult<QuoteDraftState> {
  if (state.revision === expectedRevision) return ok(state);
  return fail({
    code: 'revision_conflict',
    field: 'revision',
    message: 'Le devis a changé. Repars de sa version affichée.',
  });
}

export function updateQuoteDraftLineForm(
  state: QuoteDraftState,
  patch: Partial<QuoteDraftLineFormState>,
): QuoteDraftState {
  const next: QuoteDraftLineFormState = {
    label: patch.label ?? state.lineForm.label,
    quantity: patch.quantity ?? state.lineForm.quantity,
    unitPrice: patch.unitPrice ?? state.lineForm.unitPrice,
    category: patch.category ?? state.lineForm.category,
  };
  if (lineFormEquals(state.lineForm, next)) return state;
  return { ...state, lineForm: next, stagingRevision: state.stagingRevision + 1 };
}

export function clearQuoteDraftLineForm(state: QuoteDraftState): QuoteDraftState {
  const cleared = { ...EMPTY_QUOTE_DRAFT_LINE_FORM, category: state.lineForm.category };
  if (lineFormEquals(state.lineForm, cleared)) return state;
  return {
    ...state,
    // Comme le formulaire historique, la catégorie choisie reste le défaut de la ligne suivante.
    lineForm: cleared,
    stagingRevision: state.stagingRevision + 1,
  };
}

export function markQuoteDraftSaved(state: QuoteDraftState, at: number): QuoteDraftState {
  return {
    ...state,
    saved: { contentRevision: state.revision, stagingRevision: state.stagingRevision, at },
  };
}

function newEmptyDraft(
  state: QuoteDraftState,
  sessionId: string,
  completedArtifactIds = state.completedArtifactIds,
): QuoteDraftState {
  return {
    ...createQuoteDraft(sessionId),
    completedArtifactIds: Object.freeze([...completedArtifactIds]),
  };
}

export function discardQuoteDraft(state: QuoteDraftState, newSessionId: string): QuoteDraftState {
  return newEmptyDraft(state, newSessionId);
}

export interface CompleteQuoteDraftResult {
  readonly state: QuoteDraftState;
  readonly didReset: boolean;
}

/**
 * Reset idempotent après création réelle. L'identifiant de la pièce est la fence : un callback
 * tardif ou un double tap portant le même résultat ne peut jamais effacer le brouillon suivant.
 */
export function completeQuoteDraft(
  state: QuoteDraftState,
  input: { readonly artifactId: string; readonly newSessionId: string },
): CompleteQuoteDraftResult {
  const artifactId = input.artifactId.trim();
  if (artifactId === '') throw new Error('completeQuoteDraft: artifactId requis');
  if (state.completedArtifactIds.includes(artifactId)) return { state, didReset: false };
  const history = [...state.completedArtifactIds, artifactId];
  return {
    state: newEmptyDraft(state, input.newSessionId, history),
    didReset: true,
  };
}

export function quoteDraftStage(state: QuoteDraftState): QuoteDraftStage {
  if (state.flow.step === 'client') return 'client';
  if (state.flow.step === 'lignes') return 'lignes';
  return 'revue';
}

function applyRawCommand(
  state: QuoteDraftState,
  command: QuoteDraftCommand,
): QuoteDraftResult<QuoteDraftState> {
  const invariant = ensureMetadataInvariant(state);
  if (!invariant.ok) return invariant;

  if (command.type === 'select_customer') {
    const step = requireStep(state, ['client'], 'Le choix du client');
    if (!step.ok) return step;
    const customer = validateCustomer(command.customer);
    if (!customer.ok) return customer;
    return ok({
      ...state,
      flow: devisEdit(cloneFlow(state.flow), { customerId: customer.value.id }),
      customer: customer.value,
    });
  }

  if (command.type === 'clear_customer') {
    const step = requireStep(state, ['client', 'lignes'], 'Le changement de client');
    if (!step.ok) return step;
    const cleared = devisEdit(cloneFlow(state.flow), { customerId: null });
    let clearedFlow = cleared;
    if (state.flow.step === 'lignes') {
      const rewound = devisBack(cleared);
      if (!rewound.ok) return fail(fromDomainError(rewound.error));
      clearedFlow = rewound.value;
    }
    return ok({
      ...state,
      // Changer le client passe par la transition core et remet au choix explicite.
      flow: clearedFlow,
      customer: null,
    });
  }

  if (command.type === 'add_line') {
    const step = requireStep(state, ['lignes'], 'L’ajout d’une ligne');
    if (!step.ok) return step;
    if (state.flow.draft.tvaContext === null || state.flow.draft.vatRate === null) {
      return fail({
        code: 'validation',
        field: 'vatRate',
        message: 'Confirme le taux de TVA avant d’ajouter une ligne.',
      });
    }
    const lineId = command.lineId.trim();
    if (lineId === '')
      return fail({ code: 'validation', field: 'lineId', message: 'Identifiant de ligne requis.' });
    if (state.lineMetadata.some((metadata) => metadata.id === lineId)) {
      return fail({ code: 'validation', field: 'lineId', message: 'Cette ligne existe déjà.' });
    }
    const line = validateQuoteDraftLine(command.line);
    if (!line.ok) return line;
    if (line.value.vatRate !== state.flow.draft.vatRate) {
      return fail({
        code: 'validation',
        field: 'vatRate',
        message: 'Le taux de la ligne doit correspondre au taux confirmé du devis.',
      });
    }
    return ok({
      ...state,
      flow: devisEdit(cloneFlow(state.flow), {
        lines: [...state.flow.draft.lines.map(cloneLine), line.value],
      }),
      lineMetadata: [
        ...state.lineMetadata,
        {
          id: lineId,
          interaction: command.interaction,
          ...(command.catalogue !== undefined ? { catalogue: { ...command.catalogue } } : {}),
        },
      ],
    });
  }

  if (command.type === 'update_line') {
    const step = requireStep(state, ['lignes'], 'La modification d’une ligne');
    if (!step.ok) return step;
    const index = state.lineMetadata.findIndex((metadata) => metadata.id === command.lineId);
    if (index < 0) {
      return fail({ code: 'not_found', field: 'lineId', message: 'Ligne de devis introuvable.' });
    }
    const current = state.flow.draft.lines[index];
    if (current === undefined) {
      return fail({
        code: 'validation',
        field: 'lineMetadata',
        message: 'Ligne de devis désynchronisée.',
      });
    }
    const line = validateQuoteDraftLine({ ...cloneLine(current), ...command.patch });
    if (!line.ok) return line;
    if (state.flow.draft.vatRate === null || line.value.vatRate !== state.flow.draft.vatRate) {
      return fail({
        code: 'validation',
        field: 'vatRate',
        message: 'Modifie le taux depuis le choix TVA du devis.',
      });
    }
    const lines = state.flow.draft.lines.map((candidate, candidateIndex) =>
      candidateIndex === index ? line.value : cloneLine(candidate),
    );
    return ok({ ...state, flow: devisEdit(cloneFlow(state.flow), { lines }) });
  }

  if (command.type === 'remove_line') {
    const step = requireStep(state, ['lignes'], 'La suppression d’une ligne');
    if (!step.ok) return step;
    const index = state.lineMetadata.findIndex((metadata) => metadata.id === command.lineId);
    if (index < 0) {
      return fail({ code: 'not_found', field: 'lineId', message: 'Ligne de devis introuvable.' });
    }
    return ok({
      ...state,
      flow: devisEdit(cloneFlow(state.flow), {
        lines: state.flow.draft.lines
          .filter((_, candidateIndex) => candidateIndex !== index)
          .map(cloneLine),
      }),
      lineMetadata: state.lineMetadata.filter((_, candidateIndex) => candidateIndex !== index),
    });
  }

  if (command.type === 'set_vat') {
    const step = requireStep(state, ['client', 'lignes', 'tvaMentions'], 'Le choix de TVA');
    if (!step.ok) return step;
    if (!isVatRate(command.vatRate)) {
      return fail({ code: 'validation', field: 'vatRate', message: 'Taux de TVA non autorisé.' });
    }
    if (command.context === null) {
      return fail({
        code: 'validation',
        field: 'vatRate',
        message: 'Le contexte TVA doit être confirmé.',
      });
    }
    return ok({
      ...state,
      flow: devisEdit(cloneFlow(state.flow), {
        tvaContext: { ...command.context },
        vatRate: command.vatRate,
        lines: state.flow.draft.lines.map((line) => ({
          ...cloneLine(line),
          vatRate: command.vatRate,
        })),
      }),
    });
  }

  if (command.type === 'set_signer_name') {
    const step = requireStep(state, ['signature'], 'La signature');
    if (!step.ok) return step;
    const signerName = command.signerName === null ? null : normalizeSingleLine(command.signerName);
    if (signerName !== null && signerName.length < 2) {
      return fail({
        code: 'validation',
        field: 'signerName',
        message: 'Nom du signataire trop court.',
      });
    }
    return ok({ ...state, flow: devisEdit(cloneFlow(state.flow), { signerName }) });
  }

  if (command.type === 'set_sign_mode') {
    const step = requireStep(state, ['signature'], 'Le choix du mode de signature');
    if (!step.ok) return step;
    // Changer de mode invalide le nom déjà saisi (le passage « sur place » ↔ « envoyer »
    // ne doit jamais laisser un signataire fantôme attaché au mauvais mode).
    return ok({
      ...state,
      flow: devisEdit(cloneFlow(state.flow), { signMode: command.signMode, signerName: null }),
    });
  }

  if (command.type === 'set_deposit_pct') {
    // L'acompte est une clause CHIFFRÉE du brouillon, décidée AVANT l'engagement : il reste
    // modifiable jusqu'à l'étape acompte incluse. Le seed des Réglages facturation s'applique
    // ainsi dès l'entrée du wizard (étape client) — l'exiger à la seule étape acompte faisait
    // échouer ce seed en silence et bloquait l'écran en spinner infini (bug fondateur
    // 2026-07-19, tenant vierge). Après l'engagement (signature, recap), il est figé.
    const step = requireStep(
      state,
      ['client', 'lignes', 'tvaMentions', 'acompte'],
      'Le choix de l’acompte',
    );
    if (!step.ok) return step;
    if (
      !Number.isFinite(command.depositPct) ||
      command.depositPct < 0 ||
      command.depositPct > 100
    ) {
      return fail({
        code: 'validation',
        field: 'depositPct',
        message: 'Acompte entre 0 et 100 %.',
      });
    }
    return ok({
      ...state,
      flow: devisEdit(cloneFlow(state.flow), { depositPct: command.depositPct }),
    });
  }

  if (command.type === 'next_step') {
    const next = devisNext(cloneFlow(state.flow));
    return next.ok ? ok({ ...state, flow: next.value }) : fail(fromDomainError(next.error));
  }

  const previous = devisBack(cloneFlow(state.flow));
  return previous.ok
    ? ok({ ...state, flow: previous.value })
    : fail(fromDomainError(previous.error));
}

function supersededDecision(state: QuoteDraftState, at: number): QuoteDraftProposalDecision | null {
  return state.proposal === null
    ? state.lastProposalDecision
    : { proposalId: state.proposal.id, decision: 'superseded', at };
}

/** Applique une commande tap/voix immédiatement. Une proposition en attente devient caduque. */
export function applyQuoteDraftCommand(
  state: QuoteDraftState,
  command: QuoteDraftCommand,
  at = 0,
): QuoteDraftResult<QuoteDraftState> {
  const result = applyRawCommand(state, command);
  if (!result.ok) return result;
  return ok({
    ...result.value,
    revision: state.revision + 1,
    proposal: null,
    lastProposalDecision: supersededDecision(state, at),
  });
}

/** Transaction locale : toutes les commandes passent, ou aucune modification n'est retournée. */
export function applyQuoteDraftCommands(
  state: QuoteDraftState,
  commands: readonly QuoteDraftCommand[],
  at = 0,
): QuoteDraftResult<QuoteDraftState> {
  if (commands.length === 0) {
    return fail({
      code: 'validation',
      field: 'commands',
      message: 'Au moins une commande est requise.',
    });
  }
  let working = state;
  for (const command of commands) {
    const result = applyRawCommand(working, command);
    if (!result.ok) return result;
    working = result.value;
  }
  return ok({
    ...working,
    revision: state.revision + 1,
    proposal: null,
    lastProposalDecision: supersededDecision(state, at),
  });
}

export function selectCustomer(
  state: QuoteDraftState,
  customer: QuoteDraftCustomer,
  at = 0,
): QuoteDraftResult<QuoteDraftState> {
  return applyQuoteDraftCommand(state, { type: 'select_customer', customer }, at);
}

export interface AddQuoteDraftLineInput {
  readonly lineId: string;
  readonly line: LineInput;
  readonly interaction: QuoteDraftInteraction;
  readonly catalogue?: QuoteDraftLineMetadata['catalogue'];
}

export function addLine(
  state: QuoteDraftState,
  input: AddQuoteDraftLineInput,
  at = 0,
): QuoteDraftResult<QuoteDraftState> {
  return applyQuoteDraftCommand(
    state,
    {
      type: 'add_line',
      lineId: input.lineId,
      line: input.line,
      interaction: input.interaction,
      ...(input.catalogue !== undefined ? { catalogue: input.catalogue } : {}),
    },
    at,
  );
}

export function addCatalogueLine(
  state: QuoteDraftState,
  input: {
    readonly lineId: string;
    readonly prestation: CataloguePrestation;
    readonly qty: number;
    readonly interaction: QuoteDraftInteraction;
  },
  at = 0,
): QuoteDraftResult<QuoteDraftState> {
  return addLine(
    state,
    {
      lineId: input.lineId,
      interaction: input.interaction,
      catalogue: {
        id: input.prestation.id,
        source: input.prestation.source,
        indicative: input.prestation.indicative,
      },
      line: {
        label: input.prestation.label,
        category: input.prestation.category,
        qty: input.qty,
        unitPriceHT: input.prestation.unitPriceHT,
        vatRate: input.prestation.vatRate,
        ...(input.prestation.unit !== null ? { unit: input.prestation.unit } : {}),
      },
    },
    at,
  );
}

export function updateLine(
  state: QuoteDraftState,
  lineId: string,
  patch: Partial<LineInput>,
  at = 0,
): QuoteDraftResult<QuoteDraftState> {
  return applyQuoteDraftCommand(state, { type: 'update_line', lineId, patch }, at);
}

function lineSummary(line: LineInput): string {
  return `${line.qty} × ${line.label} · ${formatEUR(line.unitPriceHT)} HT · TVA ${String(line.vatRate).replace('.', ',')} %`;
}

function buildDiff(before: QuoteDraftState, after: QuoteDraftState): QuoteDraftDiffField[] {
  const fields: QuoteDraftDiffField[] = [];
  if (
    before.customer?.id !== after.customer?.id ||
    before.customer?.name !== after.customer?.name
  ) {
    fields.push({
      key: 'customer',
      label: 'Client',
      before: before.customer?.name ?? 'Non sélectionné',
      after: after.customer?.name ?? 'Non sélectionné',
      kind: 'change',
    });
  }

  const beforeById = new Map(
    before.lineMetadata.map(
      (metadata, index) => [metadata.id, before.flow.draft.lines[index]] as const,
    ),
  );
  const afterById = new Map(
    after.lineMetadata.map(
      (metadata, index) => [metadata.id, after.flow.draft.lines[index]] as const,
    ),
  );
  for (const metadata of after.lineMetadata) {
    const current = afterById.get(metadata.id);
    const previous = beforeById.get(metadata.id);
    if (current === undefined) continue;
    if (previous === undefined) {
      fields.push({
        key: `line:${metadata.id}`,
        label: 'Ligne ajoutée',
        before: '—',
        after: lineSummary(current),
        kind: 'add',
      });
      continue;
    }
    const attributes: readonly {
      readonly key: keyof LineInput;
      readonly label: string;
      readonly format: (value: LineInput[keyof LineInput]) => string;
    }[] = [
      { key: 'label', label: 'Libellé', format: String },
      {
        key: 'category',
        label: 'Catégorie',
        format: (value) => CATEGORY_LABEL[value as LineCategory],
      },
      { key: 'qty', label: 'Quantité', format: String },
      {
        key: 'unit',
        label: 'Unité',
        format: (value) => (value === undefined ? '—' : String(value)),
      },
      {
        key: 'unitPriceHT',
        label: 'Prix unitaire HT',
        format: (value) => formatEUR(value as number),
      },
      { key: 'vatRate', label: 'TVA', format: (value) => `${String(value).replace('.', ',')} %` },
    ];
    for (const attribute of attributes) {
      if (previous[attribute.key] === current[attribute.key]) continue;
      fields.push({
        key: `line:${metadata.id}:${attribute.key}`,
        label: attribute.label,
        before: attribute.format(previous[attribute.key]),
        after: attribute.format(current[attribute.key]),
        kind: 'change',
      });
    }
  }
  for (const metadata of before.lineMetadata) {
    const previous = beforeById.get(metadata.id);
    if (previous === undefined || afterById.has(metadata.id)) continue;
    fields.push({
      key: `line:${metadata.id}`,
      label: 'Ligne supprimée',
      before: lineSummary(previous),
      after: '—',
      kind: 'remove',
    });
  }

  const beforeTotals = computeTotals(before.flow.draft.lines.map(cloneLine), {
    depositPct: before.flow.draft.depositPct,
  });
  const afterTotals = computeTotals(after.flow.draft.lines.map(cloneLine), {
    depositPct: after.flow.draft.depositPct,
  });
  if (beforeTotals.ht !== afterTotals.ht) {
    fields.push({
      key: 'total:ht',
      label: 'Total HT',
      before: formatEUR(beforeTotals.ht),
      after: formatEUR(afterTotals.ht),
      kind: 'change',
    });
  }
  if (beforeTotals.ttc !== afterTotals.ttc) {
    fields.push({
      key: 'total:ttc',
      label: 'Total TTC',
      before: formatEUR(beforeTotals.ttc),
      after: formatEUR(afterTotals.ttc),
      kind: 'change',
    });
  }
  if (before.flow.step !== after.flow.step) {
    fields.push({
      key: 'step',
      label: 'Étape',
      before: quoteDraftStage(before),
      after: quoteDraftStage(after),
      kind: 'change',
    });
  }
  return fields;
}

function defaultProposalTitle(commands: readonly QuoteDraftCommand[]): string {
  if (commands.length !== 1) return 'Mettre à jour le devis';
  const command = commands[0];
  if (command === undefined) return 'Mettre à jour le devis';
  if (command.type === 'select_customer') return `Sélectionner ${command.customer.name}`;
  if (command.type === 'clear_customer') return 'Changer de client';
  if (command.type === 'add_line') return `Ajouter ${normalizeSingleLine(command.line.label)}`;
  if (command.type === 'update_line') return 'Modifier la ligne';
  if (command.type === 'remove_line') return 'Supprimer la ligne';
  if (command.type === 'set_vat') return 'Modifier la TVA';
  if (command.type === 'set_signer_name') return 'Modifier le signataire';
  if (command.type === 'set_deposit_pct') return 'Modifier l’acompte';
  if (command.type === 'set_sign_mode') return 'Modifier le mode de signature';
  return command.type === 'next_step' ? 'Continuer' : 'Revenir à l’étape précédente';
}

export interface ProposeQuoteDraftInput {
  readonly id: string;
  readonly source: QuoteDraftProposal['source'];
  readonly commands: readonly QuoteDraftCommand[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly title?: string;
  readonly explanation?: string | null;
}

/** Prépare et valide une proposition sans appliquer la moindre mutation au contenu. */
export function proposeQuoteDraft(
  state: QuoteDraftState,
  input: ProposeQuoteDraftInput,
): QuoteDraftResult<QuoteDraftState> {
  const id = input.id.trim();
  if (id === '')
    return fail({
      code: 'validation',
      field: 'proposalId',
      message: 'Identifiant de proposition requis.',
    });
  if (
    !Number.isFinite(input.createdAt) ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= input.createdAt
  ) {
    return fail({
      code: 'validation',
      field: 'expiresAt',
      message: 'Expiration de proposition invalide.',
    });
  }
  const preview = applyQuoteDraftCommands(
    { ...state, proposal: null },
    input.commands,
    input.createdAt,
  );
  if (!preview.ok) return preview;
  const diff = buildDiff(state, preview.value);
  if (diff.length === 0) {
    return fail({
      code: 'validation',
      field: 'commands',
      message: 'La proposition ne change pas le brouillon.',
    });
  }
  const title = normalizeSingleLine(input.title ?? defaultProposalTitle(input.commands)).slice(
    0,
    160,
  );
  const commands = Object.freeze(input.commands.map(freezeCommand));
  const immutableDiff = Object.freeze(diff.map((field) => Object.freeze({ ...field })));
  const proposal: QuoteDraftProposal = Object.freeze({
    id,
    source: input.source,
    title,
    explanation:
      input.explanation === undefined || input.explanation === null
        ? null
        : normalizeSingleLine(input.explanation).slice(0, 500),
    commands,
    baseRevision: state.revision,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    diff: immutableDiff,
    spokenPrompt: `${title}. Vérifie le détail, puis dis « je confirme » ou « annule ».`,
  });
  return ok({
    ...state,
    proposal,
    lastProposalDecision:
      state.proposal === null
        ? state.lastProposalDecision
        : { proposalId: state.proposal.id, decision: 'superseded', at: input.createdAt },
  });
}

function cloneCommand(command: QuoteDraftCommand): QuoteDraftCommand {
  if (command.type === 'select_customer') {
    return { type: command.type, customer: { ...command.customer } };
  }
  if (command.type === 'add_line') {
    return {
      type: command.type,
      lineId: command.lineId,
      line: cloneLine(command.line),
      interaction: command.interaction,
      ...(command.catalogue !== undefined ? { catalogue: { ...command.catalogue } } : {}),
    };
  }
  if (command.type === 'update_line') {
    return { type: command.type, lineId: command.lineId, patch: { ...command.patch } };
  }
  if (
    command.type === 'remove_line' ||
    command.type === 'set_deposit_pct' ||
    command.type === 'set_signer_name' ||
    command.type === 'set_sign_mode'
  ) {
    return { ...command };
  }
  if (command.type === 'set_vat') {
    return { ...command, context: command.context === null ? null : { ...command.context } };
  }
  return { type: command.type };
}

function freezeCommand(command: QuoteDraftCommand): QuoteDraftCommand {
  const clone = cloneCommand(command);
  if (clone.type === 'select_customer') {
    Object.freeze(clone.customer);
  } else if (clone.type === 'add_line') {
    Object.freeze(clone.line);
    if (clone.catalogue !== undefined) Object.freeze(clone.catalogue);
  } else if (clone.type === 'update_line') {
    Object.freeze(clone.patch);
  } else if (clone.type === 'set_vat' && clone.context !== null) {
    Object.freeze(clone.context);
  }
  return Object.freeze(clone);
}

export function acceptQuoteDraftProposal(
  state: QuoteDraftState,
  proposalId: string,
  at: number,
): QuoteDraftResult<QuoteDraftState> {
  const proposal = state.proposal;
  if (proposal === null) {
    return fail({
      code: 'proposal_missing',
      field: 'proposalId',
      message: 'Aucune proposition à confirmer.',
    });
  }
  if (proposal.id !== proposalId) {
    return fail({
      code: 'proposal_mismatch',
      field: 'proposalId',
      message: 'Cette proposition n’est plus active.',
    });
  }
  if (at >= proposal.expiresAt) {
    return fail({
      code: 'proposal_expired',
      field: 'proposalId',
      message: 'La proposition a expiré.',
    });
  }
  if (state.revision !== proposal.baseRevision) {
    return fail({
      code: 'proposal_stale',
      field: 'revision',
      message: 'Le devis a changé depuis la proposition. Bob doit la recalculer.',
    });
  }
  const accepted = applyQuoteDraftCommands({ ...state, proposal: null }, proposal.commands, at);
  if (!accepted.ok) return accepted;
  return ok({
    ...accepted.value,
    proposal: null,
    lastProposalDecision: { proposalId, decision: 'accepted', at },
  });
}

export function rejectQuoteDraftProposal(
  state: QuoteDraftState,
  proposalId: string,
  at: number,
): QuoteDraftResult<QuoteDraftState> {
  if (state.proposal === null) {
    return fail({
      code: 'proposal_missing',
      field: 'proposalId',
      message: 'Aucune proposition à refuser.',
    });
  }
  if (state.proposal.id !== proposalId) {
    return fail({
      code: 'proposal_mismatch',
      field: 'proposalId',
      message: 'Cette proposition n’est plus active.',
    });
  }
  return ok({
    ...state,
    proposal: null,
    lastProposalDecision: { proposalId, decision: 'rejected', at },
  });
}

export function expireQuoteDraftProposal(state: QuoteDraftState, at: number): QuoteDraftState {
  if (state.proposal === null || at < state.proposal.expiresAt) return state;
  return {
    ...state,
    proposal: null,
    lastProposalDecision: { proposalId: state.proposal.id, decision: 'expired', at },
  };
}

export function startQuoteDraftMission(
  state: QuoteDraftState,
  input: {
    readonly id: string;
    readonly mode: 'manual' | 'guided_voice';
    readonly startedFrom: string;
    readonly startedAt: number;
  },
): QuoteDraftResult<QuoteDraftState> {
  const id = input.id.trim();
  if (id === '')
    return fail({
      code: 'validation',
      field: 'missionId',
      message: 'Identifiant de mission requis.',
    });
  return ok({
    ...state,
    mission: {
      status: 'active',
      id,
      mode: input.mode,
      startedFrom: input.startedFrom || '/',
      startedAt: input.startedAt,
    },
  });
}

/** Arrête le guidage, conserve le brouillon, mais abandonne tout diff non confirmé. */
export function stopQuoteDraftMission(
  state: QuoteDraftState,
  input: { readonly reason: QuoteDraftMissionStopReason; readonly stoppedAt: number },
): QuoteDraftState {
  if (state.mission.status !== 'active') return state;
  return {
    ...state,
    proposal: null,
    lastProposalDecision:
      state.proposal === null
        ? state.lastProposalDecision
        : { proposalId: state.proposal.id, decision: 'superseded', at: input.stoppedAt },
    mission: {
      status: 'stopped',
      id: state.mission.id,
      reason: input.reason,
      stoppedAt: input.stoppedAt,
    },
  };
}

export function completeQuoteDraftMission(
  state: QuoteDraftState,
  completedAt: number,
): QuoteDraftState {
  if (state.mission.status !== 'active') return state;
  return {
    ...state,
    proposal: null,
    lastProposalDecision:
      state.proposal === null
        ? state.lastProposalDecision
        : { proposalId: state.proposal.id, decision: 'superseded', at: completedAt },
    mission: { status: 'completed', id: state.mission.id, completedAt },
  };
}

export type QuoteDraftGuidanceExpectation =
  'customer' | 'advance' | 'line' | 'proposal_confirmation' | 'review_decision';

export interface QuoteDraftGuidance {
  readonly stage: QuoteDraftStage;
  readonly expectation: QuoteDraftGuidanceExpectation;
  readonly title: string;
  readonly spokenPrompt: string;
  readonly suggestions: readonly string[];
}

/** Guidance canonique : la voix lit la même réalité que le wizard, sans contenu financier inventé. */
export function deriveQuoteDraftGuidance(state: QuoteDraftState): QuoteDraftGuidance | null {
  if (state.mission.status !== 'active') return null;
  const stage = quoteDraftStage(state);
  if (state.proposal !== null) {
    return {
      stage,
      expectation: 'proposal_confirmation',
      title: state.proposal.title,
      spokenPrompt: state.proposal.spokenPrompt,
      suggestions: ['Je confirme', 'Modifier', 'Annule'],
    };
  }
  if (stage === 'client') {
    if (state.customer === null) {
      return {
        stage,
        expectation: 'customer',
        title: 'Choisir le client',
        spokenPrompt:
          'Pour quel client prépares-tu ce devis ? Tu peux me le dire ou le choisir à l’écran.',
        suggestions: ['Dire le nom du client', 'Choisir à l’écran'],
      };
    }
    return {
      stage,
      expectation: 'advance',
      title: state.customer.name,
      spokenPrompt: `${state.customer.name} est sélectionné. Dis « continue » ou utilise le bouton à l’écran.`,
      suggestions: ['Continuer', 'Changer de client'],
    };
  }
  if (stage === 'lignes') {
    const count = state.flow.draft.lines.length;
    return {
      stage,
      expectation: 'line',
      title:
        count === 0 ? 'Ajouter une prestation' : `${count} ligne${count > 1 ? 's' : ''} au devis`,
      spokenPrompt:
        count === 0
          ? 'Dis-moi ce que tu factures, avec la quantité et le prix. Je préparerai la ligne avant validation.'
          : `Le devis contient ${count} ligne${count > 1 ? 's' : ''}. Tu peux en ajouter, en modifier une, ou dire « continue ».`,
      suggestions: ['Ajouter une ligne', 'Modifier une ligne', 'Continuer'],
    };
  }
  return {
    stage,
    expectation: 'review_decision',
    title: 'Relire le devis',
    spokenPrompt:
      'Relis le devis à l’écran. Tu peux me demander une modification ou continuer vers la validation.',
    suggestions: ['Résumer le devis', 'Modifier', 'Continuer'],
  };
}
