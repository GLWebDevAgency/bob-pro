import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
  DisabledMistralRealtimeIngressTicketAuthority,
  hashMistralRealtimeIngressTicket,
  isMistralRealtimeIngressTicket,
  openMistralRealtimeUserIdentity,
  sealMistralRealtimeUserIdentity,
  validateMistralRealtimeIngressIdentityKeyRing,
  validateMistralRealtimeIngressTicketPolicy,
  type MistralRealtimeIdentityBinding,
  type MistralRealtimeIngressIdentityKeyRing,
} from './realtime-mistral-ingress-ticket';

const binding: MistralRealtimeIdentityBinding = {
  companyId: 'company-1',
  subjectHash: '1'.repeat(64),
  subjectKeyVersion: 7,
  sessionId: '10000000-0000-4000-8000-000000000001',
  redemptionId: '20000000-0000-4000-8000-000000000002',
  plan: 'pro',
  contextRevision: 3,
  contextDigest: '2'.repeat(64),
};

function ring(currentVersion = 4, versions: Record<number, string> = {
  3: 'o'.repeat(32),
  4: 'n'.repeat(32),
}): MistralRealtimeIngressIdentityKeyRing {
  return {
    currentVersion,
    secret: (version) => versions[version] ?? null,
  };
}

describe('Bob Live — capacité ingress Mistral', () => {
  it('n’accepte qu’un ticket base64url canonique de 256 bits et ne hash que sa valeur opaque', () => {
    const ticket = randomBytes(32).toString('base64url');
    expect(ticket).toHaveLength(43);
    expect(isMistralRealtimeIngressTicket(ticket)).toBe(true);
    expect(hashMistralRealtimeIngressTicket(ticket)).toMatch(/^[a-f0-9]{64}$/u);
    expect(isMistralRealtimeIngressTicket('A'.repeat(42))).toBe(false);
    expect(isMistralRealtimeIngressTicket(`${ticket}=`)).toBe(false);
    expect(isMistralRealtimeIngressTicket('A'.repeat(43))).toBe(true);
  });

  it('scelle le userId par AEAD lié à toutes les fences et supporte une rotation explicite', () => {
    const sealed = sealMistralRealtimeUserIdentity(
      'auth-user-42',
      binding,
      ring(),
      () => Uint8Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(sealed.keyVersion).toBe(4);
    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain('auth-user-42');
    expect(openMistralRealtimeUserIdentity(sealed, binding, ring())).toBe('auth-user-42');
    expect(openMistralRealtimeUserIdentity(sealed, binding, ring(5, {
      4: 'n'.repeat(32),
      5: 'x'.repeat(32),
    }))).toBe('auth-user-42');
  });

  it('refuse mauvaise keyVersion, mauvaise fence et bitflip sans exposer le plaintext', () => {
    const sealed = sealMistralRealtimeUserIdentity('auth-user-42', binding, ring());
    expect(openMistralRealtimeUserIdentity(sealed, binding, ring(5, {
      5: 'x'.repeat(32),
    }))).toBeNull();
    expect(openMistralRealtimeUserIdentity(sealed, {
      ...binding,
      subjectKeyVersion: binding.subjectKeyVersion + 1,
    }, ring())).toBeNull();
    expect(openMistralRealtimeUserIdentity(sealed, {
      ...binding,
      contextDigest: '3'.repeat(64),
    }, ring())).toBeNull();
    const forged = Uint8Array.from(sealed.ciphertext);
    forged[0] = forged[0]! ^ 1;
    expect(openMistralRealtimeUserIdentity({ ...sealed, ciphertext: forged }, binding, ring())).toBeNull();
  });

  it('valide strictement politique et key ring et garde le mode mémoire fail-closed', async () => {
    expect(() => validateMistralRealtimeIngressTicketPolicy(
      DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
    )).not.toThrow();
    expect(() => validateMistralRealtimeIngressTicketPolicy({
      ...DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
      ticketTtlSeconds: 121,
    })).toThrow(/Invalid Mistral realtime ingress ticket policy/u);
    expect(() => validateMistralRealtimeIngressTicketPolicy({
      ...DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
      deliveryGraceSeconds: 301,
    })).toThrow(/Invalid Mistral realtime ingress ticket policy/u);
    expect(() => validateMistralRealtimeIngressIdentityKeyRing(ring())).not.toThrow();
    expect(() => validateMistralRealtimeIngressIdentityKeyRing({
      currentVersion: 99,
      secret: () => null,
    })).toThrow(/Invalid Mistral realtime ingress identity key ring/u);

    const disabled = new DisabledMistralRealtimeIngressTicketAuthority();
    await expect(disabled.issue()).resolves.toEqual({ ok: false, reason: 'unavailable' });
    await expect(disabled.consume()).resolves.toEqual({ ok: false, reason: 'unavailable' });
    await expect(disabled.bindAndActivate()).resolves.toEqual({ ok: false, reason: 'unavailable' });
    await expect(disabled.complete()).rejects.toThrow(/authority unavailable/u);
  });
});
