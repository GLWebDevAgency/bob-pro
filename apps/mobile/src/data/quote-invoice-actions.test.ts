import { describe, expect, it } from 'vitest';
import { deriveQuoteInvoiceCtaState } from '../components/quote-invoice-actions.logic';

describe('deriveQuoteInvoiceCtaState', () => {
  it('propose le choix uniquement sans pièce liée', () => {
    expect(deriveQuoteInvoiceCtaState({
      hasDepositInvoice: false,
      hasFinalInvoice: false,
      depositStatus: null,
      finalStatus: null,
    })).toBe('choose_first_invoice');
  });

  it('bloque le solde tant que l’acompte est brouillon', () => {
    expect(deriveQuoteInvoiceCtaState({
      hasDepositInvoice: true,
      hasFinalInvoice: false,
      depositStatus: 'draft',
      finalStatus: null,
    })).toBe('deposit_draft_pending');
  });

  it.each(['issued', 'partially_paid', 'paid', 'late'] as const)('autorise le solde après un acompte %s', (status) => {
    expect(deriveQuoteInvoiceCtaState({
      hasDepositInvoice: true,
      hasFinalInvoice: false,
      depositStatus: status,
      finalStatus: null,
    })).toBe('generate_final');
  });

  it('distingue une finale brouillon d’une finale émise', () => {
    expect(deriveQuoteInvoiceCtaState({
      hasDepositInvoice: true,
      hasFinalInvoice: true,
      depositStatus: 'issued',
      finalStatus: 'draft',
    })).toBe('final_draft_pending');
    expect(deriveQuoteInvoiceCtaState({
      hasDepositInvoice: true,
      hasFinalInvoice: true,
      depositStatus: 'paid',
      finalStatus: 'issued',
    })).toBe('final_exists');
  });
});
