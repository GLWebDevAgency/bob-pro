import { describe, expect, it } from 'vitest';

import { authenticatedRuntimeBoundaryKey } from './authenticated-runtime-boundary';

describe('authenticatedRuntimeBoundaryKey', () => {
  it('reste stable pour le meme owner authentifie', () => {
    const identity = { subjectId: 'user-a', companyId: 'company-a' };

    expect(authenticatedRuntimeBoundaryKey(identity)).toBe(
      authenticatedRuntimeBoundaryKey({ ...identity }),
    );
  });

  it('change lors du passage direct a un autre compte', () => {
    expect(authenticatedRuntimeBoundaryKey({ subjectId: 'user-a', companyId: 'company-a' }))
      .not.toBe(authenticatedRuntimeBoundaryKey({ subjectId: 'user-b', companyId: 'company-a' }));
  });

  it('change lors du passage a une autre societe du meme compte', () => {
    expect(authenticatedRuntimeBoundaryKey({ subjectId: 'user-a', companyId: 'company-a' }))
      .not.toBe(authenticatedRuntimeBoundaryKey({ subjectId: 'user-a', companyId: 'company-b' }));
  });

  it('refuse une identite partielle au lieu de monter une frontiere partagee', () => {
    expect(() => authenticatedRuntimeBoundaryKey({ subjectId: '', companyId: 'company-a' }))
      .toThrow('authenticated_runtime_identity_missing');
    expect(() => authenticatedRuntimeBoundaryKey({ subjectId: 'user-a', companyId: '' }))
      .toThrow('authenticated_runtime_identity_missing');
  });
});
