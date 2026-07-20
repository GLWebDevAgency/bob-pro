import { describe, expect, it } from 'vitest';
import {
  generatedInvoiceDocumentId,
  generatedInvoiceDocumentVersionId,
  generatedQuoteDocumentId,
  generatedQuoteDocumentVersionId,
} from './generated-document-ids';

describe('generated invoice document ids', () => {
  it('produit des ids déterministes et distincts par tenant, facture et type', () => {
    const id = generatedInvoiceDocumentId('co-1', 'inv-1', 'invoice_pdf');

    expect(generatedInvoiceDocumentId('co-1', 'inv-1', 'invoice_pdf')).toBe(id);
    expect(generatedInvoiceDocumentVersionId('co-1', 'inv-1', 'invoice_pdf')).toBe(
      generatedInvoiceDocumentVersionId('co-1', 'inv-1', 'invoice_pdf'),
    );
    expect(generatedInvoiceDocumentId('co-1', 'inv-1', 'facturx_xml')).not.toBe(id);
    expect(generatedInvoiceDocumentId('co-1', 'inv-2', 'invoice_pdf')).not.toBe(id);
    expect(generatedInvoiceDocumentId('co-2', 'inv-1', 'invoice_pdf')).not.toBe(id);
    expect(id).toMatch(/^doc-invoice-invoice_pdf-[a-f0-9]{32}$/);
  });
});

describe('A8 — generated quote document ids (original du devis signé)', () => {
  it('produit des ids déterministes, distincts par tenant/devis et sans collision avec les factures', () => {
    const id = generatedQuoteDocumentId('co-1', 'piece-1', 'signed_quote');

    expect(generatedQuoteDocumentId('co-1', 'piece-1', 'signed_quote')).toBe(id);
    expect(generatedQuoteDocumentVersionId('co-1', 'piece-1', 'signed_quote')).toBe(
      generatedQuoteDocumentVersionId('co-1', 'piece-1', 'signed_quote'),
    );
    expect(generatedQuoteDocumentId('co-1', 'piece-2', 'signed_quote')).not.toBe(id);
    expect(generatedQuoteDocumentId('co-2', 'piece-1', 'signed_quote')).not.toBe(id);
    // Même id d'entité qu'une facture : les espaces de nommage restent disjoints.
    expect(generatedInvoiceDocumentId('co-1', 'piece-1', 'invoice_pdf')).not.toBe(id);
    expect(id).toMatch(/^doc-quote-signed_quote-[a-f0-9]{32}$/);
  });
});
