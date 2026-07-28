import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentMissionHmacKeyRing } from '../config/env';
import {
  fingerprintAgentMissionHmacKey,
} from './agent-mission-fingerprint-key-version';
import {
  assertAgentMissionFingerprintReadiness,
} from './agent-mission-fingerprint-readiness';

const PREVIOUS = Buffer.alloc(32, 21).toString('base64url');
const CURRENT = Buffer.alloc(32, 22).toString('base64url');
const KEY_RING = Object.freeze({
  currentVersion: 2,
  versions: Object.freeze([1, 2]),
  secret: (version: number) => (
    version === 1 ? PREVIOUS : version === 2 ? CURRENT : null
  ),
}) satisfies ResolvedAgentMissionHmacKeyRing;

describe('AgentMission fingerprint readiness', () => {
  it('refuse le boot si l’adapter PostgreSQL est absent', async () => {
    await expect(assertAgentMissionFingerprintReadiness({
      createAgentMissionFingerprintKeyVersionAuthority: vi.fn(() => null),
    }, KEY_RING)).rejects.toThrow(/authority is unavailable/u);
  });

  it('atteste exactement version et matériau avant de déclarer le master prêt', async () => {
    const assertKeyBindings = vi.fn(async () => undefined);
    const create = vi.fn(() => ({ assertKeyBindings }));

    await expect(assertAgentMissionFingerprintReadiness({
      createAgentMissionFingerprintKeyVersionAuthority: create,
    }, KEY_RING)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledWith(
      [
        {
          keyVersion: 1,
          keyFingerprint: fingerprintAgentMissionHmacKey(PREVIOUS),
        },
        {
          keyVersion: 2,
          keyFingerprint: fingerprintAgentMissionHmacKey(CURRENT),
        },
      ],
      2,
    );
    expect(assertKeyBindings).toHaveBeenCalledOnce();
  });

  it('propage un rejet durable et ne transforme jamais la panne en master OFF', async () => {
    const retainedError = new Error('retained key missing');
    await expect(assertAgentMissionFingerprintReadiness({
      createAgentMissionFingerprintKeyVersionAuthority: vi.fn(() => ({
        assertKeyBindings: vi.fn(async () => Promise.reject(retainedError)),
      })),
    }, KEY_RING)).rejects.toBe(retainedError);
  });

  it('refuse un secret absent avant de consulter PostgreSQL', async () => {
    const create = vi.fn();
    await expect(assertAgentMissionFingerprintReadiness({
      createAgentMissionFingerprintKeyVersionAuthority: create,
    }, {
      currentVersion: 2,
      versions: [1, 2],
      secret: (version) => version === 2 ? CURRENT : null,
    })).rejects.toThrow('AgentMission fingerprint HMAC key version 1 is unavailable.');
    expect(create).not.toHaveBeenCalled();
  });
});
