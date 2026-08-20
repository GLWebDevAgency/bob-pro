import {
  appConflict,
  buildDocumentStorageKey,
  err,
  loadVerifiedStoredObject,
  ok,
  type AppError,
  type DocumentStoragePort,
  type Invoice,
  type Quote,
  type Result,
} from '@bob/core';

import { appErrorSummary } from '../app-error-summary';
import type { Persistence } from '../persistence/persistence';
import {
  documentArchiveIntegrityProofSha256,
  type DocumentArchiveArtifactProof,
  type DocumentArchiveIntegrityProof,
  type DocumentArchiveJobReason,
} from '../persistence/document-archive-jobs';
import {
  generatedInvoiceDocumentId,
  generatedInvoiceDocumentVersionId,
  generatedQuoteDocumentId,
  generatedQuoteDocumentVersionId,
} from './generated-document-ids';
import { inspectInvoicePdfRepresentation } from './pdfa3';

export interface ExpectedArchiveArtifact {
  readonly kind: DocumentArchiveArtifactProof['kind'];
  readonly documentId: string;
  readonly versionId: string;
  readonly filename: string;
  readonly mimeType: string;
}

export interface DocumentArchiveMutationBarrier {
  assertIssuedInvoiceArchivesComplete(companyId: string): Promise<Result<void, AppError>>;
  assertSignedQuoteArchivesComplete(companyId: string): Promise<Result<void, AppError>>;
}

/**
 * Autorité unique des preuves d'intégrité des originaux légaux. Les mutations manuelles et
 * différées consomment la même instance applicative ; aucune surface ne recopie ces barrières.
 */
export class DocumentArchiveIntegrityAuthority implements DocumentArchiveMutationBarrier {
  constructor(
    private readonly p: Persistence,
    private readonly documentStorage: DocumentStoragePort,
  ) {}

  /**
   * Changer une donnée qui influe sur le PDF est interdit tant qu'une facture émise n'a pas son
   * original archivé. Cette barrière ferme la fenêtre émission→job et protège aussi les imports
   * legacy incomplets contre une régénération rétroactive.
   */
  async assertIssuedInvoiceArchivesComplete(
    companyId: string,
  ): Promise<Result<void, AppError>> {
    const [fullIncomplete, pdfOnlyIncomplete, invoices, customers] = await Promise.all([
      this.p.documentArchiveJobs.countIncomplete(companyId, 'invoice-issued'),
      this.p.documentArchiveJobs.countIncomplete(companyId, 'invoice-issued-pdf-only-b2c'),
      this.p.invoices.listByCompany(companyId),
      this.p.customers.listByCompany(companyId),
    ]);
    if (fullIncomplete + pdfOnlyIncomplete > 0) {
      return err(appConflict('company_billing_settings', 'issued_invoice_archive_missing'));
    }
    const customerTypes = new Map(customers.map((customer) => [customer.id, customer.type]));
    for (const invoice of invoices) {
      if (invoice.number === null || invoice.issuedAt === null) continue;
      const customerType = customerTypes.get(invoice.customerId);
      if (customerType === undefined) {
        return err(appConflict('company_billing_settings', 'issued_invoice_archive_missing'));
      }
      const reason: Extract<DocumentArchiveJobReason, `invoice-${string}`> =
        customerType === 'b2c' ? 'invoice-issued-pdf-only-b2c' : 'invoice-issued';
      const proof = await this.proveDocumentArchiveIntegrity({
        companyId,
        pieceId: invoice.id,
        reason,
        linkedEntityType: 'invoice',
        expected: this.expectedInvoiceArchiveArtifacts(invoice, reason),
      });
      if (!proof.ok) {
        return err(appConflict('company_billing_settings', 'issued_invoice_archive_missing'));
      }
      const job = await this.p.documentArchiveJobs.findByPiece(
        companyId,
        invoice.id,
        reason,
      );
      if (
        job !== null
        && (
          job.status !== 'done'
          || job.integrityProof === null
          || job.integrityProofSha256 !== documentArchiveIntegrityProofSha256(proof.value)
        )
      ) {
        return err(appConflict('company_billing_settings', 'issued_invoice_archive_missing'));
      }
    }
    return ok(undefined);
  }

  /**
   * Même doctrine pour le contrat signé. Un devis antérieur à l'outbox d'archives, sans job,
   * n'est jamais rétro-généré depuis des données mutables : il reste honnêtement hors barrière.
   */
  async assertSignedQuoteArchivesComplete(
    companyId: string,
  ): Promise<Result<void, AppError>> {
    const incomplete = await this.p.documentArchiveJobs.countIncomplete(companyId, 'quote-signed');
    if (incomplete > 0) {
      return err(appConflict('company_billing_settings', 'signed_quote_archive_missing'));
    }
    const quotes = await this.p.quotes.listByCompany(companyId);
    for (const quote of quotes) {
      if (quote.signature === null) continue;
      const job = await this.p.documentArchiveJobs.findByPiece(companyId, quote.id, 'quote-signed');
      if (job === null) continue;
      const proof = await this.proveDocumentArchiveIntegrity({
        companyId,
        pieceId: quote.id,
        reason: 'quote-signed',
        linkedEntityType: 'quote',
        expected: this.expectedSignedQuoteArchiveArtifacts(quote),
      });
      if (
        !proof.ok
        || job.status !== 'done'
        || job.integrityProof === null
        || job.integrityProofSha256 !== documentArchiveIntegrityProofSha256(proof.value)
      ) {
        return err(appConflict('company_billing_settings', 'signed_quote_archive_missing'));
      }
    }
    return ok(undefined);
  }

  expectedInvoiceArchiveArtifacts(
    invoice: Invoice,
    reason: Extract<DocumentArchiveJobReason, `invoice-${string}`>,
  ): readonly ExpectedArchiveArtifact[] {
    if (!invoice.number) {
      throw new Error('Invoice archive expectations require an issued invoice.');
    }
    const pdf: ExpectedArchiveArtifact = {
      kind: 'invoice_pdf',
      documentId: generatedInvoiceDocumentId(invoice.companyId, invoice.id, 'invoice_pdf'),
      versionId: generatedInvoiceDocumentVersionId(invoice.companyId, invoice.id, 'invoice_pdf'),
      filename: `facture-${invoice.number}.pdf`,
      mimeType: 'application/pdf',
    };
    return reason === 'invoice-issued-pdf-only-b2c'
      ? [pdf]
      : [pdf, {
          kind: 'facturx_xml',
          documentId: generatedInvoiceDocumentId(invoice.companyId, invoice.id, 'facturx_xml'),
          versionId: generatedInvoiceDocumentVersionId(
            invoice.companyId,
            invoice.id,
            'facturx_xml',
          ),
          filename: `factur-x-${invoice.number}.xml`,
          mimeType: 'application/xml',
        }];
  }

  expectedSignedQuoteArchiveArtifacts(quote: Quote): readonly ExpectedArchiveArtifact[] {
    return [{
      kind: 'signed_quote',
      documentId: generatedQuoteDocumentId(quote.companyId, quote.id, 'signed_quote'),
      versionId: generatedQuoteDocumentVersionId(quote.companyId, quote.id, 'signed_quote'),
      filename: `devis-signe-${quote.number ?? quote.id}.pdf`,
      mimeType: 'application/pdf',
    }];
  }

  /**
   * Construit une preuve uniquement depuis les originaux effectivement relus. Une ligne SQL,
   * même active, ne suffit jamais ; cardinalité, identité déterministe, version et stockage sont
   * tous vérifiés avant qu'un job puisse devenir `done`.
   */
  async proveDocumentArchiveIntegrity(input: {
    readonly companyId: string;
    readonly pieceId: string;
    readonly reason: DocumentArchiveJobReason;
    readonly linkedEntityType: 'invoice' | 'quote';
    readonly expected: readonly ExpectedArchiveArtifact[];
  }): Promise<Result<DocumentArchiveIntegrityProof, AppError>> {
    const fail = (cause: string): Result<DocumentArchiveIntegrityProof, AppError> => ({
      ok: false,
      error: { kind: 'dependency', port: 'document-archive-integrity', cause },
    });
    const documents = await this.p.runWithTenant(input.companyId, () =>
      this.p.documents.findByEntity(
        input.companyId,
        input.linkedEntityType,
        input.pieceId,
      ),
    );
    const artifacts: DocumentArchiveArtifactProof[] = [];
    let invoicePdfEmbeddedXmlSha256: string | null | undefined;
    for (const expected of input.expected) {
      const candidates = documents.filter(
        (document) => document.kind === expected.kind && document.status === 'active',
      );
      if (candidates.length !== 1) {
        return fail(`Cardinalité ${expected.kind} invalide : ${candidates.length}.`);
      }
      const document = candidates[0]!;
      const props = document.toProps();
      if (
        document.id !== expected.documentId
        || props.companyId !== input.companyId
        || props.origin !== 'generated'
        || props.filename !== expected.filename
        || props.mimeType !== expected.mimeType
        || props.linkedEntityType !== input.linkedEntityType
        || props.linkedEntityId !== input.pieceId
        || props.versions.length !== 1
      ) {
        return fail(`Identité immuable ${expected.kind} incohérente.`);
      }
      const version = props.versions[0]!;
      const expectedStorageKey = buildDocumentStorageKey({
        companyId: input.companyId,
        documentId: expected.documentId,
        version: 1,
        sha256: props.sha256,
        filename: expected.filename,
        mimeType: expected.mimeType,
      });
      if (
        version.id !== expected.versionId
        || version.version !== 1
        || version.documentId !== expected.documentId
        || version.storageKey !== props.storageKey
        || version.sha256 !== props.sha256
        || version.mimeType !== props.mimeType
        || version.byteSize !== props.byteSize
        || props.storageKey !== expectedStorageKey
      ) {
        return fail(`Version initiale ${expected.kind} incohérente.`);
      }
      const verified = await loadVerifiedStoredObject(this.documentStorage, {
        companyId: input.companyId,
        key: props.storageKey,
        sizeBytes: props.byteSize,
        sha256: props.sha256,
        contentType: props.mimeType,
      });
      if (!verified.ok) {
        return fail(`Octets ${expected.kind} non vérifiables : ${appErrorSummary(verified.error)}.`);
      }
      if (version.reason !== input.reason) {
        return fail(`Provenance de représentation ${expected.kind} incohérente.`);
      }
      let contentProfile: DocumentArchiveArtifactProof['contentProfile'];
      if (expected.kind === 'invoice_pdf') {
        const observed = await inspectInvoicePdfRepresentation(verified.value.bytes);
        const required = input.reason === 'invoice-issued-pdf-only-b2c'
          ? 'plain_pdf'
          : 'facturx_pdfa3';
        if (
          !observed.ok
          || observed.profile !== required
          || observed.documentSha256 !== props.sha256
        ) {
          return fail(
            `Représentation PDF incompatible avec ${input.reason} (attendu ${required}).`,
          );
        }
        const attestationInput = observed.profile === 'plain_pdf'
          ? {
              companyId: input.companyId,
              documentId: expected.documentId,
              versionId: expected.versionId,
              documentSha256: observed.documentSha256,
              profile: 'plain_pdf' as const,
              embeddedXmlSha256: null,
              detectorVersion: observed.detectorVersion,
            }
          : {
              companyId: input.companyId,
              documentId: expected.documentId,
              versionId: expected.versionId,
              documentSha256: observed.documentSha256,
              profile: 'facturx_pdfa3' as const,
              embeddedXmlSha256: observed.embeddedXmlSha256,
              detectorVersion: observed.detectorVersion,
            };
        const attested = await this.p.runWithTenant(input.companyId, () =>
          this.p.documents.attestInvoicePdf(attestationInput),
        );
        if (!attested) return fail('Attestation immuable de la représentation PDF refusée.');
        contentProfile = observed.profile;
        invoicePdfEmbeddedXmlSha256 = observed.embeddedXmlSha256;
      } else if (expected.kind === 'signed_quote') {
        const observed = await inspectInvoicePdfRepresentation(verified.value.bytes);
        if (
          !observed.ok
          || observed.profile !== 'plain_pdf'
          || observed.documentSha256 !== props.sha256
        ) {
          return fail('Le PDF du devis signé contient une représentation embarquée inattendue.');
        }
        contentProfile = 'plain_pdf';
      } else {
        contentProfile = 'facturx_xml';
      }
      artifacts.push({
        kind: expected.kind,
        contentProfile,
        documentId: expected.documentId,
        versionId: expected.versionId,
        version: 1,
        storageKey: props.storageKey,
        mimeType: props.mimeType,
        byteSize: props.byteSize,
        sha256: props.sha256,
      });
    }
    artifacts.sort((left, right) => left.kind.localeCompare(right.kind));
    if (input.reason === 'invoice-issued') {
      const xmlArtifact = artifacts.find((artifact) => artifact.kind === 'facturx_xml');
      if (
        xmlArtifact === undefined
        || invoicePdfEmbeddedXmlSha256 === undefined
        || invoicePdfEmbeddedXmlSha256 === null
        || invoicePdfEmbeddedXmlSha256 !== xmlArtifact.sha256
      ) {
        return fail('Le XML Factur-X embarqué diffère de l’original XML séparé.');
      }
    } else if (
      input.reason === 'invoice-issued-pdf-only-b2c'
      && invoicePdfEmbeddedXmlSha256 !== null
    ) {
      return fail('Une facture consommateur ne peut contenir de XML Factur-X embarqué.');
    }
    return ok({
      version: 1,
      algorithm: 'sha256',
      companyId: input.companyId,
      pieceId: input.pieceId,
      reason: input.reason,
      artifacts,
    });
  }
}
