import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalAgentMissionFingerprintKeyBindings,
  fingerprintAgentMissionHmacKey,
} from './agent-mission-fingerprint-key-version';

const DOMAIN = Buffer.from('bob.agent-mission.fingerprint-hmac-key.v1\0', 'utf8');
const FIRST = Buffer.alloc(32, 31).toString('base64url');
const SECOND = Buffer.alloc(32, 32).toString('base64url');

describe('AgentMission fingerprint key binding', () => {
  it('engage les 32 octets décodés avec un domaine dédié', () => {
    expect(fingerprintAgentMissionHmacKey(FIRST)).toBe(
      createHash('sha256').update(DOMAIN).update(Buffer.alloc(32, 31)).digest('hex'),
    );
    expect(fingerprintAgentMissionHmacKey(FIRST)).not.toBe(
      createHash('sha256').update(Buffer.alloc(32, 31)).digest('hex'),
    );
  });

  it.each([
    '',
    'not-base64url',
    Buffer.alloc(31, 1).toString('base64url'),
    Buffer.alloc(33, 1).toString('base64url'),
    `${FIRST}=`,
  ])('refuse un matériau non canonique (%s)', (secret) => {
    expect(() => fingerprintAgentMissionHmacKey(secret)).toThrow(/material is invalid/u);
  });

  it('canonise les bindings par version sans muter l’entrée', () => {
    const input = [
      { keyVersion: 2, keyFingerprint: fingerprintAgentMissionHmacKey(SECOND) },
      { keyVersion: 1, keyFingerprint: fingerprintAgentMissionHmacKey(FIRST) },
    ];
    const canonical = canonicalAgentMissionFingerprintKeyBindings(input);

    expect(canonical).toEqual([
      { keyVersion: 1, keyFingerprint: fingerprintAgentMissionHmacKey(FIRST) },
      { keyVersion: 2, keyFingerprint: fingerprintAgentMissionHmacKey(SECOND) },
    ]);
    expect(input[0]?.keyVersion).toBe(2);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical?.[0])).toBe(true);
  });

  const invalidBindings: ReadonlyArray<ReadonlyArray<{
    readonly keyVersion: number;
    readonly keyFingerprint: string;
  }>> = [
    [],
    [{ keyVersion: 0, keyFingerprint: 'a'.repeat(64) }],
    [{ keyVersion: 1, keyFingerprint: 'A'.repeat(64) }],
    [
      { keyVersion: 1, keyFingerprint: 'a'.repeat(64) },
      { keyVersion: 1, keyFingerprint: 'b'.repeat(64) },
    ],
    [
      { keyVersion: 1, keyFingerprint: 'a'.repeat(64) },
      { keyVersion: 2, keyFingerprint: 'a'.repeat(64) },
    ],
  ];

  it.each(invalidBindings.map((bindings) => [bindings] as const))(
    'refuse des bindings ambigus ou non canoniques (%j)',
    (bindings) => {
    expect(canonicalAgentMissionFingerprintKeyBindings(bindings)).toBeNull();
    },
  );
});
