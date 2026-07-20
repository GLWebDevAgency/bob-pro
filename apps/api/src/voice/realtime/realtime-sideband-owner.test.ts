import { describe, expect, it } from 'vitest';
import {
  DisabledRealtimeSidebandOwner,
  isRealtimeSidebandContextVersion,
  isRealtimeSidebandOwnerAcquireInput,
  isRealtimeSidebandOwnerIdentity,
} from './realtime-sideband-owner';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const SESSION = '00000000-0000-4000-8000-000000000001';

describe('Bob Live — contrat du propriétaire sideband', () => {
  it('rejette toute identité, durée ou fence non canonique', () => {
    expect(isRealtimeSidebandOwnerAcquireInput({
      companyId: 'company-a',
      sessionId: SESSION,
      ownerInstanceHash: HASH,
      candidateOwnerTokenHash: OTHER_HASH,
      leaseSeconds: 30,
    })).toBe(true);
    expect(isRealtimeSidebandOwnerAcquireInput({
      companyId: 'company-a',
      sessionId: SESSION,
      ownerInstanceHash: HASH,
      candidateOwnerTokenHash: OTHER_HASH,
      leaseSeconds: 301,
    })).toBe(false);
    expect(isRealtimeSidebandOwnerIdentity({
      companyId: 'company-a',
      subjectHash: HASH,
      sessionId: SESSION,
      ownerInstanceHash: HASH,
      ownerTokenHash: OTHER_HASH,
      ownerEpoch: 1,
    })).toBe(true);
    expect(isRealtimeSidebandOwnerIdentity({
      companyId: 'company-a',
      subjectHash: HASH,
      sessionId: SESSION,
      ownerInstanceHash: HASH,
      ownerTokenHash: OTHER_HASH,
      ownerEpoch: 0,
    })).toBe(false);
    expect(isRealtimeSidebandContextVersion({ revision: 7, digest: HASH })).toBe(true);
    expect(isRealtimeSidebandContextVersion({ revision: 0, digest: HASH })).toBe(false);
  });

  it('reste fail-closed sans repository durable', async () => {
    const disabled = new DisabledRealtimeSidebandOwner();
    const owner = {
      companyId: 'company-a',
      subjectHash: HASH,
      sessionId: SESSION,
      ownerInstanceHash: HASH,
      ownerTokenHash: OTHER_HASH,
      ownerEpoch: 1,
    };
    await expect(disabled.acquire({
      companyId: 'company-a',
      sessionId: SESSION,
      ownerInstanceHash: HASH,
      candidateOwnerTokenHash: OTHER_HASH,
      leaseSeconds: 30,
    })).resolves.toEqual({ status: 'unavailable' });
    await expect(disabled.applyContext(owner, { revision: 1, digest: HASH }))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(disabled.readCurrentContext(owner)).resolves.toEqual({ status: 'unavailable' });
    await expect(disabled.renew(owner, 30)).resolves.toEqual({ status: 'unavailable' });
    await expect(disabled.release(owner)).resolves.toEqual({ status: 'unavailable' });
  });
});
