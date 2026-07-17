import {
  assertCompanyBillingSettings,
  type CompanyBillingSettings,
  type CompanyBillingSettingsRepository,
} from '@bob/core';

const INITIAL_POLICY = {
  showRibOnInvoices: false,
  showInsuranceOnInvoices: true,
  pdfAccentColor: 'navy' as const,
  defaultQuoteValidityDays: 30,
  defaultDepositPercent: 30,
  // Test harness uniquement : les scénarios historiques d'émission choisissent explicitement J+30.
  // La migration PostgreSQL de production laisse cette colonne à NULL.
  defaultInvoicePaymentTermsDays: 30,
};

function clone(value: CompanyBillingSettings): CompanyBillingSettings {
  return { ...value };
}

/** Double strict réservé aux tests, exclu du build de production. */
export class InMemoryCompanyBillingSettingsRepository implements CompanyBillingSettingsRepository {
  private readonly rows = new Map<string, CompanyBillingSettings>();

  async findByCompanyId(companyId: string): Promise<CompanyBillingSettings | null> {
    const row = this.rows.get(companyId);
    return row === undefined ? null : clone(row);
  }

  async ensureForCompany(companyId: string): Promise<CompanyBillingSettings> {
    const current = this.rows.get(companyId);
    if (current !== undefined) return clone(current);
    const now = new Date().toISOString();
    const created: CompanyBillingSettings = {
      companyId,
      revision: 1,
      ...INITIAL_POLICY,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(companyId, created);
    return clone(created);
  }

  async update(input: Parameters<CompanyBillingSettingsRepository['update']>[0]) {
    const current = this.rows.get(input.companyId);
    if (current === undefined || current.revision !== input.expectedRevision) {
      return {
        status: 'revision_conflict' as const,
        currentRevision: current?.revision ?? null,
      };
    }
    const updated: CompanyBillingSettings = {
      ...current,
      ...input.patch,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    assertCompanyBillingSettings(updated);
    this.rows.set(input.companyId, updated);
    return { status: 'updated' as const, settings: clone(updated) };
  }

  snapshot(): CompanyBillingSettings[] {
    return [...this.rows.values()].map(clone);
  }

  restore(rows: readonly CompanyBillingSettings[]): void {
    this.rows.clear();
    for (const row of rows) this.rows.set(row.companyId, clone(row));
  }
}
