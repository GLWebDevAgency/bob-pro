import { describe, it, expect } from 'vitest';
import { ActionJournal, digestResult, type JournalEntry } from './journal';
import { InMemoryJournalStore } from './journal.testing';

const base = { at: 't', tool: 'x', label: 'X', args: {}, mutating: true, outbound: false, compliance: 'low' as const };

describe('ActionJournal', () => {
  it('append incrémente seq (1-based), fige les entrées et porte le runId', () => {
    const j = new ActionJournal('run-1');
    const e1 = j.append({ ...base, phase: 'planned' });
    const e2 = j.append({ ...base, phase: 'executed' });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.runId).toBe('run-1');
    expect(Object.isFrozen(e1)).toBe(true);
  });

  it('snapshot est une copie : la muter ne modifie pas le journal', () => {
    const j = new ActionJournal('run-1');
    j.append({ ...base, phase: 'planned' });
    const snap = j.snapshot();
    snap.push({} as unknown as JournalEntry);
    expect(j.size).toBe(1);
  });
});

describe('InMemoryJournalStore', () => {
  it('append + load par runId (append-only, isolé par run)', async () => {
    const store = new InMemoryJournalStore();
    await store.append({ seq: 1, runId: 'r', ...base, phase: 'planned' });
    await store.append({ seq: 2, runId: 'r', ...base, phase: 'executed' });
    const loaded = await store.load('r');
    expect(loaded.map((e) => e.seq)).toEqual([1, 2]);
    expect(await store.load('autre')).toEqual([]);
  });
});

describe('digestResult', () => {
  it('résume un objet en chaîne bornée et lisible', () => {
    expect(digestResult({ status: 'paid', number: 'F-1' })).toContain('status=paid');
    expect(digestResult(null)).toBe('null');
    expect(digestResult(undefined)).toBe('undefined');
    expect(digestResult(42)).toBe('42');
    expect(digestResult({ nested: { a: 1 } })).toContain('nested=[object]');
    expect(digestResult({ list: [1, 2] })).toContain('list=[array]');
    expect(digestResult('x'.repeat(500)).length).toBeLessThanOrEqual(200);
  });
});
