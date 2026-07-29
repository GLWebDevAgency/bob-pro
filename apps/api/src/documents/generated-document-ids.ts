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

/**
 * PR-16 — fiche de passage archivée. L'archive est datée par l'ÉTAT de la fiche (`completed`,
 * puis au plus `signed`) : deux ids déterministes distincts, donc deux archives INDÉPENDANTES
 * et immuables — la fiche non signée reste intacte quand le client finit par signer (A8).
 */
type GeneratedInterventionReportState = 'completed' | 'signed';

function interventionDocumentDigest(
  companyId: string,
  interventionId: string,
  state: GeneratedInterventionReportState,
  suffix = '',
): string {
  return createHash('sha256')
    .update(`${companyId}:intervention:${interventionId}:intervention_report:${state}${suffix}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function generatedInterventionReportDocumentId(
  companyId: string,
  interventionId: string,
  state: GeneratedInterventionReportState,
): string {
  return `doc-intervention-report-${interventionDocumentDigest(companyId, interventionId, state)}`;
}

export function generatedInterventionReportVersionId(
  companyId: string,
  interventionId: string,
  state: GeneratedInterventionReportState,
): string {
  return `ver-intervention-report-${interventionDocumentDigest(companyId, interventionId, state, ':v1')}`;
}
