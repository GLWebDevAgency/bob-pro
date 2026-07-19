import { describe, expect, it, vi } from 'vitest';
import type {
  MistralConversationDurableAuthority,
  MistralConversationProvider,
} from './mistral-conversation-gateway-v2';
import { DisabledMistralConversationResumeAuthority } from './mistral-conversation-resume-ticket';
import { DisabledMistralConversationAdmissionAuthority } from './mistral-conversation-admission';
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
  it('encapsule les autorités et refuse chaque chemin live avant toute mutation', async () => {
    const durable = durableAuthority();
    const resume = new DisabledMistralConversationResumeAuthority();
    const reconcile = vi.spyOn(resume, 'reconcileInitialBootstrap');
    const redeem = vi.spyOn(resume, 'redeemAndOpen');
    const admission = new DisabledMistralConversationAdmissionAuthority();
    const termination = { terminateReaping: vi.fn(async () => ({ status: 'unavailable' as const })) };
    const runtime = createMistralConversationTerminalReplayRuntime({
      durable,
      resume,
      initialBootstrap: null,
      admission,
      termination,
    });
    const signal = new AbortController().signal;

    expect(runtime.resume).not.toBe(resume);
    expect(runtime.initialBootstrap).toBeNull();
    expect(runtime.liveTurnsAvailable).toBe(false);
    expect(runtime.gatewayDependencies.authority).toBe(durable);
    expect(runtime.gatewayDependencies.resume).toBe(runtime.resume);
    expect(runtime.gatewayDependencies.admission).toBe(admission);
    expect(runtime.termination).toBe(termination);
    await expect(runtime.gatewayDependencies.bootstrap.redeemAndOpenInitial({
      companyId: 'company-1',
      ticket: 'A'.repeat(32),
      protocol: 'bob.mistral-pcm.v2',
      ownerLeaseToken: 'O'.repeat(43),
      resumeNextServerSequence: 0,
      maxReplayEvents: 256,
      maxReplayBytes: 240_000,
      signal,
    })).resolves.toEqual({ status: 'unavailable' });
    await expect(runtime.resume.reconcileInitialBootstrap({
      companyId: 'company-1',
      userId: 'user-1',
      sessionHandle: 'mistral_terminal_session_1',
      protocol: 'bob.mistral-pcm.v2',
      bootstrapTicket: `b2_${'B'.repeat(43)}`,
      attempt: 1,
      signal,
    })).resolves.toEqual({ status: 'unavailable' });
    expect(reconcile).not.toHaveBeenCalled();
    await expect(runtime.resume.redeemAndOpen({
      companyId: 'company-1',
      ticket: `r2_${'R'.repeat(43)}`,
      protocol: 'bob.mistral-pcm.v2',
      expectedScope: 'live_takeover',
      resumeNextServerSequence: 0,
      maxReplayEvents: 256,
      maxReplayBytes: 240_000,
      signal,
    })).resolves.toEqual({ status: 'unavailable' });
    expect(redeem).not.toHaveBeenCalled();
    await expect(runtime.resume.redeemAndOpen({
      companyId: 'company-1',
      ticket: `r2_${'T'.repeat(43)}`,
      protocol: 'bob.mistral-pcm.v2',
      expectedScope: 'terminal_replay',
      resumeNextServerSequence: 0,
      maxReplayEvents: 256,
      maxReplayBytes: 240_000,
      signal,
    })).resolves.toEqual({ status: 'unavailable' });
    expect(redeem).toHaveBeenCalledOnce();
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
      initialBootstrap: null,
      admission: new DisabledMistralConversationAdmissionAuthority(),
      termination: {} as never,
    })).toThrow(/authorities are unavailable/i);
  });
});
