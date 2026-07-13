import { describe, expect, it, vi } from 'vitest';
import { CabinetInvitationTokenAdapter, CabinetInvitationTokenCipher } from './cabinet-token';

describe('Cabinet invitation token infrastructure', () => {
  it('émet un secret opaque et ne persiste qu’un SHA-256 hexadécimal', async () => {
    const adapter = new CabinetInvitationTokenAdapter();
    const issued = await adapter.issue();

    expect(issued.rawToken).toMatch(/^cbi_[A-Za-z0-9_-]{43}$/);
    expect(issued.tokenHash.value).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.tokenHash.value).not.toContain(issued.rawToken);
    expect((await adapter.hash(issued.rawToken)).value).toBe(issued.tokenHash.value);
  });

  it('chiffre par AES-GCM avec AAD invitation/version et rejette toute altération', () => {
    vi.stubEnv('DEMO_MODE', 'false');
    const cipher = new CabinetInvitationTokenCipher('k'.repeat(40), 7);
    const encrypted = cipher.encrypt('invitation-a', 'secret-a-ne-jamais-logger');

    expect(encrypted.ciphertext).not.toContain('secret-a');
    expect(cipher.decrypt('invitation-a', encrypted)).toBe('secret-a-ne-jamais-logger');
    expect(() => cipher.decrypt('invitation-b', encrypted)).toThrow();
    const tamperedFirstCharacter = encrypted.ciphertext[0] === 'A' ? 'B' : 'A';
    expect(() =>
      cipher.decrypt('invitation-a', {
        ...encrypted,
        ciphertext: `${tamperedFirstCharacter}${encrypted.ciphertext.slice(1)}`,
      }),
    ).toThrow();
    vi.unstubAllEnvs();
  });

  it('échoue fermé hors démo sans clé de chiffrement', () => {
    vi.stubEnv('DEMO_MODE', 'false');
    vi.stubEnv('CABINET_INVITATION_TOKEN_ENCRYPTION_KEY', '');
    expect(() => new CabinetInvitationTokenCipher()).toThrow(/ENCRYPTION_KEY/);
    vi.unstubAllEnvs();
  });
});
