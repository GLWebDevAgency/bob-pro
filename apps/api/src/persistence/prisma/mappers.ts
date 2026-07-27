import {
  type CompanyProps,
  type CustomerProps,
  type CustomerPortfolio,
  type ExpenseProps,
  type ExpensePaymentEvidence,
  type ExpenseCategory,
  type ExpenseStatus,
  type ExpenseSource,
  type LegalForm,
  type VatRegime,
  type Trade,
  type CustomerType,
  type QuoteSnapshot,
  type InvoiceSnapshot,
  type QuoteStatus,
  type InvoiceStatus,
  type InvoiceKind,
  type CreditedInvoiceKind,
  type PrecedingInvoiceSnapshot,
  type Payment,
  type PaymentMethod,
  type QuoteLine,
  type LineCategory,
  type VatRate,
  type Totals,
  type Signature,
  type SignatureMethod,
  type PurchaseOrderRef,
  type Discount,
  type CustomerBillingChannel,
  type CustomerBillingChannelType,
  isFrenchBillingMode,
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
  sourceQuoteLineId: string | null;
  label: string;
  category: string;
  qty: { toString(): string };
  unit: string | null;
  unitPriceHt: number;
  vatRate: { toString(): string };
  /** B3 — remise de ligne (exclusive : % OU montant, CHECK SQL). NULL/NULL = aucune. */
  discountPercent: { toString(): string } | null;
  discountAmountCents: number | null;
}

/** Colonnes communes d'une remise (ligne, devis, facture) — deux formes EXCLUSIVES (CHECK SQL). */
interface DiscountColumns {
  percent: { toString(): string } | null;
  amountCents: number | null;
}

/**
 * Réhydratation d'une remise persistée. Les deux colonnes ensemble seraient une corruption de
 * stockage (le CHECK l'empêche) : échec de lecture EXPLICITE plutôt qu'une remise réinventée —
 * sur un brouillon, choisir une des deux formes changerait silencieusement les totaux.
 */
function discountFromColumns(cols: DiscountColumns, context: string): Discount | undefined {
  if (cols.percent !== null && cols.amountCents !== null) {
    throw new Error(`Corrupted discount state for ${context}: percent and amount are both set.`);
  }
  if (cols.percent !== null) return { type: 'percent', value: Number(cols.percent.toString()) };
  if (cols.amountCents !== null) return { type: 'amount', cents: cols.amountCents };
  return undefined;
}

/** Écriture write-side d'une remise — NULL/NULL quand absente (lignes antérieures inchangées). */
export function discountToColumns(discount: Discount | null | undefined): {
  percent: number | null;
  amountCents: number | null;
} {
  if (!discount) return { percent: null, amountCents: null };
  return discount.type === 'percent'
    ? { percent: discount.value, amountCents: null }
    : { percent: null, amountCents: discount.cents };
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
  if (row.sourceQuoteLineId !== null) line.sourceQuoteLineId = row.sourceQuoteLineId;
  const discount = discountFromColumns(
    { percent: row.discountPercent, amountCents: row.discountAmountCents },
    `line ${row.id}`,
  );
  if (discount !== undefined) line.discount = discount;
  return line;
}

export function quoteLineToCreate(l: QuoteLine, owner: { quoteId?: string; invoiceId?: string }, position: number) {
  const discount = discountToColumns(l.discount);
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
    discountPercent: discount.percent,
    discountAmountCents: discount.amountCents,
    sourceQuoteLineId: l.sourceQuoteLineId ?? null,
  };
}

export interface PaymentPersistenceRow {
  id: string;
  companyId: string;
  invoiceId: string;
  amount: number;
  method: string;
  receivedAt: Date;
  idempotencyKey: string | null;
  ordinaryReceivableCents: number | null;
  retentionReceivableCents: number | null;
}

/**
 * Lecture compatible expand : les deux NULL signifient un paiement écrit avant le contrat 4117,
 * donc 100 % de la somme sur la créance ordinaire. Une moitié NULL est une corruption, jamais un
 * montant complété silencieusement.
 */
export function paymentRowToRecordInput(row: PaymentPersistenceRow): {
  id: string;
  companyId: string;
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  receivedAt: string;
  idempotencyKey: string | null;
  ordinaryReceivableCents: number;
  retentionReceivableCents: number;
} {
  const bothLegacy = row.ordinaryReceivableCents === null && row.retentionReceivableCents === null;
  let ordinaryReceivableCents: number;
  let retentionReceivableCents: number;
  if (bothLegacy) {
    ordinaryReceivableCents = row.amount;
    retentionReceivableCents = 0;
  } else if (row.ordinaryReceivableCents !== null && row.retentionReceivableCents !== null) {
    ordinaryReceivableCents = row.ordinaryReceivableCents;
    retentionReceivableCents = row.retentionReceivableCents;
  } else {
    throw new Error(`Corrupted receivable allocation for payment ${row.id}: partial allocation.`);
  }
  return {
    id: row.id,
    companyId: row.companyId,
    invoiceId: row.invoiceId,
    amount: row.amount,
    method: row.method as PaymentMethod,
    receivedAt: row.receivedAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
    ordinaryReceivableCents,
    retentionReceivableCents,
  };
}

export function paymentToPersistence(payment: Payment) {
  return {
    id: payment.id,
    companyId: payment.companyId,
    invoiceId: payment.invoiceId,
    amount: payment.amount,
    method: payment.method,
    receivedAt: new Date(payment.receivedAt),
    idempotencyKey: payment.idempotencyKey,
    ordinaryReceivableCents: payment.ordinaryReceivableCents,
    retentionReceivableCents: payment.retentionReceivableCents,
  };
}

interface CompanyRow {
  id: string; name: string; legalForm: string; siren: string; siret: string; apeCode: string | null;
  trade: string; vatRegime: string; rcsOrRm: string | null; addrLine1: string; addrZip: string; addrCity: string;
  customerPortfolio: string | null;
  tvaIntracom: string | null; dateCreation: Date | null;
  natureJuridiqueCode: string | null; estRge: boolean | null;
  capitalSocialCents: bigint | null;
  mediateurConsoNom: string | null; mediateurConsoCoordonnees: string | null;
  /** A3 — coordonnées de l'entreprise (modèles R221-1/R221-3, décret 2022-424). NULL = jamais saisies. */
  email: string | null; phone: string | null;
  iban: string | null; bic: string | null; insurerName: string | null; policyNo: string | null;
  coverage: string | null; policyExpiresAt: Date | null;
  closedAt: Date | null; closureReason: string | null;
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
  if (row.customerPortfolio) props.customerPortfolio = row.customerPortfolio as CustomerPortfolio;
  if (row.rcsOrRm) props.rcsOrRm = row.rcsOrRm;
  if (row.tvaIntracom) props.tvaIntracom = row.tvaIntracom;
  if (row.dateCreation) props.dateCreation = row.dateCreation.toISOString().slice(0, 10);
  if (row.natureJuridiqueCode) props.natureJuridiqueCode = row.natureJuridiqueCode;
  // `false` est une donnée réelle (« pas RGE à l'annuaire ») — seul NULL signifie « jamais fourni ».
  if (row.estRge !== null) props.estRge = row.estRge;
  // A6 : BIGINT → number. Une valeur hors entier sûr JS produirait un montant faux : Company.of
  // la rejette (Number.isSafeInteger) et la réhydratation échoue — fail-closed, jamais arrondi.
  if (row.capitalSocialCents !== null) props.capitalSocialCents = Number(row.capitalSocialCents);
  // A2 : les deux colonnes vont ensemble (CHECK SQL) — une moitié seule serait une corruption,
  // honnêtement réhydratée « jamais saisi » plutôt qu'un médiateur incomplet imprimable.
  if (row.mediateurConsoNom !== null && row.mediateurConsoCoordonnees !== null) {
    props.mediateurConso = { nom: row.mediateurConsoNom, coordonnees: row.mediateurConsoCoordonnees };
  }
  // A3 : coordonnées de l'entreprise pour les modèles de rétractation — NULL = jamais saisies.
  if (row.email) props.email = row.email;
  if (row.phone) props.phone = row.phone;
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
  if (row.closedAt) props.closedAt = row.closedAt.toISOString();
  if (row.closureReason) props.closureReason = row.closureReason;
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
    customerPortfolio: p.customerPortfolio ?? null,
    rcsOrRm: p.rcsOrRm ?? null,
    addrLine1: p.address.line1,
    addrZip: p.address.zip,
    addrCity: p.address.city,
    tvaIntracom: p.tvaIntracom ?? null,
    dateCreation: p.dateCreation ? new Date(p.dateCreation) : null,
    natureJuridiqueCode: p.natureJuridiqueCode ?? null,
    estRge: p.estRge ?? null,
    capitalSocialCents: p.capitalSocialCents === undefined ? null : BigInt(p.capitalSocialCents),
    mediateurConsoNom: p.mediateurConso?.nom ?? null,
    mediateurConsoCoordonnees: p.mediateurConso?.coordonnees ?? null,
    email: p.email ?? null,
    phone: p.phone ?? null,
    iban: p.iban ?? null,
    bic: p.bic ?? null,
    insurerName: p.decennale?.insurer ?? null,
    policyNo: p.decennale?.policyNo ?? null,
    coverage: p.decennale?.coverage ?? null,
    policyExpiresAt: p.decennale ? new Date(p.decennale.expiresAt) : null,
    closedAt: p.closedAt ? new Date(p.closedAt) : null,
    closureReason: p.closureReason ?? null,
  };
}

interface CustomerRow {
  id: string; companyId: string; type: string; name: string; siren: string | null; isInternational: boolean;
  tvaIntracom: string | null;
  addrLine1: string; addrZip: string; addrCity: string; email: string | null; phone: string | null;
  contactName: string | null;
  ptLabel: string | null; isSubcontractingBtp: boolean;
  /** B4 — conditions de paiement du client : les TROIS colonnes vont ensemble (CHECK SQL). */
  paymentTermsDays: number | null;
  paymentTermsEndOfMonth: boolean | null;
  paymentTermsLabel: string | null;
  /** Canal de facturation — NULL = email (défaut honnête, jamais un canal inventé). */
  billingChannelType: string | null;
  billingChorusServiceCode: string | null;
  billingPortailNom: string | null;
  billingPortailUrl: string | null;
  /** PR-04 — garde « BC obligatoire » par client ; NULL = non exigé (défaut). */
  requiresPurchaseOrder: boolean | null;
}

const BILLING_CHANNEL_TYPES = new Set<CustomerBillingChannelType>(['email', 'chorus', 'portail']);

export function customerRowToProps(row: CustomerRow): CustomerProps {
  const props: CustomerProps = {
    id: row.id,
    companyId: row.companyId,
    type: row.type as CustomerType,
    name: row.name,
    address: { line1: row.addrLine1, zip: row.addrZip, city: row.addrCity },
    isInternational: row.isInternational,
    isSubcontractingBtp: row.isSubcontractingBtp,
  };
  if (row.siren) props.siren = row.siren;
  if (row.tvaIntracom) props.tvaIntracom = row.tvaIntracom;
  if (row.email) props.email = row.email;
  if (row.phone) props.phone = row.phone;
  if (row.contactName) props.contactName = row.contactName;
  if (row.ptLabel) props.paymentTermsLabel = row.ptLabel;
  // B4 : les trois colonnes vont ensemble (CHECK SQL) — une moitié seule serait une corruption,
  // réhydratée « défaut société » plutôt qu'une échéance incomplète inventée.
  if (
    row.paymentTermsDays !== null
    && row.paymentTermsEndOfMonth !== null
    && row.paymentTermsLabel !== null
  ) {
    props.paymentTerms = {
      days: row.paymentTermsDays,
      endOfMonth: row.paymentTermsEndOfMonth,
      label: row.paymentTermsLabel,
    };
  }
  // Canal de facturation : un type hors référentiel serait une corruption (CHECK SQL),
  // réhydraté « email par défaut » fail-closed (jamais un canal inventé).
  if (row.billingChannelType !== null && BILLING_CHANNEL_TYPES.has(row.billingChannelType as CustomerBillingChannelType)) {
    const type = row.billingChannelType as CustomerBillingChannelType;
    const channel: CustomerBillingChannel = { type };
    if (type === 'chorus' && row.billingChorusServiceCode !== null)
      channel.chorusServiceCode = row.billingChorusServiceCode;
    if (type === 'portail') {
      if (row.billingPortailNom !== null) channel.portailNom = row.billingPortailNom;
      if (row.billingPortailUrl !== null) channel.portailUrl = row.billingPortailUrl;
    }
    props.billingChannel = channel;
  }
  // PR-04 : NULL = non exigé (le champ reste absent — comportement historique inchangé).
  if (row.requiresPurchaseOrder !== null) props.requiresPurchaseOrder = row.requiresPurchaseOrder;
  return props;
}

export function customerPropsToCreate(p: CustomerProps) {
  const channel = p.billingChannel ?? null;
  return {
    id: p.id,
    companyId: p.companyId,
    type: p.type,
    name: p.name,
    siren: p.siren ?? null,
    tvaIntracom: p.tvaIntracom ?? null,
    isInternational: p.isInternational ?? false,
    addrLine1: p.address.line1,
    addrZip: p.address.zip,
    addrCity: p.address.city,
    email: p.email ?? null,
    phone: p.phone ?? null,
    contactName: p.contactName ?? null,
    ptLabel: p.paymentTermsLabel ?? null,
    paymentTermsDays: p.paymentTerms?.days ?? null,
    paymentTermsEndOfMonth: p.paymentTerms?.endOfMonth ?? null,
    paymentTermsLabel: p.paymentTerms?.label ?? null,
    billingChannelType: channel?.type ?? null,
    billingChorusServiceCode: channel?.type === 'chorus' ? (channel.chorusServiceCode ?? null) : null,
    billingPortailNom: channel?.type === 'portail' ? (channel.portailNom ?? null) : null,
    billingPortailUrl: channel?.type === 'portail' ? (channel.portailUrl ?? null) : null,
    requiresPurchaseOrder: p.requiresPurchaseOrder ?? null,
    isSubcontractingBtp: p.isSubcontractingBtp ?? false,
  };
}

interface ExpenseRow {
  id: string;
  companyId: string;
  supplierName: string;
  supplierSiren: string | null;
  documentDate: string;
  totalTtcCents: number;
  totalHtCents: number | null;
  vatCents: number | null;
  vatRatePct: number | null;
  category: string;
  status: string;
  paymentPaidOn: Date | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  paymentProofDocumentId: string | null;
  paymentEvidenceLegacyUnverified: boolean;
  source: string;
  supplierInvoiceNumber: string | null;
  dueAt: string | null;
  chantierId: string | null;
}

/**
 * Réhydrate la preuve réellement persistée. Une ligne historique est explicitement rendue sans
 * preuve ; une combinaison impossible est une corruption de stockage et fait échouer la lecture.
 */
export function expenseRowToProps(row: ExpenseRow): ExpenseProps {
  const hasStructuredEvidence = row.paymentPaidOn !== null
    || row.paymentMethod !== null
    || row.paymentReference !== null
    || row.paymentProofDocumentId !== null;
  if (row.status === 'to_pay' && (hasStructuredEvidence || row.paymentEvidenceLegacyUnverified)) {
    throw new Error(`Corrupted expense payment state for ${row.id}: unpaid expense carries payment evidence.`);
  }
  if (row.status === 'paid') {
    const structuredComplete = row.paymentPaidOn !== null && row.paymentMethod !== null;
    const legacyComplete = row.paymentEvidenceLegacyUnverified && !hasStructuredEvidence;
    if ((!structuredComplete && !legacyComplete) || (structuredComplete && row.paymentEvidenceLegacyUnverified)) {
      throw new Error(`Corrupted expense payment state for ${row.id}: paid expense evidence is incomplete.`);
    }
  }

  const paymentEvidence: ExpensePaymentEvidence | null = row.paymentPaidOn && row.paymentMethod
    ? {
        paidOn: row.paymentPaidOn.toISOString().slice(0, 10),
        method: row.paymentMethod as ExpensePaymentEvidence['method'],
        reference: row.paymentReference,
        proofDocumentId: row.paymentProofDocumentId,
      }
    : null;

  return {
    id: row.id,
    companyId: row.companyId,
    supplierName: row.supplierName,
    supplierSiren: row.supplierSiren,
    documentDate: row.documentDate,
    totalTtcCents: row.totalTtcCents,
    totalHtCents: row.totalHtCents,
    vatCents: row.vatCents,
    vatRatePct: row.vatRatePct,
    category: row.category as ExpenseCategory,
    status: row.status as ExpenseStatus,
    paymentEvidence,
    source: row.source as ExpenseSource,
    supplierInvoiceNumber: row.supplierInvoiceNumber,
    dueAt: row.dueAt,
    // Projection TOUJOURS explicite (parité domaine) : NULL = dépense hors chantier.
    chantierId: row.chantierId,
  };
}

/** Écriture explicite : aucun objet métier inconnu n'est transmis implicitement à Prisma. */
export function expensePropsToPersistence(p: ExpenseProps) {
  const evidence = p.paymentEvidence ?? null;
  if (p.status === 'to_pay' && evidence !== null) {
    throw new Error(`Invalid expense payment state for ${p.id}: unpaid expense carries payment evidence.`);
  }
  return {
    id: p.id,
    companyId: p.companyId,
    supplierName: p.supplierName,
    supplierSiren: p.supplierSiren,
    documentDate: p.documentDate,
    totalTtcCents: p.totalTtcCents,
    totalHtCents: p.totalHtCents,
    vatCents: p.vatCents,
    vatRatePct: p.vatRatePct,
    category: p.category,
    status: p.status,
    paymentPaidOn: evidence ? new Date(`${evidence.paidOn}T00:00:00.000Z`) : null,
    paymentMethod: evidence?.method ?? null,
    paymentReference: evidence?.reference ?? null,
    paymentProofDocumentId: evidence?.proofDocumentId ?? null,
    paymentEvidenceLegacyUnverified: p.status === 'paid' && evidence === null,
    source: p.source,
    supplierInvoiceNumber: p.supplierInvoiceNumber ?? null,
    dueAt: p.dueAt ?? null,
    chantierId: p.chantierId ?? null,
  };
}

interface QuoteRow {
  id: string; companyId: string; customerId: string; status: string; number: string | null;
  issuedAt: Date | null;
  validUntil: Date | null; depositPct: number | null; signerName: string | null; signedAt: Date | null;
  signatureProof: unknown;
  /** A3 — horodatage serveur de la demande d'exécution anticipée (L221-25), NULL = jamais demandée. */
  earlyExecutionRequestedAt: Date | null;
  /** A3 — qualité du client figée à la conclusion (SignQuote). NULL = signature antérieure au figeage. */
  signatureCustomerType: string | null;
  /** A3 — rétractation en ligne exercée (L221-21). NULL = jamais exercée. */
  retractedAt: Date | null;
  /** Exception dépannage urgent (L221-10, al. 2 / L221-28, 8°). NULL = jamais sollicitée. */
  urgentRepairRequestedAt: Date | null;
  purchaseOrderNumber: string | null;
  purchaseOrderReceivedAt: Date | null;
  purchaseOrderDocumentId: string | null;
  /** B3 — remise globale (exclusive : % OU montant, CHECK SQL). NULL/NULL = aucune. */
  globalDiscountPercent: { toString(): string } | null;
  globalDiscountAmountCents: number | null;
  /** B5 — retenue de garantie stipulée (loi 71-584). NULL = aucune. */
  retenueGarantiePct: { toString(): string } | null;
  /** PR-08 — site/chantier de rattachement. NULL = pièce hors site (jamais rétro-rempli). */
  chantierId: string | null;
  revision: number;
  lines: LineRow[];
}

/** Colonnes B8 partagées quotes/invoices — réhydratation du bon de commande persisté. */
interface PurchaseOrderColumns {
  purchaseOrderNumber: string | null;
  purchaseOrderReceivedAt: Date | null;
  purchaseOrderDocumentId: string | null;
}

function purchaseOrderFromRow(row: PurchaseOrderColumns): PurchaseOrderRef | null {
  if (row.purchaseOrderNumber === null) return null;
  return {
    number: row.purchaseOrderNumber,
    receivedAt: row.purchaseOrderReceivedAt ? row.purchaseOrderReceivedAt.toISOString() : null,
    documentId: row.purchaseOrderDocumentId,
  };
}

/** Écriture write-side des colonnes B8 (repositories.save) — aucune méta sans numéro. */
export function purchaseOrderToPersistence(ref: PurchaseOrderRef | null | undefined): {
  purchaseOrderNumber: string | null;
  purchaseOrderReceivedAt: Date | null;
  purchaseOrderDocumentId: string | null;
} {
  if (!ref) {
    return {
      purchaseOrderNumber: null,
      purchaseOrderReceivedAt: null,
      purchaseOrderDocumentId: null,
    };
  }
  return {
    purchaseOrderNumber: ref.number,
    purchaseOrderReceivedAt: ref.receivedAt ? new Date(ref.receivedAt) : null,
    purchaseOrderDocumentId: ref.documentId,
  };
}

const SIGNATURE_PROOF_METHODS = new Set<SignatureMethod>(['onsite_draw', 'remote_link']);
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Forme persistée de la colonne JSON `quotes.signatureProof` (R4) — voir la migration associée. */
interface PersistedSignatureProof {
  method: SignatureMethod;
  sha256?: string;
  capturedAt?: string;
}

function parsePersistedSignatureProof(value: unknown): PersistedSignatureProof | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.method !== 'string' || !SIGNATURE_PROOF_METHODS.has(row.method as SignatureMethod)) return null;
  const sha256 = typeof row.sha256 === 'string' && SHA256_HEX.test(row.sha256) ? row.sha256 : undefined;
  const capturedAt = typeof row.capturedAt === 'string' ? row.capturedAt : undefined;
  return { method: row.method as SignatureMethod, ...(sha256 ? { sha256 } : {}), ...(capturedAt ? { capturedAt } : {}) };
}

/**
 * P0 R4 — l'ancien mapper réhydratait systématiquement `method: 'draw'` : une preuve déclarée
 * par le serveur sans événement source. Désormais la méthode vient de la colonne persistée ;
 * une ligne historique sans preuve redevient `legacy_declared` (méthode inconnue, jamais
 * réinventée) et `proof` n'existe que si un hash de tracé a réellement été enregistré.
 */
const SIGNATURE_CUSTOMER_TYPES = new Set(['b2c', 'b2b', 'b2g']);

function signatureFromQuoteRow(
  row: Pick<
    QuoteRow,
    'signerName' | 'signedAt' | 'signatureProof' | 'earlyExecutionRequestedAt' | 'signatureCustomerType'
  >,
): Signature | null {
  if (!row.signerName || !row.signedAt) return null;
  const base = {
    signerName: row.signerName,
    signedAt: row.signedAt.toISOString(),
    accepted: true as const,
    // A3 — demande d'exécution anticipée (L221-25) : réhydratée depuis son horodatage persisté,
    // ABSENTE si NULL — jamais fabriquée (une signature legacy sans demande reste gelable).
    ...(row.earlyExecutionRequestedAt
      ? { earlyExecution: { requestedAt: row.earlyExecutionRequestedAt.toISOString() } }
      : {}),
    // A3 — qualité du client FIGÉE à la conclusion : réhydratée telle quelle, ABSENTE si NULL
    // (signature antérieure au figeage — les gardes retombent sur le type courant, jamais inventé).
    ...(row.signatureCustomerType !== null && SIGNATURE_CUSTOMER_TYPES.has(row.signatureCustomerType)
      ? { customerType: row.signatureCustomerType as Signature['customerType'] }
      : {}),
  };
  const persisted = parsePersistedSignatureProof(row.signatureProof);
  if (!persisted) return { ...base, method: 'legacy_declared' };
  return {
    ...base,
    method: persisted.method,
    ...(persisted.sha256 && persisted.capturedAt
      ? { proof: { method: persisted.method, sha256: persisted.sha256, capturedAt: persisted.capturedAt } }
      : {}),
  };
}

/** Sérialisation write-side de la preuve (repositories.save) — null pour les signatures legacy. */
export function signatureProofToPersistence(signature: Signature | null): PersistedSignatureProof | null {
  if (!signature || signature.method === 'legacy_declared') return null;
  return {
    method: signature.method,
    ...(signature.proof ? { sha256: signature.proof.sha256, capturedAt: signature.proof.capturedAt } : {}),
  };
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
    // A1 : date d'établissement dérivée à l'envoi — NULL honnête pour les devis legacy.
    issuedAt: toDateOnly(row.issuedAt),
    signature: signatureFromQuoteRow(row),
    // A3 : rétractation en ligne (L221-21) — NULL honnête pour les devis jamais rétractés.
    retractedAt: row.retractedAt ? row.retractedAt.toISOString() : null,
    // Exception dépannage urgent (L221-10, al. 2) — NULL honnête : jamais inventée à la relecture.
    urgentRepair: row.urgentRepairRequestedAt
      ? { requestedAt: row.urgentRepairRequestedAt.toISOString() }
      : null,
    purchaseOrder: purchaseOrderFromRow(row),
    // B3/B5 : remise globale et retenue de garantie — undefined (jamais inventées) quand NULL.
    globalDiscount:
      discountFromColumns(
        { percent: row.globalDiscountPercent, amountCents: row.globalDiscountAmountCents },
        `quote ${row.id}`,
      ) ?? null,
    retenueGarantiePct:
      row.retenueGarantiePct === null ? null : Number(row.retenueGarantiePct.toString()),
    // PR-08 : site de rattachement — NULL honnête (jamais inventé à la relecture).
    chantierId: row.chantierId,
    revision: row.revision,
  };
}

export interface InvoicePredecessorRow {
  sourceInvoiceId: string;
  kind: string;
  number: string;
  issuedAt: Date;
  position: number;
}

export function invoicePredecessorRowToSnapshot(
  row: InvoicePredecessorRow,
): PrecedingInvoiceSnapshot {
  const kind = docKindToInvoiceKind(row.kind);
  if (kind !== 'deposit' && kind !== 'situation') {
    throw new Error(`Corrupted invoice predecessor ${row.sourceInvoiceId}: unsupported kind ${row.kind}.`);
  }
  return {
    invoiceId: row.sourceInvoiceId,
    kind,
    number: row.number,
    issuedAt: row.issuedAt.toISOString().slice(0, 10),
  };
}

export function invoicePredecessorToCreate(
  predecessor: PrecedingInvoiceSnapshot,
  owner: { companyId: string; invoiceId: string },
  position: number,
) {
  return {
    companyId: owner.companyId,
    invoiceId: owner.invoiceId,
    sourceInvoiceId: predecessor.invoiceId,
    kind: invoiceKindToDocKind(predecessor.kind),
    number: predecessor.number,
    issuedAt: new Date(`${predecessor.issuedAt}T00:00:00.000Z`),
    position,
  };
}

interface InvoiceRow {
  id: string; companyId: string; customerId: string; kind: string; status: string; number: string | null;
  issuedAt: Date | null; dueAt: Date | null; parentQuoteId: string | null; depositPct: number | null;
  servicePeriodStart: Date | null; servicePeriodEnd: Date | null; deliveryAddress: string | null;
  sourceInvoiceId: string | null; sourceInvoiceKind: string | null; sourceInvoiceNumber: string | null;
  sourceInvoiceIssuedAt: Date | null;
  depositDeductionCents: number; depositInvoiceId: string | null;
  settlementSemanticsVersion: number;
  paidCents: number; totalsHt: number; totalsVat: number; totalsTtc: number; totalsNetToPay: number;
  totalsDuePayableCents: number | null;
  vatByRate: unknown; legalMentions: string[];
  /** B3/B5 — compléments de totaux : présents UNIQUEMENT quand le fait existe (NULL sinon). */
  totalsGrossHt: number | null;
  totalsDiscountCents: number | null;
  totalsRetenueGarantieCents: number | null;
  /** B2 — situation de travaux : n° d'ordre + part « situations » de la déduction de la finale. */
  situationOrder: number | null;
  situationDeductionCents: number;
  /** B3 — remise globale (exclusive : % OU montant). NULL/NULL = aucune. */
  globalDiscountPercent: { toString(): string } | null;
  globalDiscountAmountCents: number | null;
  /** B5 — retenue de garantie applicable. NULL = aucune. */
  retenueGarantiePct: { toString(): string } | null;
  /** B1/A3bis — qualification d'urgence de la facture directe B2C. NULL = jamais sollicitée. */
  urgentRepairRequestedAt: Date | null;
  /** Suivi MANUEL de transmission (mutable après émission). NULL = jamais suivi. */
  transmissionDepositedAt: Date | null;
  transmissionAcceptedAt: Date | null;
  /** A4 — régime de TVA figé à l'émission. NULL = pièce émise avant le figeage. */
  vatTreatmentAtIssuance: string | null;
  /** BT-23 — cadre France figé. NULL = archive historique. */
  frenchBillingModeAtIssuance: string | null;
  purchaseOrderNumber: string | null;
  purchaseOrderReceivedAt: Date | null;
  purchaseOrderDocumentId: string | null;
  /** PR-08 — site/chantier de rattachement. NULL = pièce hors site (jamais rétro-rempli). */
  chantierId: string | null;
  revision: number;
  lines: LineRow[];
  precedingInvoices: InvoicePredecessorRow[];
}

export function invoiceRowToSnapshot(row: InvoiceRow): InvoiceSnapshot {
  const status = row.status as InvoiceStatus;
  const kind = docKindToInvoiceKind(row.kind);
  if (row.settlementSemanticsVersion !== 1 && row.settlementSemanticsVersion !== 2) {
    throw new Error(
      `Corrupted settlement semantics for invoice ${row.id}: version ${row.settlementSemanticsVersion}.`,
    );
  }
  const expectedDuePayable = row.totalsNetToPay + (row.totalsRetenueGarantieCents ?? 0);
  if (
    row.settlementSemanticsVersion === 2
    && row.totalsDuePayableCents !== expectedDuePayable
  ) {
    throw new Error(
      `Corrupted settlement semantics for invoice ${row.id}: due payable must equal `
      + `net to pay plus retention (${expectedDuePayable}).`,
    );
  }
  const frozen: Totals | null =
    status === 'draft' && kind !== 'credit_note'
      ? null
      : {
          ht: row.totalsHt,
          vat: row.totalsVat,
          ttc: row.totalsTtc,
          netToPay: row.totalsNetToPay,
          ...(row.totalsDuePayableCents !== null
            ? { duePayableCents: row.totalsDuePayableCents }
            : {}),
          vatByRate: (row.vatByRate as Record<string, number>) ?? {},
          // B3/B5 : compléments PRÉSENTS uniquement quand le fait a été figé (NULL honnête
          // sinon — les totaux des pièces antérieures restent identiques au centime).
          ...(row.totalsGrossHt !== null ? { grossHt: row.totalsGrossHt } : {}),
          ...(row.totalsDiscountCents !== null ? { discountCents: row.totalsDiscountCents } : {}),
          ...(row.totalsRetenueGarantieCents !== null
            ? { retenueGarantieCents: row.totalsRetenueGarantieCents }
            : {}),
        };
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    kind,
    status,
    lines: row.lines.map(lineRowToQuoteLine),
    number: row.number,
    frozenTotals: frozen,
    settlementSemanticsVersion: row.settlementSemanticsVersion,
    mentions: row.legalMentions,
    issuedAt: toDateOnly(row.issuedAt),
    dueAt: toDateOnly(row.dueAt),
    // A7 : période de prestation (fin NULL = jour unique) + adresse de chantier/livraison —
    // une fin sans début serait une corruption (CHECK SQL), réhydratée null fail-closed.
    servicePeriod:
      row.servicePeriodStart === null
        ? null
        : { start: row.servicePeriodStart.toISOString().slice(0, 10), end: toDateOnly(row.servicePeriodEnd) },
    deliveryAddress: row.deliveryAddress,
    // A4 : régime figé à l'émission — une valeur hors référentiel serait une corruption (CHECK
    // SQL), réhydratée null fail-closed (dérivation dynamique, jamais un régime inventé).
    vatTreatmentAtIssuance:
      row.vatTreatmentAtIssuance === 'standard'
      || row.vatTreatmentAtIssuance === 'franchise'
      || row.vatTreatmentAtIssuance === 'autoliquidation'
        ? row.vatTreatmentAtIssuance
        : null,
    frenchBillingModeAtIssuance: isFrenchBillingMode(row.frenchBillingModeAtIssuance)
      ? row.frenchBillingModeAtIssuance
      : null,
    paid: row.paidCents,
    depositPct: row.depositPct,
    parentQuoteId: row.parentQuoteId,
    depositDeductionCents: row.depositDeductionCents ?? 0,
    depositInvoiceId: row.depositInvoiceId ?? null,
    precedingInvoices: row.precedingInvoices.map(invoicePredecessorRowToSnapshot),
    // B2/B3/B5 : situation, remise globale et retenue — NULL honnête (jamais rétro-remplis).
    situationDeductionCents: row.situationDeductionCents ?? 0,
    situationOrder: row.situationOrder,
    globalDiscount:
      discountFromColumns(
        { percent: row.globalDiscountPercent, amountCents: row.globalDiscountAmountCents },
        `invoice ${row.id}`,
      ) ?? null,
    retenueGarantiePct:
      row.retenueGarantiePct === null ? null : Number(row.retenueGarantiePct.toString()),
    // B1/A3bis : qualification d'urgence réhydratée depuis son horodatage — jamais inventée.
    urgentRepair: row.urgentRepairRequestedAt
      ? { requestedAt: row.urgentRepairRequestedAt.toISOString() }
      : null,
    // Suivi de transmission : une acceptation sans dépôt serait une corruption (CHECK SQL),
    // réhydratée null fail-closed (jamais un suivi incohérent présenté à l'artisan).
    transmission:
      row.transmissionDepositedAt === null
        ? null
        : {
            depositedAt: row.transmissionDepositedAt.toISOString().slice(0, 10),
            acceptedAt: toDateOnly(row.transmissionAcceptedAt),
          },
    sourceInvoiceId: row.sourceInvoiceId,
    sourceInvoiceKind:
      row.sourceInvoiceKind === null
        ? null
        : (docKindToInvoiceKind(row.sourceInvoiceKind) as CreditedInvoiceKind),
    sourceInvoiceNumber: row.sourceInvoiceNumber,
    sourceInvoiceIssuedAt: toDateOnly(row.sourceInvoiceIssuedAt),
    purchaseOrder: purchaseOrderFromRow(row),
    // PR-08 : site de rattachement — NULL honnête (jamais inventé à la relecture).
    chantierId: row.chantierId,
    revision: row.revision,
  };
}
