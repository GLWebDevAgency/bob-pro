import type { BobClient } from '@bob/api-client';
import { ok } from '@bob/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 42,
  isAvailableAsync: vi.fn(async () => true),
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import {
  createMistralConversationCheckpointCoordinatorForTesting,
  createMistralConversationCheckpointStoreForTesting,
  type MistralConversationCheckpointStoreDependencies,
} from './mistral-conversation-checkpoint-store';
import { recoverMistralConversationTerminalCheckpoint } from './mistral-conversation-terminal-recovery';

const OWNER = Object.freeze({ subjectId: 'subject-1', companyId: 'company-1' });
const SESSION = '00000000-0000-4000-8000-000000000101';

describe('reprise terminale avec le coffre reel', () => {
  it('reprend un delete SecureStore non atteste avec la preuve verrouillee, sans second ticket', async () => {
    const values = new Map<string, string>();
    let deletePersists = false;
    const dependencies: MistralConversationCheckpointStoreDependencies = {
      secureStore: {
        isAvailable: vi.fn(async () => true),
        getItem: vi.fn(async (key: string) => values.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => {
          values.set(key, value);
        }),
        deleteItem: vi.fn(async (key: string) => {
          if (deletePersists) values.delete(key);
        }),
      },
      keychainAccessible: 42,
    };
    const store = createMistralConversationCheckpointStoreForTesting(
      dependencies,
      createMistralConversationCheckpointCoordinatorForTesting(),
    );
    const fence = store.activateOwner(OWNER);
    await store.save(fence, {
      sessionHandle: SESSION,
      missionExpiresAt: '2026-07-19T13:00:00.000Z',
      stream: {
        nextServerSequence: 3,
        sessionReadyAccepted: true,
        sessionHandle: SESSION,
        missionConnectionEpoch: 1,
        closed: true,
      },
      projection: { phase: 'closed', reason: 'user' },
    });
    const requestRealtimeVoiceResumeTicket = vi.fn(async () => ok({
      status: 'terminal_complete' as const,
      companyId: OWNER.companyId,
      sessionHandle: SESSION,
      protocol: 'bob.mistral-pcm.v2' as const,
      missionConnectionEpoch: 1,
      nextServerSequence: 3,
      reason: 'user' as const,
      closedAt: '2026-07-19T12:00:20.000Z',
    }));
    const client: Pick<BobClient, 'requestRealtimeVoiceResumeTicket'> = {
      requestRealtimeVoiceResumeTicket,
    };

    await expect(recoverMistralConversationTerminalCheckpoint({
      client,
      store,
      fence,
    })).rejects.toMatchObject({ code: 'delete_verification_failed' });

    deletePersists = true;
    await expect(recoverMistralConversationTerminalCheckpoint({
      client,
      store,
      fence,
    })).resolves.toBe(true);

    expect(requestRealtimeVoiceResumeTicket).toHaveBeenCalledOnce();
    expect(values.size).toBe(0);
    await expect(store.load(fence)).resolves.toBeNull();
  });
});
