import { describe, expect, it } from 'vitest';
import {
  canonicalCompanyIdForUser,
  isCanonicalCompanyOwnerBinding,
} from './company-owner-binding';

describe('binding propriétaire Company V1', () => {
  it('dérive exactement company-<sub> pour un sujet accepté', () => {
    expect(canonicalCompanyIdForUser('a1b2c3d4-0000-4000-8000-1234567890ab')).toBe(
      'company-a1b2c3d4-0000-4000-8000-1234567890ab',
    );
  });

  it.each(['', 'with_underscore', 'with/slash', 'a'.repeat(57)])(
    'refuse un sujet non canonique %j',
    (userId) => {
      expect(canonicalCompanyIdForUser(userId)).toBeNull();
    },
  );

  it('refuse les préfixes ressemblants et les bindings attribués à un autre sujet', () => {
    expect(isCanonicalCompanyOwnerBinding('owner', 'company-owner')).toBe(true);
    expect(isCanonicalCompanyOwnerBinding('owner', 'company-company-owner')).toBe(false);
    expect(isCanonicalCompanyOwnerBinding('owner', 'company-attacker')).toBe(false);
  });
});
