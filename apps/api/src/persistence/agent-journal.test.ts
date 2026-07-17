import { describe, expect, it } from 'vitest';
import { CompanyScopedJournalStore } from './agent-journal';
import { InMemoryAgentJournalRepository } from './agent-journal.testing';
import type { JournalEntry } from '@bob/ai';

const entry = (seq: number, runId = 'run-1'): JournalEntry => ({
  seq,
  runId,
  at: `2026-07-01T10:00:0${seq}.000Z`,
  phase: seq === 1 ? 'planned' : 'executed',
  tool: 'encaisser_facture',
  label: 'Encaisser F-001',
  args: { invoiceId: 'inv-1', amountCents: 12000 },
  mutating: true,
  outbound: false,
  compliance: 'high',
  ...(seq === 2 ? { resultDigest: 'status=paid' } : {}),
});

describe('Agent journal persistence', () => {
  it('charge les entrées par tenant/run et les trie par séquence', async () => {
    const repo = new InMemoryAgentJournalRepository();
    const tenantA = new CompanyScopedJournalStore(repo, 'co-a');
    const tenantB = new CompanyScopedJournalStore(repo, 'co-b');

    await tenantA.append(entry(2));
    await tenantB.append(entry(1));
    await tenantA.append(entry(1));

    expect(await tenantA.load('run-1')).toMatchObject([
      { seq: 1, runId: 'run-1' },
      { seq: 2, runId: 'run-1', resultDigest: 'status=paid' },
    ]);
    expect(await tenantB.load('run-1')).toMatchObject([{ seq: 1, runId: 'run-1' }]);
  });

  it('ignore un append dupliqué pour garder le journal append-only et rejouable', async () => {
    const repo = new InMemoryAgentJournalRepository();
    const store = new CompanyScopedJournalStore(repo, 'co-a');

    await store.append(entry(1));
    await store.append({ ...entry(1), label: 'Tentative de réécriture' });

    expect(await store.load('run-1')).toHaveLength(1);
    expect((await store.load('run-1'))[0]!.label).toBe('Encaisser F-001');
  });

  it('ne laisse qu’un seul caller réclamer une confirmation, avec isolation tenant', async () => {
    const repo = new InMemoryAgentJournalRepository();
    const claim = { ...entry(1, 'confirm:proposal-1'), tool: '__confirm_proposal__', args: { proposalId: 'proposal-1' } };

    expect(await repo.claim('co-a', claim)).toBe(true);
    expect(await repo.claim('co-a', claim)).toBe(false);
    expect(await repo.claim('co-b', claim)).toBe(true);
    expect(await repo.load('co-a', claim.runId)).toMatchObject([
      { tool: '__confirm_proposal__', args: { proposalId: 'proposal-1' } },
    ]);
  });
});
