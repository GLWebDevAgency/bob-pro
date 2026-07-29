import { describe, expect, it } from 'vitest';
import {
  consumeContractDeletedNotice,
  issueContractDeletedNotice,
} from './navigation-notice';

describe('navigation notice — contrat supprimé', () => {
  it('est liée au client et consommable exactement une fois', () => {
    const token = issueContractDeletedNotice(
      { customerId: 'customer-1', contractId: 'contract-1' },
      1_000,
    );

    expect(consumeContractDeletedNotice(token, 'customer-1', 1_001)).toEqual({
      kind: 'contract_deleted',
      contractId: 'contract-1',
    });
    expect(consumeContractDeletedNotice(token, 'customer-1', 1_002)).toBeNull();
  });

  it('un mauvais client consume sans divulguer ni permettre un replay', () => {
    const token = issueContractDeletedNotice(
      { customerId: 'customer-1', contractId: 'contract-2' },
      2_000,
    );

    expect(consumeContractDeletedNotice(token, 'customer-2', 2_001)).toBeNull();
    expect(consumeContractDeletedNotice(token, 'customer-1', 2_002)).toBeNull();
  });

  it('expire : une restauration de route tardive ne rejoue aucun message', () => {
    const token = issueContractDeletedNotice(
      { customerId: 'customer-1', contractId: 'contract-3' },
      3_000,
    );

    expect(consumeContractDeletedNotice(token, 'customer-1', 123_000)).toBeNull();
  });
});
