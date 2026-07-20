import { describe, expect, it } from 'vitest';
import {
  openRealtimeControl,
  sealRealtimeControl,
  type RealtimeControlBinding,
  type RealtimeControlSealKeys,
} from './realtime-control-seal';

const BINDING: RealtimeControlBinding = {
  companyId: 'company-1',
  sessionId: '11111111-1111-4111-8111-111111111111',
  turnId: '22222222-2222-4222-8222-222222222222',
  artifactId: '33333333-3333-4333-8333-333333333333',
  contextRevision: 7,
  contextDigest: 'a'.repeat(64),
};
const KEYS: RealtimeControlSealKeys = {
  encryptionSecret: 'encryption-secret-long-enough-00001',
  encryptionKeyVersion: 4,
  proofSecret: 'proof-secret-that-is-long-enough-0001',
  proofKeyVersion: 2,
};
const RING = {
  encryptionSecret: (version: number) => version === 4 ? KEYS.encryptionSecret : null,
  proofSecret: (version: number) => version === 2 ? KEYS.proofSecret : null,
};

describe('Realtime control seal', () => {
  it('scelle et ouvre une navigation exacte sans JSON lisible en persistance', () => {
    const sealed = sealRealtimeControl({
      turnId: BINDING.turnId,
      kind: 'answer',
      contextRevision: BINDING.contextRevision,
      contextDigest: BINDING.contextDigest,
      navigate: '/devis/new',
    }, BINDING, KEYS, () => new Uint8Array(12).fill(7));

    expect(sealed.controlKind).toBe('navigate');
    expect(new TextDecoder().decode(sealed.sealedControl)).not.toContain('/devis/new');
    expect(openRealtimeControl(sealed, BINDING, RING)).toEqual({
      turnId: BINDING.turnId,
      kind: 'answer',
      contextRevision: BINDING.contextRevision,
      contextDigest: BINDING.contextDigest,
      navigate: '/devis/new',
    });
  });

  it('préserve une proposition opaque non expirée', () => {
    const expiry = new Date(Date.now() + 30_000).toISOString();
    const proposalId = '44444444-4444-4444-8444-444444444444';
    const sealed = sealRealtimeControl({
      turnId: BINDING.turnId,
      kind: 'proposed',
      contextRevision: BINDING.contextRevision,
      contextDigest: BINDING.contextDigest,
      proposalId,
      proposalExpiresAt: expiry,
    }, BINDING, KEYS);

    expect(openRealtimeControl(sealed, BINDING, RING, Date.now()))
      .toMatchObject({ proposalId, proposalExpiresAt: expiry });
    expect(openRealtimeControl(sealed, BINDING, RING, Date.parse(expiry) + 1)).toBeNull();
  });

  it.each([
    ['tenant', { ...BINDING, companyId: 'company-2' }],
    ['session', { ...BINDING, sessionId: '55555555-5555-4555-8555-555555555555' }],
    ['tour', { ...BINDING, turnId: '66666666-6666-4666-8666-666666666666' }],
    ['artefact', { ...BINDING, artifactId: '77777777-7777-4777-8777-777777777777' }],
    ['contexte', { ...BINDING, contextRevision: 8 }],
  ] as const)('rejette une transplantation vers un autre %s', (_label, binding) => {
    const sealed = sealRealtimeControl({
      turnId: BINDING.turnId,
      kind: 'done',
      contextRevision: BINDING.contextRevision,
      contextDigest: BINDING.contextDigest,
      navigate: '/devis/new',
    }, BINDING, KEYS);
    expect(openRealtimeControl(sealed, binding, RING)).toBeNull();
  });

  it('rejette bitflip, tag, HMAC, mauvaise version et mauvaise clé', () => {
    const sealed = sealRealtimeControl({
      turnId: BINDING.turnId,
      kind: 'done',
      contextRevision: BINDING.contextRevision,
      contextDigest: BINDING.contextDigest,
      navigate: '/devis/new',
    }, BINDING, KEYS);
    const bitflip = new Uint8Array(sealed.sealedControl);
    bitflip[0] = (bitflip[0] ?? 0) ^ 1;
    expect(openRealtimeControl({ ...sealed, sealedControl: bitflip }, BINDING, RING)).toBeNull();
    expect(openRealtimeControl({ ...sealed, controlTag: new Uint8Array(16) }, BINDING, RING)).toBeNull();
    expect(openRealtimeControl({ ...sealed, controlPayloadHmac: '0'.repeat(64) }, BINDING, RING)).toBeNull();
    expect(openRealtimeControl({ ...sealed, encryptionKeyVersion: 5 }, BINDING, RING)).toBeNull();
    expect(openRealtimeControl(sealed, BINDING, {
      ...RING,
      encryptionSecret: () => 'different-encryption-secret-0000001',
    })).toBeNull();
  });

  it('refuse une route hors allowlist, un contrôle sans effet et un nonce invalide', () => {
    const base = {
      turnId: BINDING.turnId,
      kind: 'answer' as const,
      contextRevision: BINDING.contextRevision,
      contextDigest: BINDING.contextDigest,
    };
    expect(() => sealRealtimeControl({ ...base, navigate: 'https://evil.example' }, BINDING, KEYS))
      .toThrow(/payload/);
    expect(() => sealRealtimeControl(base, BINDING, KEYS)).toThrow(/payload/);
    expect(() => sealRealtimeControl({ ...base, navigate: '/devis/new' }, BINDING, KEYS, () => new Uint8Array(11)))
      .toThrow(/nonce/);
  });
});
