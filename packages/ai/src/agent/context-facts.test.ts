import { describe, expect, it } from 'vitest';
import {
  chantierStatusLabel,
  customerTypeLabel,
  documentKindLabel,
  documentStatusLabel,
  expenseCategoryLabel,
  expenseStatusLabel,
  frDateLabel,
  invoiceKindLabel,
  invoiceStatusLabel,
  quoteStatusLabel,
} from './context-facts';

describe('context-facts — les faits contextuels parlent français (parité UI↔Bob)', () => {
  it('traduit chaque statut du domaine — plus jamais « Statut : issued » à l’oral', () => {
    expect(invoiceStatusLabel('issued')).toBe('Émise');
    expect(invoiceStatusLabel('partially_paid')).toBe('Partiellement payée');
    expect(invoiceStatusLabel('late')).toBe('En retard');
    expect(quoteStatusLabel('signed')).toBe('Signé');
    expect(quoteStatusLabel('viewed')).toBe('Consulté');
    expect(invoiceKindLabel('deposit')).toBe('Facture d’acompte');
    expect(invoiceKindLabel('credit_note')).toBe('Avoir');
    expect(expenseStatusLabel('to_pay')).toBe('À payer');
    expect(expenseCategoryLabel('sous_traitance')).toBe('Sous-traitance');
    expect(documentKindLabel('facturx_xml')).toBe('Factur-X');
    expect(chantierStatusLabel('open')).toBe('En cours');
    expect(customerTypeLabel('b2g')).toBe('Marché public');
  });

  it('aucune valeur des tables ne contient de token technique (underscore/anglais)', () => {
    const all = [
      ...['draft', 'issued', 'partially_paid', 'paid', 'late', 'cancelled'].map(invoiceStatusLabel),
      ...['draft', 'sent', 'viewed', 'signed', 'refused', 'expired'].map(quoteStatusLabel),
      ...['final', 'deposit', 'credit_note', 'situation'].map(invoiceKindLabel),
      ...['to_pay', 'paid'].map(expenseStatusLabel),
      ...['invoice_pdf', 'quote_pdf', 'facturx_xml', 'expense_receipt', 'signed_quote', 'other'].map(documentKindLabel),
      ...['active', 'deleted'].map(documentStatusLabel),
      ...['open', 'closed'].map(chantierStatusLabel),
      ...['b2c', 'b2b', 'b2g'].map(customerTypeLabel),
    ];
    for (const value of all) expect(value).not.toMatch(/_|^(issued|paid|late|sent|viewed|signed|open|closed|active)$/);
  });

  it('un token inconnu est rendu tel quel (fail-safe, jamais de crash)', () => {
    expect(invoiceStatusLabel('archived_v2')).toBe('archived_v2');
    expect(frDateLabel('bientôt')).toBe('bientôt');
  });

  it('formate les dates ISO en JJ/MM/AAAA — l’oral ne dit plus « 2026-07-20 »', () => {
    expect(frDateLabel('2026-07-20')).toBe('20/07/2026');
    expect(frDateLabel('2026-07-20T08:00:00.000Z')).toBe('20/07/2026');
  });
});
