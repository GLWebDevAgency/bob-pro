import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Env, ResolvedAgentMissionHmacKeyRing } from '../config/env';
import type { Persistence } from '../persistence/persistence';
import {
  fingerprintAgentMissionHmacKey,
} from './agent-mission-fingerprint-key-version';
import {
  HmacAgentMissionFingerprints,
  UnavailableAgentMissionFingerprints,
  buildAgentMissionFingerprints,
} from './agent-mission-fingerprint.provider';

const PREVIOUS = Buffer.alloc(32, 11).toString('base64url');
const CURRENT = Buffer.alloc(32, 12).toString('base64url');
const KEY_RING = Object.freeze({
  currentVersion: 2,
  versions: Object.freeze([1, 2]),
  secret: (version: number) => (
    version === 1 ? PREVIOUS : version === 2 ? CURRENT : null
  ),
}) satisfies ResolvedAgentMissionHmacKeyRing;

function expected(secret: string, canonicalRequest: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(canonicalRequest, 'utf8')
    .digest('hex');
}

describe('AgentMission fingerprint HMAC provider', () => {
  it('reste dormant sans master et ne consulte aucune autorité globale', async () => {
    const create = vi.fn();
    const fingerprints = await buildAgentMissionFingerprints({
      createAgentMissionFingerprintKeyVersionAuthority: create,
    } as Pick<Persistence, 'createAgentMissionFingerprintKeyVersionAuthority'>, {
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'false',
    } as Env);

    expect(fingerprints).toBeInstanceOf(UnavailableAgentMissionFingerprints);
    expect(create).not.toHaveBeenCalled();
  });

  it('résout une seule fois le keyring prêt avant d’exposer le signer', async () => {
    const assertKeyBindings = vi.fn(async () => undefined);
    const create = vi.fn(() => ({ assertKeyBindings }));
    const fingerprints = await buildAgentMissionFingerprints({
      createAgentMissionFingerprintKeyVersionAuthority: create,
    }, {
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
      BOB_AGENT_MISSION_HMAC_KEY_VERSION: 2,
      BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({
        1: PREVIOUS,
        2: CURRENT,
      }),
    } as Env);

    expect(fingerprints).toBeInstanceOf(HmacAgentMissionFingerprints);
    expect(create).toHaveBeenCalledOnce();
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

  it('signe avec N, vérifie N-1 et ne divulgue jamais le matériau du keyring', () => {
    const fingerprints = new HmacAgentMissionFingerprints(KEY_RING);
    const current = fingerprints.sign('request:current');
    const previous = fingerprints.sign('request:previous', 1);

    expect(current).toEqual({
      keyVersion: 2,
      hmac: expected(CURRENT, 'request:current'),
    });
    expect(previous).toEqual({
      keyVersion: 1,
      hmac: expected(PREVIOUS, 'request:previous'),
    });
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(previous)).toBe(true);
    expect(fingerprints.matches('request:current', current!)).toBe(true);
    expect(fingerprints.matches('request:previous', previous!)).toBe(true);
    expect(JSON.stringify({ current, previous })).not.toContain(CURRENT);
    expect(JSON.stringify({ current, previous })).not.toContain(PREVIOUS);
  });

  it('distingue mismatch, version retirée et empreinte non canonique sans exception', () => {
    const fingerprints = new HmacAgentMissionFingerprints(KEY_RING);

    expect(fingerprints.matches('request', {
      keyVersion: 2,
      hmac: '0'.repeat(64),
    })).toBe(false);
    expect(fingerprints.sign('request', 3)).toBeNull();
    expect(fingerprints.matches('request', {
      keyVersion: 3,
      hmac: '0'.repeat(64),
    })).toBeNull();
    expect(fingerprints.matches('request', {
      keyVersion: 2,
      hmac: '0'.repeat(63),
    })).toBeNull();
    expect(fingerprints.matches('request', {
      keyVersion: 2,
      hmac: 'A'.repeat(64),
    })).toBeNull();
  });

  it('reste fail-closed lorsque le keyring n’est pas provisionné', () => {
    const unavailable = new UnavailableAgentMissionFingerprints();
    expect(unavailable.sign()).toBeNull();
    expect(unavailable.matches()).toBeNull();
  });
});
