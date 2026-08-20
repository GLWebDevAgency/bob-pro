/**
 * Vocabulaire JarvisRun (spec §5.1) — unions fermées, projection statut×phase TOTALE
 * (oracle unique de la projection cutover §17), enveloppe quote_creation fidèle au
 * snapshot writer N-1, dérivation pure de l'index de réveil.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_MISSION_KIND,
  AGENT_MISSION_STATUSES,
  AgentMission,
  QUOTE_CREATION_MISSION_PHASES,
  type AgentMissionProtocolVersion,
  type AgentMissionResult,
  type AgentMissionSnapshot,
} from './agent-mission';
import {
  JARVIS_FOREGROUND_HOLDING_STATUSES,
  JARVIS_RUN_EFFECT_OUTCOME_PENDING_BY_STATUS,
  JARVIS_RUN_KINDS,
  JARVIS_RUN_LEASE_RELEASING_STATUSES,
  JARVIS_RUN_PERSISTED_STATUSES,
  JARVIS_RUN_STATUSES,
  JARVIS_RUN_TERMINAL_STATUSES,
  deriveJarvisDefinitionVersion,
  deriveNextWakeAt,
  isJarvisRunEffectOutcomePending,
  projectQuoteMissionEnvelope,
  projectQuoteMissionJarvisStatus,
  type JarvisRunStatus,
  type JarvisWake,
} from './jarvis-run';

const MISSION_ID = '00000000-0000-4000-8000-0000000000a1';
const CREATED_AT = '2026-08-18T10:00:00.000Z';

function value<T>(result: AgentMissionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function startedSnapshot(protocolVersion: AgentMissionProtocolVersion = 2): AgentMissionSnapshot {
  return value(
    AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      protocolVersion,
      createdAt: CREATED_AT,
      stagedCustomerResolution: null,
      startOutcome: 'no_slot',
      draft: { sessionId: 'quote-session-1', slotRevision: 1, contentRevision: 0 },
    }),
  ).mission.toSnapshot();
}

function wake(wakeId: string, dueAt: string, kind: JarvisWake['kind'] = 'retry'): JarvisWake {
  return { wakeId, kind, dueAt };
}

describe('JarvisRun — unions fermées §5.1', () => {
  it('fige les 3 kinds, quote_creation en tête (composition, jamais duplication)', () => {
    expect([...JARVIS_RUN_KINDS]).toEqual([
      'quote_creation',
      'single_business_action',
      'customer_contact',
    ]);
    expect(JARVIS_RUN_KINDS[0]).toBe(AGENT_MISSION_KIND);
  });

  it('fige exactement les 11 statuts §5.1 — sans le terminal legacy expired', () => {
    expect([...JARVIS_RUN_STATUSES]).toEqual([
      'active',
      'waiting_user',
      'waiting_screen',
      'waiting_external',
      'retry_due',
      'parked',
      'cancelling',
      'completed',
      'cancelled',
      'failed_terminal',
      'quarantined',
    ]);
    expect(JARVIS_RUN_STATUSES).toHaveLength(11);
    expect(JARVIS_RUN_STATUSES).not.toContain('expired');
  });

  it('fige exactement les 12 statuts persistés = AGENT_MISSION_STATUSES ∪ §5.1, sans doublon', () => {
    expect([...JARVIS_RUN_PERSISTED_STATUSES]).toEqual([
      'active',
      'cancelled',
      'expired',
      'waiting_user',
      'waiting_screen',
      'waiting_external',
      'retry_due',
      'parked',
      'cancelling',
      'completed',
      'failed_terminal',
      'quarantined',
    ]);
    expect(JARVIS_RUN_PERSISTED_STATUSES).toHaveLength(12);
    expect(new Set<string>(JARVIS_RUN_PERSISTED_STATUSES).size).toBe(12);
    for (const status of AGENT_MISSION_STATUSES) {
      expect(JARVIS_RUN_PERSISTED_STATUSES).toContain(status);
    }
    for (const status of JARVIS_RUN_STATUSES) {
      expect(JARVIS_RUN_PERSISTED_STATUSES).toContain(status);
    }
  });

  it('classe terminaux et libération de lease à l’intérieur de l’union fermée', () => {
    expect([...JARVIS_RUN_TERMINAL_STATUSES].sort()).toEqual([
      'cancelled',
      'completed',
      'failed_terminal',
    ]);
    expect([...JARVIS_RUN_LEASE_RELEASING_STATUSES].sort()).toEqual([
      'cancelling',
      'parked',
      'waiting_external',
    ]);
    for (const status of JARVIS_RUN_TERMINAL_STATUSES) {
      expect(JARVIS_RUN_STATUSES).toContain(status);
    }
    for (const status of JARVIS_RUN_LEASE_RELEASING_STATUSES) {
      expect(JARVIS_RUN_STATUSES).toContain(status);
    }
  });

  it('fige une seule liste des statuts qui tiennent le premier plan', () => {
    expect([...JARVIS_FOREGROUND_HOLDING_STATUSES]).toEqual([
      'active',
      'waiting_user',
      'waiting_screen',
      'retry_due',
    ]);
    expect(Object.isFrozen(JARVIS_FOREGROUND_HOLDING_STATUSES)).toBe(true);
    for (const status of JARVIS_FOREGROUND_HOLDING_STATUSES) {
      expect(JARVIS_RUN_STATUSES).toContain(status);
      expect(JARVIS_RUN_TERMINAL_STATUSES.has(status)).toBe(false);
      expect(JARVIS_RUN_LEASE_RELEASING_STATUSES.has(status)).toBe(false);
      expect(status).not.toBe('quarantined');
    }
  });

  it('décide exhaustivement quels statuts peuvent encore livrer un effet métier', () => {
    expect(JARVIS_RUN_EFFECT_OUTCOME_PENDING_BY_STATUS).toEqual({
      active: false,
      waiting_user: false,
      waiting_screen: false,
      waiting_external: true,
      retry_due: true,
      parked: false,
      cancelling: true,
      completed: false,
      cancelled: false,
      failed_terminal: false,
      quarantined: false,
    });
    expect(Object.isFrozen(JARVIS_RUN_EFFECT_OUTCOME_PENDING_BY_STATUS)).toBe(true);
    expect(
      JARVIS_RUN_STATUSES.filter((status) => isJarvisRunEffectOutcomePending(status)),
    ).toEqual(['waiting_external', 'retry_due', 'cancelling']);
    expect(Object.keys(JARVIS_RUN_EFFECT_OUTCOME_PENDING_BY_STATUS).sort()).toEqual(
      [...JARVIS_RUN_STATUSES].sort(),
    );
  });
});

describe('projectQuoteMissionJarvisStatus — grille statut×phase TOTALE (oracle cutover §17)', () => {
  it('projette les 27 combinaisons : expired→failed_terminal, awaiting_quote_screen→waiting_screen', () => {
    const grid: Record<string, JarvisRunStatus> = {};
    for (const status of AGENT_MISSION_STATUSES) {
      for (const phase of QUOTE_CREATION_MISSION_PHASES) {
        grid[`${status}/${phase}`] = projectQuoteMissionJarvisStatus(status, phase);
      }
    }
    expect(Object.keys(grid)).toHaveLength(
      AGENT_MISSION_STATUSES.length * QUOTE_CREATION_MISSION_PHASES.length,
    );
    expect(grid).toMatchInlineSnapshot(`
      {
        "active/awaiting_catalogue_choice": "waiting_user",
        "active/awaiting_customer": "waiting_user",
        "active/awaiting_customer_choice": "waiting_user",
        "active/awaiting_draft_decision": "waiting_user",
        "active/awaiting_draft_discard_confirmation": "waiting_user",
        "active/awaiting_line_confirmation": "waiting_user",
        "active/awaiting_line_details": "waiting_user",
        "active/awaiting_lines": "waiting_user",
        "active/awaiting_quote_screen": "waiting_screen",
        "cancelled/awaiting_catalogue_choice": "cancelled",
        "cancelled/awaiting_customer": "cancelled",
        "cancelled/awaiting_customer_choice": "cancelled",
        "cancelled/awaiting_draft_decision": "cancelled",
        "cancelled/awaiting_draft_discard_confirmation": "cancelled",
        "cancelled/awaiting_line_confirmation": "cancelled",
        "cancelled/awaiting_line_details": "cancelled",
        "cancelled/awaiting_lines": "cancelled",
        "cancelled/awaiting_quote_screen": "cancelled",
        "expired/awaiting_catalogue_choice": "failed_terminal",
        "expired/awaiting_customer": "failed_terminal",
        "expired/awaiting_customer_choice": "failed_terminal",
        "expired/awaiting_draft_decision": "failed_terminal",
        "expired/awaiting_draft_discard_confirmation": "failed_terminal",
        "expired/awaiting_line_confirmation": "failed_terminal",
        "expired/awaiting_line_details": "failed_terminal",
        "expired/awaiting_lines": "failed_terminal",
        "expired/awaiting_quote_screen": "failed_terminal",
      }
    `);
  });

  it('ne projette jamais hors de l’union §5.1', () => {
    for (const status of AGENT_MISSION_STATUSES) {
      for (const phase of QUOTE_CREATION_MISSION_PHASES) {
        expect(JARVIS_RUN_STATUSES).toContain(projectQuoteMissionJarvisStatus(status, phase));
      }
    }
  });
});

describe('projectQuoteMissionEnvelope — projection pure du writer N-1', () => {
  it('projette fidèlement : createdBy=ownerUserId, definitionVersion=protocolVersion, snapshot verbatim', () => {
    const snapshot = startedSnapshot(2);
    const envelope = projectQuoteMissionEnvelope(snapshot);

    expect(envelope.kind).toBe(AGENT_MISSION_KIND);
    expect(envelope.runId).toBe(snapshot.id);
    expect(envelope.companyId).toBe(snapshot.companyId);
    expect(envelope.createdBy).toBe(snapshot.ownerUserId);
    expect(envelope.definitionVersion).toBe(snapshot.protocolVersion);
    expect(envelope.revision).toBe(snapshot.revision);
    // Round-trip fidèle : l'enveloppe transporte le snapshot writer N-1 inchangé —
    // le rejouer dans AgentMission.rehydrate redonne l'état exact.
    expect(envelope.snapshot).toEqual(snapshot);
    expect(value(AgentMission.rehydrate(envelope.snapshot)).toSnapshot()).toEqual(snapshot);
    // Statut projeté par l'oracle unique — mission démarrée no_slot = awaiting_quote_screen.
    expect(envelope.status).toBe('waiting_screen');
    expect(envelope.status).toBe(projectQuoteMissionJarvisStatus(snapshot.status, snapshot.phase));
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.keys(envelope).sort()).toEqual([
      'companyId',
      'createdBy',
      'definitionVersion',
      'kind',
      'revision',
      'runId',
      'snapshot',
      'status',
    ]);
  });

  it('suit le protocolVersion du writer N-1 (deriveJarvisDefinitionVersion = identité)', () => {
    for (const protocolVersion of [1, 2] as const) {
      const snapshot = startedSnapshot(protocolVersion);
      expect(deriveJarvisDefinitionVersion(snapshot)).toBe(protocolVersion);
      expect(projectQuoteMissionEnvelope(snapshot).definitionVersion).toBe(protocolVersion);
    }
  });

  it('projette un snapshot annulé en statut cancelled', () => {
    const mission = value(AgentMission.rehydrate(startedSnapshot()));
    const cancelled = value(
      mission.cancel({
        expectedRevision: 1,
        reason: 'user_cancelled',
        occurredAt: '2026-08-18T10:05:00.000Z',
      }),
    ).mission.toSnapshot();
    const envelope = projectQuoteMissionEnvelope(cancelled);
    expect(envelope.status).toBe('cancelled');
    expect(envelope.revision).toBe(cancelled.revision);
    expect(envelope.snapshot).toEqual(cancelled);
  });
});

describe('deriveNextWakeAt — dérivation pure de l’index de réveil §5.1', () => {
  it('rend null sans réveil pendant', () => {
    expect(deriveNextWakeAt([])).toBeNull();
  });

  it('rend l’unique échéance d’un seul réveil', () => {
    expect(deriveNextWakeAt([wake('wake-1', '2026-08-19T08:00:00.000Z')])).toBe(
      '2026-08-19T08:00:00.000Z',
    );
  });

  it('rend le minimum, indépendamment de l’ordre, sans muter l’entrée', () => {
    const wakes: readonly JarvisWake[] = [
      wake('wake-ttl', '2026-08-20T10:00:00.000Z', 'confirmation_ttl'),
      wake('wake-retry', '2026-08-19T08:30:00.000Z', 'retry'),
      wake('wake-park', '2026-08-25T00:00:00.000Z', 'park_review'),
    ];
    const reversed = [...wakes].reverse();
    const before = structuredClone(wakes);

    expect(deriveNextWakeAt(wakes)).toBe('2026-08-19T08:30:00.000Z');
    expect(deriveNextWakeAt(reversed)).toBe('2026-08-19T08:30:00.000Z');
    // Pur : même entrée → même sortie, entrée intacte.
    expect(deriveNextWakeAt(wakes)).toBe('2026-08-19T08:30:00.000Z');
    expect(wakes).toEqual(before);
  });

  it('départage les échéances par valeur d’instant, pas par représentation lexicale', () => {
    // +02:00 = 06:00Z : antérieur au 07:00Z bien que lexicalement supérieur.
    const wakes: readonly JarvisWake[] = [
      wake('wake-utc', '2026-08-19T07:00:00.000Z', 'external_deadline'),
      wake('wake-paris', '2026-08-19T08:00:00.000+02:00', 'retry'),
    ];
    expect(deriveNextWakeAt(wakes)).toBe('2026-08-19T08:00:00.000+02:00');
  });
});
