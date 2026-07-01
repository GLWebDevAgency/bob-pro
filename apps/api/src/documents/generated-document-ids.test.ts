import { describe, expect, it } from 'vitest';
import { generatedInvoiceDocumentId, generatedInvoiceDocumentVersionId } from './generated-document-ids';

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
