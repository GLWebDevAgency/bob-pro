import { describe, expect, it, vi } from 'vitest';
import type {
  MistralConversationDurableAuthority,
  MistralConversationProvider,
} from './mistral-conversation-gateway-v2';
import { DisabledMistralConversationResumeAuthority } from './mistral-conversation-resume-ticket';
import {
  TerminalReplayOnlyMistralConversationCompletion,
  createMistralConversationTerminalReplayRuntime,
} from './mistral-conversation-terminal-replay';

function durableAuthority(): MistralConversationDurableAuthority {
  return {
    open: vi.fn(async () => ({ status: 'unavailable' as const })),
    transition: vi.fn(async () => ({ status: 'unavailable' as const })),
  };
}

describe('Mistral conversation terminal replay composition', () => {
  it('réutilise les autorités exactes tout en refusant chaque port live', async () => {
    const durable = durableAuthority();
    const resume = new DisabledMistralConversationResumeAuthority();
    const runtime = createMistralConversationTerminalReplayRuntime({ durable, resume });
    const signal = new AbortController().signal;

    expect(runtime.resume).toBe(resume);
    expect(runtime.gatewayDependencies.authority).toBe(durable);
    expect(runtime.gatewayDependencies.resume).toBe(resume);
    await expect(runtime.gatewayDependencies.bootstrap.consume({
      companyId: 'company-1',
      ticket: 'A'.repeat(32),
      protocol: 'bob.mistral-pcm.v2',
      signal,
    })).resolves.toEqual({ status: 'unavailable' });
    await expect(runtime.gatewayDependencies.context.authorize({
      companyId: 'company-1',
      subjectHash: 'a'.repeat(64),
      subjectKeyVersion: 1,
      sessionHandle: 'mistral_terminal_session_1',
      action: 'reason',
      contextRevision: 1,
      contextDigest: 'b'.repeat(64),
      signal,
    })).resolves.toEqual({ status: 'unavailable' });
    await expect((runtime.gatewayDependencies.provider as MistralConversationProvider).openTurn({
      sessionHandle: 'mistral_terminal_session_1',
      turnId: '00000000-0000-4000-8000-000000000001',
      maxAudioMs: 1_000,
      signal,
    })).rejects.toThrow('terminal_replay_only');
    await expect(runtime.gatewayDependencies.pipeline.reason({
      companyId: 'company-1',
      subjectHash: 'a'.repeat(64),
      subjectKeyVersion: 1,
      sessionHandle: 'mistral_terminal_session_1',
      turnId: '00000000-0000-4000-8000-000000000001',
      clientTurnId: 'client-turn-1',
      plan: 'business',
      missionConnectionEpoch: 1,
      cancellationGeneration: 0,
      contextRevision: 1,
      contextDigest: 'b'.repeat(64),
      authorizationHandle: 'authorization-handle',
      transcript: 'secret interdit au replay terminal',
      signal,
    })).rejects.toThrow('terminal_replay_only');
  });

  it('refuse toute completion même si elle est appelée par erreur', async () => {
    const completion = new TerminalReplayOnlyMistralConversationCompletion();
    await expect(completion.authorizeAndOpen({} as never, {} as never))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('refuse une composition incomplète au boot', () => {
    expect(() => createMistralConversationTerminalReplayRuntime({
      durable: {} as MistralConversationDurableAuthority,
      resume: new DisabledMistralConversationResumeAuthority(),
    })).toThrow(/authorities are unavailable/i);
  });
});
