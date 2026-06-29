import {
  type CompanyProps,
  type CustomerProps,
  type LegalForm,
  type VatRegime,
  type Trade,
  type CustomerType,
  type QuoteSnapshot,
  type InvoiceSnapshot,
  type QuoteStatus,
  type InvoiceStatus,
  type InvoiceKind,
  type QuoteLine,
  type LineCategory,
  type VatRate,
  type Totals,
} from '@bob/core';

const toDateOnly = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

// Le domaine parle InvoiceKind (final/deposit/...) ; la DB parle DocKind (invoice/deposit_invoice/...).
export type DbDocKind = 'quote' | 'invoice' | 'deposit_invoice' | 'credit_note' | 'situation';
export function invoiceKindToDocKind(k: InvoiceKind): DbDocKind {
  return k === 'final' ? 'invoice' : k === 'deposit' ? 'deposit_invoice' : k;
}
function docKindToInvoiceKind(d: string): InvoiceKind {
  return d === 'invoice' ? 'final' : d === 'deposit_invoice' ? 'deposit' : (d as InvoiceKind);
}

interface LineRow {
  id: string;
  label: string;
  category: string;
  qty: { toString(): string };
  unit: string | null;
  unitPriceHt: number;
  vatRate: { toString(): string };
}

export function lineRowToQuoteLine(row: LineRow): QuoteLine {
  const line: QuoteLine = {
    id: row.id,
    label: row.label,
    category: row.category as LineCategory,
    qty: Number(row.qty.toString()),
    unitPriceHT: row.unitPriceHt,
    vatRate: Number(row.vatRate.toString()) as VatRate,
  };
  if (row.unit !== null) line.unit = row.unit;
  return line;
}

export function quoteLineToCreate(l: QuoteLine, owner: { quoteId?: string; invoiceId?: string }, position: number) {
  // id généré par la base (@default(uuid)) : évite la collision lignes devis ↔ facture (copie).
  return {
    quoteId: owner.quoteId ?? null,
    invoiceId: owner.invoiceId ?? null,
    position,
    label: l.label,
    category: l.category,
    qty: l.qty,
    unit: l.unit ?? null,
    unitPriceHt: l.unitPriceHT,
    vatRate: l.vatRate,
  };
}

interface CompanyRow {
  id: string; name: string; legalForm: string; siren: string; siret: string; apeCode: string | null;
  trade: string; vatRegime: string; rcsOrRm: string | null; addrLine1: string; addrZip: string; addrCity: string;
  iban: string | null; bic: string | null; insurerName: string | null; policyNo: string | null;
  coverage: string | null; policyExpiresAt: Date | null;
}

export function companyRowToProps(row: CompanyRow): CompanyProps {
  const props: CompanyProps = {
    id: row.id,
    name: row.name,
    legalForm: row.legalForm as LegalForm,
    siren: row.siren,
    siret: row.siret,
    trade: row.trade as Trade,
    vatRegime: row.vatRegime as VatRegime,
    address: { line1: row.addrLine1, zip: row.addrZip, city: row.addrCity },
  };
  if (row.apeCode) props.apeCode = row.apeCode;
  if (row.rcsOrRm) props.rcsOrRm = row.rcsOrRm;
  if (row.iban) props.iban = row.iban;
  if (row.bic) props.bic = row.bic;
  if (row.insurerName && row.policyNo && row.coverage && row.policyExpiresAt) {
    props.decennale = {
      insurer: row.insurerName,
      policyNo: row.policyNo,
      coverage: row.coverage,
      expiresAt: row.policyExpiresAt.toISOString().slice(0, 10),
    };
  }
  return props;
}

export function companyPropsToCreate(p: CompanyProps) {
  return {
    id: p.id,
    name: p.name,
    legalForm: p.legalForm,
    siren: p.siren,
    siret: p.siret,
    apeCode: p.apeCode ?? null,
    trade: p.trade,
    vatRegime: p.vatRegime,
    rcsOrRm: p.rcsOrRm ?? null,
    addrLine1: p.address.line1,
    addrZip: p.address.zip,
    addrCity: p.address.city,
    iban: p.iban ?? null,
    bic: p.bic ?? null,
    insurerName: p.decennale?.insurer ?? null,
    policyNo: p.decennale?.policyNo ?? null,
    coverage: p.decennale?.coverage ?? null,
    policyExpiresAt: p.decennale ? new Date(p.decennale.expiresAt) : null,
  };
}

interface CustomerRow {
  id: string; companyId: string; type: string; name: string; siren: string | null; isInternational: boolean;
  addrLine1: string; addrZip: string; addrCity: string; email: string | null; phone: string | null;
  ptLabel: string | null; score: number; avgDelayDays: number; outstanding: number; isSubcontractingBtp: boolean;
}

export function customerRowToProps(row: CustomerRow): CustomerProps {
  const props: CustomerProps = {
    id: row.id,
    companyId: row.companyId,
    type: row.type as CustomerType,
    name: row.name,
    address: { line1: row.addrLine1, zip: row.addrZip, city: row.addrCity },
    score: row.score,
    avgDelayDays: row.avgDelayDays,
    outstanding: row.outstanding,
    isInternational: row.isInternational,
    isSubcontractingBtp: row.isSubcontractingBtp,
  };
  if (row.siren) props.siren = row.siren;
  if (row.email) props.email = row.email;
  if (row.phone) props.phone = row.phone;
  if (row.ptLabel) props.paymentTermsLabel = row.ptLabel;
  return props;
}

export function customerPropsToCreate(p: CustomerProps) {
  return {
    id: p.id,
    companyId: p.companyId,
    type: p.type,
    name: p.name,
    siren: p.siren ?? null,
    isInternational: p.isInternational ?? false,
    addrLine1: p.address.line1,
    addrZip: p.address.zip,
    addrCity: p.address.city,
    email: p.email ?? null,
    phone: p.phone ?? null,
    ptLabel: p.paymentTermsLabel ?? null,
    score: p.score,
    avgDelayDays: p.avgDelayDays,
    outstanding: p.outstanding,
    isSubcontractingBtp: p.isSubcontractingBtp ?? false,
  };
}

interface QuoteRow {
  id: string; companyId: string; customerId: string; status: string; number: string | null;
  validUntil: Date | null; depositPct: number | null; signerName: string | null; signedAt: Date | null;
  lines: LineRow[];
}

export function quoteRowToSnapshot(row: QuoteRow): QuoteSnapshot {
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    status: row.status as QuoteStatus,
    lines: row.lines.map(lineRowToQuoteLine),
    number: row.number,
    depositPct: row.depositPct,
    validUntil: toDateOnly(row.validUntil),
    signature:
      row.signerName && row.signedAt
        ? { signerName: row.signerName, signedAt: row.signedAt.toISOString(), method: 'draw', accepted: true }
        : null,
  };
}

interface InvoiceRow {
  id: string; companyId: string; customerId: string; kind: string; status: string; number: string | null;
  issuedAt: Date | null; dueAt: Date | null; parentQuoteId: string | null; depositPct: number | null;
  paidCents: number; totalsHt: number; totalsVat: number; totalsTtc: number; totalsNetToPay: number;
  vatByRate: unknown; legalMentions: string[]; lines: LineRow[];
}

export function invoiceRowToSnapshot(row: InvoiceRow): InvoiceSnapshot {
  const status = row.status as InvoiceStatus;
  const frozen: Totals | null =
    status === 'draft'
      ? null
      : {
          ht: row.totalsHt,
          vat: row.totalsVat,
          ttc: row.totalsTtc,
          netToPay: row.totalsNetToPay,
          vatByRate: (row.vatByRate as Record<string, number>) ?? {},
        };
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    kind: docKindToInvoiceKind(row.kind),
    status,
    lines: row.lines.map(lineRowToQuoteLine),
    number: row.number,
    frozenTotals: frozen,
    mentions: row.legalMentions,
    issuedAt: toDateOnly(row.issuedAt),
    dueAt: toDateOnly(row.dueAt),
    paid: row.paidCents,
    depositPct: row.depositPct,
    parentQuoteId: row.parentQuoteId,
  };
}
