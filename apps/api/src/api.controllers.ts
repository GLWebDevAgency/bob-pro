import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Headers,
  Param,
  Query,
  Header,
  HttpException,
  HttpStatus,
  HttpCode,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type {
  CreateQuoteInput,
  Scenario,
  Horizon,
  PaymentMethod,
  PlanTier,
  CompanyProps,
  CustomerProps,
  RecordExpenseInput,
  CreateChantierInput,
  DocumentKind,
  DocumentLinkedEntityType,
  ExpenseCategory,
  DeleteDocumentFolderStrategy,
  UpdateQuoteLineInput,
  SalesDocumentSearchScope,
  CatalogueItemWriteInput,
  Trade,
  VatRegime,
  CustomerPortfolio,
} from '@bob/core';
import { Iban, isCatalogueCategory, isValidDateOnly, isVatRate } from '@bob/core';
import { type AgentAskPayload } from '@bob/ai';
import { Throttle } from '@nestjs/throttler';
import { BackendService, type FacturXImportDecision, type UploadDocumentInput } from './backend.service';
import { RelanceService } from './jobs/relance.service';
import { DocumentArchiveService } from './jobs/document-archive.service';
import { NotificationsApiService } from './notifications/notifications-api.service';
import {
  PUBLIC_PUSH_CAPABILITY_LIMIT,
  PUBLIC_PUSH_CAPABILITY_THROTTLER,
  PUBLIC_PUSH_IP_LIMIT,
  PUBLIC_PUSH_THROTTLE_TTL_MS,
  PublicPushCapabilityThrottle,
} from './notifications/push-revocation-throttle';
import { DigestService } from './jobs/digest.service';
import { unwrap } from './http/result';
import { readReleaseMetadata } from './release-metadata';
import { WithoutTenantPersistenceTransaction } from './persistence/tenant-persistence.interceptor';
import { clientIpSourceForRequest } from './config/client-ip';

function assertJsonObjectBody(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException(
      { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Corps JSON objet requis.' }] } },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const RECORD_EXPENSE_FIELDS = new Set([
  'idempotencyKey',
  'supplierName',
  'supplierSiren',
  'documentDate',
  'totalTtcCents',
  'totalHtCents',
  'vatCents',
  'vatRatePct',
  'category',
  'source',
  'supplierInvoiceNumber',
  'dueAt',
]);
const CREATE_QUOTE_FIELDS = new Set([
  'idempotencyKey',
  'customerId',
  'lines',
  'depositPct',
  'validUntil',
  'context',
]);
const CREATE_QUOTE_LINE_FIELDS = new Set(['label', 'category', 'qty', 'unit', 'unitPriceHT', 'vatRate']);
const CREATE_QUOTE_CONTEXT_FIELDS = new Set(['housingOlderThan2y', 'energyRenovation']);
const INVOICE_GENERATION_FIELDS = new Set(['mode']);
const QUOTE_LINE_PATCH_FIELDS = new Set(['label', 'qty', 'unitPriceHT', 'vatRate']);
const SIGN_QUOTE_FIELDS = new Set(['signerName', 'proofDataUrl']);
const CATALOGUE_ITEM_FIELDS = new Set(['label', 'category', 'unit', 'unitPriceHT', 'vatRate']);
const CATALOGUE_ITEM_UPDATE_FIELDS = new Set([...CATALOGUE_ITEM_FIELDS, 'expectedRevision']);
const COMPANY_PROFILE_FIELDS = new Set(['trade', 'vatRegime', 'customerPortfolio']);
/** Réglages facturation §Coordonnées bancaires (RIB) — champs déjà persistés (CompanyProps.iban/
 * bic) mais jusqu'ici jamais éditables : seul endpoint qui les écrit après l'onboarding. */
const COMPANY_BILLING_FIELDS = new Set(['iban', 'bic']);
const BIC_PATTERN = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/;
const MANUAL_BANK_BALANCE_FIELDS = new Set(['amountCents', 'observedAt']);
const CREATE_CUSTOMER_FIELDS = new Set([
  'type',
  'name',
  'siren',
  'address',
  'email',
  'phone',
  'paymentTermsLabel',
  'isInternational',
  'isSubcontractingBtp',
]);
const CUSTOMER_ADDRESS_FIELDS = new Set(['line1', 'zip', 'city']);
const TRADES = new Set<Trade>([
  'plombier',
  'electricien',
  'macon',
  'peintre',
  'paysagiste',
  'consultant',
  'freelance_it',
  'photographe',
  'coach',
  'autre',
]);
const VAT_REGIMES = new Set<VatRegime>(['franchise', 'reel_simpl', 'reel_normal']);
const CUSTOMER_PORTFOLIOS = new Set<CustomerPortfolio>(['b2c', 'b2b', 'b2g', 'mixte']);
// Tracé du pad : dataURL SVG/PNG de quelques Ko en pratique — borne large mais finie (anti-DoS).
const SIGN_PROOF_MAX_CHARS = 512_000;
const QUOTE_LINE_CATEGORIES = new Set(['labor', 'supply', 'travel', 'disbursement', 'subscription']);
const QUOTE_VAT_RATES = new Set([0, 2.1, 5.5, 10, 20]);
const MAX_QUOTE_LINES = 100;
const MAX_QUOTE_HT_CENTS = 1_500_000_000;
const DOCUMENT_EXPENSE_FIELDS = new Set(
  [...RECORD_EXPENSE_FIELDS].filter((field) => field !== 'idempotencyKey' && field !== 'source'),
);
const DOCUMENT_EXPENSE_BODY_FIELDS = new Set(['expectedRevision', 'targetFolderId', 'expense']);
const EXPENSE_CATEGORIES = new Set(['fournitures', 'materiel', 'carburant', 'repas', 'sous_traitance', 'autre']);
const EXPENSE_SOURCES = new Set(['ocr', 'manual', 'facturx']);
const DOCUMENT_UPLOAD_FIELDS = new Set([
  'contentBase64',
  'mimeType',
  'filename',
  'kind',
  'linkedEntityType',
  'linkedEntityId',
  'documentDate',
  'folderId',
  'tags',
]);
const DOCUMENT_CLASSIFY_FIELDS = new Set(['linkedEntityType', 'linkedEntityId', 'expectedRevision']);
const DOCUMENT_KINDS = new Set<DocumentKind>([
  'invoice_pdf',
  'quote_pdf',
  'facturx_xml',
  'expense_receipt',
  'signed_quote',
  'other',
]);
const DOCUMENT_LINK_TYPES = new Set<DocumentLinkedEntityType>(['invoice', 'quote', 'expense', 'chantier', 'company']);

type ValidationIssue = { field: string; message: string };

function throwValidationIssues(issues: ValidationIssue[]): never {
  throw new HttpException(
    { ok: false, error: { kind: 'validation', issues } },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function parseManualBankBalanceBody(body: Record<string, unknown>): {
  amountCents: number;
  observedAt: string;
} {
  const unknownField = Object.keys(body).find((field) => !MANUAL_BANK_BALANCE_FIELDS.has(field));
  if (unknownField !== undefined) {
    throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
  }
  if (!Number.isSafeInteger(body.amountCents)) {
    throwValidationIssues([{ field: 'amountCents', message: 'Solde en centimes entier requis.' }]);
  }
  if (
    typeof body.observedAt !== 'string'
    || !Number.isFinite(Date.parse(body.observedAt))
    || new Date(Date.parse(body.observedAt)).toISOString() !== body.observedAt
  ) {
    throwValidationIssues([{ field: 'observedAt', message: 'Instant ISO canonique requis.' }]);
  }
  return { amountCents: body.amountCents as number, observedAt: body.observedAt };
}

function parseCreateCustomerBody(
  body: Record<string, unknown>,
): Omit<CustomerProps, 'id' | 'companyId'> {
  const unknownField = Object.keys(body).find((field) => !CREATE_CUSTOMER_FIELDS.has(field));
  if (unknownField !== undefined) {
    throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
  }
  if (!isJsonRecord(body.address)) {
    throwValidationIssues([{ field: 'address', message: 'Adresse objet requise.' }]);
  }
  const unknownAddressField = Object.keys(body.address).find(
    (field) => !CUSTOMER_ADDRESS_FIELDS.has(field),
  );
  if (unknownAddressField !== undefined) {
    throwValidationIssues([{
      field: `address.${unknownAddressField}`,
      message: 'Champ non autorisé.',
    }]);
  }
  const validOptionalString = (value: unknown) => value === undefined || typeof value === 'string';
  const validOptionalBoolean = (value: unknown) =>
    value === undefined || typeof value === 'boolean';
  if (
    (body.type !== 'b2c' && body.type !== 'b2b' && body.type !== 'b2g')
    || typeof body.name !== 'string'
    || typeof body.address.line1 !== 'string'
    || typeof body.address.zip !== 'string'
    || typeof body.address.city !== 'string'
    || !validOptionalString(body.siren)
    || !validOptionalString(body.email)
    || !validOptionalString(body.phone)
    || !validOptionalString(body.paymentTermsLabel)
    || !validOptionalBoolean(body.isInternational)
    || !validOptionalBoolean(body.isSubcontractingBtp)
  ) {
    throwValidationIssues([{ field: 'body', message: 'Fiche client invalide.' }]);
  }
  return {
    type: body.type,
    name: body.name,
    address: {
      line1: body.address.line1,
      zip: body.address.zip,
      city: body.address.city,
    },
    ...(body.siren !== undefined ? { siren: body.siren as string } : {}),
    ...(body.email !== undefined ? { email: body.email as string } : {}),
    ...(body.phone !== undefined ? { phone: body.phone as string } : {}),
    ...(body.paymentTermsLabel !== undefined
      ? { paymentTermsLabel: body.paymentTermsLabel as string }
      : {}),
    ...(body.isInternational !== undefined
      ? { isInternational: body.isInternational as boolean }
      : {}),
    ...(body.isSubcontractingBtp !== undefined
      ? { isSubcontractingBtp: body.isSubcontractingBtp as boolean }
      : {}),
  };
}

function parseCatalogueItemBody(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): { item: CatalogueItemWriteInput; expectedRevision?: number } {
  const allowed = mode === 'create' ? CATALOGUE_ITEM_FIELDS : CATALOGUE_ITEM_UPDATE_FIELDS;
  const unknownField = Object.keys(body).find((field) => !allowed.has(field));
  if (unknownField !== undefined) {
    throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
  }
  const unit = body.unit;
  const valid =
    typeof body.label === 'string'
    && isCatalogueCategory(body.category)
    && (unit === null || typeof unit === 'string')
    && Number.isSafeInteger(body.unitPriceHT)
    && typeof body.vatRate === 'number'
    && isVatRate(body.vatRate);
  const revision = body.expectedRevision;
  const validRevision = mode === 'create'
    || (Number.isSafeInteger(revision) && (revision as number) >= 1);
  if (!valid || !validRevision) {
    throwValidationIssues([{ field: 'body', message: 'Prestation catalogue invalide.' }]);
  }
  const item: CatalogueItemWriteInput = {
    label: body.label as string,
    category: body.category as CatalogueItemWriteInput['category'],
    unit: unit as string | null,
    unitPriceHT: body.unitPriceHT as number,
    vatRate: body.vatRate as CatalogueItemWriteInput['vatRate'],
  };
  return mode === 'update'
    ? { item, expectedRevision: revision as number }
    : { item };
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function hasForbiddenSignerCharacter(value: string): boolean {
  if (hasControlCharacter(value)) return true;
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code >= 0x80 && code <= 0x9f)
      || (code >= 0x200b && code <= 0x200d)
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069)
      || code === 0xfeff
    );
  });
}

function parseInvoiceGenerationBody(body: Record<string, unknown>): { mode: 'deposit' | 'final' } {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!INVOICE_GENERATION_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const mode = body['mode'];
  if (mode !== 'deposit' && mode !== 'final') {
    issues.push({ field: 'mode', message: 'Mode de facture requis (deposit | final).' });
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return { mode: mode as 'deposit' | 'final' };
}

function parseSignQuoteBody(body: Record<string, unknown>): { signerName: string; proofDataUrl?: string } {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!SIGN_QUOTE_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const value = body['signerName'];
  if (
    typeof value !== 'string'
    || value.trim().length < 2
    || value.length > 120
    || hasForbiddenSignerCharacter(value)
  ) {
    issues.push({ field: 'signerName', message: 'Nom du signataire invalide.' });
  }
  // R4 : tracé du pad (dataURL image), OPTIONNEL — jamais persisté tel quel, le serveur en
  // calcule le SHA-256 (preuve d'intégrité). Absent = signature sans capture (preuve absente,
  // jamais fabriquée).
  const proof = body['proofDataUrl'];
  if (proof !== undefined) {
    if (
      typeof proof !== 'string'
      || !proof.startsWith('data:image/')
      || proof.length > SIGN_PROOF_MAX_CHARS
      || hasControlCharacter(proof)
    ) {
      issues.push({ field: 'proofDataUrl', message: 'Tracé de signature invalide.' });
    }
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    signerName: (value as string).trim().replace(/\s+/g, ' '),
    ...(proof !== undefined ? { proofDataUrl: proof as string } : {}),
  };
}

function parseQuoteLinePatchBody(body: Record<string, unknown>): UpdateQuoteLineInput['patch'] {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!QUOTE_LINE_PATCH_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  if (![...QUOTE_LINE_PATCH_FIELDS].some((field) => Object.hasOwn(body, field))) {
    issues.push({ field: 'body', message: 'Au moins un champ modifiable est requis.' });
  }

  const patch: UpdateQuoteLineInput['patch'] = {};
  if (Object.hasOwn(body, 'label')) {
    const value = body['label'];
    if (
      typeof value !== 'string'
      || value.trim().length === 0
      || value.length > 500
      || hasControlCharacter(value)
    ) {
      issues.push({ field: 'label', message: 'Libellé requis (500 caractères maximum).' });
    } else {
      patch.label = value.trim();
    }
  }
  if (Object.hasOwn(body, 'qty')) {
    const value = body['qty'];
    if (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || value <= 0
      || value > 1_000_000
      || Math.round(value * 1_000) !== value * 1_000
    ) {
      issues.push({ field: 'qty', message: 'Quantité positive avec 3 décimales maximum requise.' });
    } else {
      patch.qty = value;
    }
  }
  if (Object.hasOwn(body, 'unitPriceHT')) {
    const value = body['unitPriceHT'];
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_QUOTE_HT_CENTS) {
      issues.push({ field: 'unitPriceHT', message: 'Prix HT en centimes invalide.' });
    } else {
      patch.unitPriceHT = value as number;
    }
  }
  if (Object.hasOwn(body, 'vatRate')) {
    const value = body['vatRate'];
    if (typeof value !== 'number' || !QUOTE_VAT_RATES.has(value)) {
      issues.push({ field: 'vatRate', message: 'Taux de TVA invalide.' });
    } else {
      patch.vatRate = value as UpdateQuoteLineInput['patch']['vatRate'];
    }
  }

  if (issues.length > 0) throwValidationIssues(issues);
  return patch;
}

function requiredExpenseString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  issues: ValidationIssue[],
): string {
  const value = body[field];
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > maxLength
    || hasControlCharacter(value)
  ) {
    issues.push({ field, message: `Texte requis (${maxLength} caractères maximum).` });
    return '';
  }
  return value;
}

function optionalExpenseString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  issues: ValidationIssue[],
): string | null | undefined {
  if (!Object.hasOwn(body, field)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (
    typeof value !== 'string'
    || value.length > maxLength
    || hasControlCharacter(value)
  ) {
    issues.push({ field, message: `Texte attendu (${maxLength} caractères maximum).` });
    return undefined;
  }
  return value;
}

function requiredExpenseInteger(
  body: Record<string, unknown>,
  field: string,
  issues: ValidationIssue[],
): number {
  const value = body[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    issues.push({ field, message: 'Entier positif ou nul attendu.' });
    return 0;
  }
  return value as number;
}

function optionalExpenseInteger(
  body: Record<string, unknown>,
  field: string,
  issues: ValidationIssue[],
): number | null | undefined {
  if (!Object.hasOwn(body, field)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    issues.push({ field, message: 'Entier positif, nul ou null attendu.' });
    return undefined;
  }
  return value as number;
}

function parseCreateQuoteBody(body: Record<string, unknown>): Omit<CreateQuoteInput, 'companyId'> {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!CREATE_QUOTE_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }

  const customerId = body['customerId'];
  if (
    typeof customerId !== 'string'
    || customerId.length === 0
    || customerId.length > 240
    || customerId !== customerId.trim()
    || hasControlCharacter(customerId)
  ) {
    issues.push({ field: 'customerId', message: 'Identifiant client invalide.' });
  }

  const rawKey = body['idempotencyKey'];
  if (
    rawKey !== undefined
    && rawKey !== null
    && (
      typeof rawKey !== 'string'
      || rawKey.trim().length === 0
      || rawKey.length > 200
      || hasControlCharacter(rawKey)
    )
  ) {
    issues.push({ field: 'idempotencyKey', message: "Clé d'idempotence invalide (1 à 200 caractères imprimables)." });
  }

  const rawLines = body['lines'];
  const lines: CreateQuoteInput['lines'] = [];
  let totalHtCents = 0;
  if (!Array.isArray(rawLines) || rawLines.length > MAX_QUOTE_LINES) {
    issues.push({ field: 'lines', message: `Tableau requis (${MAX_QUOTE_LINES} lignes maximum).` });
  } else {
    rawLines.forEach((rawLine, index) => {
      const prefix = `lines.${index}`;
      if (rawLine === null || typeof rawLine !== 'object' || Array.isArray(rawLine)) {
        issues.push({ field: prefix, message: 'Ligne objet requise.' });
        return;
      }
      const line = rawLine as Record<string, unknown>;
      for (const field of Object.keys(line)) {
        if (!CREATE_QUOTE_LINE_FIELDS.has(field)) {
          issues.push({ field: prefix, message: `Champ non autorisé : ${field}.` });
        }
      }
      const label = line['label'];
      if (
        typeof label !== 'string'
        || label.trim().length === 0
        || label.length > 500
        || hasControlCharacter(label)
      ) {
        issues.push({ field: `${prefix}.label`, message: 'Libellé requis (500 caractères maximum).' });
      }
      const category = line['category'];
      if (typeof category !== 'string' || !QUOTE_LINE_CATEGORIES.has(category)) {
        issues.push({ field: `${prefix}.category`, message: 'Catégorie de ligne invalide.' });
      }
      const qty = line['qty'];
      if (
        typeof qty !== 'number'
        || !Number.isFinite(qty)
        || qty <= 0
        || qty > 1_000_000
        || Math.round(qty * 1_000) !== qty * 1_000
      ) {
        issues.push({ field: `${prefix}.qty`, message: 'Quantité positive avec 3 décimales maximum requise.' });
      }
      const unit = line['unit'];
      if (
        unit !== undefined
        && (
          typeof unit !== 'string'
          || unit.trim().length === 0
          || unit.length > 80
          || hasControlCharacter(unit)
        )
      ) {
        issues.push({ field: `${prefix}.unit`, message: 'Unité invalide (80 caractères maximum).' });
      }
      const unitPriceHT = line['unitPriceHT'];
      if (!Number.isSafeInteger(unitPriceHT) || (unitPriceHT as number) < 0 || (unitPriceHT as number) > MAX_QUOTE_HT_CENTS) {
        issues.push({ field: `${prefix}.unitPriceHT`, message: 'Prix HT en centimes invalide.' });
      }
      const vatRate = line['vatRate'];
      if (typeof vatRate !== 'number' || !QUOTE_VAT_RATES.has(vatRate)) {
        issues.push({ field: `${prefix}.vatRate`, message: 'Taux de TVA invalide.' });
      }

      if (
        typeof qty === 'number'
        && Number.isFinite(qty)
        && Number.isSafeInteger(unitPriceHT)
        && (unitPriceHT as number) >= 0
      ) {
        totalHtCents += Math.round(qty * (unitPriceHT as number));
      }
      if (
        typeof label === 'string'
        && typeof category === 'string'
        && QUOTE_LINE_CATEGORIES.has(category)
        && typeof qty === 'number'
        && Number.isFinite(qty)
        && Number.isSafeInteger(unitPriceHT)
        && typeof vatRate === 'number'
        && QUOTE_VAT_RATES.has(vatRate)
      ) {
        lines.push({
          label,
          category: category as CreateQuoteInput['lines'][number]['category'],
          qty,
          ...(typeof unit === 'string' ? { unit } : {}),
          unitPriceHT: unitPriceHT as number,
          vatRate: vatRate as CreateQuoteInput['lines'][number]['vatRate'],
        });
      }
    });
  }
  if (totalHtCents > MAX_QUOTE_HT_CENTS) {
    issues.push({ field: 'lines', message: 'Montant total HT du devis hors limite.' });
  }

  const depositPct = body['depositPct'];
  if (
    depositPct !== undefined
    && (
      typeof depositPct !== 'number'
      || !Number.isFinite(depositPct)
      || depositPct < 0
      || depositPct > 100
    )
  ) {
    issues.push({ field: 'depositPct', message: 'Pourcentage d\'acompte invalide.' });
  }

  const validUntil = body['validUntil'];
  if (validUntil !== undefined && (typeof validUntil !== 'string' || !isValidDateOnly(validUntil))) {
    issues.push({ field: 'validUntil', message: 'Date de validité invalide (AAAA-MM-JJ).' });
  }

  const rawContext = body['context'];
  let context: CreateQuoteInput['context'];
  if (rawContext !== undefined) {
    if (rawContext === null || typeof rawContext !== 'object' || Array.isArray(rawContext)) {
      issues.push({ field: 'context', message: 'Contexte objet requis.' });
    } else {
      const candidate = rawContext as Record<string, unknown>;
      for (const field of Object.keys(candidate)) {
        if (!CREATE_QUOTE_CONTEXT_FIELDS.has(field)) {
          issues.push({ field: 'context', message: `Champ non autorisé : ${field}.` });
        }
      }
      for (const field of CREATE_QUOTE_CONTEXT_FIELDS) {
        if (candidate[field] !== undefined && typeof candidate[field] !== 'boolean') {
          issues.push({ field: `context.${field}`, message: 'Booléen attendu.' });
        }
      }
      if (
        (candidate['housingOlderThan2y'] === undefined || typeof candidate['housingOlderThan2y'] === 'boolean')
        && (candidate['energyRenovation'] === undefined || typeof candidate['energyRenovation'] === 'boolean')
      ) {
        context = {
          ...(typeof candidate['housingOlderThan2y'] === 'boolean'
            ? { housingOlderThan2y: candidate['housingOlderThan2y'] }
            : {}),
          ...(typeof candidate['energyRenovation'] === 'boolean'
            ? { energyRenovation: candidate['energyRenovation'] }
            : {}),
        };
      }
    }
  }

  if (issues.length > 0) throwValidationIssues(issues);
  return {
    customerId: customerId as string,
    lines,
    ...(rawKey !== undefined ? { idempotencyKey: rawKey as string | null } : {}),
    ...(typeof depositPct === 'number' ? { depositPct } : {}),
    ...(typeof validUntil === 'string' ? { validUntil } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}

/** Frontière HTTP stricte : aucun champ client ne peut atteindre le métier par simple cast/spread. */
function parseRecordExpenseBody(
  body: Record<string, unknown>,
  allowedFields: ReadonlySet<string> = RECORD_EXPENSE_FIELDS,
): Omit<RecordExpenseInput, 'companyId'> {
  const issues: ValidationIssue[] = [];
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    issues.push({ field: 'body', message: 'Le corps contient un champ non autorisé.' });
  }

  const supplierName = requiredExpenseString(body, 'supplierName', 240, issues);
  const documentDate = requiredExpenseString(body, 'documentDate', 10, issues);
  const totalTtcCents = requiredExpenseInteger(body, 'totalTtcCents', issues);
  const supplierSiren = optionalExpenseString(body, 'supplierSiren', 32, issues);
  const totalHtCents = optionalExpenseInteger(body, 'totalHtCents', issues);
  const vatCents = optionalExpenseInteger(body, 'vatCents', issues);
  const supplierInvoiceNumber = optionalExpenseString(body, 'supplierInvoiceNumber', 120, issues);
  const dueAt = optionalExpenseString(body, 'dueAt', 10, issues);
  const idempotencyKey = optionalExpenseString(body, 'idempotencyKey', 200, issues);

  const category = body.category;
  if (typeof category !== 'string' || !EXPENSE_CATEGORIES.has(category)) {
    issues.push({ field: 'category', message: 'Catégorie de dépense inconnue.' });
  }
  const source = Object.hasOwn(body, 'source') ? body.source : undefined;
  if (source !== undefined && (typeof source !== 'string' || !EXPENSE_SOURCES.has(source))) {
    issues.push({ field: 'source', message: 'Source de dépense inconnue.' });
  }
  const vatRatePct = Object.hasOwn(body, 'vatRatePct') ? body.vatRatePct : undefined;
  if (
    vatRatePct !== undefined
    && vatRatePct !== null
    && (typeof vatRatePct !== 'number' || !Number.isFinite(vatRatePct) || vatRatePct < 0 || vatRatePct > 100)
  ) {
    issues.push({ field: 'vatRatePct', message: 'Taux de TVA attendu entre 0 et 100.' });
  }

  if (issues.length > 0) throwValidationIssues(issues);
  return {
    supplierName,
    documentDate,
    totalTtcCents,
    category: category as RecordExpenseInput['category'],
    ...(supplierSiren !== undefined ? { supplierSiren } : {}),
    ...(totalHtCents !== undefined ? { totalHtCents } : {}),
    ...(vatCents !== undefined ? { vatCents } : {}),
    ...(vatRatePct !== undefined ? { vatRatePct: vatRatePct as number | null } : {}),
    ...(source !== undefined ? { source: source as NonNullable<RecordExpenseInput['source']> } : {}),
    ...(supplierInvoiceNumber !== undefined ? { supplierInvoiceNumber } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

type RecordDocumentExpenseBody = {
  expectedRevision: number;
  targetFolderId: string;
  expense: Omit<RecordExpenseInput, 'companyId' | 'idempotencyKey' | 'source'>;
};

function parseRecordDocumentExpenseBody(body: Record<string, unknown>): RecordDocumentExpenseBody {
  const issues: ValidationIssue[] = [];
  if (Object.keys(body).some((field) => !DOCUMENT_EXPENSE_BODY_FIELDS.has(field))) {
    issues.push({ field: 'body', message: 'Le corps contient un champ non autorisé.' });
  }

  const expectedRevision = body.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    issues.push({ field: 'expectedRevision', message: 'Révision document positive attendue.' });
  }
  const targetFolderId = body.targetFolderId;
  if (
    typeof targetFolderId !== 'string'
    || targetFolderId.length === 0
    || targetFolderId.length > 200
    || targetFolderId !== targetFolderId.trim()
    || hasControlCharacter(targetFolderId)
  ) {
    issues.push({ field: 'targetFolderId', message: 'Identifiant de dossier canonique requis.' });
  }
  const expenseBody = body.expense;
  if (expenseBody === null || typeof expenseBody !== 'object' || Array.isArray(expenseBody)) {
    issues.push({ field: 'expense', message: 'Dépense objet requise.' });
  }
  if (issues.length > 0) throwValidationIssues(issues);

  // Le parseur financier reste l'unique frontière de validation. Dans ce workflow, la source
  // et la clé d'idempotence sont exclusivement décidées par le serveur à partir de l'original.
  const expense = parseRecordExpenseBody(
    expenseBody as Record<string, unknown>,
    DOCUMENT_EXPENSE_FIELDS,
  );
  return {
    expectedRevision: expectedRevision as number,
    targetFolderId: targetFolderId as string,
    expense,
  };
}

function canonicalDocumentString(
  value: unknown,
  field: string,
  maxLength: number,
  issues: ValidationIssue[],
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || hasControlCharacter(value)
  ) {
    issues.push({ field, message: `Texte canonique requis (${maxLength} caractères maximum).` });
    return '';
  }
  return value;
}

function parseUploadDocumentBody(body: Record<string, unknown>): UploadDocumentInput {
  const issues: ValidationIssue[] = [];
  if (Object.keys(body).some((field) => !DOCUMENT_UPLOAD_FIELDS.has(field))) {
    issues.push({ field: 'body', message: 'Le corps contient un champ non autorisé.' });
  }

  const contentBase64 = body.contentBase64;
  if (typeof contentBase64 !== 'string' || contentBase64.trim().length === 0 || contentBase64.length > 14_000_000) {
    issues.push({ field: 'contentBase64', message: 'Document base64 requis (10 Mo maximum).' });
  }
  const mimeType = canonicalDocumentString(body.mimeType, 'mimeType', 120, issues);
  const filename = canonicalDocumentString(body.filename, 'filename', 255, issues);

  const kind = Object.hasOwn(body, 'kind') ? body.kind : undefined;
  if (kind !== undefined && (typeof kind !== 'string' || !DOCUMENT_KINDS.has(kind as DocumentKind))) {
    issues.push({ field: 'kind', message: 'Type de document inconnu.' });
  }

  const hasLinkedEntityType = Object.hasOwn(body, 'linkedEntityType');
  const hasLinkedEntityId = Object.hasOwn(body, 'linkedEntityId');
  const linkedEntityType = hasLinkedEntityType ? body.linkedEntityType : undefined;
  const linkedEntityId = hasLinkedEntityId ? body.linkedEntityId : undefined;
  if (hasLinkedEntityType !== hasLinkedEntityId) {
    issues.push({ field: 'linkedEntity', message: 'Le type et l’identifiant de rattachement sont indissociables.' });
  } else if (hasLinkedEntityType) {
    const bothNull = linkedEntityType === null && linkedEntityId === null;
    const bothNonNull = linkedEntityType !== null && linkedEntityId !== null;
    if (!bothNull && !bothNonNull) {
      issues.push({ field: 'linkedEntity', message: 'Le rattachement doit être null/null ou type/id.' });
    } else if (bothNonNull) {
      if (typeof linkedEntityType !== 'string' || !DOCUMENT_LINK_TYPES.has(linkedEntityType as DocumentLinkedEntityType)) {
        issues.push({ field: 'linkedEntityType', message: 'Type de rattachement inconnu.' });
      }
      canonicalDocumentString(linkedEntityId, 'linkedEntityId', 200, issues);
    }
  }

  const documentDate = Object.hasOwn(body, 'documentDate') ? body.documentDate : undefined;
  if (documentDate !== undefined && documentDate !== null) {
    canonicalDocumentString(documentDate, 'documentDate', 10, issues);
  }
  const folderId = Object.hasOwn(body, 'folderId') ? body.folderId : undefined;
  if (folderId !== undefined && folderId !== null) {
    canonicalDocumentString(folderId, 'folderId', 200, issues);
  }

  const tags = Object.hasOwn(body, 'tags') ? body.tags : undefined;
  if (
    tags !== undefined
    && (
      !Array.isArray(tags)
      || tags.length > 16
      || tags.some((tag) => (
        typeof tag !== 'string'
        || tag.trim().length < 2
        || tag.trim().length > 32
        || hasControlCharacter(tag)
      ))
    )
  ) {
    issues.push({ field: 'tags', message: 'Au plus 16 tags texte de 2 à 32 caractères sont attendus.' });
  }

  if (issues.length > 0) throwValidationIssues(issues);
  return {
    contentBase64: contentBase64 as string,
    mimeType,
    filename,
    ...(kind !== undefined ? { kind: kind as DocumentKind } : {}),
    ...(hasLinkedEntityType
      ? {
          linkedEntityType: linkedEntityType as DocumentLinkedEntityType | null,
          linkedEntityId: linkedEntityId as string | null,
        }
      : {}),
    ...(documentDate !== undefined ? { documentDate: documentDate as string | null } : {}),
    ...(folderId !== undefined ? { folderId: folderId as string | null } : {}),
    ...(tags !== undefined ? { tags: tags as string[] } : {}),
  };
}

type ClassifyDocumentBody = {
  linkedEntityType: DocumentLinkedEntityType;
  linkedEntityId: string;
  expectedRevision: number;
};

function parseClassifyDocumentBody(body: Record<string, unknown>): ClassifyDocumentBody {
  const issues: ValidationIssue[] = [];
  if (Object.keys(body).some((field) => !DOCUMENT_CLASSIFY_FIELDS.has(field))) {
    issues.push({ field: 'body', message: 'Le corps contient un champ non autorisé.' });
  }
  const linkedEntityType = body.linkedEntityType;
  if (typeof linkedEntityType !== 'string' || !DOCUMENT_LINK_TYPES.has(linkedEntityType as DocumentLinkedEntityType)) {
    issues.push({ field: 'linkedEntityType', message: 'Type de rattachement inconnu.' });
  }
  const linkedEntityId = canonicalDocumentString(body.linkedEntityId, 'linkedEntityId', 200, issues);
  const expectedRevision = body.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    issues.push({ field: 'expectedRevision', message: 'Révision document positive attendue.' });
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    linkedEntityType: linkedEntityType as DocumentLinkedEntityType,
    linkedEntityId,
    expectedRevision: expectedRevision as number,
  };
}

@Controller('health')
export class HealthController {
  constructor(private readonly backend: BackendService) {}

  @Get()
  health() {
    return { ok: true, service: 'bob-pro-api', dataMode: 'postgresql' as const };
  }

  @Get('ready')
  async ready(@Req() request: Record<string, unknown>) {
    // C24b : sonde SANS tenant (aucun Principal sur /health ; plus de repli société de démo).
    const r = await this.backend.readiness();
    if (!r.ok) throw new HttpException({ ready: false, error: r.error }, HttpStatus.SERVICE_UNAVAILABLE);
    return {
      ready: true,
      customers: r.value.customers,
      release: readReleaseMetadata(),
      network: { clientIpSource: clientIpSourceForRequest(request) },
    };
  }
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listCustomers());
  }
  @Post()
  async create(@Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.createCustomer(parseCreateCustomerBody(body)));
  }
}

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly backend: BackendService) {}
  @Post('company')
  async company(@Body() body: Omit<CompanyProps, 'id'>) {
    return unwrap(await this.backend.registerCompany(body));
  }
}

/**
 * DELETE /account (Apple 5.1.1(v)) — clôture DÉFINITIVE et IRRÉVERSIBLE du compte courant.
 * Controller MINCE : validation de forme + délégation (cf. BackendService.closeAccount pour
 * l'orchestration complète). `@WithoutTenantPersistenceTransaction` : la transaction tenant HTTP
 * automatique n'est PAS ouverte ici — closeAccount gère elle-même son runWithTenant COURT (DB
 * only) puis appelle Supabase Admin (I/O externe) APRÈS commit, hors transaction (même posture
 * que l'upload/intake documents).
 */
@Controller('account')
export class AccountController {
  constructor(private readonly backend: BackendService) {}
  @Delete()
  @WithoutTenantPersistenceTransaction()
  async close(@Body() body: { confirmationText?: string; reason?: string }) {
    return unwrap(
      await this.backend.closeAccount({
        confirmationText: typeof body?.confirmationText === 'string' ? body.confirmationText : '',
        reason: typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : null,
      }),
    );
  }
}

@Controller('diagnostic')
export class DiagnosticController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async get() {
    return unwrap(await this.backend.getDiagnostic());
  }
}

@Controller('profile')
export class ProfileController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async get() {
    return unwrap(await this.backend.getProfile());
  }
}

/** Échéancier fiscal (C-EXP5b) : dates dérivées de la fiche société du tenant par
 * deriveFiscalCalendar (@bob/core) — mêmes règles pour l'API, la démo locale et l'outil agent.
 * JWT + tenant requis (guard global, comme /diagnostic — aucune liste blanche). */
@Controller('fiscal-calendar')
export class FiscalCalendarController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async get() {
    return unwrap(await this.backend.getFiscalCalendar());
  }
}

@Controller('company')
export class CompanyLookupController {
  constructor(private readonly backend: BackendService) {}
  // PUBLIC assumé (guard C24b) : à l'étape SIRET de l'inscription, l'utilisateur n'a pas encore
  // de compte (aucun JWT possible) et les données renvoyées sont l'annuaire OFFICIEL public
  // (Recherche d'entreprises) — zéro donnée tenant. Garde-fou : ce throttle 20/min par IP
  // (anti-abus + protège le quota amont 7 req/s).
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Get('lookup')
  async lookup(@Query('siret') siret: string) {
    return unwrap(await this.backend.lookupCompany(siret ?? ''));
  }
  /** GET /company/me (PONT-SERVEUR v1) : la fiche société du tenant (CompanyProps complet) —
   * JWT + tenant REQUIS (le guard ne blanchit que GET /company/lookup, chemin exact). Débloque
   * l'identité en mode connecté (useIdentity lit ENFIN la raison sociale de la BDD). */
  @Get('me')
  async me() {
    return unwrap(await this.backend.getCompanyMe());
  }

  @Patch('profile')
  async updateProfile(@Body() body: unknown) {
    assertJsonObjectBody(body);
    const unknownField = Object.keys(body).find((field) => !COMPANY_PROFILE_FIELDS.has(field));
    if (
      unknownField !== undefined
      || typeof body.trade !== 'string'
      || !TRADES.has(body.trade as Trade)
      || typeof body.vatRegime !== 'string'
      || !VAT_REGIMES.has(body.vatRegime as VatRegime)
      || (
        body.customerPortfolio !== undefined
        && (
          typeof body.customerPortfolio !== 'string'
          || !CUSTOMER_PORTFOLIOS.has(body.customerPortfolio as CustomerPortfolio)
        )
      )
    ) {
      throwValidationIssues([{
        field: unknownField ?? 'body',
        message: unknownField === undefined ? 'Profil entreprise invalide.' : 'Champ non autorisé.',
      }]);
    }
    return unwrap(await this.backend.updateCompanyProfile({
      trade: body.trade as Trade,
      vatRegime: body.vatRegime as VatRegime,
      ...(body.customerPortfolio === undefined
        ? {}
        : { customerPortfolio: body.customerPortfolio as CustomerPortfolio }),
    }));
  }

  /** PATCH /company/billing — Réglages facturation §Coordonnées bancaires : le seul endroit qui
   * écrit iban/bic après l'onboarding. Partiel (les deux champs optionnels, absent = inchangé,
   * `null` explicite = effacer) — contrairement à /profile, on ne force pas les deux à la fois
   * (l'IBAN et le BIC n'ont pas de dépendance mutuelle contractuelle). */
  @Patch('billing')
  async updateBilling(@Body() body: unknown) {
    assertJsonObjectBody(body);
    const unknownField = Object.keys(body).find((field) => !COMPANY_BILLING_FIELDS.has(field));
    if (unknownField !== undefined) {
      throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
    }
    const issues: ValidationIssue[] = [];
    let iban: string | null | undefined;
    if ('iban' in body) {
      if (body.iban === null) {
        iban = null;
      } else if (typeof body.iban === 'string') {
        const parsed = Iban.of(body.iban);
        if (!parsed.ok) issues.push({ field: 'iban', message: 'IBAN invalide.' });
        else iban = parsed.value.value;
      } else {
        issues.push({ field: 'iban', message: 'IBAN doit être une chaîne ou null.' });
      }
    }
    let bic: string | null | undefined;
    if ('bic' in body) {
      if (body.bic === null) {
        bic = null;
      } else if (typeof body.bic === 'string' && BIC_PATTERN.test(body.bic.trim().toUpperCase())) {
        bic = body.bic.trim().toUpperCase();
      } else {
        issues.push({ field: 'bic', message: 'BIC invalide.' });
      }
    }
    if (issues.length > 0) throwValidationIssues(issues);
    return unwrap(await this.backend.updateCompanyBilling({ iban, bic }));
  }
}

@Controller('vat')
export class VatController {
  constructor(private readonly backend: BackendService) {}
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('check')
  async check(@Query('vat') vat: string) {
    return unwrap(await this.backend.checkVat(vat ?? ''));
  }
}

@Controller('address')
export class AddressController {
  constructor(private readonly backend: BackendService) {}
  // Autocomplétion : throttle plus large (BAN ~50 req/s), keyé par IP.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('search')
  async search(@Query('q') q: string) {
    return unwrap(await this.backend.searchAddress(q ?? ''));
  }
}

@Controller('cashflow')
export class CashflowController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async get(@Query('scenario') scenario: Scenario = 'realiste', @Query('horizon') horizon = '30') {
    return unwrap(await this.backend.getCashflow(scenario, Number(horizon) as Horizon));
  }
}

@Controller('bank-balance')
export class BankBalanceController {
  constructor(private readonly backend: BackendService) {}

  @Get()
  async latest() {
    return unwrap(await this.backend.latestQualifiedBankBalance());
  }

  @Post('manual')
  async recordManual(@Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.recordManualBankBalance(parseManualBankBalanceBody(body)));
  }
}

@Controller('quotes')
export class QuotesController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listQuotes());
  }
  @Get(':id')
  async get(@Param('id') id: string) {
    return unwrap(await this.backend.getQuote(id));
  }
  @Post()
  @WithoutTenantPersistenceTransaction()
  async create(@Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.createQuote(parseCreateQuoteBody(body)));
  }
  @Post(':id/send')
  async send(@Param('id') id: string) {
    return unwrap(await this.backend.sendQuote(id));
  }
  /** P0 R4 : prépare/rotate le lien public de signature SANS AUCUN envoi (pas d'e-mail, pas
   * d'outbox) — commande distincte de POST :id/send. Annuler le partage côté client = rien
   * n'est parti. */
  @Post(':id/signature-link')
  async createSignatureLink(@Param('id') id: string) {
    return unwrap(await this.backend.createQuoteSignatureLink(id));
  }
  @Post(':id/sign')
  async sign(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.signQuote({ quoteId: id, ...parseSignQuoteBody(body) }));
  }
  @Post(':id/refuse')
  async refuse(@Param('id') id: string) {
    return unwrap(await this.backend.refuseQuote(id));
  }
  @Post(':id/invoice')
  async invoice(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.generateInvoice({ quoteId: id, ...parseInvoiceGenerationBody(body) }));
  }
  /** R6 : édition d'une ligne de devis BROUILLON (le use case/l'agrégat gardent le statut). */
  @Patch(':id/lines/:lineId')
  async updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.updateQuoteLine({ quoteId: id, lineId, patch: parseQuoteLinePatchBody(body) }));
  }
  /** R6 : suppression d'une ligne de devis BROUILLON. */
  @Delete(':id/lines/:lineId')
  async removeLine(@Param('id') id: string, @Param('lineId') lineId: string) {
    return unwrap(await this.backend.removeQuoteLine({ quoteId: id, lineId }));
  }
}

@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly backend: BackendService,
    private readonly relances: RelanceService,
  ) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listInvoices());
  }
  /** C25 ② : envoi RÉEL d'une relance ciblée (ton du plan @bob/core, mise en demeure incluse —
   * le geste utilisateur EST la validation). Throttlé : action sortante vers un tiers. */
  @Post(':id/relance')
  @Throttle({ default: { limit: 5, ttl: 10_000 } })
  async sendRelance(@Param('id') id: string) {
    return unwrap(await this.relances.sendRelance(id));
  }
  @Get(':id')
  async get(@Param('id') id: string) {
    return unwrap(await this.backend.getInvoice(id));
  }
  @Get(':id/accounting-preview')
  async accountingPreview(@Param('id') id: string) {
    return unwrap(await this.backend.invoiceAccountingPreview(id));
  }
  @Get(':id/payment-accounting-preview')
  async paymentAccountingPreview(@Param('id') id: string, @Query('amount') amount: string, @Query('method') method?: PaymentMethod) {
    return unwrap(
      await this.backend.paymentAccountingPreview({
        invoiceId: id,
        amountCents: Number(amount),
        method: method ?? 'transfer',
      }),
    );
  }
  @Post(':id/issue')
  async issue(@Param('id') id: string) {
    return unwrap(await this.backend.issueInvoice({ invoiceId: id }));
  }
  /** R6 : suppression définitive d'une facture BROUILLON (erreur détectée après génération). */
  @Delete(':id/draft')
  async deleteDraft(@Param('id') id: string) {
    return unwrap(await this.backend.deleteDraftInvoice(id));
  }
  /** A6 (PONT-SERVEUR v1) : avoir TOTAL (brouillon) d'une facture émise — s'émet ensuite par
   * POST /invoices/:id/issue (numéro A- sans trou, écriture comptable inverse). */
  @Post(':id/credit-note')
  async creditNote(@Param('id') id: string) {
    return unwrap(await this.backend.createCreditNote({ invoiceId: id }));
  }
  @Post(':id/pay')
  async pay(
    @Param('id') id: string,
    @Body() body: { amount: number; method: PaymentMethod; idempotencyKey?: string | null },
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    return unwrap(
      await this.backend.registerPayment({
        invoiceId: id,
        amount: body.amount,
        method: body.method,
        idempotencyKey: idempotencyHeader ?? body.idempotencyKey ?? null,
      }),
    );
  }
  @Post(':id/payment-link')
  async paymentLink(@Param('id') id: string) {
    return unwrap(await this.backend.invoicePaymentLink(id));
  }
  @Get(':id/pdf')
  async pdf(@Param('id') id: string): Promise<StreamableFile> {
    const bytes = unwrap(await this.backend.invoicePdf(id));
    return new StreamableFile(Buffer.from(bytes), {
      type: 'application/pdf',
      disposition: `inline; filename="facture-${id}.pdf"`,
    });
  }
  @Get(':id/facturx.xml')
  async facturx(@Param('id') id: string): Promise<StreamableFile> {
    const xml = unwrap(await this.backend.invoiceFacturXXml(id));
    return new StreamableFile(Buffer.from(xml, 'utf-8'), {
      type: 'application/xml',
      disposition: `attachment; filename="factur-x-${id}.xml"`,
    });
  }
}

@Controller('accounting')
export class AccountingController {
  constructor(private readonly backend: BackendService) {}
  @Get('entries')
  async entries() {
    return unwrap(await this.backend.listAccountingEntries());
  }
  @Get('fec')
  async fec(@Query('from') from: string, @Query('to') to: string): Promise<StreamableFile> {
    const fec = unwrap(await this.backend.exportFec({ from: from ?? '', to: to ?? '' }));
    return new StreamableFile(Buffer.from(fec.content, 'utf-8'), {
      type: fec.mimeType,
      disposition: `attachment; filename="${fec.filename}"`,
    });
  }
  @Get('fec-description')
  async fecDescription(@Query('from') from: string, @Query('to') to: string): Promise<StreamableFile> {
    const fec = unwrap(await this.backend.exportFec({ from: from ?? '', to: to ?? '' }));
    return new StreamableFile(Buffer.from(fec.descriptionContent, 'utf-8'), {
      type: fec.mimeType,
      disposition: `attachment; filename="${fec.descriptionFilename}"`,
    });
  }
  @Get('fec-metadata')
  async fecMetadata(@Query('from') from: string, @Query('to') to: string) {
    const fec = unwrap(await this.backend.exportFec({ from: from ?? '', to: to ?? '' }));
    return {
      filename: fec.filename,
      descriptionFilename: fec.descriptionFilename,
      entryCount: fec.entryCount,
      rowCount: fec.rowCount,
      warnings: fec.warnings,
    };
  }
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list(
    @Query('kind') kind?: DocumentKind,
    @Query('linkedEntityType') linkedEntityType?: DocumentLinkedEntityType,
    @Query('linkedEntityId') linkedEntityId?: string,
    @Query('folderId') folderId?: string,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    return unwrap(
      await this.backend.listDocuments({
        ...(kind !== undefined ? { kind } : {}),
        ...(linkedEntityType !== undefined ? { linkedEntityType } : {}),
        ...(linkedEntityId !== undefined ? { linkedEntityId } : {}),
        ...(folderId !== undefined ? { folderId: folderId === 'null' ? null : folderId } : {}),
        ...(includeDeleted !== undefined ? { includeDeleted: includeDeleted === 'true' } : {}),
      }),
    );
  }
  /** B9 — recherche unifiée devis/factures (« retrouve les devis de Mairie de Sèvres du mois
   * dernier ») : pertinence pg_trgm puis date, tenant-scopée, paginée. DOIT rester déclarée avant
   * @Get(':id') plus bas — sinon "/documents/search" matcherait la route par id. */
  @Get('search')
  async search(
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const scope: SalesDocumentSearchScope = type === 'quote' || type === 'invoice' ? type : 'all';
    return unwrap(
      await this.backend.searchSalesDocuments({
        query: q ?? '',
        scope,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(customerId !== undefined ? { customerId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
      }),
    );
  }
  /** B9 — autocomplétion typée {kind, value, count} au fil de la frappe. Même contrainte d'ordre
   * que @Get('search') vis-à-vis de @Get(':id'). */
  @Get('suggest')
  async suggest(@Query('q') q?: string) {
    return unwrap(await this.backend.suggestSalesDocuments({ query: q ?? '' }));
  }
  @Post('upload')
  @WithoutTenantPersistenceTransaction()
  async upload(@Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.uploadDocument(parseUploadDocumentBody(body)));
  }
  @Post('intakes')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  async intake(
    @Body()
    body: { contentBase64: string; mimeType: string; filename: string; idempotencyKey: string },
  ) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.createDocumentIntake(body));
  }
  @Post(':id/classify')
  async classify(
    @Param('id') documentId: string,
    @Body() body: unknown,
  ) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.classifyDocument({ documentId, ...parseClassifyDocumentBody(body) }));
  }
  @Put(':id/expense')
  @WithoutTenantPersistenceTransaction()
  async recordExpenseFromDocument(
    @Param('id') documentId: string,
    @Body() body: unknown,
  ) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.recordDocumentExpense({
        documentId,
        ...parseRecordDocumentExpenseBody(body),
      }),
    );
  }
  @Post(':id/analysis')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  async analyze(@Param('id') documentId: string) {
    return unwrap(await this.backend.analyzeStoredDocument(documentId));
  }
  @Put(':id/folder')
  async moveToFolder(
    @Param('id') documentId: string,
    @Body() body: { folderId: string | null; expectedRevision: number },
  ) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.moveDocumentToFolder({ documentId, ...body }));
  }
  @Get(':id/download-url')
  @WithoutTenantPersistenceTransaction()
  async downloadUrl(@Param('id') id: string, @Query('ttl') ttl?: string) {
    return unwrap(await this.backend.documentDownloadUrl(id, ttl ? Number(ttl) : undefined));
  }
  @Get(':id')
  async getOne(@Param('id') id: string) {
    return unwrap(await this.backend.getDocument(id));
  }
  @Post('ocr')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  async ocr(@Body() body: { contentBase64: string; mimeType: string }) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.extractDocument(body));
  }
}

@Controller('document-folders')
export class DocumentFoldersController {
  constructor(private readonly backend: BackendService) {}

  @Get()
  async list(
    @Query('parentId') parentId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return unwrap(
      await this.backend.listDocumentFolders({
        ...(parentId !== undefined ? { parentId: parentId === 'root' ? null : parentId } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
  }

  @Post()
  async create(@Body() body: { name: string; parentId?: string | null }) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.createDocumentFolder(body));
  }

  @Post(':id/deletion-plans')
  async previewDeletion(@Param('id') folderId: string) {
    return unwrap(await this.backend.previewDocumentFolderDeletion(folderId));
  }

  @Get(':id')
  async get(@Param('id') folderId: string) {
    return unwrap(await this.backend.getDocumentFolder(folderId));
  }

  @Patch(':id')
  async update(
    @Param('id') folderId: string,
    @Body() body: { expectedRevision: number; name?: string; parentId?: string | null },
  ) {
    assertJsonObjectBody(body);
    const changes = Number(body.name !== undefined) + Number(body.parentId !== undefined);
    if (changes !== 1) {
      throw new HttpException(
        { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Une seule modification à la fois.' }] } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return body.name !== undefined
      ? unwrap(await this.backend.renameDocumentFolder({ folderId, name: body.name, expectedRevision: body.expectedRevision }))
      : unwrap(
          await this.backend.moveDocumentFolder({
            folderId,
            parentId: body.parentId ?? null,
            expectedRevision: body.expectedRevision,
          }),
        );
  }
}

@Controller('document-folder-deletion-plans')
export class DocumentFolderDeletionPlansController {
  constructor(private readonly backend: BackendService) {}

  @Post(':planId/executions')
  @WithoutTenantPersistenceTransaction()
  async execute(
    @Param('planId') planId: string,
    @Body() body: { strategy: DeleteDocumentFolderStrategy },
  ) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.executeDocumentFolderDeletion({ planId, strategy: body.strategy }));
  }
}

@Controller('public/sign')
export class PublicSignatureController {
  constructor(private readonly backend: BackendService) {}
  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async get(@Param('token') token: string) {
    return unwrap(await this.backend.publicQuoteForSignature(token));
  }
  @Post(':token')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async sign(@Param('token') token: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    const parsed = parseSignQuoteBody(body);
    return unwrap(await this.backend.publicSignQuote(token, parsed.signerName, parsed.proofDataUrl));
  }
}

@Controller('catalogue/prestations')
export class CatalogueController {
  constructor(private readonly backend: BackendService) {}

  @Get()
  async list() {
    return unwrap(await this.backend.listCatalogueItems());
  }

  @Post()
  async create(@Body() body: unknown) {
    assertJsonObjectBody(body);
    const parsed = parseCatalogueItemBody(body, 'create');
    return unwrap(await this.backend.createCatalogueItem(parsed.item));
  }

  @Patch(':itemId')
  async update(@Param('itemId') itemId: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    const parsed = parseCatalogueItemBody(body, 'update');
    return unwrap(await this.backend.updateCatalogueItem({
      itemId,
      expectedRevision: parsed.expectedRevision as number,
      item: parsed.item,
    }));
  }

  @Delete(':itemId')
  async remove(@Param('itemId') itemId: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    const unknownField = Object.keys(body).find((field) => field !== 'expectedRevision');
    if (unknownField !== undefined) {
      throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
    }
    if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) {
      throwValidationIssues([{ field: 'expectedRevision', message: 'Révision invalide.' }]);
    }
    return unwrap(await this.backend.deleteCatalogueItem({
      itemId,
      expectedRevision: body.expectedRevision as number,
    }));
  }
}

@Controller('chantiers')
export class ChantiersController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listChantiers());
  }
  @Post()
  async create(@Body() body: Omit<CreateChantierInput, 'companyId'>) {
    return unwrap(await this.backend.createChantier(body));
  }
}

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listExpenses());
  }
  @Post('defaults')
  async defaults(
    @Body()
    body: {
      supplierName: string;
      supplierSiren?: string | null;
      vatRatePctApplied?: number | null;
      categoryGuess: ExpenseCategory;
    },
  ) {
    return unwrap(await this.backend.suggestExpenseDefaults(body));
  }
  @WithoutTenantPersistenceTransaction()
  @Post()
  async create(@Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.recordExpense(parseRecordExpenseBody(body)));
  }
  /** C-EXP6b ① : CONTRÔLE DE RÉCEPTION d'une e-facture (destinataire, cohérence EN 16931,
   * doublon) + brouillon expert — RIEN n'est enregistré, la décision revient à l'appelant. */
  @Post('import-facturx')
  async importFacturX(@Body() body: { xml: string }) {
    return unwrap(await this.backend.importFacturXExpense({ xml: body.xml ?? '' }));
  }
  /** C-EXP6b ② : DÉCISION AFNOR explicite — approve (RecordExpense en transaction tenant,
   * écritures E1, XML archivé au coffre) ou refuse (motif OBLIGATOIRE, statuts 210/213). */
  @WithoutTenantPersistenceTransaction()
  @Post('import-facturx/confirm')
  async confirmImportFacturX(@Body() body: { xml: string; decision: FacturXImportDecision }) {
    return unwrap(await this.backend.confirmFacturXExpense({ xml: body.xml ?? '', decision: body.decision }));
  }
  /** E4 (PONT-SERVEUR v1) : règle une dépense fournisseur — MÊME route que le HttpBobClient
   * (payExpense), transition to_pay→paid + décaissement 401/512 (idempotent). */
  @Post(':id/pay')
  async pay(@Param('id') id: string) {
    return unwrap(await this.backend.payExpense({ expenseId: id }));
  }
}

/** Encaissements datés du tenant (E3 — PONT-SERVEUR v1) : socle du CA encaissé annuel (293 B),
 * de la balance âgée et de la prescription. JWT + tenant requis (guard global, comme /invoices). */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listPayments());
  }
}

/** Fil de notifications (C25) — le mobile lit ce que les jobs produisent, company-scoped (Principal + RLS). */
/** Digest de valeur (pilier 2) — le mobile lit le digest CALCULÉ SERVEUR (jamais un chiffre local). */
@Controller('engagement')
export class EngagementController {
  constructor(private readonly digest: DigestService) {}
  @Get('digest/latest')
  async latestDigest() {
    return unwrap(await this.digest.latestForCurrentTenant());
  }
  /** Bilan de fin d'essai (pilier 2) : les MÊMES agrégats que le digest, cumulés sur l'essai. */
  @Get('trial-report')
  async trialReport() {
    return unwrap(await this.digest.trialReportForCurrentTenant());
  }
  /** value_digest_opened : l'utilisateur a OUVERT le détail du digest (tap carte, pas rendu). */
  @Post('digest/opened')
  async digestOpened(@Body() body: { highlightKind?: unknown }) {
    return unwrap(await this.digest.recordDigestOpened({ highlightKind: body?.highlightKind }));
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsApiService) {}
  @Get()
  async list(@Query('limit') limit?: string) {
    return unwrap(await this.notifications.list(limit));
  }
  @Get('unread-preview')
  async unreadPreview() {
    return unwrap(await this.notifications.unreadPreview());
  }
  @Post('read-through')
  async markReadThrough(@Body() body: { throughCreatedAt?: unknown }) {
    return unwrap(await this.notifications.markReadThrough(body));
  }
  @Post(':id/read')
  async markRead(@Param('id') id: string) {
    return unwrap(await this.notifications.markRead(id));
  }
}

/** Appareils push Expo (C25) — binding global atomique + révocation tenant-scopée. */
@Controller('devices')
export class DevicesController {
  constructor(private readonly notifications: NotificationsApiService) {}
  @Post()
  async register(@Body() body: unknown) {
    return unwrap(await this.notifications.registerDevice(body));
  }
  @Post('revocations')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store, private, max-age=0')
  async revokeBinding(@Body() body: unknown) {
    return unwrap(await this.notifications.revokeDeviceBinding(body, 'authenticated'));
  }
  @Delete()
  async unregister(@Body() body: unknown) {
    return unwrap(await this.notifications.unregisterDevice(body));
  }
}

/**
 * Replay de tombstone après destruction du JWT. Route publique étroite, one-way et sans oracle :
 * elle ne sait que révoquer un binding exact déjà matérialisé, jamais lister ni enregistrer.
 */
@Controller('public/push-revocations')
export class PublicPushRevocationsController {
  constructor(private readonly notifications: NotificationsApiService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @PublicPushCapabilityThrottle()
  @Throttle({
    default: { limit: PUBLIC_PUSH_IP_LIMIT, ttl: PUBLIC_PUSH_THROTTLE_TTL_MS },
    [PUBLIC_PUSH_CAPABILITY_THROTTLER]: {
      limit: PUBLIC_PUSH_CAPABILITY_LIMIT,
      ttl: PUBLIC_PUSH_THROTTLE_TTL_MS,
    },
  })
  @WithoutTenantPersistenceTransaction()
  @Header('Cache-Control', 'no-store, private, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  async revoke(@Body() body: unknown) {
    return unwrap(await this.notifications.revokeDeviceBinding(body, 'public'));
  }
}

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly backend: BackendService,
    private readonly relances: RelanceService,
    private readonly documentArchives: DocumentArchiveService,
  ) {}
  @Post('run-relances')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  run() {
    return this.relances.runRelancesForCurrentTenant();
  }
  @Post('run-document-archives')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  async runDocumentArchives() {
    return unwrap(await this.documentArchives.run());
  }
  @Post('run-notifications')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  // Le service réalise claim/commit -> Brevo -> finalize/commit. L'intercepteur global ne
  // doit pas ré-englober ces étapes dans une transaction HTTP longue.
  @WithoutTenantPersistenceTransaction()
  async runNotifications() {
    return unwrap(await this.backend.runNotificationJobs({ limit: 25 }));
  }
}

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async get() {
    return unwrap(await this.backend.getSubscription());
  }
  @Post('checkout')
  checkout(@Body() body: { tier: PlanTier }) {
    return this.backend.startCheckout(body.tier);
  }
  @Post('portal')
  portal() {
    return this.backend.billingPortal();
  }
}

// BOB EXPERT FISCAL (Phase 1A — SPEC_EXPERT_FISCAL.md §V2) : profil fiscal du tenant.
@Controller('fiscal-profile')
export class FiscalProfileController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async get() {
    return unwrap(await this.backend.getFiscalProfile());
  }
  /** Un champ à la fois — { value } peut légitimement être null (fiscalYearEnd) ou false. */
  @Patch(':field')
  async update(@Param('field') field: string, @Body() body: { value?: unknown }) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.updateFiscalProfileField(field, body.value));
  }
}

@Controller('ai')
export class AiController {
  constructor(private readonly backend: BackendService) {}
  @Post('ask')
  @Throttle({ default: { limit: 5, ttl: 10_000 } })
  async ask(@Body() body: AgentAskPayload) {
    return unwrap(await this.backend.askBob(body));
  }
  @Get('proposals/:proposalId')
  @Throttle({ default: { limit: 20, ttl: 10_000 } })
  async proposal(@Param('proposalId') proposalId: string) {
    return unwrap(await this.backend.previewBobProposal({ proposalId }));
  }
  @Post('confirm')
  @Throttle({ default: { limit: 10, ttl: 10_000 } })
  async confirm(@Body() body: { proposalId?: unknown }) {
    return unwrap(await this.backend.confirmBob(body));
  }
  @Get('runs/:runId/journal')
  async journal(@Param('runId') runId: string) {
    return unwrap(await this.backend.agentJournal(runId));
  }
}

@Controller('voice')
export class VoiceController {
  constructor(private readonly backend: BackendService) {}
  @Get('config')
  async config() {
    return {
      cloudAvailable: this.backend.voiceCloudAvailable(),
      ttsCloudAvailable: await this.backend.voiceTtsCloudAvailable(),
    };
  }
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('transcribe')
  async transcribe(@Body() body: { audioBase64?: string; mimeType?: string }) {
    return unwrap(await this.backend.transcribe({ audioBase64: body.audioBase64 ?? '', mimeType: body.mimeType ?? 'audio/m4a' }));
  }
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('synthesize')
  async synthesize(@Body() body: { text?: string }) {
    return unwrap(await this.backend.synthesizeSpeech({ text: body.text ?? '' }));
  }
}
