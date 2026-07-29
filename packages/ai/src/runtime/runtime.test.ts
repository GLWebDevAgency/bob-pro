import { describe, it, expect } from 'vitest';
import { ok, err, QUOTE_CREATION_MISSION_KIND_V1 } from '@bob/core';
import { AgentRuntime, describeError, type RuntimeInvocation } from './runtime';
import { ActionPolicy } from './permissions';
import { type ComplianceLevel } from './journal';
import { InMemoryJournalStore } from './journal.testing';
import { type AnyTool } from '../tools/tool';
import { createLegacyExecutionAuthority } from '../agent/intent-ownership';

const clock = { now: () => '2026-07-01T00:00:00.000Z' };
let idc = 0;
const ids = { newId: () => `run-${++idc}` };
const executionAuthority = createLegacyExecutionAuthority([]);

type FakeTool = AnyTool & { calls: number };

function fakeTool(
  over: Partial<{
    name: string;
    mutating: boolean;
    outbound: boolean;
    compliance: ComplianceLevel;
    runResult: unknown;
    parseOk: boolean;
  }> = {},
): FakeTool {
  const t = {
    name: over.name ?? 'encaisser_facture',
    description: 'fake',
    mutating: over.mutating ?? true,
    outbound: over.outbound ?? false,
    compliance: over.compliance ?? 'high',
    calls: 0,
    parse: (raw: unknown) => (over.parseOk === false ? err({ kind: 'validation', issues: [] }) : ok(raw)),
    run: async () => {
      t.calls++;
      return (over.runResult ?? ok({ status: 'paid' })) as Awaited<ReturnType<AnyTool['run']>>;
    },
  };
  return t as unknown as FakeTool;
}

const inv = (tool: string, label = tool, args: Record<string, unknown> = {}): RuntimeInvocation => ({ tool, args, label });

describe('AgentRuntime — dry-run', () => {
  it("n'exécute PAS les outils ; journal en planned ; outcomes planned", async () => {
    const tool = fakeTool();
    const rt = new AgentRuntime({ tools: [tool], clock, ids, executionAuthority });
    const rec = await rt.run([inv('encaisser_facture', 'Encaisser F-1')], { mode: 'dry-run' });
    expect(tool.calls).toBe(0);
    expect(rec.mode).toBe('dry-run');
    expect(rec.outcomes[0]!.status).toBe('planned');
    expect(rec.entries.map((e) => e.phase)).toEqual(['planned']);
    expect(rec.ok).toBe(true);
  });

  it('évalue TOUT le plan (pas de fail-fast) même après un refus', async () => {
    const a = fakeTool({ name: 'encaisser_facture' });
    const b = fakeTool({ name: 'factures_impayees', mutating: false, compliance: 'low' });
    const rt = new AgentRuntime({ tools: [a, b], clock, ids, executionAuthority, policy: new ActionPolicy({ deny: ['encaisser_facture'] }) });
    const rec = await rt.run([inv('encaisser_facture'), inv('factures_impayees')], { mode: 'dry-run' });
    expect(rec.outcomes.map((o) => o.status)).toEqual(['denied', 'planned']);
    expect(a.calls + b.calls).toBe(0);
  });
});

describe('AgentRuntime — live', () => {
  it('conserve entité + raison bornées d’un conflit pour le parcours de rattrapage', () => {
    expect(
      describeError({
        kind: 'conflict',
        entity: 'maintenance_contract',
        reason: 'stale_revision',
      }),
    ).toBe('conflict:maintenance_contract stale_revision');
  });

  it('refuse atomiquement un lot contenant un outil MissionKind-owned avant le premier effet', async () => {
    const first = fakeTool({
      name: 'factures_impayees',
      mutating: false,
      compliance: 'low',
    });
    const owned = fakeTool({ name: 'creer_devis' });
    const rt = new AgentRuntime({
      tools: [first, owned],
      clock,
      ids,
      executionAuthority: createLegacyExecutionAuthority([
        QUOTE_CREATION_MISSION_KIND_V1,
      ]),
    });

    const rec = await rt.run([
      inv('factures_impayees'),
      inv('creer_devis'),
    ]);

    expect(first.calls + owned.calls).toBe(0);
    expect(rec.ok).toBe(false);
    expect(rec.entries).toHaveLength(1);
    expect(rec.outcomes).toEqual([
      expect.objectContaining({
        tool: 'creer_devis',
        status: 'denied',
        reason: 'agent_intent_ownership:mission_owned:nouveau_devis',
      }),
    ]);
  });

  it('exécute et trace planned puis executed avec digest', async () => {
    const tool = fakeTool();
    const rt = new AgentRuntime({ tools: [tool], clock, ids, executionAuthority });
    const rec = await rt.run([inv('encaisser_facture')]);
    expect(tool.calls).toBe(1);
    expect(rec.entries.map((e) => e.phase)).toEqual(['planned', 'executed']);
    expect(rec.entries[1]!.resultDigest).toContain('status=paid');
    expect(rec.ok).toBe(true);
  });

  it('ne propage et ne journalise que la projection publique déclarée par l’outil', async () => {
    const base = fakeTool({
      name: 'envoyer_devis',
      runResult: ok({
        number: 'D-1',
        deliveryStatus: 'queued',
        signatureToken: 'secret-qui-ne-doit-jamais-sortir',
      }),
    });
    const tool = {
      ...base,
      projectPublicResult: (output: unknown) => ({
        deliveryStatus: (output as { deliveryStatus: string }).deliveryStatus,
      }),
    } as unknown as AnyTool;
    const rt = new AgentRuntime({ tools: [tool], clock, ids, executionAuthority });

    const rec = await rt.run([inv('envoyer_devis')]);

    expect(rec.outcomes[0]?.result).toEqual({ deliveryStatus: 'queued' });
    expect(rec.entries[1]?.resultDigest).toBe('deliveryStatus=queued');
    expect(JSON.stringify(rec)).not.toContain('secret-qui-ne-doit-jamais-sortir');
  });

  it('policy denied : rien exécuté, fail-fast (2e action non atteinte)', async () => {
    const a = fakeTool({ name: 'encaisser_facture' });
    const b = fakeTool({ name: 'relance_brouillon', outbound: true });
    const rt = new AgentRuntime({ tools: [a, b], clock, ids, executionAuthority, policy: new ActionPolicy({ deny: ['encaisser_facture'] }) });
    const rec = await rt.run([inv('encaisser_facture'), inv('relance_brouillon')]);
    expect(a.calls).toBe(0);
    expect(b.calls).toBe(0);
    expect(rec.outcomes).toHaveLength(1);
    expect(rec.outcomes[0]!.status).toBe('denied');
    expect(rec.ok).toBe(true); // un refus de policy n'est pas un échec
  });

  it('run en échec : entrée failed, arrêt, ok=false', async () => {
    const tool = fakeTool({ runResult: err({ kind: 'domain', error: { code: 'BOOM', message: 'boom' } }) });
    const rt = new AgentRuntime({ tools: [tool], clock, ids, executionAuthority });
    const rec = await rt.run([inv('encaisser_facture')]);
    expect(rec.entries.map((e) => e.phase)).toEqual(['planned', 'failed']);
    expect(rec.entries[1]!.reason).toContain('domain:BOOM');
    expect(rec.ok).toBe(false);
  });

  it('outil inconnu : failed, ok=false', async () => {
    const rt = new AgentRuntime({ tools: [], clock, ids, executionAuthority });
    const rec = await rt.run([inv('inexistant')]);
    expect(rec.outcomes[0]!.status).toBe('failed');
    expect(rec.ok).toBe(false);
  });

  it('args invalides (parse) : failed, aucune exécution', async () => {
    const tool = fakeTool({ parseOk: false });
    const rt = new AgentRuntime({ tools: [tool], clock, ids, executionAuthority });
    const rec = await rt.run([inv('encaisser_facture')]);
    expect(tool.calls).toBe(0);
    expect(rec.entries.map((e) => e.phase)).toEqual(['failed']);
    expect(rec.ok).toBe(false);
  });

  it('persiste chaque entrée dans le store (append-only)', async () => {
    const tool = fakeTool();
    const store = new InMemoryJournalStore();
    const rt = new AgentRuntime({ tools: [tool], clock, ids, executionAuthority, store });
    const rec = await rt.run([inv('encaisser_facture')], { runId: 'run-fixe' });
    const persisted = await store.load('run-fixe');
    expect(persisted.map((e) => e.phase)).toEqual(['planned', 'executed']);
    expect(rec.runId).toBe('run-fixe');
  });
});
