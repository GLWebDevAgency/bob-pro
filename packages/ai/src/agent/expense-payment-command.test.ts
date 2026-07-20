import { describe, expect, it } from 'vitest';
import { parseExpensePaymentDetails } from './expense-payment-command';

describe('parseExpensePaymentDetails', () => {
  it('extrait date ISO, moyen et référence', () => {
    expect(parseExpensePaymentDetails(
      'J’ai réglé Cedeo le 2026-07-03 par virement, référence VIR-0042',
      '2026-07-04',
    )).toEqual({ paidOn: '2026-07-03', method: 'transfer', reference: 'VIR-0042' });
  });

  it('comprend date française, aujourd’hui/hier et les trois moyens', () => {
    expect(parseExpensePaymentDetails('payée le 03/07/2026 en espèces', '2026-07-04')).toMatchObject({
      paidOn: '2026-07-03', method: 'cash',
    });
    expect(parseExpensePaymentDetails('réglée aujourd’hui par CB', '2026-07-04')).toMatchObject({
      paidOn: '2026-07-04', method: 'card',
    });
    expect(parseExpensePaymentDetails('réglée hier par carte', '2026-07-04')).toMatchObject({
      paidOn: '2026-07-03', method: 'card',
    });
  });

  it('laisse explicitement null ce que la phrase ne dit pas', () => {
    expect(parseExpensePaymentDetails('règle la dépense Cedeo', '2026-07-04')).toEqual({
      paidOn: null, method: null, reference: null,
    });
    expect(parseExpensePaymentDetails('payée hier par carte', null)).toMatchObject({ paidOn: null, method: 'card' });
  });

  it('ne transforme pas une date impossible en preuve', () => {
    expect(parseExpensePaymentDetails('payée le 31/02/2026 par virement', '2026-07-04').paidOn).toBeNull();
  });
});
