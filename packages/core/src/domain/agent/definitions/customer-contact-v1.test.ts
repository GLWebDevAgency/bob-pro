import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../shared-kernel/sha256';
import { JARVIS_RUN_STATUSES, type JarvisRunEnvelope } from '../jarvis-run';
import {
  reduceJarvisRun,
  resolveJarvisDefinition,
  type JarvisReduceContext,
  type JarvisReduceResult,
  type JarvisRunTransition,
  type JarvisTargetRevalidation,
} from '../jarvis-run-reducer';
import {
  CUSTOMER_CONTACT_ACTION_VERSION,
  CUSTOMER_CONTACT_CONFIRMATION_TTL_MS,
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  CUSTOMER_CONTACT_EXECUTE_BY_MS,
  CUSTOMER_CONTACT_LIMITS,
  CUSTOMER_CONTACT_PHASES,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  CUSTOMER_CONTACT_V1,
  computeCustomerContactCandidateSetHash,
  customerContactStatusForPhase,
  parseCustomerContactState,
  type CustomerContactDuplicateDecision,
  type CustomerContactStateV1,
} from './customer-contact-v1';

type CustomerContactRunEnvelope = Extract<
  JarvisRunEnvelope,
  { readonly kind: 'single_business_action' | 'customer_contact' }
>;

// --------------------------------------------------------------------------
// Fixtures déterministes — aucune horloge ambiante, aucun aléa
// --------------------------------------------------------------------------

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

const RUN_ID = uuid(0x1);
const EFFECT_ID = uuid(0xe1);
const OTHER_EFFECT_ID = uuid(0xe2);
const REVIEW_ID = uuid(0xd1);
const CHOICE_A = uuid(0xca);
const CHOICE_B = uuid(0xcb);
const PROPOSAL_ID = uuid(0xa1);
const CONFIRMATION_ID = uuid(0xf1);
const TARGET_CUSTOMER_ID = 'customer-42';
const EXISTING_CUSTOMER_ID = 'customer-7';

const FIELDS_DIGEST = sha256Hex('fields-v1');
const SENSITIVE_DIGEST = sha256Hex('sensitive-v1');
const MATCH_DIGEST = sha256Hex('match-evidence');

/**
 * Ce que l'ADMISSION dérive de la fiche RELUE sous verrou (§7.1) — jamais une valeur du wire :
 * le sceau posé à la mise en proposition, puis la même lecture au confirm.
 */
const TARGET_SENSITIVE_DIGEST = sha256Hex('target-sensitive-v1');
const MUTATED_TARGET_SENSITIVE_DIGEST = sha256Hex('target-sensitive-v2');
const TARGET_AT_REVISION_3 = Object.freeze({
  revision: 3,
  sensitiveDigest: TARGET_SENSITIVE_DIGEST,
});

const T0 = '2026-08-18T10:00:00.000Z';
function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

let commandCounter = 0;
function nextCommandId(): string {
  commandCounter += 1;
  return uuid(0xc0_0000 + commandCounter);
}

function ctx(
  run: CustomerContactRunEnvelope,
  over: Partial<JarvisReduceContext> = {},
): JarvisReduceContext {
  return {
    commandId: over.commandId ?? nextCommandId(),
    expectedRevision: over.expectedRevision ?? run.revision,
    occurredAt: over.occurredAt ?? T0,
    actingPrincipalId: over.actingPrincipalId ?? 'principal-1',
    allocatedEffectIds: over.allocatedEffectIds ?? [],
    // L'admission relit TOUJOURS la cible d'un run de modification, dans SA transaction : le
    // contexte par défaut simule cette relecture « la fiche n'a pas bougé ». Un test qui prouve
    // une dérive — ou une cible devenue illisible — la pose explicitement.
    targetRevalidation:
      over.targetRevalidation === undefined ? unmutatedTarget(run) : over.targetRevalidation,
  };
}

/**
 * Relecture d'une cible intacte : la révision vérifiée, et le digest déjà scellé s'il existe.
 * Un state CORROMPU (suites de garde-fous) n'a pas de cible lisible : aucune relecture.
 */
function unmutatedTarget(run: CustomerContactRunEnvelope): JarvisTargetRevalidation | null {
  const state = parseCustomerContactState(run.state);
  if (state === null || state.intent.mode !== 'update') return null;
  return {
    revision: state.intent.target.revision,
    sensitiveDigest: state.proposal?.targetSensitiveDigest ?? TARGET_SENSITIVE_DIGEST,
  };
}

function seedRun(): CustomerContactRunEnvelope {
  return {
    kind: 'customer_contact',
    runId: RUN_ID,
    companyId: 'company-1',
    createdBy: 'user-1',
    definitionVersion: 1,
    status: 'active',
    revision: 0,
    stateVersion: 1,
    state: null,
    nextWakeAt: null,
    terminalAt: null,
  };
}

function step(
  run: CustomerContactRunEnvelope,
  command: unknown,
  over: Partial<JarvisReduceContext> = {},
): { run: CustomerContactRunEnvelope; transition: JarvisRunTransition } {
  const result = CUSTOMER_CONTACT_V1.reduce(run, command, ctx(run, over));
  if (!result.ok) throw new Error(`transition refusée: ${JSON.stringify(result)}`);
  const postimage = result.value.postimage as CustomerContactRunEnvelope;
  // Canonicité §5.4 : TOUT state produit par une transition doit reparser à l'identique
  // (round-trip parse(produce(state))) — sinon le run serait briqué en `state_shape`.
  const reparsed = parseCustomerContactState(postimage.state);
  expect(reparsed).not.toBeNull();
  expect(reparsed).toEqual(postimage.state);
  return { run: postimage, transition: result.value };
}

function stateOf(run: CustomerContactRunEnvelope): CustomerContactStateV1 {
  return run.state as CustomerContactStateV1;
}

function expectInvalid(result: JarvisReduceResult, reason: string): void {
  expect(result).toEqual({ ok: false, error: { code: 'invalid_command', reason } });
}

const START_CREATE = { type: 'start_run', intent: { mode: 'create' } } as const;
const START_UPDATE = {
  type: 'start_run',
  intent: { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 3 } },
} as const;

function startedCreate(): CustomerContactRunEnvelope {
  return step(seedRun(), START_CREATE, { allocatedEffectIds: [EFFECT_ID] }).run;
}

/** update démarré + cible relue (§8) : prêt à proposer. */
function updateAtPreparing(): CustomerContactRunEnvelope {
  const started = step(seedRun(), START_UPDATE, { allocatedEffectIds: [EFFECT_ID] }).run;
  return step(started, {
    type: 'record_customer_resolution',
    resolution: { kind: 'target_verified', customerId: TARGET_CUSTOMER_ID },
  }).run;
}

const STAGE_UPDATE_PROPOSAL = {
  type: 'stage_proposal',
  proposalId: PROPOSAL_ID,
  confirmationId: CONFIRMATION_ID,
  fieldsDigest: FIELDS_DIGEST,
  sensitiveDigest: SENSITIVE_DIGEST,
  targetRevision: 3,
} as const;

function updateAtPresented(): CustomerContactRunEnvelope {
  let run = updateAtPreparing();
  // Le sceau de cible naît de la relecture d'admission — pas du contenu de la commande.
  run = step(run, STAGE_UPDATE_PROPOSAL, { targetRevalidation: TARGET_AT_REVISION_3 }).run;
  run = step(run, {
    type: 'record_presentation_ack',
    confirmationId: CONFIRMATION_ID,
    ack: 'screen_ack',
  }, { occurredAt: at(10_000) }).run;
  return run;
}

function confirmUpdateCommand(run: CustomerContactRunEnvelope): Record<string, unknown> {
  return {
    type: 'confirm',
    confirmationId: CONFIRMATION_ID,
    proposalHash: stateOf(run).proposal!.proposalHash,
  };
}

function updateAtCompleted(): {
  run: CustomerContactRunEnvelope;
  receiptCommand: Record<string, unknown>;
} {
  let run = updateAtPresented();
  run = step(run, confirmUpdateCommand(run), {
    occurredAt: at(20_000),
    targetRevalidation: TARGET_AT_REVISION_3,
  }).run;
  run = step(run, {
    type: 'record_effect_submitted',
    effectId: EFFECT_ID,
    submittedJobRef: 'job-77',
  }, { occurredAt: at(30_000) }).run;
  const receiptCommand = {
    type: 'record_effect_receipt',
    effectId: EFFECT_ID,
    outcome: { kind: 'succeeded', customerId: TARGET_CUSTOMER_ID, customerRevision: 4 },
  };
  run = step(run, receiptCommand, { occurredAt: at(40_000) }).run;
  return { run, receiptCommand };
}

const DUPLICATE_RESOLUTION = {
  type: 'record_customer_resolution',
  resolution: {
    kind: 'duplicate_candidates',
    reviewId: REVIEW_ID,
    candidates: [
      { choiceId: CHOICE_A, customerId: EXISTING_CUSTOMER_ID, matchDigest: MATCH_DIGEST },
      { choiceId: CHOICE_B, customerId: 'customer-8', matchDigest: MATCH_DIGEST },
    ],
  },
} as const;

// --------------------------------------------------------------------------
// Démarrage et effet unique
// --------------------------------------------------------------------------

describe('customer_contact@1 — démarrage et effectId unique', () => {
  it('pince context.allocatedEffectIds[0] au démarrage — le SEUL effectId du run (§5.4)', () => {
    const { run, transition } = step(seedRun(), START_CREATE, {
      allocatedEffectIds: [EFFECT_ID, OTHER_EFFECT_ID],
    });
    expect(stateOf(run).effectId).toBe(EFFECT_ID);
    expect(stateOf(run).phase).toBe('resolving_customer');
    expect(run.status).toBe('active');
    expect(run.revision).toBe(1);
    expect(run.terminalAt).toBeNull();
    expect(transition.workItemIntents).toHaveLength(0);
  });

  it('refuse de démarrer sans effectId préalloué par le serveur', () => {
    const seed = seedRun();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(seed, START_CREATE, ctx(seed, { allocatedEffectIds: [] })),
      'missing_allocated_effect_id',
    );
  });

  it("update SANS cible réelle = erreur — la cible n'est jamais inventée (§9.1)", () => {
    const seed = seedRun();
    const context = ctx(seed, { allocatedEffectIds: [EFFECT_ID] });
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(seed, { type: 'start_run', intent: { mode: 'update' } }, context),
      'command_shape',
    );
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        seed,
        { type: 'start_run', intent: { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID } } },
        context,
      ),
      'command_shape',
    );
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        seed,
        { type: 'start_run', intent: { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 0 } } },
        context,
      ),
      'command_shape',
    );
  });

  it('refuse toute commande avant démarrage et tout second démarrage', () => {
    const seed = seedRun();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(seed, { type: 'cancel_run', reason: 'user_cancelled' }, ctx(seed)),
      'run_not_started',
    );
    const started = startedCreate();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(started, START_CREATE, ctx(started, { allocatedEffectIds: [OTHER_EFFECT_ID] })),
      'already_started',
    );
  });

  it("émet l'effectId PINCÉ même si un contexte ultérieur alloue d'autres ids", () => {
    const presented = updateAtPresented();
    const { transition } = step(presented, confirmUpdateCommand(presented), {
      occurredAt: at(20_000),
      allocatedEffectIds: [OTHER_EFFECT_ID],
    });
    expect(transition.workItemIntents).toHaveLength(1);
    expect(transition.workItemIntents.length).toBeLessThanOrEqual(CUSTOMER_CONTACT_LIMITS.maxOpenWorkItems);
    expect(transition.workItemIntents[0]!.effectId).toBe(EFFECT_ID);
  });
});

// --------------------------------------------------------------------------
// Doublons — FD-06 : la fusion est impossible PAR CONSTRUCTION
// --------------------------------------------------------------------------

describe('customer_contact@1 — revue des doublons (FD-06)', () => {
  it('présente des candidats bornés scellés par digest', () => {
    const { run } = step(startedCreate(), DUPLICATE_RESOLUTION);
    const state = stateOf(run);
    expect(state.phase).toBe('awaiting_duplicate_review');
    expect(run.status).toBe('waiting_user');
    expect(state.duplicateReview!.candidates).toHaveLength(2);
    expect(state.duplicateReview!.candidateSetHash).toBe(
      computeCustomerContactCandidateSetHash({
        runId: RUN_ID,
        reviewId: REVIEW_ID,
        candidates: DUPLICATE_RESOLUTION.resolution.candidates,
      }),
    );
  });

  it('borne les candidats à 5 — un sixième refuse la commande', () => {
    const run = startedCreate();
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      choiceId: uuid(0x100 + index),
      customerId: `customer-${index}`,
      matchDigest: MATCH_DIGEST,
    }));
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        run,
        { type: 'record_customer_resolution', resolution: { kind: 'duplicate_candidates', reviewId: REVIEW_ID, candidates } },
        ctx(run),
      ),
      'command_shape',
    );
  });

  it("n'offre AUCUNE commande de fusion — l'union de décision la ferme par construction", () => {
    const { run } = step(startedCreate(), DUPLICATE_RESOLUTION);
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        run,
        {
          type: 'choose_duplicate_resolution',
          reviewId: REVIEW_ID,
          decision: { kind: 'merge', sourceCustomerId: EXISTING_CUSTOMER_ID, targetCustomerId: 'customer-8' },
        },
        ctx(run),
      ),
      'command_shape',
    );
    const acceptDecision = (decision: CustomerContactDuplicateDecision): string => decision.kind;
    // @ts-expect-error — FD-06 : la variante 'merge' N'EXISTE PAS dans CustomerContactDuplicateDecision.
    acceptDecision({ kind: 'merge' });
  });

  it('continue la création après revue', () => {
    const reviewed = step(startedCreate(), DUPLICATE_RESOLUTION).run;
    const { run } = step(reviewed, {
      type: 'choose_duplicate_resolution',
      reviewId: REVIEW_ID,
      decision: { kind: 'continue_create' },
    });
    expect(stateOf(run).phase).toBe('preparing_proposal');
    expect(run.status).toBe('active');
  });

  it('choisir un existant TERMINE le run sur ce client — sans effet, sans fusion', () => {
    const reviewed = step(startedCreate(), DUPLICATE_RESOLUTION).run;
    const { run, transition } = step(reviewed, {
      type: 'choose_duplicate_resolution',
      reviewId: REVIEW_ID,
      decision: { kind: 'use_existing', choiceId: CHOICE_A },
    }, { occurredAt: at(5_000) });
    expect(stateOf(run).phase).toBe('completed');
    expect(run.status).toBe('completed');
    expect(run.terminalAt).toBe(at(5_000));
    expect(stateOf(run).resolvedExistingCustomerId).toBe(EXISTING_CUSTOMER_ID);
    expect(transition.workItemIntents).toHaveLength(0);
    expect(transition.releasedForegroundLease).toBe(true);
  });

  it('refuse un reviewId divergent et un choiceId hors des candidats réels', () => {
    const reviewed = step(startedCreate(), DUPLICATE_RESOLUTION).run;
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        reviewed,
        { type: 'choose_duplicate_resolution', reviewId: uuid(0xdead), decision: { kind: 'continue_create' } },
        ctx(reviewed),
      ),
      'review_mismatch',
    );
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        reviewed,
        { type: 'choose_duplicate_resolution', reviewId: REVIEW_ID, decision: { kind: 'use_existing', choiceId: uuid(0xbeef) } },
        ctx(reviewed),
      ),
      'choice_unknown',
    );
  });
});

// --------------------------------------------------------------------------
// Cible réelle en update
// --------------------------------------------------------------------------

describe('customer_contact@1 — cible réelle en update', () => {
  it('refuse une relecture qui substitue la cible admise', () => {
    const started = step(seedRun(), START_UPDATE, { allocatedEffectIds: [EFFECT_ID] }).run;
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        started,
        { type: 'record_customer_resolution', resolution: { kind: 'target_verified', customerId: 'customer-999' } },
        ctx(started),
      ),
      'target_mismatch',
    );
  });

  it("scelle la révision RELUE, jamais celle que l'émetteur croit connaître (§8)", () => {
    // L'ouverture depuis l'écran ne peut PAS connaître la révision de la fiche : elle ne l'a pas
    // lue sous verrou. Le seul émetteur possible est donc muet là-dessus, et le domaine prend la
    // relecture d'admission — ici une fiche déjà modifiée sept fois. Si la commande faisait foi,
    // toute fiche de révision ≠ celle du seed condamnerait la proposition suivante en
    // `target_revision_stale`, sans qu'aucune trace ne dise pourquoi.
    const started = step(seedRun(), START_UPDATE, { allocatedEffectIds: [EFFECT_ID] }).run;
    const resolved = step(
      started,
      {
        type: 'record_customer_resolution',
        resolution: { kind: 'target_verified', customerId: TARGET_CUSTOMER_ID },
      },
      { targetRevalidation: { revision: 7, sensitiveDigest: TARGET_SENSITIVE_DIGEST } },
    );
    const state = stateOf(resolved.run);
    expect(state.intent.mode).toBe('update');
    expect(state.intent.mode === 'update' ? state.intent.target.revision : null).toBe(7);
    // Et la proposition qui suit doit sceller CETTE révision-là, pas celle du démarrage.
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        resolved.run,
        { ...STAGE_UPDATE_PROPOSAL, targetRevision: 3 },
        ctx(resolved.run, {
          targetRevalidation: { revision: 7, sensitiveDigest: TARGET_SENSITIVE_DIGEST },
        }),
      ),
      'target_revision_stale',
    );
  });

  it('refuse la résolution quand la cible est illisible : jamais une révision devinée', () => {
    // Fiche disparue, policy refusée, tenant incohérent : l'admission ne rend AUCUNE relecture.
    // Sceller malgré tout reviendrait à inventer l'état d'une entité — le refus est nommé.
    const started = step(seedRun(), START_UPDATE, { allocatedEffectIds: [EFFECT_ID] }).run;
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        started,
        {
          type: 'record_customer_resolution',
          resolution: { kind: 'target_verified', customerId: TARGET_CUSTOMER_ID },
        },
        ctx(started, { targetRevalidation: null }),
      ),
      'target_revalidation_missing',
    );
  });

  it("lit encore un état N-1 (proposition sans sceau de cible) : annulable, jamais confirmable", () => {
    // COMPATIBILITÉ N-1. `targetSensitiveDigest` est né avec U1-e. Un run déjà en base au moment
    // du déploiement porte une proposition SANS cette clé : si le parseur l'exigeait, le state
    // deviendrait illisible et le run IRRÉDUCTIBLE — `state_shape` sur toute commande, y compris
    // `cancel_run`. L'artisan garderait à vie un run mort tenant son premier plan.
    const presented = updateAtPresented();
    const state = stateOf(presented);
    const proposal = state.proposal;
    if (proposal === null) throw new Error('proposition attendue');
    const { targetSensitiveDigest: _retire, ...proposalN1 } = proposal as unknown as Record<
      string,
      unknown
    > & { targetSensitiveDigest: unknown };
    const runN1: CustomerContactRunEnvelope = {
      ...presented,
      state: { ...(presented.state as Record<string, unknown>), proposal: proposalN1 },
    };

    // (a) LISIBLE : le run se réduit encore, donc l'artisan peut s'en défaire.
    const cancelled = CUSTOMER_CONTACT_V1.reduce(
      runN1,
      { type: 'cancel_run', reason: 'user_cancelled' },
      ctx(runN1, { occurredAt: at(20_000) }),
    );
    expect(cancelled.ok).toBe(true);

    // (b) PAS CONFIRMABLE : sans sceau, la garde §9.1 n'a rien à comparer — la proposition est
    // INVALIDÉE (elle sera refaite), jamais consommée sur une cible qu'on n'a pas vérifiée.
    const confirmed = CUSTOMER_CONTACT_V1.reduce(
      runN1,
      confirmUpdateCommand(runN1),
      ctx(runN1, { occurredAt: at(20_000), targetRevalidation: TARGET_AT_REVISION_3 }),
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error('transition attendue');
    const after = stateOf(confirmed.value.postimage as CustomerContactRunEnvelope);
    expect(after.confirmation?.status).toBe('invalidated');
    expect(confirmed.value.workItemIntents).toEqual([]);
  });

  it('refuse un outcome de résolution incohérent avec le mode', () => {
    const startedUpdate = step(seedRun(), START_UPDATE, { allocatedEffectIds: [EFFECT_ID] }).run;
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(startedUpdate, DUPLICATE_RESOLUTION, ctx(startedUpdate)),
      'resolution_mode_mismatch',
    );
    const startedCreateRun = startedCreate();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        startedCreateRun,
        { type: 'record_customer_resolution', resolution: { kind: 'target_verified', customerId: TARGET_CUSTOMER_ID } },
        ctx(startedCreateRun),
      ),
      'resolution_mode_mismatch',
    );
  });

  it('refuse une proposition qui ne scelle pas la révision vérifiée', () => {
    const preparing = updateAtPreparing();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        preparing,
        { ...STAGE_UPDATE_PROPOSAL, targetRevision: 2 },
        ctx(preparing),
      ),
      'target_revision_stale',
    );
  });
});

// --------------------------------------------------------------------------
// Cycle de confirmation §7.1
// --------------------------------------------------------------------------

describe('customer_contact@1 — cycle §7.1', () => {
  it('issued : proposition digestée + wake confirmation_ttl, nextWakeAt dérivé', () => {
    const { run } = step(updateAtPreparing(), STAGE_UPDATE_PROPOSAL);
    const state = stateOf(run);
    expect(state.phase).toBe('awaiting_confirmation');
    expect(run.status).toBe('waiting_user');
    expect(state.confirmation!.status).toBe('issued');
    expect(state.proposal!.fieldsDigest).toBe(FIELDS_DIGEST);
    expect(state.wakes).toEqual([
      { wakeId: CONFIRMATION_ID, kind: 'confirmation_ttl', dueAt: at(CUSTOMER_CONTACT_CONFIRMATION_TTL_MS) },
    ]);
    expect(run.nextWakeAt).toBe(at(CUSTOMER_CONTACT_CONFIRMATION_TTL_MS));
  });

  it('refuse confirm avant le reçu de présentation (§7.1 : presented obligatoire)', () => {
    const issued = step(updateAtPreparing(), STAGE_UPDATE_PROPOSAL).run;
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(issued, confirmUpdateCommand(issued), ctx(issued)),
      'confirmation_not_presented',
    );
  });

  it('presented -> consumed : UN intent, source confirmation, action pincée client-modifier@1', () => {
    const presented = updateAtPresented();
    expect(stateOf(presented).confirmation!.status).toBe('presented');
    const confirmCommandId = nextCommandId();
    const { run, transition } = step(presented, confirmUpdateCommand(presented), {
      occurredAt: at(20_000),
      commandId: confirmCommandId,
    });
    const state = stateOf(run);
    expect(state.phase).toBe('committing');
    expect(run.status).toBe('waiting_external');
    expect(transition.releasedForegroundLease).toBe(true);
    expect(state.confirmation!.status).toBe('consumed');
    expect(state.confirmation!.consumedByCommandId).toBe(confirmCommandId);
    expect(state.wakes).toHaveLength(0);
    expect(run.nextWakeAt).toBeNull();
    expect(transition.workItemIntents).toEqual([
      {
        effectId: EFFECT_ID,
        actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
        actionVersion: CUSTOMER_CONTACT_ACTION_VERSION,
        authorizationSource: { source: 'confirmation', receiptId: confirmCommandId },
        actingPrincipalId: 'principal-1',
        targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string,
        payloadRef: { proposalId: PROPOSAL_ID, fieldsDigest: FIELDS_DIGEST },
        executeBy: at(20_000 + CUSTOMER_CONTACT_EXECUTE_BY_MS),
      },
    ]);
  });

  it('create : confirm émet client-creer@1 sans targetDigest', () => {
    let run = startedCreate();
    run = step(run, { type: 'record_customer_resolution', resolution: { kind: 'no_duplicates' } }).run;
    run = step(run, { ...STAGE_UPDATE_PROPOSAL, targetRevision: null }).run;
    run = step(run, { type: 'record_presentation_ack', confirmationId: CONFIRMATION_ID, ack: 'voice_presentation_ack' }).run;
    const { transition } = step(run, {
      type: 'confirm',
      confirmationId: CONFIRMATION_ID,
      proposalHash: stateOf(run).proposal!.proposalHash,
    });
    expect(transition.workItemIntents[0]!.actionId).toBe(CUSTOMER_CONTACT_CREATE_ACTION_ID);
    expect(transition.workItemIntents[0]!.targetDigest).toBeNull();
  });

  it('rejette hash divergent et confirmationId divergent', () => {
    const presented = updateAtPresented();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        presented,
        { ...confirmUpdateCommand(presented), proposalHash: sha256Hex('autre') },
        ctx(presented),
      ),
      'proposal_hash_mismatch',
    );
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        presented,
        { ...confirmUpdateCommand(presented), confirmationId: uuid(0xbad) },
        ctx(presented),
      ),
      'confirmation_mismatch',
    );
  });

  it('reject ferme la proposition et rouvre la préparation', () => {
    const presented = updateAtPresented();
    const { run } = step(presented, { type: 'reject_proposal', confirmationId: CONFIRMATION_ID });
    expect(stateOf(run).phase).toBe('preparing_proposal');
    expect(stateOf(run).confirmation!.status).toBe('rejected');
    expect(stateOf(run).proposal).toBeNull();
  });

  it('TTL dépassé au confirm : expired — jamais consumed, le run reste actif (jamais `expired`)', () => {
    const presented = updateAtPresented();
    const { run, transition } = step(presented, confirmUpdateCommand(presented), {
      occurredAt: at(CUSTOMER_CONTACT_CONFIRMATION_TTL_MS + 1_000),
    });
    expect(stateOf(run).confirmation!.status).toBe('expired');
    expect(stateOf(run).phase).toBe('preparing_proposal');
    expect(run.status).toBe('active');
    expect(transition.workItemIntents).toHaveLength(0);
  });

  it('wake à échéance fait expirer la confirmation ; wake inconnu = no-op idempotent', () => {
    const issued = step(updateAtPreparing(), STAGE_UPDATE_PROPOSAL).run;
    const noopResult = CUSTOMER_CONTACT_V1.reduce(
      issued,
      { type: 'wake_run', wakeId: uuid(0x777) },
      ctx(issued),
    );
    expect(noopResult.ok).toBe(true);
    if (noopResult.ok) {
      expect(noopResult.value.postimage).toBe(issued);
      expect(noopResult.value.event.type).toBe('cc_wake_noop');
    }
    const { run } = step(issued, { type: 'wake_run', wakeId: CONFIRMATION_ID }, {
      occurredAt: at(CUSTOMER_CONTACT_CONFIRMATION_TTL_MS),
    });
    expect(stateOf(run).confirmation!.status).toBe('expired');
    expect(stateOf(run).phase).toBe('preparing_proposal');
    expect(run.status).toBe('active');
    expect(run.nextWakeAt).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Stale §9.1 : mutation sensible entre présentation et confirm => invalidated
// --------------------------------------------------------------------------

describe('customer_contact@1 — invalidation stale (§9.1)', () => {
  it('mutation TVA observée pendant la fenêtre de confirmation => invalidated, jamais consumed', () => {
    const presented = updateAtPresented();
    const { run, transition } = step(presented, {
      type: 'record_target_mutation',
      mutatedField: 'vat_profile',
      targetRevision: 4,
    });
    const state = stateOf(run);
    expect(state.confirmation!.status).toBe('invalidated');
    expect(state.confirmation!.status).not.toBe('consumed');
    expect(state.phase).toBe('preparing_proposal');
    expect(state.proposal).toBeNull();
    expect(state.intent).toEqual({ mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 4 } });
    expect(transition.workItemIntents).toHaveLength(0);
    // La nouvelle proposition doit sceller la nouvelle révision.
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(run, STAGE_UPDATE_PROPOSAL, ctx(run)),
      'target_revision_stale',
    );
  });

  it('cible relue divergente AU confirm (adresse/destinataire mutés) => invalidated, jamais consumed', () => {
    const presented = updateAtPresented();
    // La commande de confirm est INCHANGÉE (trois clés) : seule la RELECTURE d'admission diverge.
    const { run, transition } = step(presented, confirmUpdateCommand(presented), {
      occurredAt: at(20_000),
      targetRevalidation: { revision: 5, sensitiveDigest: MUTATED_TARGET_SENSITIVE_DIGEST },
    });
    const state = stateOf(run);
    expect(state.confirmation!.status).toBe('invalidated');
    expect(state.phase).toBe('preparing_proposal');
    expect(state.intent).toEqual({ mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 5 } });
    expect(transition.workItemIntents).toHaveLength(0);
    expect(transition.event.type).toBe('cc_proposal_invalidated');
  });

  it('les DEUX bras de la garde mordent seuls : révision bougée seule, digest bougé seul', () => {
    const presented = updateAtPresented();
    // Bras 1 — la révision a bougé, le digest sensible non (mutation d'un champ non sensible).
    const byRevision = step(presented, confirmUpdateCommand(presented), {
      occurredAt: at(20_000),
      targetRevalidation: { revision: 4, sensitiveDigest: TARGET_SENSITIVE_DIGEST },
    });
    expect(stateOf(byRevision.run).confirmation!.status).toBe('invalidated');
    expect(stateOf(byRevision.run).intent).toEqual({
      mode: 'update',
      target: { customerId: TARGET_CUSTOMER_ID, revision: 4 },
    });
    // Bras 2 — la révision est intacte, le digest sensible a bougé : un writer qui n'incrémente
    // pas la révision ne peut pas passer sous le radar de la garde §9.1.
    const byDigest = step(presented, confirmUpdateCommand(presented), {
      occurredAt: at(20_000),
      targetRevalidation: { revision: 3, sensitiveDigest: MUTATED_TARGET_SENSITIVE_DIGEST },
    });
    expect(stateOf(byDigest.run).confirmation!.status).toBe('invalidated');
    expect(byDigest.transition.workItemIntents).toHaveLength(0);
  });

  it('cible NON relue par l’admission : refus nommé, jamais un confirm à l’aveugle', () => {
    const presented = updateAtPresented();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        presented,
        confirmUpdateCommand(presented),
        ctx(presented, { occurredAt: at(20_000), targetRevalidation: null }),
      ),
      'target_revalidation_missing',
    );
    // La proposition reste INTACTE : un refus n'est pas une invalidation.
    expect(stateOf(presented).confirmation!.status).toBe('presented');
  });

  it('mise en proposition sans relecture, ou avec une cible qui a déjà bougé : refus nommés', () => {
    const preparing = updateAtPreparing();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        preparing,
        STAGE_UPDATE_PROPOSAL,
        ctx(preparing, { targetRevalidation: null }),
      ),
      'target_revalidation_missing',
    );
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        preparing,
        STAGE_UPDATE_PROPOSAL,
        ctx(preparing, {
          targetRevalidation: { revision: 4, sensitiveDigest: TARGET_SENSITIVE_DIGEST },
        }),
      ),
      'target_revision_stale',
    );
  });

  it('création : une cible relue n’a aucun sens — refus nommé aux deux étapes', () => {
    let run = startedCreate();
    run = step(run, {
      type: 'record_customer_resolution',
      resolution: { kind: 'no_duplicates' },
    }).run;
    const stageCreate = { ...STAGE_UPDATE_PROPOSAL, targetRevision: null };
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        run,
        stageCreate,
        ctx(run, { targetRevalidation: TARGET_AT_REVISION_3 }),
      ),
      'target_revalidation_forbidden',
    );
    run = step(run, stageCreate).run;
    run = step(run, {
      type: 'record_presentation_ack',
      confirmationId: CONFIRMATION_ID,
      ack: 'screen_ack',
    }).run;
    expect(stateOf(run).proposal!.targetSensitiveDigest).toBeNull();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        run,
        {
          type: 'confirm',
          confirmationId: CONFIRMATION_ID,
          proposalHash: stateOf(run).proposal!.proposalHash,
        },
        ctx(run, { targetRevalidation: TARGET_AT_REVISION_3 }),
      ),
      'target_revalidation_forbidden',
    );
  });

  it('le confirm REFUSE de porter la cible relue : cinq clés = refus de forme', () => {
    const presented = updateAtPresented();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        presented,
        {
          ...confirmUpdateCommand(presented),
          revalidatedTargetRevision: 3,
          revalidatedSensitiveDigest: TARGET_SENSITIVE_DIGEST,
        },
        ctx(presented, { occurredAt: at(20_000) }),
      ),
      'command_shape',
    );
  });

  it("l'invalidation n'est jamais rétroactive : après consommation, la mutation est refusée", () => {
    const presented = updateAtPresented();
    const committed = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        committed,
        { type: 'record_target_mutation', mutatedField: 'recipient', targetRevision: 6 },
        ctx(committed),
      ),
      'invalid_phase_for_command',
    );
  });
});

// --------------------------------------------------------------------------
// Reçu d'effet idempotent
// --------------------------------------------------------------------------

describe("customer_contact@1 — reçu d'effet idempotent", () => {
  it('le reçu succeeded termine le run avec le customerId de la cible', () => {
    const { run } = updateAtCompleted();
    expect(stateOf(run).phase).toBe('completed');
    expect(run.status).toBe('completed');
    expect(run.terminalAt).toBe(at(40_000));
    expect(stateOf(run).receipt).toEqual({
      effectId: EFFECT_ID,
      customerId: TARGET_CUSTOMER_ID,
      customerRevision: 4,
      recordedAt: at(40_000),
    });
  });

  it('replay du même reçu (même effectId, même customerId) = no-op explicite audité', () => {
    const { run, receiptCommand } = updateAtCompleted();
    const replay = CUSTOMER_CONTACT_V1.reduce(run, receiptCommand, ctx(run, { occurredAt: at(50_000) }));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.postimage).toBe(run);
      expect((replay.value.postimage as CustomerContactRunEnvelope).revision).toBe(run.revision);
      expect(replay.value.event.type).toBe('cc_effect_receipt_replayed');
      expect(replay.value.workItemIntents).toHaveLength(0);
    }
  });

  it('un reçu divergent ne masque jamais un résultat externe : conflit typé', () => {
    const { run } = updateAtCompleted();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        run,
        {
          type: 'record_effect_receipt',
          effectId: EFFECT_ID,
          outcome: { kind: 'succeeded', customerId: 'customer-999', customerRevision: 4 },
        },
        ctx(run),
      ),
      'receipt_conflict',
    );
  });

  it('staleness par effectId : un reçu à mauvais effectId est refusé explicitement (§5.3)', () => {
    const { run } = updateAtCompleted();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        run,
        {
          type: 'record_effect_receipt',
          effectId: OTHER_EFFECT_ID,
          outcome: { kind: 'succeeded', customerId: TARGET_CUSTOMER_ID, customerRevision: 4 },
        },
        ctx(run),
      ),
      'effect_id_mismatch',
    );
  });

  it("en update, un reçu succeeded sur un AUTRE client que la cible est un conflit", () => {
    const presented = updateAtPresented();
    const committed = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        committed,
        {
          type: 'record_effect_receipt',
          effectId: EFFECT_ID,
          outcome: { kind: 'succeeded', customerId: 'customer-999', customerRevision: 9 },
        },
        ctx(committed),
      ),
      'receipt_conflict',
    );
  });

  it("le reçu peut arriver avant l'ACK de soumission (redélivrance level-triggered)", () => {
    const presented = updateAtPresented();
    const committing = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    expect(stateOf(committing).phase).toBe('committing');
    const { run } = step(committing, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      outcome: { kind: 'succeeded', customerId: TARGET_CUSTOMER_ID, customerRevision: 4 },
    }, { occurredAt: at(25_000) });
    expect(stateOf(run).phase).toBe('completed');
  });

  it('un échec terminal du coordinateur passe le run en failed_terminal — jamais `expired`', () => {
    const presented = updateAtPresented();
    const committing = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    const { run } = step(committing, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      outcome: { kind: 'failed_terminal', reasonCode: 'coordinator_rejected' },
    }, { occurredAt: at(30_000) });
    expect(run.status).toBe('failed_terminal');
    expect(run.terminalAt).toBe(at(30_000));
    expect(stateOf(run).failureReason).toBe('coordinator_rejected');
    // Replay idempotent du même échec.
    const replay = CUSTOMER_CONTACT_V1.reduce(run, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      outcome: { kind: 'failed_terminal', reasonCode: 'coordinator_rejected' },
    }, ctx(run));
    expect(replay.ok).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Terminal figé, annulation, CAS et garde-fous
// --------------------------------------------------------------------------

describe('customer_contact@1 — terminal figé et garde-fous', () => {
  it('un run terminal est figé : toute commande hors replay de reçu est run_terminal', () => {
    const { run } = updateAtCompleted();
    expect(
      CUSTOMER_CONTACT_V1.reduce(run, { type: 'cancel_run', reason: 'user_cancelled' }, ctx(run)),
    ).toEqual({ ok: false, error: { code: 'run_terminal', status: 'completed' } });
    expect(
      CUSTOMER_CONTACT_V1.reduce(run, STAGE_UPDATE_PROPOSAL, ctx(run)),
    ).toEqual({ ok: false, error: { code: 'run_terminal', status: 'completed' } });

    const cancelled = step(updateAtPreparing(), { type: 'cancel_run', reason: 'manual_handoff' }).run;
    expect(cancelled.status).toBe('cancelled');
    expect(
      CUSTOMER_CONTACT_V1.reduce(cancelled, { type: 'wake_run', wakeId: uuid(0x9) }, ctx(cancelled)),
    ).toEqual({ ok: false, error: { code: 'run_terminal', status: 'cancelled' } });
  });

  it("après consommation, cancel passe en `cancelling` qui OBSERVE — jamais un faux annulé (§5.3)", () => {
    const presented = updateAtPresented();
    const committing = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    const { run: cancelling, transition } = step(committing, {
      type: 'cancel_run',
      reason: 'user_cancelled',
    }, { occurredAt: at(25_000) });
    expect(cancelling.status).toBe('cancelling');
    expect(cancelling.terminalAt).toBeNull();
    expect(transition.event.type).toBe('cc_cancel_requested');
    // Un second cancel pendant l'observation est refusé (le premier est déjà scellé).
    expect(
      CUSTOMER_CONTACT_V1.reduce(cancelling, { type: 'cancel_run', reason: 'user_cancelled' }, ctx(cancelling)),
    ).toEqual({ ok: false, error: { code: 'invalid_command', reason: 'invalid_phase_for_command' } });
  });

  it('reçu SUCCEEDED pendant cancelling ⇒ completed, le succès externe n’est jamais masqué (§5.3)', () => {
    const presented = updateAtPresented();
    const committing = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    const cancelling = step(committing, { type: 'cancel_run', reason: 'user_cancelled' }, { occurredAt: at(25_000) }).run;
    const { run, transition } = step(cancelling, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      outcome: { kind: 'succeeded', customerId: TARGET_CUSTOMER_ID, customerRevision: 4 },
    }, { occurredAt: at(30_000) });
    expect(run.status).toBe('completed');
    expect(transition.event.data['cancellationRequested']).toBe(true);
    expect(stateOf(run).receipt?.customerId).toBe(TARGET_CUSTOMER_ID);
  });

  it('reçu FAILED pendant cancelling ⇒ cancelled (terminal honnête, cancelReason scellé)', () => {
    const presented = updateAtPresented();
    const committing = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    const cancelling = step(committing, { type: 'cancel_run', reason: 'manual_handoff' }, { occurredAt: at(25_000) }).run;
    const { run, transition } = step(cancelling, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      outcome: { kind: 'failed_terminal', reasonCode: 'coordinator_rejected' },
    }, { occurredAt: at(30_000) });
    expect(run.status).toBe('cancelled');
    expect(stateOf(run).cancelReason).toBe('manual_handoff');
    expect(transition.event.data['cancellationRequested']).toBe(true);
  });

  it('CAS : une révision attendue divergente est un conflit typé sans postimage', () => {
    const run = startedCreate();
    expect(
      CUSTOMER_CONTACT_V1.reduce(run, { type: 'cancel_run', reason: 'user_cancelled' }, ctx(run, { expectedRevision: 7 })),
    ).toEqual({
      ok: false,
      error: { code: 'revision_conflict', expectedRevision: 7, actualRevision: 1 },
    });
  });

  it('state corrompu = refus typé, jamais de tolérance', () => {
    const run = { ...startedCreate(), state: { garbage: true } };
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(run, { type: 'cancel_run', reason: 'user_cancelled' }, ctx(run)),
      'state_shape',
    );
  });
});

// --------------------------------------------------------------------------
// Budget maxSteps : fermeture et reçu TOUJOURS possibles (§5.3)
// --------------------------------------------------------------------------

/** Force le compteur de pas au budget — le state reste valide (parse exige steps <= maxSteps). */
function atMaxSteps(run: CustomerContactRunEnvelope): CustomerContactRunEnvelope {
  return { ...run, state: { ...stateOf(run), steps: CUSTOMER_CONTACT_LIMITS.maxSteps } };
}

describe('customer_contact@1 — budget maxSteps (§5.3)', () => {
  it('à maxSteps, toute commande ordinaire est refusée max_steps_exceeded', () => {
    const presented = atMaxSteps(updateAtPresented());
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        presented,
        { type: 'reject_proposal', confirmationId: CONFIRMATION_ID },
        ctx(presented),
      ),
      'max_steps_exceeded',
    );
  });

  it('à maxSteps, cancel_run passe TOUJOURS — le run se ferme, state reparsable', () => {
    const presented = atMaxSteps(updateAtPresented());
    const { run } = step(presented, { type: 'cancel_run', reason: 'user_cancelled' }, {
      occurredAt: at(15_000),
    });
    expect(run.status).toBe('cancelled');
    expect(stateOf(run).steps).toBe(CUSTOMER_CONTACT_LIMITS.maxSteps);
  });

  it('à maxSteps, cancel_run après consommation passe aussi (cancelling qui observe)', () => {
    const presented = updateAtPresented();
    const committed = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    const forced = atMaxSteps(committed);
    const { run } = step(forced, { type: 'cancel_run', reason: 'manual_handoff' }, {
      occurredAt: at(25_000),
    });
    expect(run.status).toBe('cancelling');
    expect(stateOf(run).steps).toBe(CUSTOMER_CONTACT_LIMITS.maxSteps);
  });

  it("à maxSteps, record_effect_receipt s'applique TOUJOURS — le résultat n'est jamais perdu", () => {
    const presented = updateAtPresented();
    const committed = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    const forced = atMaxSteps(committed);
    const { run } = step(forced, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      outcome: { kind: 'succeeded', customerId: TARGET_CUSTOMER_ID, customerRevision: 4 },
    }, { occurredAt: at(30_000) });
    expect(run.status).toBe('completed');
    expect(stateOf(run).steps).toBe(CUSTOMER_CONTACT_LIMITS.maxSteps);
    expect(stateOf(run).receipt?.customerId).toBe(TARGET_CUSTOMER_ID);
  });
});

// --------------------------------------------------------------------------
// Frontières d'expiration §7.1 : ACK tardif refusé, confirm à l'instant exact
// --------------------------------------------------------------------------

describe("customer_contact@1 — frontières d'expiration (§7.1)", () => {
  const ACK = {
    type: 'record_presentation_ack',
    confirmationId: CONFIRMATION_ID,
    ack: 'screen_ack',
  } as const;

  it("refuse un ACK arrivé À ou APRÈS expiresAt — n'atteint jamais presented", () => {
    const issued = step(updateAtPreparing(), STAGE_UPDATE_PROPOSAL).run;
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        issued,
        ACK,
        ctx(issued, { occurredAt: at(CUSTOMER_CONTACT_CONFIRMATION_TTL_MS) }),
      ),
      'confirmation_expired',
    );
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        issued,
        ACK,
        ctx(issued, { occurredAt: at(CUSTOMER_CONTACT_CONFIRMATION_TTL_MS + 60_000) }),
      ),
      'confirmation_expired',
    );
    // Juste avant l'échéance, l'ACK passe encore.
    const { run } = step(issued, ACK, { occurredAt: at(CUSTOMER_CONTACT_CONFIRMATION_TTL_MS - 1) });
    expect(stateOf(run).confirmation!.status).toBe('presented');
  });

  it("confirm À l'instant EXACT d'expiration : expired — jamais consumed", () => {
    const presented = updateAtPresented();
    const { run, transition } = step(presented, confirmUpdateCommand(presented), {
      occurredAt: at(CUSTOMER_CONTACT_CONFIRMATION_TTL_MS),
    });
    expect(transition.event.type).toBe('cc_proposal_expired');
    expect(stateOf(run).confirmation!.status).toBe('expired');
    expect(stateOf(run).phase).toBe('preparing_proposal');
    expect(transition.workItemIntents).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Cancel en awaiting_confirmation : le cycle §7.1 se ferme dans le MÊME commit
// --------------------------------------------------------------------------

describe('customer_contact@1 — cancel ferme le cycle §7.1', () => {
  it('cancel en awaiting_confirmation : confirmation pendante invalidated (authorization_revoked), un seul commit', () => {
    const presented = updateAtPresented();
    const { run, transition } = step(presented, { type: 'cancel_run', reason: 'user_cancelled' }, {
      occurredAt: at(15_000),
    });
    expect(run.status).toBe('cancelled');
    expect(run.revision).toBe(presented.revision + 1);
    expect(stateOf(run).confirmation!.status).toBe('invalidated');
    expect(stateOf(run).cancelReason).toBe('user_cancelled');
    expect(transition.event.type).toBe('cc_run_cancelled');
    expect(transition.event.data['invalidatedConfirmationId']).toBe(CONFIRMATION_ID);
    expect(transition.event.data['invalidationCause']).toBe('authorization_revoked');
    expect(run.nextWakeAt).toBeNull();
  });

  it('cancel dès issued : la confirmation pendante est aussi invalidée', () => {
    const issued = step(updateAtPreparing(), STAGE_UPDATE_PROPOSAL).run;
    const { run } = step(issued, { type: 'cancel_run', reason: 'manual_handoff' }, {
      occurredAt: at(5_000),
    });
    expect(run.status).toBe('cancelled');
    expect(stateOf(run).confirmation!.status).toBe('invalidated');
  });

  it('cancel hors fenêtre de confirmation : aucune confirmation à invalider, événement nul', () => {
    const { transition } = step(updateAtPreparing(), { type: 'cancel_run', reason: 'user_cancelled' });
    expect(transition.event.data['invalidatedConfirmationId']).toBeNull();
    expect(transition.event.data['invalidationCause']).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Cancelled issu de cancelling : reasonCode scellé + replay idempotent (§5.3)
// --------------------------------------------------------------------------

describe('customer_contact@1 — cancelled issu de cancelling (§5.3)', () => {
  function cancelledFromFailedReceipt(): {
    run: CustomerContactRunEnvelope;
    receiptCommand: Record<string, unknown>;
  } {
    const presented = updateAtPresented();
    const committing = step(presented, confirmUpdateCommand(presented), { occurredAt: at(20_000) }).run;
    const cancelling = step(committing, { type: 'cancel_run', reason: 'manual_handoff' }, {
      occurredAt: at(25_000),
    }).run;
    const receiptCommand = {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      outcome: { kind: 'failed_terminal', reasonCode: 'coordinator_rejected' },
    };
    const run = step(cancelling, receiptCommand, { occurredAt: at(30_000) }).run;
    return { run, receiptCommand };
  }

  it('scelle le reasonCode dans failureReason — le state cancelled reste parsable', () => {
    const { run } = cancelledFromFailedReceipt();
    expect(run.status).toBe('cancelled');
    expect(stateOf(run).failureReason).toBe('coordinator_rejected');
    expect(stateOf(run).cancelReason).toBe('manual_handoff');
    const reparsed = parseCustomerContactState(stateOf(run));
    expect(reparsed).toEqual(stateOf(run));
  });

  it('replay du MÊME reçu failed sur ce terminal = no-op idempotent audité, jamais receipt_conflict', () => {
    const { run, receiptCommand } = cancelledFromFailedReceipt();
    const replay = CUSTOMER_CONTACT_V1.reduce(run, receiptCommand, ctx(run, { occurredAt: at(35_000) }));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.postimage).toBe(run);
      expect(replay.value.event.type).toBe('cc_effect_receipt_replayed');
      expect(replay.value.workItemIntents).toHaveLength(0);
    }
  });

  it('un reçu DIVERGENT sur ce terminal reste un conflit typé', () => {
    const { run } = cancelledFromFailedReceipt();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(run, {
        type: 'record_effect_receipt',
        effectId: EFFECT_ID,
        outcome: { kind: 'failed_terminal', reasonCode: 'autre_raison' },
      }, ctx(run)),
      'receipt_conflict',
    );
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(run, {
        type: 'record_effect_receipt',
        effectId: EFFECT_ID,
        outcome: { kind: 'succeeded', customerId: TARGET_CUSTOMER_ID, customerRevision: 4 },
      }, ctx(run)),
      'receipt_conflict',
    );
  });
});

// --------------------------------------------------------------------------
// Canonicité §5.4 du contexte d'admission
// --------------------------------------------------------------------------

describe('customer_contact@1 — canonicité du contexte (§5.4)', () => {
  it('refuse un commandId non canonique AVANT toute transition', () => {
    const preparing = updateAtPreparing();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        preparing,
        STAGE_UPDATE_PROPOSAL,
        ctx(preparing, { commandId: 'PAS-UN-UUID' }),
      ),
      'invalid_value',
    );
  });

  it('refuse un occurredAt non canonique (round-trip ISO exigé)', () => {
    const preparing = updateAtPreparing();
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(
        preparing,
        STAGE_UPDATE_PROPOSAL,
        ctx(preparing, { occurredAt: '2026-08-18T10:00:00Z' }),
      ),
      'invalid_value',
    );
  });

  it('round-trip : le state produit par CHAQUE transition du parcours nominal reparse à l’identique', () => {
    // Le helper step() vérifie parse(produce(state)) sur TOUTES les transitions de la suite ;
    // ce parcours dédié couvre update -> proposition -> ack -> confirm -> soumission -> reçu.
    const { run } = updateAtCompleted();
    const reparsed = parseCustomerContactState(stateOf(run));
    expect(reparsed).not.toBeNull();
    expect(reparsed).toEqual(stateOf(run));
  });
});

// --------------------------------------------------------------------------
// One-shot §7.1 du confirm : replay cohérent vs conflit typé
// --------------------------------------------------------------------------

describe('customer_contact@1 — one-shot du confirm (§7.1)', () => {
  it('REPLAY (même commandId que consumedByCommandId) = no-op cohérent, intent JAMAIS ré-émis', () => {
    const presented = updateAtPresented();
    const confirmCommandId = nextCommandId();
    const command = confirmUpdateCommand(presented);
    const committed = step(presented, command, {
      occurredAt: at(20_000),
      commandId: confirmCommandId,
    }).run;
    const replay = CUSTOMER_CONTACT_V1.reduce(committed, command, ctx(committed, {
      commandId: confirmCommandId,
      occurredAt: at(21_000),
    }));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.postimage).toBe(committed);
      expect(replay.value.event.type).toBe('cc_confirm_replayed');
      expect(replay.value.event.data['consumedByCommandId']).toBe(confirmCommandId);
      expect(replay.value.workItemIntents).toHaveLength(0);
    }
  });

  it('CONFLIT (autre commandId) après consommation = erreur typée dédiée', () => {
    const presented = updateAtPresented();
    const command = confirmUpdateCommand(presented);
    const committed = step(presented, command, { occurredAt: at(20_000) }).run;
    expectInvalid(
      CUSTOMER_CONTACT_V1.reduce(committed, command, ctx(committed, { occurredAt: at(21_000) })),
      'confirmation_already_consumed',
    );
  });
});

// --------------------------------------------------------------------------
// Statuts §5.1 fermés — jamais `expired` — et intégration au reducer racine
// --------------------------------------------------------------------------

describe('customer_contact@1 — statuts §5.1 et registre racine', () => {
  it('la projection phase -> statut est totale, fermée §5.1 et n\'émet JAMAIS `expired`', () => {
    for (const phase of CUSTOMER_CONTACT_PHASES) {
      const status = customerContactStatusForPhase(phase);
      expect(JARVIS_RUN_STATUSES).toContain(status);
      expect(status).not.toBe('expired');
    }
  });

  it("aucun parcours n'émet `expired` : tous les statuts observés restent dans l'union fermée", () => {
    const observed: string[] = [];
    let run = step(seedRun(), START_CREATE, { allocatedEffectIds: [EFFECT_ID] }).run;
    observed.push(run.status);
    run = step(run, DUPLICATE_RESOLUTION).run;
    observed.push(run.status);
    run = step(run, { type: 'choose_duplicate_resolution', reviewId: REVIEW_ID, decision: { kind: 'continue_create' } }).run;
    observed.push(run.status);
    run = step(run, { ...STAGE_UPDATE_PROPOSAL, targetRevision: null }).run;
    observed.push(run.status);
    // Expiration par wake puis nouvelle proposition : le run ne devient jamais `expired`.
    run = step(run, { type: 'wake_run', wakeId: CONFIRMATION_ID }, { occurredAt: at(CUSTOMER_CONTACT_CONFIRMATION_TTL_MS) }).run;
    observed.push(run.status);
    run = step(run, { ...STAGE_UPDATE_PROPOSAL, proposalId: uuid(0xa2), confirmationId: uuid(0xf2), targetRevision: null }).run;
    observed.push(run.status);
    run = step(run, { type: 'record_presentation_ack', confirmationId: uuid(0xf2), ack: 'screen_ack' }).run;
    observed.push(run.status);
    run = step(run, {
      type: 'confirm',
      confirmationId: uuid(0xf2),
      proposalHash: stateOf(run).proposal!.proposalHash,
    }).run;
    observed.push(run.status);
    run = step(run, { type: 'record_effect_submitted', effectId: EFFECT_ID, submittedJobRef: null }).run;
    observed.push(run.status);
    run = step(run, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      outcome: { kind: 'succeeded', customerId: 'customer-new-1', customerRevision: 1 },
    }).run;
    observed.push(run.status);
    for (const status of observed) {
      expect(JARVIS_RUN_STATUSES).toContain(status);
      expect(status).not.toBe('expired');
    }
    expect(observed.at(-1)).toBe('completed');
  });

  it('expose des limites fermées §4.3 et est résolu par le registre gelé', () => {
    expect(CUSTOMER_CONTACT_LIMITS).toEqual({
      maxSteps: 24,
      maxOpenWorkItems: 1,
      maxStateBytes: 65_536,
      idleTtlMs: 86_400_000,
      hardTtlMs: 604_800_000,
      maxWakes: 4,
    });
    expect(resolveJarvisDefinition('customer_contact', 1)).toBe(CUSTOMER_CONTACT_V1);
  });

  it("reduceJarvisRun route vers la définition ; une version inconnue part en quarantaine (§5.5)", () => {
    const seed = seedRun();
    const routed = reduceJarvisRun(
      seed,
      { kind: 'customer_contact', definitionVersion: 1, command: START_CREATE },
      ctx(seed, { allocatedEffectIds: [EFFECT_ID] }),
    );
    expect(routed.ok).toBe(true);
    if (routed.ok) {
      expect((routed.value.postimage as CustomerContactRunEnvelope).status).toBe('active');
      expect((stateOf(routed.value.postimage as CustomerContactRunEnvelope)).phase).toBe('resolving_customer');
    }
    const unknownVersion = { ...seedRun(), definitionVersion: 99 };
    expect(
      reduceJarvisRun(
        unknownVersion,
        { kind: 'customer_contact', definitionVersion: 99, command: START_CREATE },
        ctx(unknownVersion, { allocatedEffectIds: [EFFECT_ID] }),
      ),
    ).toEqual({ ok: false, quarantine: { kind: 'customer_contact', definitionVersion: 99 } });
  });
});
