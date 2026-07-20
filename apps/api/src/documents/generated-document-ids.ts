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

/** A8 — original du devis signé (le contrat). Un seul kind aujourd'hui, même mécanique déterministe
 *  que les pièces générées de facture : id stable par (tenant, devis, kind) = archivage idempotent. */
type GeneratedQuoteDocumentKind = 'signed_quote';

function quoteDocumentDigest(companyId: string, quoteId: string, kind: GeneratedQuoteDocumentKind, suffix = ''): string {
  return createHash('sha256').update(`${companyId}:quote:${quoteId}:${kind}${suffix}`, 'utf8').digest('hex').slice(0, 32);
}

export function generatedQuoteDocumentId(companyId: string, quoteId: string, kind: GeneratedQuoteDocumentKind): string {
  return `doc-quote-${kind}-${quoteDocumentDigest(companyId, quoteId, kind)}`;
}

export function generatedQuoteDocumentVersionId(companyId: string, quoteId: string, kind: GeneratedQuoteDocumentKind): string {
  return `ver-quote-${kind}-${quoteDocumentDigest(companyId, quoteId, kind, ':v1')}`;
}
