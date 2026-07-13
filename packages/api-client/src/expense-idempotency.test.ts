import { describe, expect, it } from 'vitest';
import {
  decodeExpenseCreation,
  localExpenseCreationFingerprint,
  portableSha256Hex,
} from './expense-idempotency';

describe('portableSha256Hex', () => {
  it('respecte les vecteurs SHA-256 ASCII et UTF-8', () => {
    expect(portableSha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(portableSha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(portableSha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
  });
});

describe('localExpenseCreationFingerprint', () => {
  const input = {
    supplierName: 'Cedeo',
    documentDate: '2026-07-13',
    totalTtcCents: 12_000,
    category: 'fournitures' as const,
    idempotencyKey: 'secret-local-retry',
  };

  it('ne restitue pas la clé brute et distingue tenant et payload', () => {
    const first = localExpenseCreationFingerprint('co-1', input);
    const tenant = localExpenseCreationFingerprint('co-2', input);
    const payload = localExpenseCreationFingerprint('co-1', { ...input, totalTtcCents: 12_001 });
    expect(first).not.toBe('invalid');
    expect(JSON.stringify(first)).not.toContain(input.idempotencyKey);
    if (!first || first === 'invalid' || !tenant || tenant === 'invalid' || !payload || payload === 'invalid') return;
    expect(first.keyHash).not.toBe(tenant.keyHash);
    expect(first.payloadHash).not.toBe(payload.payloadHash);
  });
});

describe('decodeExpenseCreation', () => {
  it('accepte uniquement la réponse exacte avec un identifiant canonique', () => {
    expect(decodeExpenseCreation({ id: 'expense-1' })).toEqual({ id: 'expense-1' });
    expect(decodeExpenseCreation({})).toBeNull();
    expect(decodeExpenseCreation({ id: 'expense-1', companyId: 'other-tenant' })).toBeNull();
    expect(decodeExpenseCreation({ id: ' expense-1 ' })).toBeNull();
    expect(decodeExpenseCreation({ id: 'expense\n1' })).toBeNull();
    expect(decodeExpenseCreation({ id: 42 })).toBeNull();
  });
});
