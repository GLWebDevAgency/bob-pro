import type { CompanyBillingSettings as CompanyBillingSettingsRow } from '@prisma/client';
import {
  assertCompanyBillingSettings,
  type CompanyBillingSettings,
  type CompanyBillingSettingsPatch,
  type CompanyBillingSettingsRepository,
  type CompanyBillingSettingsWriteResult,
} from '@bob/core';
import type { PrismaService } from './prisma.service';

function fromRow(row: CompanyBillingSettingsRow): CompanyBillingSettings {
  const settings: CompanyBillingSettings = {
    companyId: row.companyId,
    revision: row.revision,
    showRibOnInvoices: row.showRibOnInvoices,
    showInsuranceOnInvoices: row.showInsuranceOnInvoices,
    pdfAccentColor: row.pdfAccentColor,
    defaultQuoteValidityDays: row.defaultQuoteValidityDays,
    defaultDepositPercent: row.defaultDepositPercent,
    defaultInvoicePaymentTermsDays: row.defaultInvoicePaymentTermsDays,
    // PR-06 : les QUATRE seuils vont ensemble (CHECK SQL) — une moitié seule serait une
    // corruption, réhydratée « défaut » plutôt qu'une cadence incomplète inventée.
    relancePolicy:
      row.relanceCordialAfterDays !== null &&
      row.relanceNeutreAfterDays !== null &&
      row.relanceFermeAfterDays !== null &&
      row.relanceMiseEnDemeureAfterDays !== null
        ? {
            cordialAfterDays: row.relanceCordialAfterDays,
            neutreAfterDays: row.relanceNeutreAfterDays,
            fermeAfterDays: row.relanceFermeAfterDays,
            miseEnDemeureAfterDays: row.relanceMiseEnDemeureAfterDays,
          }
        : null,
    relanceAutoEnabled: row.relanceAutoEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  assertCompanyBillingSettings(settings);
  return settings;
}

/** Autorité PostgreSQL unique, RLS tenant + compare-and-swap sur chaque écriture. */
export class PrismaCompanyBillingSettingsRepository implements CompanyBillingSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByCompanyId(companyId: string): Promise<CompanyBillingSettings | null> {
    const row = await this.prisma.client().companyBillingSettings.findUnique({
      where: { companyId },
    });
    return row === null ? null : fromRow(row);
  }

  async ensureForCompany(companyId: string): Promise<CompanyBillingSettings> {
    // createMany(skipDuplicates) reste transaction-safe sous PostgreSQL : aucun P2002 ne marque
    // la transaction courante en échec lors d'un retry de provisioning.
    await this.prisma.client().companyBillingSettings.createMany({
      data: [{ companyId }],
      skipDuplicates: true,
    });
    const settings = await this.findByCompanyId(companyId);
    if (settings === null) throw new Error('COMPANY_BILLING_SETTINGS_NOT_VISIBLE_AFTER_ENSURE');
    return settings;
  }

  async update(input: {
    readonly companyId: string;
    readonly expectedRevision: number;
    readonly patch: CompanyBillingSettingsPatch;
  }): Promise<CompanyBillingSettingsWriteResult> {
    // PR-06 : `relancePolicy` est un OBJET du contrat core — il se projette sur les 4 colonnes
    // (null = retour au défaut : les quatre repassent à NULL, atomiquement).
    const { relancePolicy, ...flatPatch } = input.patch;
    const data: {
      showRibOnInvoices?: boolean;
      showInsuranceOnInvoices?: boolean;
      pdfAccentColor?: CompanyBillingSettings['pdfAccentColor'];
      defaultQuoteValidityDays?: number;
      defaultDepositPercent?: number;
      defaultInvoicePaymentTermsDays?: number | null;
      relanceAutoEnabled?: boolean;
      relanceCordialAfterDays?: number | null;
      relanceNeutreAfterDays?: number | null;
      relanceFermeAfterDays?: number | null;
      relanceMiseEnDemeureAfterDays?: number | null;
      revision: { increment: number };
      updatedAt: Date;
    } = {
      ...flatPatch,
      ...(relancePolicy !== undefined
        ? {
            relanceCordialAfterDays: relancePolicy?.cordialAfterDays ?? null,
            relanceNeutreAfterDays: relancePolicy?.neutreAfterDays ?? null,
            relanceFermeAfterDays: relancePolicy?.fermeAfterDays ?? null,
            relanceMiseEnDemeureAfterDays: relancePolicy?.miseEnDemeureAfterDays ?? null,
          }
        : {}),
      revision: { increment: 1 },
      updatedAt: new Date(),
    };
    const updated = await this.prisma.client().companyBillingSettings.updateMany({
      where: {
        companyId: input.companyId,
        revision: input.expectedRevision,
      },
      data,
    });
    if (updated.count === 1) {
      const settings = await this.findByCompanyId(input.companyId);
      if (settings === null) throw new Error('COMPANY_BILLING_SETTINGS_UPDATED_BUT_NOT_VISIBLE');
      return { status: 'updated', settings };
    }
    const current = await this.findByCompanyId(input.companyId);
    return {
      status: 'revision_conflict',
      currentRevision: current?.revision ?? null,
    };
  }
}
