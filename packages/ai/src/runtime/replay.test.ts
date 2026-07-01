import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
import { AgentRuntime, type RuntimeInvocation } from './runtime';
import { summarizeRun, invocationsFrom, renderReplay } from './replay';
import { type AnyTool } from '../tools/tool';

const clock = { now: () => '2026-07-01T00:00:00.000Z' };
const ids = { newId: () => 'run-x' };

type FakeTool = AnyTool & { calls: number };
function tool(name: string): FakeTool {
  const t = {
    name,
    description: '',
    mutating: true,
    outbound: false,
    compliance: 'low' as const,
    calls: 0,
    parse: (r: unknown) => ok(r),
    run: async () => {
      t.calls++;
      return ok({ status: 'ok' }) as Awaited<ReturnType<AnyTool['run']>>;
    },
  };
  return t as unknown as FakeTool;
}
const inv = (t: string): RuntimeInvocation => ({ tool: t, args: { k: 1 }, label: `do ${t}` });

describe('replay', () => {
  it('summarizeRun compte les phases', async () => {
    const rt = new AgentRuntime({ tools: [tool('a'), tool('b')], clock, ids });
    const rec = await rt.run([inv('a'), inv('b')]);
    const s = summarizeRun(rec);
    expect(s.executed).toBe(2);
    expect(s.planned).toBe(2);
    expect(s.steps).toHaveLength(4);
  });

  it('dry-run -> invocationsFrom -> live rejoue exactement le plan', async () => {
    const a = tool('a');
    const b = tool('b');
    const rt = new AgentRuntime({ tools: [a, b], clock, ids });
    const dry = await rt.run([inv('a'), inv('b')], { mode: 'dry-run' });
    expect(a.calls + b.calls).toBe(0);
    const replayInvocations = invocationsFrom(dry.entries);
    expect(replayInvocations.map((i) => i.tool)).toEqual(['a', 'b']);
    const live = await rt.run(replayInvocations);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(summarizeRun(live).executed).toBe(2);
  });

  it('renderReplay produit des lignes lisibles (icône par phase)', async () => {
    const rt = new AgentRuntime({ tools: [tool('a')], clock, ids });
    const rec = await rt.run([inv('a')]);
    const text = renderReplay(summarizeRun(rec));
    expect(text).toContain('✓ do a');
    expect(text).toContain('• do a');
  });
});
