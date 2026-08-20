import { describe, expect, it } from 'vitest';

import { jsonUtf8Fits } from '../../../shared-kernel/json-size';
import {
  JARVIS_RUN_STATUSES,
  JARVIS_RUN_TERMINAL_STATUSES,
  deriveNextWakeAt,
  type JarvisRunEnvelope,
} from '../jarvis-run';
import {
  reduceJarvisRun,
  resolveJarvisDefinition,
  type JarvisReduceContext,
  type JarvisReduceResult,
  type JarvisRunTransition,
} from '../jarvis-run-reducer';
import {
  SINGLE_BUSINESS_ACTION_LIMITS,
  SINGLE_BUSINESS_ACTION_V1,
  initialSingleBusinessActionState,
  isSingleBusinessActionError,
  parseSingleBusinessActionState,
  singleBusinessActionStatusForState,
  type SingleBusinessActionCommand,
  type SingleBusinessActionError,
  type SingleBusinessActionStateV1,
} from './single-business-action-v1';

// ---------------------------------------------------------------------------
// Fixtures déterministes — jamais d'horloge ambiante ni d'aléa non seedé.
// ---------------------------------------------------------------------------

const T0 = '2026-08-18T10:00:00.000Z';
const TTL_MS = 300_000; // expiresAt = 10:05:00.000Z
const EXEC_MS = 900_000; // executeBy = occurredAt + 15 min
const EXPIRES_AT = '2026-08-18T10:05:00.000Z';

const RUN_ID = 'run-1';
const COMPANY_ID = 'company-1';
const USER_ID = 'user-1';
const EFFECT_ID = 'effect-1';
// commandIds : UUIDs canoniques — la garde d'entrée §5.4 refuse tout autre format.
const CMD_DEFAULT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CMD_STAGE = 'c0000001-0000-4000-8000-000000000001';
const CMD_ACK = 'c0000002-0000-4000-8000-000000000002';
const CMD_CONFIRM = 'c0000003-0000-4000-8000-000000000003';
const CMD_OTHER = 'c0000004-0000-4000-8000-000000000004';
const CMD_SUBMITTED = 'c0000005-0000-4000-8000-000000000005';
const CMD_SUCCEEDED = 'c0000006-0000-4000-8000-000000000006';
const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_ID_2 = '22222222-2222-4222-8222-222222222222';
const DIGEST_INPUT = 'a'.repeat(64);
const PROPOSAL_HASH = 'b'.repeat(64);
const TARGET_DIGEST = 'c'.repeat(64);
const RESULT_DIGEST = 'd'.repeat(64);
const FAILURE_DIGEST = 'e'.repeat(64);
const TTL_WAKE_ID = `sba-confirmation-ttl:${PROPOSAL_ID}`;

type SbaRun = Extract<JarvisRunEnvelope, { kind: 'single_business_action' | 'customer_contact' }>;

function initialState(): SingleBusinessActionStateV1 {
  const built = initialSingleBusinessActionState({ actionId: 'client-creer', actionVersion: 1 });
  if (!built.ok) throw new Error('initial state invalide');
  return built.value;
}

function makeRun(
  state: SingleBusinessActionStateV1,
  overrides: Partial<Omit<SbaRun, 'kind' | 'state'>> = {},
): SbaRun {
  return {
    kind: 'single_business_action',
    runId: RUN_ID,
    companyId: COMPANY_ID,
    createdBy: USER_ID,
    definitionVersion: 1,
    status: singleBusinessActionStatusForState(state),
    revision: 0,
    stateVersion: 1,
    state,
    nextWakeAt: null,
    terminalAt: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<JarvisReduceContext> = {}): JarvisReduceContext {
  return {
    commandId: CMD_DEFAULT,
    expectedRevision: 0,
    occurredAt: T0,
    actingPrincipalId: USER_ID,
    allocatedEffectIds: [EFFECT_ID],
    ...overrides,
  };
}

function stageCommand(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    type: 'stage_proposal',
    proposalId: PROPOSAL_ID,
    canonicalInputDigest: DIGEST_INPUT,
    proposalHash: PROPOSAL_HASH,
    presentationRequirement: 'screen_ack',
    targetDigest: TARGET_DIGEST,
    payloadRef: { 'payload-ref': 'staging-42' },
    confirmationTtlMs: TTL_MS,
    executeWindowMs: EXEC_MS,
    ...overrides,
  };
}

function expectOk(result: JarvisReduceResult): JarvisRunTransition {
  if (!result.ok) throw new Error(`transition refusée : ${JSON.stringify(result)}`);
  return result.value;
}

function expectSbaError(result: JarvisReduceResult): SingleBusinessActionError {
  if (result.ok || !('error' in result)) throw new Error('erreur SBA attendue');
  expect(result.error.code).toBe('delegated_error');
  const inner = (result.error as { code: 'delegated_error'; error: unknown }).error;
  if (!isSingleBusinessActionError(inner)) {
    throw new Error(`erreur SBA attendue, reçu : ${JSON.stringify(inner)}`);
  }
  return inner;
}

/** Applique une commande et rend le run suivant (postimage) — pilotage des parcours. */
function step(
  run: SbaRun,
  command: unknown,
  contextOverrides: Partial<JarvisReduceContext> = {},
): { readonly transition: JarvisRunTransition; readonly run: SbaRun } {
  const transition = expectOk(
    SINGLE_BUSINESS_ACTION_V1.reduce(
      run,
      command,
      makeContext({ expectedRevision: run.revision, ...contextOverrides }),
    ),
  );
  return { transition, run: transition.postimage as SbaRun };
}

/** Narrowing du postimage vers la branche U1-b de l'enveloppe. */
function postRun(transition: JarvisRunTransition): SbaRun {
  if (transition.postimage.kind !== 'single_business_action') {
    throw new Error('postimage inattendue : kind hors single_business_action');
  }
  return transition.postimage;
}

function postState(transition: JarvisRunTransition): SingleBusinessActionStateV1 {
  return postRun(transition).state as SingleBusinessActionStateV1;
}

/** Parcours jusqu'à `committing` inclus (proposition consommée, intent émis). */
function driveToCommitting(): { run: SbaRun; confirm: JarvisRunTransition } {
  let current = makeRun(initialState());
  current = step(current, stageCommand(), { commandId: CMD_STAGE }).run;
  current = step(
    current,
    { type: 'record_presentation_ack', proposalId: PROPOSAL_ID, ack: 'screen_ack' },
    { commandId: CMD_ACK, occurredAt: '2026-08-18T10:00:30.000Z' },
  ).run;
  const { transition, run } = step(
    current,
    { type: 'confirm', proposalId: PROPOSAL_ID, proposalHash: PROPOSAL_HASH },
    { commandId: CMD_CONFIRM, occurredAt: '2026-08-18T10:01:00.000Z' },
  );
  return { run, confirm: transition };
}

// ---------------------------------------------------------------------------
// Enregistrement et bornes
// ---------------------------------------------------------------------------

describe('single_business_action@1 — module', () => {
  it("s'enregistre dans le registre gelé du reducer racine", () => {
    expect(resolveJarvisDefinition('single_business_action', 1)).toBe(SINGLE_BUSINESS_ACTION_V1);
  });

  it('dérive l’action uniquement du state persistant', () => {
    expect(SINGLE_BUSINESS_ACTION_V1.actionReference(makeRun(initialState()), { type: 'cancel_run' }))
      .toEqual({ actionId: 'client-creer', actionVersion: 1 });
    expect(
      SINGLE_BUSINESS_ACTION_V1.actionReference(
        { ...makeRun(initialState()), state: null },
        { type: 'cancel_run' },
      ),
    ).toBeNull();
  });

  it('fige les bornes §4.3 demandées par la spec U1-b', () => {
    expect(SINGLE_BUSINESS_ACTION_LIMITS).toEqual({
      maxSteps: 32,
      maxOpenWorkItems: 1,
      maxStateBytes: 65_536,
      idleTtlMs: 24 * 60 * 60 * 1_000,
      hardTtlMs: 7 * 24 * 60 * 60 * 1_000,
      maxWakes: 4,
    });
    expect(Object.isFrozen(SINGLE_BUSINESS_ACTION_LIMITS)).toBe(true);
    expect(Object.isFrozen(SINGLE_BUSINESS_ACTION_V1)).toBe(true);
  });

  it('est atteint via reduceJarvisRun, et une version inconnue part en quarantaine sans effet', () => {
    const run = makeRun(initialState());
    const viaRoot = reduceJarvisRun(
      run,
      { kind: 'single_business_action', definitionVersion: 1, command: stageCommand() },
      makeContext(),
    );
    expect(viaRoot.ok).toBe(true);

    const unknown = reduceJarvisRun(
      makeRun(initialState(), { definitionVersion: 2 }),
      { kind: 'single_business_action', definitionVersion: 2, command: stageCommand() },
      makeContext(),
    );
    expect(unknown.ok).toBe(false);
    expect('quarantine' in unknown && unknown.quarantine).toEqual({
      kind: 'single_business_action',
      definitionVersion: 2,
    });
  });

  it('refuse un envelope au mauvais kind ou à la mauvaise version (garde défensive)', () => {
    const wrongVersion = SINGLE_BUSINESS_ACTION_V1.reduce(
      makeRun(initialState(), { definitionVersion: 2 }),
      stageCommand(),
      makeContext(),
    );
    expect(!wrongVersion.ok && 'error' in wrongVersion && wrongVersion.error).toEqual({
      code: 'invalid_command',
      reason: 'definition_version_mismatch',
    });
  });
});

// ---------------------------------------------------------------------------
// Parcours nominal
// ---------------------------------------------------------------------------

describe('single_business_action@1 — parcours nominal', () => {
  it('stage_proposal digère la proposition, pose le wake TTL et attend l’écran (screen_ack requis)', () => {
    const { transition } = step(makeRun(initialState()), stageCommand(), { commandId: CMD_STAGE });
    expect(transition.postimage.status).toBe('waiting_screen');
    expect(transition.event.type).toBe('sba_proposal_staged');
    expect(transition.event.version).toBe(1);
    expect(transition.workItemIntents).toEqual([]);
    expect(transition.wakes).toEqual([
      { wakeId: TTL_WAKE_ID, kind: 'confirmation_ttl', dueAt: EXPIRES_AT },
    ]);
    expect(transition.postimage.revision).toBe(1);
    const state = postState(transition);
    expect(state.phase).toBe('awaiting_confirmation');
    expect(state.proposal).toMatchObject({
      proposalId: PROPOSAL_ID,
      proposalCommandId: CMD_STAGE,
      canonicalInputDigest: DIGEST_INPUT,
      proposalHash: PROPOSAL_HASH,
      status: 'issued',
      issuedAt: T0,
      expiresAt: EXPIRES_AT,
      ttlWakeId: TTL_WAKE_ID,
    });
    if (transition.postimage.kind === 'single_business_action') {
      expect(transition.postimage.nextWakeAt).toBe(EXPIRES_AT);
      expect(transition.postimage.terminalAt).toBeNull();
    }
  });

  it('record_presentation_ack fait passer issued -> presented (§7.1) et le run attend l’humain', () => {
    const current = step(makeRun(initialState()), stageCommand()).run;
    const { transition } = step(
      current,
      { type: 'record_presentation_ack', proposalId: PROPOSAL_ID, ack: 'screen_ack' },
      { occurredAt: '2026-08-18T10:00:30.000Z' },
    );
    expect(transition.postimage.status).toBe('waiting_user');
    expect(transition.event.type).toBe('sba_presentation_acknowledged');
    const state = postState(transition);
    expect(state.proposal).toMatchObject({
      status: 'presented',
      presentedAt: '2026-08-18T10:00:30.000Z',
      presentationAck: 'screen_ack',
    });
  });

  it('confirm consomme one-shot et émet UN intent avec l’effectId préalloué serveur', () => {
    const { confirm } = driveToCommitting();
    expect(confirm.postimage.status).toBe('waiting_external');
    expect(confirm.event.type).toBe('sba_confirmed');
    expect(confirm.releasedForegroundLease).toBe(true);
    expect(confirm.workItemIntents).toHaveLength(1);
    expect(confirm.workItemIntents[0]).toEqual({
      effectId: EFFECT_ID,
      actionId: 'client-creer',
      actionVersion: 1,
      authorizationSource: { source: 'confirmation', receiptId: CMD_CONFIRM },
      actingPrincipalId: USER_ID,
      targetDigest: TARGET_DIGEST,
      payloadRef: { 'payload-ref': 'staging-42' },
      executeBy: '2026-08-18T10:16:00.000Z', // occurredAt confirm + executeWindowMs
    });
    expect(confirm.wakes).toEqual([]);
    const state = postState(confirm);
    expect(state.phase).toBe('committing');
    expect(state.proposal).toMatchObject({ status: 'consumed', consumedByCommandId: CMD_CONFIRM });
    expect(state.effect).toMatchObject({ effectId: EFFECT_ID, submittedJobRef: null, outcome: null });
  });

  it('record_effect_receipt submitted -> awaiting_receipt puis succeeded -> completed (terminal figé)', () => {
    const { run } = driveToCommitting();
    const submitted = step(
      run,
      {
        type: 'record_effect_receipt',
        effectId: EFFECT_ID,
        receipt: { kind: 'submitted', jobRef: 'outbox-job-7' },
      },
      { commandId: CMD_SUBMITTED },
    );
    expect(submitted.transition.postimage.status).toBe('waiting_external');
    expect(postState(submitted.transition).phase).toBe(
      'awaiting_receipt',
    );

    const done = step(
      submitted.run,
      {
        type: 'record_effect_receipt',
        effectId: EFFECT_ID,
        receipt: { kind: 'succeeded', resultDigest: RESULT_DIGEST },
      },
      { commandId: CMD_SUCCEEDED, occurredAt: '2026-08-18T10:02:00.000Z' },
    );
    expect(done.transition.postimage.status).toBe('completed');
    expect(done.transition.event.type).toBe('sba_effect_succeeded');
    if (done.transition.postimage.kind === 'single_business_action') {
      expect(done.transition.postimage.terminalAt).toBe('2026-08-18T10:02:00.000Z');
    }
    expect(postState(done.transition).effect).toMatchObject({
      outcome: 'succeeded',
      resultDigest: RESULT_DIGEST,
    });
  });

  it('un reçu failed_terminal hors annulation termine le run en failed_terminal (jamais `expired`)', () => {
    const { run } = driveToCommitting();
    const failed = step(run, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'failed_terminal', failureDigest: FAILURE_DIGEST },
    });
    expect(failed.transition.postimage.status).toBe('failed_terminal');
    expect(failed.transition.event.type).toBe('sba_effect_failed');
  });
});

// ---------------------------------------------------------------------------
// One-shot §7.1
// ---------------------------------------------------------------------------

describe('single_business_action@1 — confirmation one-shot §7.1', () => {
  it('replay : même état + même commande + même contexte = même résultat (pureté)', () => {
    const base = makeRun(initialState());
    const staged = step(base, stageCommand()).run;
    const acked = step(staged, {
      type: 'record_presentation_ack',
      proposalId: PROPOSAL_ID,
      ack: 'screen_ack',
    }).run;
    const command = { type: 'confirm', proposalId: PROPOSAL_ID, proposalHash: PROPOSAL_HASH };
    const context = makeContext({ commandId: CMD_CONFIRM, expectedRevision: acked.revision });
    const first = SINGLE_BUSINESS_ACTION_V1.reduce(acked, command, context);
    const replayed = SINGLE_BUSINESS_ACTION_V1.reduce(acked, command, context);
    expect(replayed).toEqual(first);
  });

  it('confirm après consommation par un AUTRE commandId = conflit — jamais un second intent', () => {
    const { run } = driveToCommitting();
    const error = expectSbaError(
      SINGLE_BUSINESS_ACTION_V1.reduce(
        run,
        { type: 'confirm', proposalId: PROPOSAL_ID, proposalHash: PROPOSAL_HASH },
        makeContext({ commandId: CMD_OTHER, expectedRevision: run.revision }),
      ),
    );
    expect(error).toEqual({
      code: 'single_business_action_confirmation_conflict',
      reason: 'already_consumed',
    });
  });

  it('confirm rejoué avec le MÊME commandId sur l’état consommé est signalé distinctement', () => {
    const { run } = driveToCommitting();
    const error = expectSbaError(
      SINGLE_BUSINESS_ACTION_V1.reduce(
        run,
        { type: 'confirm', proposalId: PROPOSAL_ID, proposalHash: PROPOSAL_HASH },
        makeContext({ commandId: CMD_CONFIRM, expectedRevision: run.revision }),
      ),
    );
    expect(error).toEqual({
      code: 'single_business_action_confirmation_conflict',
      reason: 'already_consumed_same_command',
    });
  });

  it('confirm exige presented : issued -> not_presented ; hash divergent -> conflit', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    expect(
      expectSbaError(
        SINGLE_BUSINESS_ACTION_V1.reduce(
          staged,
          { type: 'confirm', proposalId: PROPOSAL_ID, proposalHash: PROPOSAL_HASH },
          makeContext({ expectedRevision: staged.revision }),
        ),
      ),
    ).toMatchObject({ reason: 'not_presented' });

    const acked = step(staged, {
      type: 'record_presentation_ack',
      proposalId: PROPOSAL_ID,
      ack: 'screen_ack',
    }).run;
    expect(
      expectSbaError(
        SINGLE_BUSINESS_ACTION_V1.reduce(
          acked,
          { type: 'confirm', proposalId: PROPOSAL_ID, proposalHash: 'f'.repeat(64) },
          makeContext({ expectedRevision: acked.revision }),
        ),
      ),
    ).toMatchObject({ reason: 'proposal_hash_mismatch' });
  });

  it('screen_ack obligatoire : la voix ne fait JAMAIS atteindre presented (§7.1)', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    expect(
      expectSbaError(
        SINGLE_BUSINESS_ACTION_V1.reduce(
          staged,
          { type: 'record_presentation_ack', proposalId: PROPOSAL_ID, ack: 'voice_presentation_ack' },
          makeContext({ expectedRevision: staged.revision }),
        ),
      ),
    ).toMatchObject({ reason: 'ack_channel_insufficient' });
  });

  it('confirm sans effectId préalloué est refusé (l’admission alloue, jamais le domaine)', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    const acked = step(staged, {
      type: 'record_presentation_ack',
      proposalId: PROPOSAL_ID,
      ack: 'screen_ack',
    }).run;
    expect(
      expectSbaError(
        SINGLE_BUSINESS_ACTION_V1.reduce(
          acked,
          { type: 'confirm', proposalId: PROPOSAL_ID, proposalHash: PROPOSAL_HASH },
          makeContext({ expectedRevision: acked.revision, allocatedEffectIds: [] }),
        ),
      ),
    ).toEqual({ code: 'single_business_action_effect_conflict', reason: 'effect_id_not_allocated' });
  });
});

// ---------------------------------------------------------------------------
// Invalidation jamais rétroactive
// ---------------------------------------------------------------------------

describe('single_business_action@1 — invalidation §7.1', () => {
  it('invalide une proposition pendante puis autorise un re-stage', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    const invalidated = step(staged, {
      type: 'invalidate_proposal',
      proposalId: PROPOSAL_ID,
      reason: 'target_mutated',
    });
    expect(invalidated.transition.event.type).toBe('sba_proposal_invalidated');
    expect(invalidated.transition.postimage.status).toBe('active');
    expect(invalidated.transition.wakes).toEqual([]);
    const state = postState(invalidated.transition);
    expect(state.phase).toBe('preparing');
    expect(state.proposal).toMatchObject({ status: 'invalidated', invalidationReason: 'target_mutated' });

    const restaged = step(invalidated.run, stageCommand({ proposalId: PROPOSAL_ID_2 }));
    expect(postState(restaged.transition).proposal).toMatchObject({
      proposalId: PROPOSAL_ID_2,
      status: 'issued',
    });
  });

  it("n'invalide JAMAIS rétroactivement une proposition consommée", () => {
    const { run } = driveToCommitting();
    const error = expectSbaError(
      SINGLE_BUSINESS_ACTION_V1.reduce(
        run,
        { type: 'invalidate_proposal', proposalId: PROPOSAL_ID, reason: 'target_mutated' },
        makeContext({ expectedRevision: run.revision }),
      ),
    );
    expect(error).toEqual({
      code: 'single_business_action_confirmation_conflict',
      reason: 'already_consumed',
    });
    // Le state n'a pas bougé : la proposition reste consommée, l'effet reste engagé.
    expect((run.state as SingleBusinessActionStateV1).proposal?.status).toBe('consumed');
  });

  it('une proposition invalidée ou rejetée ne se confirme plus (not_pending / transition)', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    const rejected = step(staged, { type: 'reject', proposalId: PROPOSAL_ID });
    expect(rejected.transition.event.type).toBe('sba_proposal_rejected');
    const result = SINGLE_BUSINESS_ACTION_V1.reduce(
      rejected.run,
      { type: 'confirm', proposalId: PROPOSAL_ID, proposalHash: PROPOSAL_HASH },
      makeContext({ expectedRevision: rejected.run.revision }),
    );
    expect(expectSbaError(result).code).toBe('single_business_action_invalid_transition');
  });
});

// ---------------------------------------------------------------------------
// TTL et réveils
// ---------------------------------------------------------------------------

describe('single_business_action@1 — TTL et wake_run', () => {
  it('le wake TTL expire la proposition pendante et rend le run à preparing sans réveil pendant', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    const woken = step(
      staged,
      { type: 'wake_run', wakeId: TTL_WAKE_ID },
      { occurredAt: '2026-08-18T10:06:00.000Z' },
    );
    expect(woken.transition.event.type).toBe('sba_proposal_expired');
    expect(woken.transition.postimage.status).toBe('active');
    expect(woken.transition.wakes).toEqual([]);
    if (woken.transition.postimage.kind === 'single_business_action') {
      expect(woken.transition.postimage.nextWakeAt).toBeNull();
    }
    expect(postState(woken.transition).proposal).toMatchObject({
      status: 'expired',
    });
  });

  it('un wakeId inconnu est un no-op STRICT (§5.1) : audité, postimage inchangée, révision inchangée', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    const first = step(staged, { type: 'wake_run', wakeId: 'sba-confirmation-ttl:perime' });
    expect(first.transition.event.type).toBe('sba_wake_ignored');
    // Postimage STRICTEMENT inchangée : le scanner ne fait JAMAIS avancer le CAS du run —
    // sinon toute commande interactive concurrente perdrait son expectedRevision.
    expect(first.transition.postimage).toBe(staged);
    expect(first.transition.postimage.revision).toBe(staged.revision);
    expect(first.transition.workItemIntents).toEqual([]);
    expect(first.transition.releasedForegroundLease).toBe(false);
    expect(first.transition.wakes).toEqual([
      { wakeId: TTL_WAKE_ID, kind: 'confirmation_ttl', dueAt: EXPIRES_AT },
    ]);
    const second = step(first.run, { type: 'wake_run', wakeId: 'sba-confirmation-ttl:perime' });
    expect(second.transition.event.type).toBe('sba_wake_ignored');
    expect(second.transition.postimage).toBe(staged);
  });

  it('un wake TTL PRÉMATURÉ n’expire jamais la proposition — no-op strict ; à l’échéance il expire', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    // AVANT expiresAt : le bon wakeId ne suffit pas — l'instant d'admission fait foi (§7.1).
    const premature = step(
      staged,
      { type: 'wake_run', wakeId: TTL_WAKE_ID },
      { occurredAt: '2026-08-18T10:04:59.999Z' },
    );
    expect(premature.transition.event.type).toBe('sba_wake_ignored');
    expect(premature.transition.postimage).toBe(staged);
    expect(postState(premature.transition).proposal).toMatchObject({ status: 'issued' });
    expect(premature.transition.wakes).toEqual([
      { wakeId: TTL_WAKE_ID, kind: 'confirmation_ttl', dueAt: EXPIRES_AT },
    ]);
    // À l'échéance exacte (occurredAt === expiresAt) : le wake expire la proposition.
    const due = step(staged, { type: 'wake_run', wakeId: TTL_WAKE_ID }, { occurredAt: EXPIRES_AT });
    expect(due.transition.event.type).toBe('sba_proposal_expired');
    expect(due.transition.postimage.revision).toBe(staged.revision + 1);
    expect(postState(due.transition).proposal).toMatchObject({ status: 'expired' });
  });

  it('confirm et ACK après expiresAt sont refusés (`fresh` §7.1) — le wake reste l’expirateur', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    expect(
      expectSbaError(
        SINGLE_BUSINESS_ACTION_V1.reduce(
          staged,
          { type: 'record_presentation_ack', proposalId: PROPOSAL_ID, ack: 'screen_ack' },
          makeContext({ expectedRevision: staged.revision, occurredAt: EXPIRES_AT }),
        ),
      ),
    ).toMatchObject({ reason: 'expired' });

    const acked = step(staged, {
      type: 'record_presentation_ack',
      proposalId: PROPOSAL_ID,
      ack: 'screen_ack',
    }).run;
    expect(
      expectSbaError(
        SINGLE_BUSINESS_ACTION_V1.reduce(
          acked,
          { type: 'confirm', proposalId: PROPOSAL_ID, proposalHash: PROPOSAL_HASH },
          makeContext({ expectedRevision: acked.revision, occurredAt: '2026-08-18T11:00:00.000Z' }),
        ),
      ),
    ).toMatchObject({ reason: 'expired' });
  });

  it('borne maxWakes : le cinquième stage_proposal est refusé', () => {
    let current = makeRun(initialState());
    const proposalIds = [
      PROPOSAL_ID,
      PROPOSAL_ID_2,
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    for (const proposalId of proposalIds) {
      current = step(current, stageCommand({ proposalId })).run;
      current = step(
        current,
        { type: 'wake_run', wakeId: `sba-confirmation-ttl:${proposalId}` },
        { occurredAt: '2026-08-18T10:06:00.000Z' },
      ).run;
    }
    const fifth = SINGLE_BUSINESS_ACTION_V1.reduce(
      current,
      stageCommand({ proposalId: '55555555-5555-4555-8555-555555555555' }),
      makeContext({ expectedRevision: current.revision }),
    );
    expect(expectSbaError(fifth)).toEqual({
      code: 'single_business_action_limit_exceeded',
      limit: 'max_wakes',
    });
  });
});

// ---------------------------------------------------------------------------
// Annulation : franche avant autorisation, observatrice après (§5.3)
// ---------------------------------------------------------------------------

describe('single_business_action@1 — cancel_run', () => {
  it('cancel AVANT autorisation : run cancelled terminal, proposition pendante invalidée', () => {
    const staged = step(makeRun(initialState()), stageCommand()).run;
    const cancelled = step(
      staged,
      { type: 'cancel_run', reason: 'user_cancelled' },
      { occurredAt: '2026-08-18T10:03:00.000Z' },
    );
    expect(cancelled.transition.postimage.status).toBe('cancelled');
    expect(cancelled.transition.event.type).toBe('sba_run_cancelled');
    expect(cancelled.transition.releasedForegroundLease).toBe(true);
    expect(cancelled.transition.workItemIntents).toEqual([]);
    if (cancelled.transition.postimage.kind === 'single_business_action') {
      expect(cancelled.transition.postimage.terminalAt).toBe('2026-08-18T10:03:00.000Z');
    }
    const state = postState(cancelled.transition);
    expect(state.phase).toBe('cancelled');
    expect(state.proposal).toMatchObject({
      status: 'invalidated',
      invalidationReason: 'authorization_revoked',
    });
  });

  it('cancel APRÈS autorisation : cancelling NON terminal qui OBSERVE — jamais prétendre annulé', () => {
    const { run } = driveToCommitting();
    const cancelling = step(run, { type: 'cancel_run', reason: 'user_cancelled' });
    expect(cancelling.transition.postimage.status).toBe('cancelling');
    expect(cancelling.transition.event.type).toBe('sba_run_cancelling');
    expect(cancelling.transition.releasedForegroundLease).toBe(true);
    if (cancelling.transition.postimage.kind === 'single_business_action') {
      expect(cancelling.transition.postimage.terminalAt).toBeNull();
    }
    expect(JARVIS_RUN_TERMINAL_STATUSES.has(cancelling.transition.postimage.status)).toBe(false);

    const again = SINGLE_BUSINESS_ACTION_V1.reduce(
      cancelling.run,
      { type: 'cancel_run', reason: 'user_cancelled' },
      makeContext({ expectedRevision: cancelling.run.revision }),
    );
    expect(expectSbaError(again)).toEqual({
      code: 'single_business_action_cancel_conflict',
      reason: 'already_cancelling',
    });
  });

  it('cancelling + reçu failed_terminal => cancelled honnête (rien n’est parti), reçu conservé', () => {
    const { run } = driveToCommitting();
    const cancelling = step(run, { type: 'cancel_run', reason: 'user_cancelled' }).run;
    const observed = step(cancelling, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'failed_terminal', failureDigest: FAILURE_DIGEST },
    });
    expect(observed.transition.postimage.status).toBe('cancelled');
    expect(observed.transition.event.type).toBe('sba_effect_failed');
    expect(observed.transition.event.data['cancellationRequested']).toBe(true);
    const state = postState(observed.transition);
    expect(state.effect).toMatchObject({ outcome: 'failed', resultDigest: FAILURE_DIGEST });
  });

  it('cancelling + reçu succeeded => completed : un succès externe n’est JAMAIS masqué (§5.3)', () => {
    const { run } = driveToCommitting();
    const cancelling = step(run, { type: 'cancel_run', reason: 'user_cancelled' }).run;
    const observed = step(cancelling, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'succeeded', resultDigest: RESULT_DIGEST },
    });
    expect(observed.transition.postimage.status).toBe('completed');
    expect(observed.transition.event.type).toBe('sba_effect_succeeded');
    expect(observed.transition.event.data['cancellationRequested']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reçus d'effet : idempotence liée à l'effectId du state
// ---------------------------------------------------------------------------

describe('single_business_action@1 — record_effect_receipt', () => {
  it('refuse tout effectId qui n’est pas celui du state, sans mutation', () => {
    const { run } = driveToCommitting();
    const error = expectSbaError(
      SINGLE_BUSINESS_ACTION_V1.reduce(
        run,
        {
          type: 'record_effect_receipt',
          effectId: 'effect-intrus',
          receipt: { kind: 'succeeded', resultDigest: RESULT_DIGEST },
        },
        makeContext({ expectedRevision: run.revision }),
      ),
    );
    expect(error).toEqual({
      code: 'single_business_action_effect_conflict',
      reason: 'unknown_effect_id',
    });
  });

  it('re-soumission du même jobRef = no-op explicite audité ; jobRef divergent = conflit', () => {
    const { run } = driveToCommitting();
    const submitted = step(run, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'submitted', jobRef: 'outbox-job-7' },
    });
    const replayed = step(submitted.run, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'submitted', jobRef: 'outbox-job-7' },
    });
    expect(replayed.transition.event.type).toBe('sba_effect_receipt_deduplicated');
    expect(postState(replayed.transition)).toEqual(submitted.run.state);

    const divergent = SINGLE_BUSINESS_ACTION_V1.reduce(
      replayed.run,
      {
        type: 'record_effect_receipt',
        effectId: EFFECT_ID,
        receipt: { kind: 'submitted', jobRef: 'outbox-job-8' },
      },
      makeContext({ expectedRevision: replayed.run.revision }),
    );
    expect(expectSbaError(divergent)).toEqual({
      code: 'single_business_action_effect_conflict',
      reason: 'job_ref_mismatch',
    });
  });

  it('sans effet engagé, un reçu est une transition invalide', () => {
    const result = SINGLE_BUSINESS_ACTION_V1.reduce(
      makeRun(initialState()),
      {
        type: 'record_effect_receipt',
        effectId: EFFECT_ID,
        receipt: { kind: 'succeeded', resultDigest: RESULT_DIGEST },
      },
      makeContext(),
    );
    expect(expectSbaError(result).code).toBe('single_business_action_invalid_transition');
  });
});

// ---------------------------------------------------------------------------
// Gardes racine : CAS, terminal figé, bornes
// ---------------------------------------------------------------------------

describe('single_business_action@1 — gardes', () => {
  it('CAS : expectedRevision divergente => revision_conflict typé sans postimage', () => {
    const run = makeRun(initialState(), { revision: 3 });
    const result = SINGLE_BUSINESS_ACTION_V1.reduce(
      run,
      stageCommand(),
      makeContext({ expectedRevision: 2 }),
    );
    expect(!result.ok && 'error' in result && result.error).toEqual({
      code: 'revision_conflict',
      expectedRevision: 2,
      actualRevision: 3,
    });
  });

  it('terminal figé : plus AUCUNE transition après completed/cancelled/failed_terminal', () => {
    const { run } = driveToCommitting();
    const completed = step(run, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'succeeded', resultDigest: RESULT_DIGEST },
    }).run;
    const commands: readonly unknown[] = [
      stageCommand({ proposalId: PROPOSAL_ID_2 }),
      { type: 'cancel_run', reason: 'user_cancelled' },
      { type: 'wake_run', wakeId: TTL_WAKE_ID },
      {
        type: 'record_effect_receipt',
        effectId: EFFECT_ID,
        receipt: { kind: 'succeeded', resultDigest: RESULT_DIGEST },
      },
    ];
    for (const command of commands) {
      const result = SINGLE_BUSINESS_ACTION_V1.reduce(
        completed,
        command,
        makeContext({ expectedRevision: completed.revision }),
      );
      expect(!result.ok && 'error' in result && result.error).toEqual({
        code: 'run_terminal',
        status: 'completed',
      });
    }
  });

  it('budget maxSteps épuisé : tout est refusé SAUF cancel_run et record_effect_receipt (§5.3)', () => {
    const exhausted: SingleBusinessActionStateV1 = { ...initialState(), stepCount: 32 };
    const run = makeRun(exhausted);
    expect(expectSbaError(SINGLE_BUSINESS_ACTION_V1.reduce(run, stageCommand(), makeContext()))).toEqual(
      { code: 'single_business_action_limit_exceeded', limit: 'max_steps' },
    );
    // record_effect_receipt franchit la garde de budget : ici sans effet engagé il tombe sur la
    // transition invalide (preuve qu'il atteint le switch), jamais sur limit_exceeded.
    const receiptWithoutEffect = SINGLE_BUSINESS_ACTION_V1.reduce(
      run,
      {
        type: 'record_effect_receipt',
        effectId: EFFECT_ID,
        receipt: { kind: 'succeeded', resultDigest: RESULT_DIGEST },
      },
      makeContext(),
    );
    expect(expectSbaError(receiptWithoutEffect).code).toBe('single_business_action_invalid_transition');
    const cancelled = step(run, { type: 'cancel_run', reason: 'manual_handoff' });
    expect(cancelled.transition.postimage.status).toBe('cancelled');
  });

  it('budget épuisé en attente de reçu : le reçu d’un effet possiblement parti reste observable (§5.3)', () => {
    const { run } = driveToCommitting();
    const exhaustedState: SingleBusinessActionStateV1 = {
      ...(run.state as SingleBusinessActionStateV1),
      stepCount: SINGLE_BUSINESS_ACTION_LIMITS.maxSteps,
    };
    const exhausted: SbaRun = { ...run, state: exhaustedState };
    const done = step(exhausted, {
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'succeeded', resultDigest: RESULT_DIGEST },
    });
    expect(done.transition.postimage.status).toBe('completed');
    expect(done.transition.event.type).toBe('sba_effect_succeeded');
  });

  it('contexte d’admission non canonique refusé à l’entrée (§5.4) : commandId non-UUID, occurredAt non round-trip', () => {
    const run = makeRun(initialState());
    const badCommandId = SINGLE_BUSINESS_ACTION_V1.reduce(
      run,
      stageCommand(),
      makeContext({ commandId: 'cmd-1' }),
    );
    expect(!badCommandId.ok && 'error' in badCommandId && badCommandId.error).toEqual({
      code: 'invalid_command',
      reason: 'invalid_value',
    });
    // Parseable mais non canonique (round-trip toISOString divergent) : refusé aussi.
    const badInstant = SINGLE_BUSINESS_ACTION_V1.reduce(
      run,
      stageCommand(),
      makeContext({ occurredAt: '2026-08-18T10:00:00Z' }),
    );
    expect(!badInstant.ok && 'error' in badInstant && badInstant.error).toEqual({
      code: 'invalid_command',
      reason: 'invalid_value',
    });
  });

  it('state borné : un payloadRef qui ferait déborder maxStateBytes est refusé', () => {
    const hugePayloadRef: Record<string, string> = {};
    for (let index = 0; index < 600; index++) {
      hugePayloadRef[`ref-${String(index).padStart(4, '0')}`] = 'x'.repeat(120);
    }
    const result = SINGLE_BUSINESS_ACTION_V1.reduce(
      makeRun(initialState()),
      stageCommand({ payloadRef: hugePayloadRef }),
      makeContext(),
    );
    expect(expectSbaError(result)).toEqual({
      code: 'single_business_action_limit_exceeded',
      limit: 'max_state_bytes',
    });
  });

  it('un state corrompu (clé en trop, schéma inconnu) est refusé — jamais toléré', () => {
    const valid = initialState();
    expect(parseSingleBusinessActionState({ ...valid, intrus: true }).ok).toBe(false);
    expect(parseSingleBusinessActionState({ ...valid, schema: 'bob.autre' }).ok).toBe(false);
    expect(parseSingleBusinessActionState(valid).ok).toBe(true);
    const corrupted: SbaRun = { ...makeRun(valid), state: { ...valid, intrus: true } };
    const result = SINGLE_BUSINESS_ACTION_V1.reduce(corrupted, stageCommand(), makeContext());
    expect(expectSbaError(result).code).toBe('single_business_action_invalid_state');
  });

  it("initialSingleBusinessActionState refuse une action non canonique", () => {
    expect(initialSingleBusinessActionState({ actionId: ' devis ', actionVersion: 1 }).ok).toBe(false);
    expect(initialSingleBusinessActionState({ actionId: 'client-creer', actionVersion: 0 }).ok).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Property test : ≤ 1 effet mutant par run, unions fermées, state toujours valide
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prngHex(random: () => number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index++) {
    out += '0123456789abcdef'[Math.floor(random() * 16)];
  }
  return out;
}

function prngUuid(random: () => number): string {
  return `${prngHex(random, 8)}-${prngHex(random, 4)}-4${prngHex(random, 3)}-8${prngHex(random, 3)}-${prngHex(random, 12)}`;
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

/** commandId UUID canonique déterministe par (seed, index) — la garde §5.4 exige un UUID. */
function commandUuid(seed: number, index: number): string {
  return `${seed.toString(16).padStart(8, '0')}-${index.toString(16).padStart(4, '0')}-4000-8000-000000000000`;
}

/** Génère une commande plausible pour la phase courante — 30 % de bruit arbitraire. */
function generateCommand(
  random: () => number,
  state: SingleBusinessActionStateV1,
): SingleBusinessActionCommand {
  const noise = random() < 0.3;
  const proposalId = state.proposal?.proposalId ?? prngUuid(random);
  const effectId = state.effect?.effectId ?? `effect-${prngHex(random, 8)}`;
  const anyCommand = (): SingleBusinessActionCommand =>
    pick<SingleBusinessActionCommand>(random, [
      {
        type: 'stage_proposal',
        proposalId: prngUuid(random),
        canonicalInputDigest: prngHex(random, 64),
        proposalHash: prngHex(random, 64),
        presentationRequirement: pick(random, ['screen_ack', 'voice_presentation_ack'] as const),
        targetDigest: null,
        payloadRef: null,
        confirmationTtlMs: TTL_MS,
        executeWindowMs: EXEC_MS,
      },
      { type: 'record_presentation_ack', proposalId, ack: pick(random, ['screen_ack', 'voice_presentation_ack'] as const) },
      { type: 'confirm', proposalId, proposalHash: state.proposal?.proposalHash ?? prngHex(random, 64) },
      { type: 'reject', proposalId },
      { type: 'invalidate_proposal', proposalId, reason: 'target_mutated' },
      {
        type: 'record_effect_receipt',
        effectId,
        receipt: pick(random, [
          { kind: 'submitted', jobRef: `job-${prngHex(random, 6)}` },
          { kind: 'succeeded', resultDigest: prngHex(random, 64) },
          { kind: 'failed_terminal', failureDigest: prngHex(random, 64) },
        ] as const),
      },
      { type: 'cancel_run', reason: 'user_cancelled' },
      { type: 'wake_run', wakeId: state.proposal?.ttlWakeId ?? `sba-confirmation-ttl:${prngUuid(random)}` },
    ]);
  if (noise) return anyCommand();
  switch (state.phase) {
    case 'preparing':
      return {
        type: 'stage_proposal',
        proposalId: prngUuid(random),
        canonicalInputDigest: prngHex(random, 64),
        proposalHash: prngHex(random, 64),
        presentationRequirement: pick(random, ['screen_ack', 'voice_presentation_ack'] as const),
        targetDigest: random() < 0.5 ? prngHex(random, 64) : null,
        payloadRef: random() < 0.5 ? { [`ref-${prngHex(random, 4)}`]: prngHex(random, 8) } : null,
        confirmationTtlMs: TTL_MS,
        executeWindowMs: EXEC_MS,
      };
    case 'awaiting_confirmation':
      if (state.proposal?.status === 'issued') {
        return {
          type: 'record_presentation_ack',
          proposalId,
          ack: state.proposal.presentationRequirement,
        };
      }
      return { type: 'confirm', proposalId, proposalHash: state.proposal?.proposalHash ?? prngHex(random, 64) };
    case 'committing':
      return {
        type: 'record_effect_receipt',
        effectId,
        receipt: pick(random, [
          { kind: 'submitted', jobRef: `job-${prngHex(random, 6)}` },
          { kind: 'succeeded', resultDigest: prngHex(random, 64) },
        ] as const),
      };
    case 'awaiting_receipt':
    case 'cancelling':
      return {
        type: 'record_effect_receipt',
        effectId,
        receipt: pick(random, [
          { kind: 'succeeded', resultDigest: prngHex(random, 64) },
          { kind: 'failed_terminal', failureDigest: prngHex(random, 64) },
        ] as const),
      };
    case 'completed':
    case 'failed_terminal':
    case 'cancelled':
      return anyCommand();
  }
}

describe('single_business_action@1 — property : ≤ 1 effet mutant par séquence arbitraire', () => {
  // Même marge CI que le property test customer-contact (runner plus lent qu'en local).
  it('120 séquences × 40 commandes : au plus un intent, toujours le premier effectId serveur', { timeout: 60_000 }, () => {
    for (let seed = 1; seed <= 120; seed++) {
      const random = mulberry32(seed);
      let run: SbaRun = makeRun(initialState());
      let clockMs = Date.parse(T0);
      const allocatedEffectId = `effect-seed-${seed}`;
      let transitionsWithIntents = 0;
      const emittedEffectIds = new Set<string>();

      for (let index = 0; index < 40; index++) {
        clockMs += 1_000 + Math.floor(random() * 30_000);
        if (random() < 0.05) clockMs += 6 * 60 * 60 * 1_000; // saut → expirations TTL
        const parsed = parseSingleBusinessActionState(run.state);
        if (!parsed.ok) throw new Error('state courant invalide — invariant rompu');
        const command = generateCommand(random, parsed.value);
        const context = makeContext({
          commandId: commandUuid(seed, index),
          expectedRevision: run.revision,
          occurredAt: new Date(clockMs).toISOString(),
          allocatedEffectIds: [allocatedEffectId],
        });
        const result = SINGLE_BUSINESS_ACTION_V1.reduce(run, command, context);
        if (result.ok) {
          const { postimage, workItemIntents, wakes } = result.value;
          // Union §5.1 fermée, jamais de statut hors liste ; terminal ⇔ terminalAt posé.
          expect(JARVIS_RUN_STATUSES).toContain(postimage.status);
          if (postimage.kind === 'single_business_action') {
            expect(postimage.terminalAt !== null).toBe(
              JARVIS_RUN_TERMINAL_STATUSES.has(postimage.status),
            );
            expect(postimage.nextWakeAt).toBe(deriveNextWakeAt(wakes));
            expect(jsonUtf8Fits(postimage.state, SINGLE_BUSINESS_ACTION_LIMITS.maxStateBytes)).toBe(
              true,
            );
            expect(parseSingleBusinessActionState(postimage.state).ok).toBe(true);
          }
          // Un wake ignoré est un no-op STRICT (§5.1) : postimage inchangée, révision inchangée ;
          // toute autre transition acceptée avance le CAS d'exactement 1.
          if (result.value.event.type === 'sba_wake_ignored') {
            expect(postimage).toBe(run);
          } else {
            expect(postimage.revision).toBe(run.revision + 1);
          }
          expect(workItemIntents.length).toBeLessThanOrEqual(
            SINGLE_BUSINESS_ACTION_LIMITS.maxOpenWorkItems,
          );
          if (workItemIntents.length > 0) {
            transitionsWithIntents += 1;
            for (const intent of workItemIntents) {
              emittedEffectIds.add(intent.effectId);
              expect(intent.effectId).toBe(allocatedEffectId);
              expect(intent.authorizationSource).toEqual({
                source: 'confirmation',
                receiptId: context.commandId,
              });
            }
          }
          run = postimage as SbaRun;
        } else if ('error' in result) {
          // Erreurs fermées : racine typée, ou union SBA embarquée — jamais autre chose.
          if (result.error.code === 'delegated_error') {
            expect(isSingleBusinessActionError(result.error.error)).toBe(true);
          } else {
            expect(['run_terminal', 'revision_conflict', 'invalid_command']).toContain(
              result.error.code,
            );
          }
        } else {
          throw new Error('quarantaine inattendue pour une définition enregistrée');
        }
      }

      // ≤ 1 effet mutant par run, quel que soit l'ordre des commandes (§4.3).
      expect(transitionsWithIntents).toBeLessThanOrEqual(1);
      expect(emittedEffectIds.size).toBeLessThanOrEqual(1);
    }
  });
});
