/**
 * Reducer racine JarvisRun (spec §4.3) — OSMOSE avec l'agrégat AgentMission : la branche
 * quote_creation DÉLÈGUE (mêmes postimages, mêmes événements), les commandes interactives
 * restent à la route legacy jusqu'au cutover §17.1, l'inconnu part en quarantaine §5.5
 * sans effet, jamais en comportement par défaut.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_MISSION_KIND,
  AgentMission,
  type AgentMissionResult,
  type AgentMissionSnapshot,
} from './agent-mission';
import {
  projectQuoteMissionEnvelope,
  type JarvisRunEnvelope,
  type JarvisWake,
} from './jarvis-run';
import {
  finalizeJarvisPendingWakes,
  normalizeJarvisDefinitionReduction,
  reduceJarvisRun,
  resolveJarvisDefinition,
  type JarvisDefinitionModule,
  type JarvisReduceContext,
  type JarvisReduceError,
  type JarvisReduceResult,
  type JarvisRunTransition,
} from './jarvis-run-reducer';

const MISSION_ID = '00000000-0000-4000-8000-0000000000b1';
const COMMAND_ID = '00000000-0000-4000-8000-0000000000b2';
const RUN_ID = '00000000-0000-4000-8000-0000000000b3';
const CREATED_AT = '2026-08-18T10:00:00.000Z';
/** Version jamais enregistrée dans le registre gelé — stable même quand U2+ enregistrera v1. */
const UNKNOWN_DEFINITION_VERSION = 999;

function at(minutes: number): string {
  return new Date(Date.parse(CREATED_AT) + minutes * 60_000).toISOString();
}

function value<T>(result: AgentMissionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function startedSnapshot(): AgentMissionSnapshot {
  return value(
    AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution: null,
      startOutcome: 'no_slot',
      draft: { sessionId: 'quote-session-1', slotRevision: 1, contentRevision: 0 },
    }),
  ).mission.toSnapshot();
}

function context(occurredAt: string, expectedRevision = 1): JarvisReduceContext {
  return {
    commandId: COMMAND_ID,
    expectedRevision,
    occurredAt,
    actingPrincipalId: 'owner-1',
    allocatedEffectIds: [],
  };
}

function transitionOf(result: JarvisReduceResult): JarvisRunTransition {
  if (!result.ok) throw new Error(`réduction refusée: ${JSON.stringify(result)}`);
  return result.value;
}

function errorOf(result: JarvisReduceResult): JarvisReduceError {
  if (result.ok) throw new Error('réduction acceptée alors qu’une erreur était attendue');
  if (!('error' in result)) throw new Error(`quarantaine inattendue: ${JSON.stringify(result)}`);
  return result.error;
}

function quarantineOf(result: JarvisReduceResult): {
  readonly kind: string;
  readonly definitionVersion: number;
} {
  if (result.ok) throw new Error('réduction acceptée alors qu’une quarantaine était attendue');
  if (!('quarantine' in result)) throw new Error(`erreur inattendue: ${JSON.stringify(result)}`);
  return result.quarantine;
}

function unknownDefinitionRun(
  kind: 'single_business_action' | 'customer_contact',
): Extract<JarvisRunEnvelope, { readonly kind: 'single_business_action' | 'customer_contact' }> {
  return {
    kind,
    runId: RUN_ID,
    companyId: 'company-1',
    createdBy: 'owner-1',
    definitionVersion: UNKNOWN_DEFINITION_VERSION,
    status: 'active',
    revision: 1,
    stateVersion: 1,
    state: { step: 'preparing' },
    nextWakeAt: null,
    terminalAt: null,
  };
}

describe('reduceJarvisRun — osmose avec l’agrégat AgentMission (un seul moteur)', () => {
  it('cancel via le reducer ≡ AgentMission.rehydrate + cancel direct : même postimage projetée, même mission_cancelled', () => {
    const snapshot = startedSnapshot();
    const occurredAt = at(5);

    const reduced = transitionOf(
      reduceJarvisRun(
        projectQuoteMissionEnvelope(snapshot),
        {
          kind: AGENT_MISSION_KIND,
          command: { type: 'cancel_run', reason: 'user_cancelled' },
        },
        context(occurredAt),
      ),
    );

    const direct = value(
      value(AgentMission.rehydrate(snapshot)).cancel({
        expectedRevision: 1,
        reason: 'user_cancelled',
        occurredAt,
      }),
    );

    expect(reduced.postimage).toEqual(projectQuoteMissionEnvelope(direct.mission.toSnapshot()));
    expect(reduced.postimage.status).toBe('cancelled');
    expect(reduced.event.type).toBe('mission_cancelled');
    expect(reduced.event.type).toBe(direct.event.eventType);
    expect(reduced.event.version).toBe(1);
    expect(reduced.event.data).toEqual(direct.event.data);
    expect(reduced.workItemIntents).toEqual([]);
    expect(reduced.wakes).toEqual([]);
    expect(reduced.releasedForegroundLease).toBe(true);
  });

  it('expire via le reducer ≡ AgentMission.expire direct : terminal legacy projeté failed_terminal', () => {
    const snapshot = startedSnapshot();
    const afterIdleTtl = at(25 * 60);

    const reduced = transitionOf(
      reduceJarvisRun(
        projectQuoteMissionEnvelope(snapshot),
        { kind: AGENT_MISSION_KIND, command: { type: 'expire_run' } },
        context(afterIdleTtl),
      ),
    );

    const direct = value(
      value(AgentMission.rehydrate(snapshot)).expire({
        expectedRevision: 1,
        occurredAt: afterIdleTtl,
      }),
    );

    expect(reduced.postimage).toEqual(projectQuoteMissionEnvelope(direct.mission.toSnapshot()));
    expect(reduced.postimage.status).toBe('failed_terminal');
    expect(reduced.event.type).toBe('mission_expired');
    expect(reduced.event.type).toBe(direct.event.eventType);
    expect(reduced.event.data).toEqual(direct.event.data);
  });

  it('remonte le conflit CAS de l’agrégat en revision_conflict TYPÉ (§15 : stale distinguable)', () => {
    const snapshot = startedSnapshot();
    const result = reduceJarvisRun(
      projectQuoteMissionEnvelope(snapshot),
      {
        kind: AGENT_MISSION_KIND,
        command: { type: 'cancel_run', reason: 'user_cancelled' },
      },
      context(at(5), 7),
    );
    expect(errorOf(result)).toEqual({
      code: 'revision_conflict',
      expectedRevision: 7,
      actualRevision: 1,
    });
  });

  it('remonte le terminal de l’agrégat en run_terminal TYPÉ (expired projeté failed_terminal)', () => {
    const snapshot = startedSnapshot();
    const cancelled = reduceJarvisRun(
      projectQuoteMissionEnvelope(snapshot),
      {
        kind: AGENT_MISSION_KIND,
        command: { type: 'cancel_run', reason: 'user_cancelled' },
      },
      context(at(5), 1),
    );
    if (!('value' in cancelled) || !cancelled.ok) throw new Error('cancel attendu vert');
    const terminalEnvelope = cancelled.value.postimage;
    if (terminalEnvelope.kind !== AGENT_MISSION_KIND) throw new Error('branche quote attendue');
    const result = reduceJarvisRun(
      terminalEnvelope,
      {
        kind: AGENT_MISSION_KIND,
        command: { type: 'cancel_run', reason: 'user_cancelled' },
      },
      context(at(6), terminalEnvelope.revision),
    );
    expect(errorOf(result)).toEqual({ code: 'run_terminal', status: 'cancelled' });
  });
});

describe('reduceJarvisRun — commandes interactives quote = route legacy (cutover §17.1)', () => {
  it.each(['stage_lines', 'acknowledge_quote_screen', 'decide_customer'])(
    'rend legacy_route_active pour « %s » sans toucher au run',
    (interactiveCommand) => {
      const snapshot = startedSnapshot();
      const envelope = projectQuoteMissionEnvelope(snapshot);
      const before = structuredClone(envelope);

      const result = reduceJarvisRun(
        envelope,
        { kind: AGENT_MISSION_KIND, command: { type: interactiveCommand } },
        context(at(5)),
      );

      expect(errorOf(result)).toEqual({
        code: 'legacy_route_active',
        command: interactiveCommand,
      });
      expect(envelope).toEqual(before);
    },
  );
});

describe('reduceJarvisRun — quarantaine §5.5 : kind/version inconnus, jamais un défaut', () => {
  it.each(['single_business_action', 'customer_contact'] as const)(
    'gèle un run %s de version non enregistrée en quarantaine, SANS effet',
    (kind) => {
      expect(resolveJarvisDefinition(kind, UNKNOWN_DEFINITION_VERSION)).toBeNull();
      const run = unknownDefinitionRun(kind);
      const before = structuredClone(run);

      const result = reduceJarvisRun(
        run,
        { kind, definitionVersion: UNKNOWN_DEFINITION_VERSION, command: { type: 'noop' } },
        context(at(5)),
      );

      expect(quarantineOf(result)).toEqual({
        kind,
        definitionVersion: UNKNOWN_DEFINITION_VERSION,
      });
      // Sans effet : ni postimage, ni événement, ni intent — le run est resté intact.
      expect(result).not.toHaveProperty('value');
      expect(run).toEqual(before);
    },
  );
});

describe('reduceJarvisRun — kind du run et de la commande épinglés ensemble', () => {
  it('refuse une commande single_business_action sur un run quote_creation', () => {
    const result = reduceJarvisRun(
      projectQuoteMissionEnvelope(startedSnapshot()),
      {
        kind: 'single_business_action',
        definitionVersion: 1,
        command: { type: 'noop' },
      },
      context(at(5)),
    );
    expect(errorOf(result)).toEqual({ code: 'invalid_command', reason: 'kind_mismatch' });
  });

  it('refuse une commande quote_creation sur un run customer_contact', () => {
    const result = reduceJarvisRun(
      unknownDefinitionRun('customer_contact'),
      { kind: AGENT_MISSION_KIND, command: { type: 'expire_run' } },
      context(at(5)),
    );
    expect(errorOf(result)).toEqual({ code: 'invalid_command', reason: 'kind_mismatch' });
  });
});

describe('oracle et normalisation temporels U1-m — frontière pure anti-faux-vert', () => {
  type DefinitionRun = Extract<
    JarvisRunEnvelope,
    { readonly kind: 'single_business_action' | 'customer_contact' }
  >;
  const baseRun: DefinitionRun = Object.freeze({
    kind: 'single_business_action',
    runId: RUN_ID,
    companyId: 'company-1',
    createdBy: 'owner-1',
    definitionVersion: 1,
    status: 'active',
    revision: 3,
    stateVersion: 1,
    state: Object.freeze({}),
    nextWakeAt: null,
    terminalAt: null,
  });
  const limits = Object.freeze({
    maxSteps: 4,
    maxOpenWorkItems: 1,
    maxStateBytes: 1024,
    idleTtlMs: 60_000,
    hardTtlMs: 120_000,
    maxWakes: 4,
  });
  const definition: JarvisDefinitionModule = Object.freeze({
    kind: 'single_business_action',
    definitionVersion: 1,
    stateVersion: 1,
    limits,
    pendingWakes: (run: DefinitionRun) => finalizeJarvisPendingWakes(run, []),
    actionReference: () => null,
    reduce: () => ({
      ok: false as const,
      error: { code: 'invalid_command' as const, reason: 'unused' },
    }),
  });

  function transition(
    postimage: DefinitionRun,
    over: Partial<JarvisRunTransition> = {},
  ): JarvisRunTransition {
    return {
      postimage,
      event: { type: 'test_event', version: 1, data: {} },
      workItemIntents: [],
      wakes: [],
      releasedForegroundLease: false,
      ...over,
    };
  }

  it('trie par échéance puis octets UTF-8, gèle sans muter le tableau source', () => {
    const due = '2026-08-21T10:00:00.000Z';
    const later = '2026-08-21T10:00:01.000Z';
    const source: JarvisWake[] = [
      { wakeId: '😀', kind: 'retry', dueAt: due },
      { wakeId: 'later', kind: 'retry', dueAt: later },
      { wakeId: '\uE000', kind: 'retry', dueAt: due },
    ];
    const run = { ...baseRun, nextWakeAt: due };
    const result = finalizeJarvisPendingWakes(run, source);
    expect(result).toEqual({
      ok: true,
      value: [
        { wakeId: '\uE000', kind: 'retry', dueAt: due },
        { wakeId: '😀', kind: 'retry', dueAt: due },
        { wakeId: 'later', kind: 'retry', dueAt: later },
      ],
    });
    expect(source.map((wake) => wake.wakeId)).toEqual(['😀', 'later', '\uE000']);
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(result.value.every(Object.isFrozen)).toBe(true);
    }
  });

  it.each([
    {
      label: 'duplicate',
      wakes: [
        { wakeId: 'same', kind: 'retry', dueAt: CREATED_AT },
        { wakeId: 'same', kind: 'park_review', dueAt: CREATED_AT },
      ],
    },
    {
      label: 'instant avec offset non canonique',
      wakes: [{ wakeId: 'wake', kind: 'retry', dueAt: '2026-08-18T12:00:00.000+02:00' }],
    },
    {
      label: 'instant infini',
      wakes: [{ wakeId: 'wake', kind: 'retry', dueAt: 'infinity' }],
    },
    {
      label: 'kind runtime inconnu',
      wakes: [{ wakeId: 'wake', kind: 'unknown', dueAt: CREATED_AT }],
    },
  ])('refuse $label au lieu de deviner', ({ wakes }) => {
    expect(
      finalizeJarvisPendingWakes(
        { ...baseRun, nextWakeAt: CREATED_AT },
        wakes as readonly JarvisWake[],
      ),
    ).toEqual({ ok: false, error: 'invalid_state' });
  });

  it('refuse un terminal qui conserve un wake', () => {
    expect(
      finalizeJarvisPendingWakes(
        { ...baseRun, status: 'completed', terminalAt: CREATED_AT, nextWakeAt: CREATED_AT },
        [{ wakeId: 'wake', kind: 'retry', dueAt: CREATED_AT }],
      ),
    ).toEqual({ ok: false, error: 'invalid_state' });
  });

  it('accepte seulement R+1 avec identité/oracle intacts et interdit un commit prématuré', () => {
    const committed = transition({ ...baseRun, revision: 4 });
    expect(
      normalizeJarvisDefinitionReduction(
        baseRun,
        { ok: true, value: committed },
        definition,
        { strictNoOpReason: null },
      ),
    ).toMatchObject({ kind: 'committed', transition: committed });
    expect(
      normalizeJarvisDefinitionReduction(
        baseRun,
        { ok: true, value: committed },
        definition,
        { strictNoOpReason: 'wake_not_due' },
      ),
    ).toMatchObject({ kind: 'refused' });
    for (const postimage of [
      { ...baseRun },
      { ...baseRun, revision: 5 },
      { ...baseRun, revision: 4, runId: 'other-run' },
      { ...baseRun, revision: 4, companyId: 'other-company' },
      { ...baseRun, revision: 4, createdBy: 'other-owner' },
      { ...baseRun, revision: 4, definitionVersion: 2 },
      { ...baseRun, revision: 4, stateVersion: 2 },
    ]) {
      expect(
        normalizeJarvisDefinitionReduction(
          baseRun,
          { ok: true, value: transition(postimage) },
          definition,
          { strictNoOpReason: null },
        ),
      ).toMatchObject({ kind: 'refused' });
    }
  });

  it('ne classe ignored que le strict no-op autorisé et relaie erreur/quarantaine', () => {
    const strict = transition(baseRun);
    expect(
      normalizeJarvisDefinitionReduction(
        baseRun,
        { ok: true, value: strict },
        definition,
        { strictNoOpReason: 'wake_not_due' },
      ),
    ).toMatchObject({ kind: 'ignored', reason: 'wake_not_due' });
    expect(
      normalizeJarvisDefinitionReduction(
        baseRun,
        { ok: true, value: strict },
        definition,
        { strictNoOpReason: null },
      ),
    ).toMatchObject({ kind: 'refused' });
    for (const malformed of [
      transition({ ...baseRun }),
      transition(baseRun, { releasedForegroundLease: true }),
      transition(baseRun, { workItemIntents: [{} as never] }),
      transition(baseRun, {
        wakes: [{ wakeId: 'unexpected', kind: 'retry', dueAt: CREATED_AT }],
      }),
    ]) {
      expect(
        normalizeJarvisDefinitionReduction(
          baseRun,
          { ok: true, value: malformed },
          definition,
          { strictNoOpReason: 'wake_not_due' },
        ),
      ).toMatchObject({ kind: 'refused' });
    }
    expect(
      normalizeJarvisDefinitionReduction(
        baseRun,
        { ok: false, error: { code: 'invalid_command', reason: 'bad' } },
        definition,
        { strictNoOpReason: null },
      ),
    ).toEqual({ kind: 'refused', error: { code: 'invalid_command', reason: 'bad' } });
    expect(
      normalizeJarvisDefinitionReduction(
        baseRun,
        { ok: false, quarantine: { kind: baseRun.kind, definitionVersion: 99 } },
        null,
        { strictNoOpReason: null },
      ),
    ).toEqual({
      kind: 'quarantine_required',
      quarantine: { kind: baseRun.kind, definitionVersion: 99 },
    });
  });
});
