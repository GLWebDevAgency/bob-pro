import { createHash } from 'node:crypto';

type GeneratedInvoiceDocumentKind = 'invoice_pdf' | 'facturx_xml';

function invoiceDocumentDigest(companyId: string, invoiceId: string, kind: GeneratedInvoiceDocumentKind, suffix = ''): string {
  return createHash('sha256').update(`${companyId}:${invoiceId}:${kind}${suffix}`, 'utf8').digest('hex').slice(0, 32);
}

export function generatedInvoiceDocumentId(companyId: string, invoiceId: string, kind: GeneratedInvoiceDocumentKind): string {
  return `doc-invoice-${kind}-${invoiceDocumentDigest(companyId, invoiceId, kind)}`;
}

export function generatedInvoiceDocumentVersionId(companyId: string, invoiceId: string, kind: GeneratedInvoiceDocumentKind): string {
  return `ver-invoice-${kind}-${invoiceDocumentDigest(companyId, invoiceId, kind, ':v1')}`;
}
