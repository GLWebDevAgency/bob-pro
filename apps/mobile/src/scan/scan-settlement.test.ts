import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TICKET_PAYMENT_METHOD,
  deriveScanSettlementProposal,
  settlementExpenseFields,
} from './scan-settlement';

describe('deriveScanSettlementProposal (routage payé/à payer du scan)', () => {
  it('ticket de caisse → dépense proposée PAYÉE, moyen lu conservé, jamais d’échéance', () => {
    expect(
      deriveScanSettlementProposal({ kind: 'ticket_caisse', paymentMethodSeen: 'cash', dueDate: null }),
    ).toEqual({ proposal: 'paid', methodSeen: 'cash', dueAt: null });
  });

  it('ticket sans moyen visible → payé proposé, moyen null (défaut CB affiché et corrigeable)', () => {
    expect(
      deriveScanSettlementProposal({ kind: 'ticket_caisse', paymentMethodSeen: null, dueDate: null }),
    ).toEqual({ proposal: 'paid', methodSeen: null, dueAt: null });
    expect(DEFAULT_TICKET_PAYMENT_METHOD).toBe('card');
  });

  it('facture fournisseur → « à payer » + échéance lue reprise', () => {
    expect(
      deriveScanSettlementProposal({
        kind: 'facture_fournisseur',
        paymentMethodSeen: null,
        dueDate: '2026-08-15',
      }),
    ).toEqual({ proposal: 'to_pay', methodSeen: null, dueAt: '2026-08-15' });
  });

  it('extraction ambiguë (kind null) → aucune proposition : la question DOIT être posée', () => {
    expect(
      deriveScanSettlementProposal({ kind: null, paymentMethodSeen: null, dueDate: null }),
    ).toEqual({ proposal: null, methodSeen: null, dueAt: null });
  });
});

describe('settlementExpenseFields (décision → commande de création)', () => {
  it('payée → payment { paidOn = date du ticket, method } et jamais de dueAt', () => {
    expect(
      settlementExpenseFields({ choice: 'paid', method: 'cash', dueAt: '2026-08-15' }, '2026-07-10'),
    ).toEqual({ payment: { paidOn: '2026-07-10', method: 'cash' } });
  });

  it('à payer avec échéance → dueAt seul', () => {
    expect(
      settlementExpenseFields({ choice: 'to_pay', method: 'card', dueAt: '2026-08-15' }, '2026-07-10'),
    ).toEqual({ dueAt: '2026-08-15' });
  });

  it('à payer sans échéance → aucun champ additionnel', () => {
    expect(
      settlementExpenseFields({ choice: 'to_pay', method: 'card', dueAt: null }, '2026-07-10'),
    ).toEqual({});
  });
});
