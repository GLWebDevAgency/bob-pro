import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  appConflict,
  appDomain,
  appForbidden,
  appNotFound,
  appUnavailable,
  buildDiagnosticAssessmentView,
  canonicalDiagnosticSourceMaterial,
  diagnosticAssessmentSaveInput,
  diagnosticQuestions,
  err,
  ok,
  parisDateOnly,
  parseDiagnosticAssessmentWriteRequest,
  runDiagnostic,
  type AppError,
  type DiagnosticAssessmentSource,
  type DiagnosticAssessmentView,
  type Result,
} from '@bob/core';
import { AppLogger, getPrincipal } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Autorité du diagnostic terminé. Les réponses viennent du propriétaire ; toutes les autres
 * valeurs (sources, score, axes, empreinte et obsolescence) viennent exclusivement du serveur.
 */
@Injectable()
export class DiagnosticAssessmentService {
  constructor(
    @Inject(PERSISTENCE) private readonly persistence: Persistence,
    private readonly logger: AppLogger,
  ) {}

  private identity(): Result<{ companyId: string }, AppError> {
    const principal = getPrincipal();
    if (principal === undefined || principal.companyId === null) {
      return err(appForbidden('authenticated_diagnostic_tenant_required'));
    }
    return ok({ companyId: principal.companyId });
  }

  private async loadSource(companyId: string): Promise<Result<DiagnosticAssessmentSource, AppError>> {
    const company = await this.persistence.companies.findById(companyId);
    if (company === null) return err(appNotFound('company', companyId));

    const [customers, invoices, payments] = await Promise.all([
      this.persistence.customers.listByCompany(companyId),
      this.persistence.invoices.listByCompany(companyId),
      this.persistence.payments.listByCompany(companyId),
    ]);
    const today = parisDateOnly();
    const customerTypes = [...new Set(customers.map((customer) => customer.type))];
    const currentYear = today.slice(0, 4);
    const annualEncaissedCents = payments
      .filter((payment) => payment.receivedAt.slice(0, 4) === currentYear)
      .reduce((sum, payment) => sum + payment.amount, 0);
    const facts = runDiagnostic({
      country: 'FR',
      trade: company.trade,
      vatRegime: company.vatRegime,
      customerTypes,
      hasDecennale: company.hasValidDecennale(today),
      asOf: today,
      annualEncaissedCents,
    });
    const input: DiagnosticAssessmentSource['input'] = {
      facts,
      customers: customers.map((customer) => ({
        id: customer.id,
        type: customer.type,
        siren: customer.siren ?? null,
      })),
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        customerId: invoice.customerId,
        kind: invoice.kind,
        status: invoice.status,
        ttcCents: invoice.totals().ttc,
        lineCategories: invoice.lines.map((line) => line.category),
      })),
      payments: payments.map((payment) => ({
        invoiceId: payment.invoiceId,
        amountCents: payment.amount,
      })),
      profile: { trade: company.trade },
      today,
    };
    const fingerprint = sha256(canonicalDiagnosticSourceMaterial({ companyId, source: input }));
    return ok({ companyId, fingerprint, asOf: today, input });
  }

  private async inTenant<T>(
    operation: (companyId: string) => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    const identity = this.identity();
    if (!identity.ok) return identity;
    return this.persistence.runWithTenant(identity.value.companyId, () =>
      operation(identity.value.companyId));
  }

  getCurrent(): Promise<Result<DiagnosticAssessmentView, AppError>> {
    return this.inTenant(async (companyId) => {
      const source = await this.loadSource(companyId);
      if (!source.ok) return source;
      const saved = await this.persistence.diagnosticAssessments.findByCompanyId(companyId);
      return ok(buildDiagnosticAssessmentView(source.value, saved));
    });
  }

  saveCurrent(body: unknown): Promise<Result<DiagnosticAssessmentView, AppError>> {
    return this.inTenant(async (companyId) => {
      const source = await this.loadSource(companyId);
      if (!source.ok) return source;
      const parsed = parseDiagnosticAssessmentWriteRequest(
        body,
        diagnosticQuestions(source.value.input),
      );
      if (!parsed.ok) return err(appDomain(parsed.error));
      if (parsed.value.expectedSourceFingerprint !== source.value.fingerprint) {
        return err(appConflict('diagnostic_assessment', 'source_changed'));
      }
      const persisted = await this.persistence.diagnosticAssessments.save(
        diagnosticAssessmentSaveInput({
          companyId,
          expectedRevision: parsed.value.expectedRevision,
          source: source.value,
          answers: parsed.value.answers,
        }),
      );
      if (persisted.status === 'revision_conflict') {
        return err(appConflict('diagnostic_assessment', 'stale_revision'));
      }
      const view = buildDiagnosticAssessmentView(source.value, persisted.assessment);
      if (view.status !== 'current') return err(appUnavailable('diagnostic-assessment-integrity'));
      this.logger.audit('diagnostic.assessment.saved', {
        companyId,
        revision: persisted.assessment.revision,
        score: persisted.assessment.score,
        outcome: persisted.status,
      });
      return ok(view);
    });
  }
}
