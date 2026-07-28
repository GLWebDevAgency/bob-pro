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
  Inject,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type {
  CreateQuoteInput,
  Scenario,
  Horizon,
  PaymentMethod,
  PlanTier,
  CompanyRegistrationInput,
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
  ExpensePaymentEvidenceInput,
  LegalForm,
  PurchaseOrderRefInput,
  Discount,
  LineInput,
  SituationAmountInput,
  CustomerPaymentTerms,
  CustomerBillingChannel,
} from '@bob/core';
import {
  Iban,
  MAX_PURCHASE_ORDER_NUMBER_LENGTH,
  Siren,
  Siret,
  isCatalogueCategory,
  isValidDateOnly,
  isVatRate,
} from '@bob/core';
import { type AgentAskPayload } from '@bob/ai';
import { Throttle } from '@nestjs/throttler';
import {
  BackendService,
  type FacturXImportDecision,
  type UploadDocumentInput,
} from './backend.service';
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
import {
  AllowsClosedCompany,
  AllowsMissingCompanyRow,
  WithoutTenantPersistenceTransaction,
} from './persistence/tenant-persistence.interceptor';
import { clientIpSourceForRequest } from './config/client-ip';
import { BOB_LIVE_RUNTIME_READINESS } from './voice/realtime/realtime.tokens';
import type { BobLiveRuntimeReadinessPort } from './voice/realtime/realtime-readiness';

function assertJsonObjectBody(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException(
      {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'body', message: 'Corps JSON objet requis.' }],
        },
      },
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
  // Imputation chantier à la création (rentabilité par chantier) — optionnelle, additive ;
  // le chantier est PROUVÉ dans le tenant côté core (RecordExpense, anti-IDOR fail-closed).
  'chantierId',
]);
const CREATE_QUOTE_FIELDS = new Set([
  'idempotencyKey',
  'customerId',
  'lines',
  'depositPct',
  'validUntil',
  'context',
  // Exception dépannage urgent (L221-10, al. 2 / L221-28, 8°) — posée À LA CRÉATION (wizard
  // B2C), jamais rétroactive : aucun endpoint de mutation ne l'accepte après coup.
  'urgentRepairRequested',
  // B3/B5 — remise globale négociée et retenue de garantie stipulée au devis-chantier.
  'globalDiscount',
  'retenueGarantiePct',
  // PR-08 — site de rattachement (picker du wizard) — optionnel, additif ; le chantier est
  // PROUVÉ dans le tenant côté core (CreateQuote, anti-IDOR fail-closed).
  'chantierId',
]);
const CREATE_QUOTE_LINE_FIELDS = new Set([
  'label',
  'category',
  'qty',
  'unit',
  'unitPriceHT',
  'vatRate',
  // B3 — remise de ligne ({ type: 'percent', value } | { type: 'amount', cents }).
  'discount',
]);
const CREATE_QUOTE_CONTEXT_FIELDS = new Set(['housingOlderThan2y', 'energyRenovation']);
// `override` : override RESPONSABILISÉ de l'embargo L221-10 — le serveur refuse par défaut,
// n'accepte que le flag EXPLICITE true (jamais implicite) et le journalise (payment.embargo_overridden).
// B2 : `situation` accompagne le mode situation ({ percent } OU { amountHtCents }, exclusifs).
const INVOICE_GENERATION_FIELDS = new Set(['mode', 'override', 'situation']);
const SITUATION_PERCENT_FIELDS = new Set(['percent']);
const SITUATION_AMOUNT_FIELDS = new Set(['amountHtCents']);
/** B1 — POST /invoices (facture directe sans devis signé) : composition libre de lignes. */
const COMPOSE_INVOICE_FIELDS = new Set([
  'customerId',
  'lines',
  'globalDiscount',
  'context',
  // A3bis — qualification d'urgence OBLIGATOIRE pour un client B2C (booléen strict).
  'urgentOnSiteRepair',
  // PR-08 — site de rattachement (picker de l'écran facture directe) — optionnel, additif.
  'chantierId',
]);
const DISCOUNT_FIELDS = new Set(['type', 'value', 'cents']);
/** Suivi MANUEL de transmission (PATCH /invoices/:id/transmission) : dates déclarées. */
const INVOICE_TRANSMISSION_FIELDS = new Set(['depositedAt', 'acceptedAt']);
const QUOTE_LINE_PATCH_FIELDS = new Set(['label', 'qty', 'unitPriceHT', 'vatRate']);
const SIGN_QUOTE_FIELDS = new Set(['signerName', 'proofDataUrl', 'earlyExecutionRequested']);
const CATALOGUE_ITEM_FIELDS = new Set(['label', 'category', 'unit', 'unitPriceHT', 'vatRate']);
const CATALOGUE_ITEM_UPDATE_FIELDS = new Set([...CATALOGUE_ITEM_FIELDS, 'expectedRevision']);
const COMPANY_PROFILE_FIELDS = new Set(['trade', 'vatRegime', 'customerPortfolio']);
/** Réglages facturation §Coordonnées bancaires (RIB) — champs déjà persistés (CompanyProps.iban/
 * bic) mais jusqu'ici jamais éditables : seul endpoint qui les écrit après l'onboarding. */
const COMPANY_BILLING_FIELDS = new Set(['iban', 'bic']);
/** Réglages entreprise §Identité légale (A6 capital social, A2 médiateur conso) — seul endpoint
 * qui les écrit (jamais /onboarding/company : contrat d'inscription volontairement fermé). */
// A3 : email/phone = coordonnées DE L'ENTREPRISE exigées par les modèles types de rétractation
// en vigueur (formulaire annexe R221-1 : adresse électronique ; avis annexe R221-3, instruction
// (2) : téléphone + adresse électronique — décret n° 2022-424 du 25/03/2022).
// `rcsOrRm` et `address` : ajoutés au chantier « cul-de-sac d'émission » — ce sont les DEUX
// seules données qu'exige `Company.assertCanIssue()` (art. R123-237 c. com.) et elles n'avaient
// AUCUN endpoint d'écriture après l'onboarding (COMPANY_REGISTRATION_FIELDS ne sert qu'à
// POST /onboarding/company) : une société provisionnée sans RCS ne pouvait jamais émettre.
const COMPANY_LEGAL_FIELDS = new Set([
  'capitalSocialCents',
  'mediateurConso',
  'email',
  'phone',
  'rcsOrRm',
  'address',
  'tvaIntracom',
]);
const MEDIATEUR_CONSO_FIELDS = new Set(['nom', 'coordonnees']);
const COMPANY_LEGAL_ADDRESS_FIELDS = new Set(['line1', 'zip', 'city']);
/** A7 — inputs d'émission de facture (POST /invoices/:id/issue) : période de prestation et
 * adresse de chantier/livraison, validés puis FIGÉS par le domaine (Invoice.issue).
 * `invoiceId` et `terms` sont TOLÉRÉS mais ignorés : les clients déployés envoient depuis
 * toujours l'input complet en corps (le serveur ne lisait pas le corps) — l'id fait foi par le
 * chemin (mismatch rejeté) et les conditions de paiement restent décidées par les réglages
 * serveur, jamais par le client. */
const INVOICE_ISSUE_FIELDS = new Set([
  'servicePeriod',
  'deliveryAddress',
  'operationCategory',
  'invoiceId',
  'terms',
  // Override RESPONSABILISÉ de l'embargo L221-10 (`true` strict, journalisé côté use case).
  'override',
  // PR-04 — override RESPONSABILISÉ de la garde « BC obligatoire » (`true` strict, journalisé).
  'purchaseOrderOverride',
]);
const SERVICE_PERIOD_FIELDS = new Set(['start', 'end']);
const COMPANY_BILLING_SETTINGS_FIELDS = new Set([
  'expectedRevision',
  'showRibOnInvoices',
  'showInsuranceOnInvoices',
  'pdfAccentColor',
  'defaultQuoteValidityDays',
  'defaultDepositPercent',
  'defaultInvoicePaymentTermsDays',
  // PR-06 — cadence de relance paramétrable + interrupteur des relances automatiques.
  'relancePolicy',
  'relanceAutoEnabled',
]);
const RELANCE_POLICY_FIELDS = new Set([
  'cordialAfterDays',
  'neutreAfterDays',
  'fermeAfterDays',
  'miseEnDemeureAfterDays',
]);
const INVOICE_PDF_ACCENTS = new Set(['navy', 'green', 'purple', 'orange']);
const BIC_PATTERN = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/;
const MANUAL_BANK_BALANCE_FIELDS = new Set(['amountCents', 'observedAt']);
const SUBSCRIPTION_CHECKOUT_FIELDS = new Set(['tier']);
const SUBSCRIPTION_CHECKOUT_TIERS = new Set<PlanTier>(['solo', 'pro', 'business']);
const CREATE_CUSTOMER_FIELDS = new Set([
  'type',
  'name',
  'siren',
  'tvaIntracom',
  'address',
  'email',
  'phone',
  'contactName',
  'paymentTermsLabel',
  // B4 — conditions de paiement propres au client (jours + fin de mois + libellé imprimable).
  'paymentTerms',
  // Canal de facturation (email | chorus | portail) — guide de transmission dérivé à l'émission.
  'billingChannel',
  // PR-04 — garde « BC obligatoire » par client (désactivée par défaut, amendement fondateur).
  'requiresPurchaseOrder',
  'isInternational',
  'isSubcontractingBtp',
]);
const CUSTOMER_PAYMENT_TERMS_FIELDS = new Set(['days', 'endOfMonth', 'label']);
const CUSTOMER_BILLING_CHANNEL_FIELDS = new Set([
  'type',
  'chorusServiceCode',
  'portailNom',
  'portailUrl',
]);
const CUSTOMER_ADDRESS_FIELDS = new Set(['line1', 'zip', 'city']);
const COMPANY_REGISTRATION_FIELDS = new Set([
  'name',
  'legalForm',
  'siren',
  'siret',
  'apeCode',
  'trade',
  'vatRegime',
  'customerPortfolio',
  'rcsOrRm',
  'address',
  'tvaIntracom',
  'dateCreation',
  'natureJuridiqueCode',
  'estRge',
  'iban',
  'bic',
  'decennale',
]);
const COMPANY_REGISTRATION_ADDRESS_FIELDS = new Set(['line1', 'zip', 'city']);
const COMPANY_REGISTRATION_INSURANCE_FIELDS = new Set([
  'insurer',
  'policyNo',
  'coverage',
  'expiresAt',
]);
const LEGAL_FORMS = new Set<LegalForm>(['EI', 'EURL', 'SASU', 'SARL', 'SAS', 'micro']);
const TRADES = new Set<Trade>([
  'plombier',
  'electricien',
  'macon',
  'peintre',
  'paysagiste',
  // PR-10 — métiers de la maintenance (vocabulaire « site », module chantiers pertinent).
  'frigoriste',
  'mainteneur',
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
const QUOTE_LINE_CATEGORIES = new Set([
  'labor',
  'supply',
  'travel',
  'disbursement',
  'subscription',
]);
const QUOTE_VAT_RATES = new Set([0, 2.1, 5.5, 10, 20]);
const MAX_QUOTE_LINES = 100;
const MAX_QUOTE_HT_CENTS = 1_500_000_000;
// `payment` (ticket déjà réglé : date + moyen) n'est accepté QUE sur le flux document :
// la preuve est alors l'original archivé, imposé côté serveur — jamais un champ client.
const DOCUMENT_EXPENSE_FIELDS = new Set([
  ...[...RECORD_EXPENSE_FIELDS].filter((field) => field !== 'idempotencyKey' && field !== 'source'),
  'payment',
]);
const DOCUMENT_EXPENSE_PAYMENT_FIELDS = new Set(['paidOn', 'method']);
const DOCUMENT_EXPENSE_BODY_FIELDS = new Set(['expectedRevision', 'targetFolderId', 'expense']);
const EXPENSE_CATEGORIES = new Set([
  'fournitures',
  'materiel',
  'carburant',
  'repas',
  'sous_traitance',
  'autre',
]);
const EXPENSE_SOURCES = new Set(['ocr', 'manual', 'facturx']);
const EXPENSE_PAYMENT_FIELDS = new Set(['paidOn', 'method', 'reference', 'proofDocumentId']);
const EXPENSE_PAYMENT_METHODS = new Set<PaymentMethod>(['card', 'transfer', 'cash']);
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
const DOCUMENT_CLASSIFY_FIELDS = new Set([
  'linkedEntityType',
  'linkedEntityId',
  'expectedRevision',
]);
const DOCUMENT_KINDS = new Set<DocumentKind>([
  'invoice_pdf',
  'quote_pdf',
  'facturx_xml',
  'expense_receipt',
  'signed_quote',
  'other',
]);
const DOCUMENT_LINK_TYPES = new Set<DocumentLinkedEntityType>([
  'invoice',
  'quote',
  'expense',
  'chantier',
  'company',
]);

type ValidationIssue = { field: string; message: string };

function throwValidationIssues(issues: ValidationIssue[]): never {
  throw new HttpException(
    { ok: false, error: { kind: 'validation', issues } },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function optionalCompanyRegistrationString(
  body: Record<string, unknown>,
  field: keyof CompanyRegistrationInput,
  issues: ValidationIssue[],
): string | undefined {
  if (!Object.hasOwn(body, field)) return undefined;
  const value = body[field];
  if (typeof value !== 'string') {
    issues.push({ field, message: 'Chaîne de caractères requise.' });
    return undefined;
  }
  return value.trim();
}

/** Frontière HTTP stricte : reconstruit le DTO positif sans jamais propager le corps reçu. */
function parseCompanyRegistrationBody(body: Record<string, unknown>): CompanyRegistrationInput {
  const issues: ValidationIssue[] = [];
  const unknownField = Object.keys(body).find((field) => !COMPANY_REGISTRATION_FIELDS.has(field));
  if (unknownField !== undefined) {
    issues.push({ field: unknownField, message: 'Champ non autorisé.' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0) issues.push({ field: 'name', message: 'Raison sociale requise.' });

  const legalForm = body.legalForm;
  if (typeof legalForm !== 'string' || !LEGAL_FORMS.has(legalForm as LegalForm)) {
    issues.push({ field: 'legalForm', message: 'Forme juridique inconnue.' });
  }
  const trade = body.trade;
  if (typeof trade !== 'string' || !TRADES.has(trade as Trade)) {
    issues.push({ field: 'trade', message: 'Métier inconnu.' });
  }
  const vatRegime = body.vatRegime;
  if (typeof vatRegime !== 'string' || !VAT_REGIMES.has(vatRegime as VatRegime)) {
    issues.push({ field: 'vatRegime', message: 'Régime de TVA inconnu.' });
  }
  const customerPortfolio = body.customerPortfolio;
  if (
    customerPortfolio !== undefined &&
    (typeof customerPortfolio !== 'string' ||
      !CUSTOMER_PORTFOLIOS.has(customerPortfolio as CustomerPortfolio))
  ) {
    issues.push({ field: 'customerPortfolio', message: 'Clientèle principale inconnue.' });
  }

  let siren: string | undefined;
  if (typeof body.siren !== 'string') {
    issues.push({ field: 'siren', message: 'SIREN requis.' });
  } else {
    const parsed = Siren.of(body.siren);
    if (!parsed.ok) issues.push({ field: 'siren', message: 'SIREN invalide.' });
    else siren = parsed.value.value;
  }
  let siret: string | undefined;
  if (typeof body.siret !== 'string') {
    issues.push({ field: 'siret', message: 'SIRET requis.' });
  } else {
    const parsed = Siret.of(body.siret);
    if (!parsed.ok) issues.push({ field: 'siret', message: 'SIRET invalide.' });
    else siret = parsed.value.value;
  }
  if (siren !== undefined && siret !== undefined && siret.slice(0, 9) !== siren) {
    issues.push({ field: 'siret', message: 'SIRET incohérent avec le SIREN.' });
  }

  let address: CompanyRegistrationInput['address'] | undefined;
  if (!isJsonRecord(body.address)) {
    issues.push({ field: 'address', message: 'Adresse objet requise.' });
  } else {
    const unknownAddressField = Object.keys(body.address).find(
      (field) => !COMPANY_REGISTRATION_ADDRESS_FIELDS.has(field),
    );
    if (unknownAddressField !== undefined) {
      issues.push({ field: `address.${unknownAddressField}`, message: 'Champ non autorisé.' });
    }
    if (
      typeof body.address.line1 !== 'string' ||
      typeof body.address.zip !== 'string' ||
      typeof body.address.city !== 'string'
    ) {
      issues.push({ field: 'address', message: 'Adresse invalide.' });
    } else {
      // Les chaînes vides sont acceptées à l'inscription si l'annuaire ne connaît pas le siège.
      // Company.assertCanIssue() bloque ensuite tout acte légal tant que l'adresse n'est pas complétée.
      address = {
        line1: body.address.line1.trim(),
        zip: body.address.zip.trim(),
        city: body.address.city.trim(),
      };
    }
  }

  const apeCode = optionalCompanyRegistrationString(body, 'apeCode', issues);
  const rcsOrRm = optionalCompanyRegistrationString(body, 'rcsOrRm', issues);
  const tvaIntracom = optionalCompanyRegistrationString(body, 'tvaIntracom', issues);
  const dateCreation = optionalCompanyRegistrationString(body, 'dateCreation', issues);
  if (dateCreation !== undefined && !isValidDateOnly(dateCreation)) {
    issues.push({ field: 'dateCreation', message: 'Date de création AAAA-MM-JJ invalide.' });
  }
  // Fiche annuaire complète (Phase B fiscal) : code catégorie juridique INSEE + qualification RGE
  // remontés par le lookup SIRET — optionnels, jamais inventés quand la source est muette.
  const natureJuridiqueCode = optionalCompanyRegistrationString(body, 'natureJuridiqueCode', issues);
  let estRge: boolean | undefined;
  if (Object.hasOwn(body, 'estRge')) {
    if (typeof body.estRge !== 'boolean') {
      issues.push({ field: 'estRge', message: 'estRge doit être un booléen.' });
    } else {
      estRge = body.estRge;
    }
  }

  let iban: string | undefined;
  if (Object.hasOwn(body, 'iban')) {
    if (typeof body.iban !== 'string') {
      issues.push({ field: 'iban', message: 'IBAN doit être une chaîne.' });
    } else {
      const parsed = Iban.of(body.iban);
      if (!parsed.ok) issues.push({ field: 'iban', message: 'IBAN invalide.' });
      else iban = parsed.value.value;
    }
  }
  let bic: string | undefined;
  if (Object.hasOwn(body, 'bic')) {
    if (typeof body.bic !== 'string' || !BIC_PATTERN.test(body.bic.trim().toUpperCase())) {
      issues.push({ field: 'bic', message: 'BIC invalide.' });
    } else {
      bic = body.bic.trim().toUpperCase();
    }
  }

  let decennale: CompanyRegistrationInput['decennale'] | undefined;
  if (Object.hasOwn(body, 'decennale')) {
    if (!isJsonRecord(body.decennale)) {
      issues.push({ field: 'decennale', message: 'Assurance décennale objet requise.' });
    } else {
      const unknownInsuranceField = Object.keys(body.decennale).find(
        (field) => !COMPANY_REGISTRATION_INSURANCE_FIELDS.has(field),
      );
      if (unknownInsuranceField !== undefined) {
        issues.push({
          field: `decennale.${unknownInsuranceField}`,
          message: 'Champ non autorisé.',
        });
      }
      const insurer =
        typeof body.decennale.insurer === 'string' ? body.decennale.insurer.trim() : '';
      const policyNo =
        typeof body.decennale.policyNo === 'string' ? body.decennale.policyNo.trim() : '';
      const coverage =
        typeof body.decennale.coverage === 'string' ? body.decennale.coverage.trim() : '';
      const expiresAt =
        typeof body.decennale.expiresAt === 'string' ? body.decennale.expiresAt : '';
      if (insurer.length === 0)
        issues.push({ field: 'decennale.insurer', message: 'Assureur requis.' });
      if (policyNo.length === 0)
        issues.push({ field: 'decennale.policyNo', message: 'N° de police requis.' });
      if (coverage.length === 0)
        issues.push({ field: 'decennale.coverage', message: 'Couverture requise.' });
      if (!isValidDateOnly(expiresAt)) {
        issues.push({ field: 'decennale.expiresAt', message: 'Échéance AAAA-MM-JJ invalide.' });
      } else if (insurer.length > 0 && policyNo.length > 0 && coverage.length > 0) {
        decennale = { insurer, policyNo, coverage, expiresAt };
      }
    }
  }

  if (issues.length > 0) throwValidationIssues(issues);
  return {
    name,
    legalForm: legalForm as LegalForm,
    siren: siren as string,
    siret: siret as string,
    trade: trade as Trade,
    vatRegime: vatRegime as VatRegime,
    address: address as CompanyRegistrationInput['address'],
    ...(customerPortfolio === undefined
      ? {}
      : { customerPortfolio: customerPortfolio as CustomerPortfolio }),
    ...(apeCode === undefined ? {} : { apeCode }),
    ...(rcsOrRm === undefined ? {} : { rcsOrRm }),
    ...(tvaIntracom === undefined ? {} : { tvaIntracom }),
    ...(dateCreation === undefined ? {} : { dateCreation }),
    ...(natureJuridiqueCode === undefined || natureJuridiqueCode === ''
      ? {}
      : { natureJuridiqueCode }),
    ...(estRge === undefined ? {} : { estRge }),
    ...(iban === undefined ? {} : { iban }),
    ...(bic === undefined ? {} : { bic }),
    ...(decennale === undefined ? {} : { decennale }),
  };
}

/** Preuve de règlement fournisseur (POST :id/pay et :id/regularize-payment — MÊME contrat). */
function parseExpensePaymentEvidenceBody(body: unknown): ExpensePaymentEvidenceInput {
  assertJsonObjectBody(body);
  const unknownField = Object.keys(body).find((field) => !EXPENSE_PAYMENT_FIELDS.has(field));
  if (
    unknownField !== undefined ||
    typeof body.paidOn !== 'string' ||
    !isValidDateOnly(body.paidOn) ||
    typeof body.method !== 'string' ||
    !EXPENSE_PAYMENT_METHODS.has(body.method as PaymentMethod) ||
    (body.reference !== undefined &&
      body.reference !== null &&
      typeof body.reference !== 'string') ||
    (body.proofDocumentId !== undefined &&
      body.proofDocumentId !== null &&
      typeof body.proofDocumentId !== 'string')
  ) {
    throwValidationIssues([
      {
        field: unknownField ?? 'paymentEvidence',
        message:
          unknownField === undefined
            ? 'Date et moyen de règlement valides requis.'
            : 'Champ non autorisé.',
      },
    ]);
  }
  return {
    paidOn: body.paidOn,
    method: body.method as PaymentMethod,
    ...(body.reference === undefined ? {} : { reference: body.reference as string | null }),
    ...(body.proofDocumentId === undefined
      ? {}
      : { proofDocumentId: body.proofDocumentId as string | null }),
  };
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
    typeof body.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(body.observedAt)) ||
    new Date(Date.parse(body.observedAt)).toISOString() !== body.observedAt
  ) {
    throwValidationIssues([{ field: 'observedAt', message: 'Instant ISO canonique requis.' }]);
  }
  return { amountCents: body.amountCents as number, observedAt: body.observedAt };
}

/** Champs partagés création ET édition (C13/C40 TODO partagé) — même allowlist, même forme :
 * l'édition post-création est un remplacement complet revalidé par Customer.of, pas un patch. */
function parseCustomerBody(body: Record<string, unknown>): Omit<CustomerProps, 'id' | 'companyId'> {
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
    throwValidationIssues([
      {
        field: `address.${unknownAddressField}`,
        message: 'Champ non autorisé.',
      },
    ]);
  }
  const validOptionalString = (value: unknown) => value === undefined || typeof value === 'string';
  const validOptionalBoolean = (value: unknown) =>
    value === undefined || typeof value === 'boolean';
  if (
    (body.type !== 'b2c' && body.type !== 'b2b' && body.type !== 'b2g') ||
    typeof body.name !== 'string' ||
    typeof body.address.line1 !== 'string' ||
    typeof body.address.zip !== 'string' ||
    typeof body.address.city !== 'string' ||
    !validOptionalString(body.siren) ||
    !validOptionalString(body.tvaIntracom) ||
    !validOptionalString(body.email) ||
    !validOptionalString(body.phone) ||
    !validOptionalString(body.contactName) ||
    !validOptionalString(body.paymentTermsLabel) ||
    !validOptionalBoolean(body.isInternational) ||
    !validOptionalBoolean(body.isSubcontractingBtp) ||
    // PR-04 — booléen strict OU null (retour au défaut « non exigé »).
    !(
      body.requiresPurchaseOrder === undefined ||
      body.requiresPurchaseOrder === null ||
      typeof body.requiresPurchaseOrder === 'boolean'
    )
  ) {
    throwValidationIssues([{ field: 'body', message: 'Fiche client invalide.' }]);
  }
  // B4 — conditions de paiement du client : FORME gardée ici ({ days, endOfMonth, label } ou
  // null = défaut société) ; plafond légal L441-10 et structure fine = autorité de Customer.of.
  let paymentTerms: CustomerPaymentTerms | undefined;
  if (body.paymentTerms !== undefined && body.paymentTerms !== null) {
    if (!isJsonRecord(body.paymentTerms)) {
      throwValidationIssues([{ field: 'paymentTerms', message: 'Conditions de paiement objet requises.' }]);
    }
    const terms = body.paymentTerms;
    const unknownTermsField = Object.keys(terms).find((f) => !CUSTOMER_PAYMENT_TERMS_FIELDS.has(f));
    if (
      unknownTermsField !== undefined ||
      !Number.isSafeInteger(terms.days) ||
      typeof terms.endOfMonth !== 'boolean' ||
      typeof terms.label !== 'string'
    ) {
      throwValidationIssues([
        { field: 'paymentTerms', message: 'Conditions de paiement invalides ({ days, endOfMonth, label }).' },
      ]);
    }
    paymentTerms = {
      days: terms.days as number,
      endOfMonth: terms.endOfMonth as boolean,
      label: terms.label as string,
    };
  }
  // Canal de facturation : FORME gardée ici ; cohérence champs↔type = autorité de Customer.of
  // (validateBillingChannel). `null` = retour au défaut email (champ absent côté domaine).
  let billingChannel: CustomerBillingChannel | undefined;
  if (body.billingChannel !== undefined && body.billingChannel !== null) {
    if (!isJsonRecord(body.billingChannel)) {
      throwValidationIssues([{ field: 'billingChannel', message: 'Canal de facturation objet requis.' }]);
    }
    const channel = body.billingChannel;
    const unknownChannelField = Object.keys(channel).find(
      (f) => !CUSTOMER_BILLING_CHANNEL_FIELDS.has(f),
    );
    if (
      unknownChannelField !== undefined ||
      typeof channel.type !== 'string' ||
      !validOptionalString(channel.chorusServiceCode) ||
      !validOptionalString(channel.portailNom) ||
      !validOptionalString(channel.portailUrl)
    ) {
      throwValidationIssues([
        { field: 'billingChannel', message: 'Canal de facturation invalide ({ type, chorusServiceCode?, portailNom?, portailUrl? }).' },
      ]);
    }
    billingChannel = {
      type: channel.type as CustomerBillingChannel['type'],
      ...(channel.chorusServiceCode !== undefined
        ? { chorusServiceCode: channel.chorusServiceCode as string }
        : {}),
      ...(channel.portailNom !== undefined ? { portailNom: channel.portailNom as string } : {}),
      ...(channel.portailUrl !== undefined ? { portailUrl: channel.portailUrl as string } : {}),
    };
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
    ...(body.tvaIntracom !== undefined ? { tvaIntracom: body.tvaIntracom as string } : {}),
    ...(body.email !== undefined ? { email: body.email as string } : {}),
    ...(body.phone !== undefined ? { phone: body.phone as string } : {}),
    ...(body.contactName !== undefined ? { contactName: body.contactName as string } : {}),
    ...(body.paymentTermsLabel !== undefined
      ? { paymentTermsLabel: body.paymentTermsLabel as string }
      : {}),
    ...(paymentTerms !== undefined ? { paymentTerms } : {}),
    ...(billingChannel !== undefined ? { billingChannel } : {}),
    // PR-04 — booléen strict ; null = retour au défaut (champ absent côté domaine).
    ...(body.requiresPurchaseOrder !== undefined && body.requiresPurchaseOrder !== null
      ? { requiresPurchaseOrder: body.requiresPurchaseOrder as boolean }
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
    typeof body.label === 'string' &&
    isCatalogueCategory(body.category) &&
    (unit === null || typeof unit === 'string') &&
    Number.isSafeInteger(body.unitPriceHT) &&
    typeof body.vatRate === 'number' &&
    isVatRate(body.vatRate);
  const revision = body.expectedRevision;
  const validRevision =
    mode === 'create' || (Number.isSafeInteger(revision) && (revision as number) >= 1);
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
  return mode === 'update' ? { item, expectedRevision: revision as number } : { item };
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
      (code >= 0x80 && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200d) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    );
  });
}

function parseInvoiceGenerationBody(body: Record<string, unknown>): {
  mode: 'deposit' | 'final' | 'situation';
  situation?: SituationAmountInput;
  embargoOverride?: boolean;
} {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!INVOICE_GENERATION_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const mode = body['mode'];
  if (mode !== 'deposit' && mode !== 'final' && mode !== 'situation') {
    issues.push({ field: 'mode', message: 'Mode de facture requis (deposit | final | situation).' });
  }
  // B2 — montant de la situation : { percent } OU { amountHtCents }, formes exclusives. La
  // cohérence mode↔montant (requis avec situation, interdit sinon) et les bornes métier
  // (0 < % ≤ 100, cumul ≤ marché) restent l'autorité du use case GenerateInvoiceFromQuote.
  let situation: SituationAmountInput | undefined;
  const rawSituation = body['situation'];
  if (rawSituation !== undefined) {
    if (!isJsonRecord(rawSituation)) {
      issues.push({
        field: 'situation',
        message: 'Montant de situation objet requis ({ percent } | { amountHtCents }).',
      });
    } else if ('percent' in rawSituation) {
      const unknownField = Object.keys(rawSituation).find((f) => !SITUATION_PERCENT_FIELDS.has(f));
      if (unknownField !== undefined || typeof rawSituation.percent !== 'number' || !Number.isFinite(rawSituation.percent)) {
        issues.push({ field: 'situation.percent', message: "Pourcentage d'avancement invalide." });
      } else {
        situation = { percent: rawSituation.percent };
      }
    } else if ('amountHtCents' in rawSituation) {
      const unknownField = Object.keys(rawSituation).find((f) => !SITUATION_AMOUNT_FIELDS.has(f));
      if (unknownField !== undefined || !Number.isSafeInteger(rawSituation.amountHtCents)) {
        issues.push({
          field: 'situation.amountHtCents',
          message: 'Montant HT de situation invalide (centimes entiers requis).',
        });
      } else {
        situation = { amountHtCents: rawSituation.amountHtCents as number };
      }
    } else {
      issues.push({
        field: 'situation',
        message: 'Montant de situation requis ({ percent } | { amountHtCents }).',
      });
    }
  }
  // Override L221-10 : `true` strict uniquement — toute autre valeur est un refus explicite
  // (jamais un contournement par truthiness) ; absent = comportement légal par défaut.
  const override = body['override'];
  if (override !== undefined && typeof override !== 'boolean') {
    issues.push({ field: 'override', message: 'Booléen attendu.' });
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    mode: mode as 'deposit' | 'final' | 'situation',
    ...(situation !== undefined ? { situation } : {}),
    ...(override === true ? { embargoOverride: true } : {}),
  };
}

/**
 * PR-08 — champ `chantierId` optionnel des créations de pièces (devis + facture directe) :
 * même hygiène de forme que l'imputation chantier des dépenses (id canonique 1..200, trimmé,
 * sans caractère de contrôle) ; `null` explicite = hors site (idempotent avec le champ absent).
 * La SUBSTANCE (chantier prouvé dans le tenant) reste l'autorité du use case (anti-IDOR).
 */
function parseChantierIdField(
  body: Record<string, unknown>,
  issues: ValidationIssue[],
): string | undefined {
  if (!('chantierId' in body)) return undefined;
  const value = body['chantierId'];
  if (value === null) return undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    issues.push({ field: 'chantierId', message: 'Identifiant de chantier invalide.' });
    return undefined;
  }
  return value;
}

/** PR-09 — corps des créations/éditions de contact client : formes seulement (les invariants —
 * longueurs, e-mail, normalisation — restent l'autorité de CustomerContact.of). */
const CUSTOMER_CONTACT_FIELDS = new Set(['label', 'name', 'email', 'phone']);

function parseCustomerContactBody(body: Record<string, unknown>): {
  label: string;
  name: string;
  email?: string | null;
  phone?: string | null;
} {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!CUSTOMER_CONTACT_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const requiredText = (field: 'label' | 'name', max: number): string | null => {
    const value = body[field];
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || hasControlCharacter(value)) {
      issues.push({ field, message: `Texte requis (${max} caractères maximum).` });
      return null;
    }
    return value;
  };
  const optionalText = (field: 'email' | 'phone', max: number): string | null | undefined => {
    if (!(field in body)) return undefined;
    const value = body[field];
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > max || hasControlCharacter(value)) {
      issues.push({ field, message: `Valeur invalide (${max} caractères maximum).` });
      return undefined;
    }
    return value;
  };
  const label = requiredText('label', 80);
  const name = requiredText('name', 160);
  const email = optionalText('email', 320);
  const phone = optionalText('phone', 40);
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    label: label as string,
    name: name as string,
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
  };
}

/**
 * B1 — POST /invoices (facture DIRECTE sans devis signé) : mêmes contraintes de forme que les
 * lignes de devis (500 caractères, TVA du référentiel, 100 lignes max, plafond HT), remise de
 * ligne et remise globale B3 comprises. La substance (client du tenant, urgence B2C A3bis,
 * garde-fou pro étranger B6, TVA suggérée) reste l'autorité du use case ComposeStandaloneInvoice.
 */
function parseComposeInvoiceBody(body: Record<string, unknown>): {
  customerId: string;
  lines: LineInput[];
  globalDiscount?: Discount | null;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
  urgentOnSiteRepair?: boolean;
  chantierId?: string;
} {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!COMPOSE_INVOICE_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const customerId = body['customerId'];
  if (
    typeof customerId !== 'string' ||
    customerId.length === 0 ||
    customerId.length > 240 ||
    customerId !== customerId.trim() ||
    hasControlCharacter(customerId)
  ) {
    issues.push({ field: 'customerId', message: 'Identifiant client invalide.' });
  }
  const rawLines = body['lines'];
  const lines: LineInput[] = [];
  let totalHtCents = 0;
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_QUOTE_LINES) {
    issues.push({
      field: 'lines',
      message: `Tableau de lignes requis (1 à ${MAX_QUOTE_LINES} lignes).`,
    });
  } else {
    rawLines.forEach((rawLine, index) => {
      const prefix = `lines.${index}`;
      if (!isJsonRecord(rawLine)) {
        issues.push({ field: prefix, message: 'Ligne objet requise.' });
        return;
      }
      const line = rawLine;
      for (const field of Object.keys(line)) {
        if (!CREATE_QUOTE_LINE_FIELDS.has(field)) {
          issues.push({ field: prefix, message: `Champ non autorisé : ${field}.` });
        }
      }
      const label = line['label'];
      if (
        typeof label !== 'string' ||
        label.trim().length === 0 ||
        label.length > 500 ||
        hasControlCharacter(label)
      ) {
        issues.push({ field: `${prefix}.label`, message: 'Libellé requis (500 caractères maximum).' });
      }
      const category = line['category'];
      if (typeof category !== 'string' || !QUOTE_LINE_CATEGORIES.has(category)) {
        issues.push({ field: `${prefix}.category`, message: 'Catégorie de ligne invalide.' });
      }
      const qty = line['qty'];
      if (
        typeof qty !== 'number' ||
        !Number.isFinite(qty) ||
        qty <= 0 ||
        qty > 1_000_000 ||
        Math.round(qty * 1_000) !== qty * 1_000
      ) {
        issues.push({ field: `${prefix}.qty`, message: 'Quantité positive avec 3 décimales maximum requise.' });
      }
      const unit = line['unit'];
      if (
        unit !== undefined &&
        (typeof unit !== 'string' || unit.trim().length === 0 || unit.length > 80 || hasControlCharacter(unit))
      ) {
        issues.push({ field: `${prefix}.unit`, message: 'Unité invalide (80 caractères maximum).' });
      }
      const unitPriceHT = line['unitPriceHT'];
      if (
        !Number.isSafeInteger(unitPriceHT) ||
        (unitPriceHT as number) < 0 ||
        (unitPriceHT as number) > MAX_QUOTE_HT_CENTS
      ) {
        issues.push({ field: `${prefix}.unitPriceHT`, message: 'Prix HT en centimes invalide.' });
      }
      const vatRate = line['vatRate'];
      if (typeof vatRate !== 'number' || !QUOTE_VAT_RATES.has(vatRate)) {
        issues.push({ field: `${prefix}.vatRate`, message: 'Taux de TVA invalide.' });
      }
      if (
        typeof qty === 'number' &&
        Number.isFinite(qty) &&
        Number.isSafeInteger(unitPriceHT) &&
        (unitPriceHT as number) >= 0
      ) {
        totalHtCents += Math.round(qty * (unitPriceHT as number));
      }
      const rawDiscount = line['discount'];
      let discount: Discount | undefined;
      if (rawDiscount !== undefined) {
        const parsed = parseDiscountField(rawDiscount, `${prefix}.discount`, issues);
        if (parsed !== undefined && parsed !== null) discount = parsed;
      }
      if (
        typeof label === 'string' &&
        typeof category === 'string' &&
        QUOTE_LINE_CATEGORIES.has(category) &&
        typeof qty === 'number' &&
        Number.isFinite(qty) &&
        Number.isSafeInteger(unitPriceHT) &&
        typeof vatRate === 'number' &&
        QUOTE_VAT_RATES.has(vatRate)
      ) {
        lines.push({
          label,
          category: category as LineInput['category'],
          qty,
          ...(typeof unit === 'string' ? { unit } : {}),
          unitPriceHT: unitPriceHT as number,
          vatRate: vatRate as LineInput['vatRate'],
          ...(discount !== undefined ? { discount } : {}),
        });
      }
    });
  }
  if (totalHtCents > MAX_QUOTE_HT_CENTS) {
    issues.push({ field: 'lines', message: 'Montant total HT de la facture hors limite.' });
  }
  let globalDiscount: Discount | null | undefined;
  if (body['globalDiscount'] !== undefined) {
    globalDiscount = parseDiscountField(body['globalDiscount'], 'globalDiscount', issues);
  }
  const rawContext = body['context'];
  let context: { housingOlderThan2y?: boolean; energyRenovation?: boolean } | undefined;
  if (rawContext !== undefined) {
    if (!isJsonRecord(rawContext)) {
      issues.push({ field: 'context', message: 'Contexte objet requis.' });
    } else {
      const unknownField = Object.keys(rawContext).find((f) => !CREATE_QUOTE_CONTEXT_FIELDS.has(f));
      if (unknownField !== undefined) {
        issues.push({ field: 'context', message: `Champ non autorisé : ${unknownField}.` });
      }
      for (const field of CREATE_QUOTE_CONTEXT_FIELDS) {
        if (rawContext[field] !== undefined && typeof rawContext[field] !== 'boolean') {
          issues.push({ field: `context.${field}`, message: 'Booléen attendu.' });
        }
      }
      context = {
        ...(typeof rawContext['housingOlderThan2y'] === 'boolean'
          ? { housingOlderThan2y: rawContext['housingOlderThan2y'] }
          : {}),
        ...(typeof rawContext['energyRenovation'] === 'boolean'
          ? { energyRenovation: rawContext['energyRenovation'] }
          : {}),
      };
    }
  }
  // A3bis — booléen STRICT : seul `true` porte la qualification (jamais par truthiness).
  const urgentOnSiteRepair = body['urgentOnSiteRepair'];
  if (urgentOnSiteRepair !== undefined && typeof urgentOnSiteRepair !== 'boolean') {
    issues.push({ field: 'urgentOnSiteRepair', message: 'Booléen attendu.' });
  }
  // PR-08 — site de rattachement (forme seulement ; substance anti-IDOR au use case).
  const chantierId = parseChantierIdField(body, issues);
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    customerId: customerId as string,
    lines,
    ...(globalDiscount !== undefined ? { globalDiscount } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(urgentOnSiteRepair === true ? { urgentOnSiteRepair: true } : {}),
    ...(chantierId !== undefined ? { chantierId } : {}),
  };
}

/** Suivi MANUEL de transmission : champ absent = inchangé, null = effacé, sinon AAAA-MM-JJ. */
/** PR-01 — corps OPTIONNEL de POST /invoices/:id/send : `recipientEmail` (contact choisi) seul
 *  champ autorisé ; body absent/vide = destinataire résolu depuis la fiche client (use case). */
function parseSendInvoiceBody(body: unknown): { recipientEmail?: string } {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throwValidationIssues([{ field: 'body', message: 'Objet JSON attendu.' }]);
  }
  const record = body as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(record)) {
    if (field !== 'recipientEmail') {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  if ('recipientEmail' in record && typeof record.recipientEmail !== 'string') {
    issues.push({ field: 'recipientEmail', message: 'Adresse e-mail attendue (chaîne).' });
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return typeof record.recipientEmail === 'string'
    ? { recipientEmail: record.recipientEmail }
    : {};
}

function parseInvoiceTransmissionBody(body: Record<string, unknown>): {
  depositedAt?: string | null;
  acceptedAt?: string | null;
} {
  const issues: ValidationIssue[] = [];
  const knownFields = Object.keys(body).filter((field) => INVOICE_TRANSMISSION_FIELDS.has(field));
  for (const field of Object.keys(body)) {
    if (!INVOICE_TRANSMISSION_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  if (knownFields.length === 0) {
    issues.push({ field: 'body', message: 'Au moins un champ requis (depositedAt | acceptedAt).' });
  }
  const parseDate = (field: 'depositedAt' | 'acceptedAt'): string | null | undefined => {
    if (!(field in body)) return undefined;
    const value = body[field];
    if (value === null) return null;
    if (typeof value !== 'string' || !isValidDateOnly(value)) {
      issues.push({ field, message: 'Date invalide (AAAA-MM-JJ ou null).' });
      return undefined;
    }
    return value;
  };
  const depositedAt = parseDate('depositedAt');
  const acceptedAt = parseDate('acceptedAt');
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    ...(depositedAt !== undefined ? { depositedAt } : {}),
    ...(acceptedAt !== undefined ? { acceptedAt } : {}),
  };
}

// ——— B8 : bon de commande (numéro d'engagement grands comptes) ———

const PURCHASE_ORDER_ATTACH_FIELDS = new Set([
  'number',
  'receivedAt',
  'documentId',
  'expectedRevision',
]);
const PURCHASE_ORDER_DETACH_FIELDS = new Set(['expectedRevision']);

function parseExpectedRevision(body: Record<string, unknown>, issues: ValidationIssue[]): number {
  const expectedRevision = body['expectedRevision'];
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    issues.push({ field: 'expectedRevision', message: 'Révision positive attendue.' });
    return 1;
  }
  return expectedRevision as number;
}

/**
 * PUT /{quotes|invoices}/:id/purchase-order — corps plat { number, receivedAt?, documentId?,
 * expectedRevision }. Le parseur borne les types et NORMALISE la date de réception en ISO
 * canonique (l'idempotence du domaine compare des chaînes) ; l'assainissement/la longueur du
 * numéro restent l'autorité de makePurchaseOrderRef (@bob/core).
 */
function parsePurchaseOrderAttachBody(body: Record<string, unknown>): {
  purchaseOrder: PurchaseOrderRefInput;
  expectedRevision: number;
} {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!PURCHASE_ORDER_ATTACH_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const number = body['number'];
  if (
    typeof number !== 'string' ||
    number.trim().length === 0 ||
    number.length > MAX_PURCHASE_ORDER_NUMBER_LENGTH * 4
  ) {
    issues.push({ field: 'number', message: 'Numéro de bon de commande requis.' });
  }
  const receivedAt = body['receivedAt'];
  let normalizedReceivedAt: string | null = null;
  if (receivedAt !== undefined && receivedAt !== null) {
    if (typeof receivedAt !== 'string' || Number.isNaN(Date.parse(receivedAt))) {
      issues.push({ field: 'receivedAt', message: 'Date de réception invalide.' });
    } else {
      normalizedReceivedAt = new Date(Date.parse(receivedAt)).toISOString();
    }
  }
  const documentId = body['documentId'];
  if (
    documentId !== undefined &&
    documentId !== null &&
    (typeof documentId !== 'string' || documentId.trim().length === 0 || documentId.length > 100)
  ) {
    issues.push({ field: 'documentId', message: 'Document invalide.' });
  }
  const expectedRevision = parseExpectedRevision(body, issues);
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    purchaseOrder: {
      number: number as string,
      receivedAt: normalizedReceivedAt,
      documentId: (documentId as string | null | undefined) ?? null,
    },
    expectedRevision,
  };
}

/** DELETE /{quotes|invoices}/:id/purchase-order — seule la révision optimiste voyage. */
function parsePurchaseOrderDetachBody(body: Record<string, unknown>): {
  expectedRevision: number;
} {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!PURCHASE_ORDER_DETACH_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const expectedRevision = parseExpectedRevision(body, issues);
  if (issues.length > 0) throwValidationIssues(issues);
  return { expectedRevision };
}

function parseSignQuoteBody(body: Record<string, unknown>): {
  signerName: string;
  proofDataUrl?: string;
  earlyExecutionRequested?: boolean;
} {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!SIGN_QUOTE_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const value = body['signerName'];
  if (
    typeof value !== 'string' ||
    value.trim().length < 2 ||
    value.length > 120 ||
    hasForbiddenSignerCharacter(value)
  ) {
    issues.push({ field: 'signerName', message: 'Nom du signataire invalide.' });
  }
  // R4 : tracé du pad (dataURL image), OPTIONNEL — jamais persisté tel quel, le serveur en
  // calcule le SHA-256 (preuve d'intégrité). Absent = signature sans capture (preuve absente,
  // jamais fabriquée).
  const proof = body['proofDataUrl'];
  if (proof !== undefined) {
    if (
      typeof proof !== 'string' ||
      !proof.startsWith('data:image/') ||
      proof.length > SIGN_PROOF_MAX_CHARS ||
      hasControlCharacter(proof)
    ) {
      issues.push({ field: 'proofDataUrl', message: 'Tracé de signature invalide.' });
    }
  }
  // A3 — case « exécution immédiate des travaux » (art. L221-25 c. conso), OPTIONNELLE et
  // strictement booléenne : cochée = true. Toute autre forme est rejetée — un consentement
  // légal ne se devine pas depuis une valeur ambiguë.
  const earlyExecution = body['earlyExecutionRequested'];
  if (earlyExecution !== undefined && typeof earlyExecution !== 'boolean') {
    issues.push({ field: 'earlyExecutionRequested', message: 'Valeur invalide.' });
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    signerName: (value as string).trim().replace(/\s+/g, ' '),
    ...(proof !== undefined ? { proofDataUrl: proof as string } : {}),
    ...(earlyExecution === true ? { earlyExecutionRequested: true } : {}),
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
      typeof value !== 'string' ||
      value.trim().length === 0 ||
      value.length > 500 ||
      hasControlCharacter(value)
    ) {
      issues.push({ field: 'label', message: 'Libellé requis (500 caractères maximum).' });
    } else {
      patch.label = value.trim();
    }
  }
  if (Object.hasOwn(body, 'qty')) {
    const value = body['qty'];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 1_000_000 ||
      Math.round(value * 1_000) !== value * 1_000
    ) {
      issues.push({ field: 'qty', message: 'Quantité positive avec 3 décimales maximum requise.' });
    } else {
      patch.qty = value;
    }
  }
  if (Object.hasOwn(body, 'unitPriceHT')) {
    const value = body['unitPriceHT'];
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 0 ||
      (value as number) > MAX_QUOTE_HT_CENTS
    ) {
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
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    hasControlCharacter(value)
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
  if (typeof value !== 'string' || value.length > maxLength || hasControlCharacter(value)) {
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

/**
 * B3 — parse de FORME d'une remise ({ type: 'percent', value } | { type: 'amount', cents }).
 * Les bornes métier (0 < % ≤ 100 deux décimales, centimes entiers > 0, plafond de base) restent
 * l'autorité du domaine (validateDiscount/validateLineDiscount) — ici seule la forme est gardée.
 * Retourne undefined si invalide (l'issue est poussée), null si `null` explicite (retrait).
 */
function parseDiscountField(
  value: unknown,
  field: string,
  issues: ValidationIssue[],
): Discount | null | undefined {
  if (value === null) return null;
  if (!isJsonRecord(value)) {
    issues.push({ field, message: 'Remise objet requise ({ type, value | cents }).' });
    return undefined;
  }
  const unknownField = Object.keys(value).find((key) => !DISCOUNT_FIELDS.has(key));
  if (unknownField !== undefined) {
    issues.push({ field, message: `Champ non autorisé : ${unknownField}.` });
    return undefined;
  }
  if (value.type === 'percent') {
    if (typeof value.value !== 'number' || !Number.isFinite(value.value) || 'cents' in value) {
      issues.push({ field, message: 'Remise en pourcentage invalide ({ type: "percent", value }).' });
      return undefined;
    }
    return { type: 'percent', value: value.value };
  }
  if (value.type === 'amount') {
    if (!Number.isSafeInteger(value.cents) || 'value' in value) {
      issues.push({ field, message: 'Remise en montant invalide ({ type: "amount", cents }).' });
      return undefined;
    }
    return { type: 'amount', cents: value.cents as number };
  }
  issues.push({ field, message: 'Type de remise inconnu (percent | amount).' });
  return undefined;
}

/** PR-14 — POST /quotes/:id/duplicate : la duplication n'accepte AUCUNE matière libre — le
 * contenu vient du devis source relu serveur ; seuls l'éligibilité re-déclarée des taux
 * réduits, le choix explicite « repasser à 20 % » et la clé d'idempotence traversent. */
const DUPLICATE_QUOTE_FIELDS = new Set(['context', 'standardRateForReducedLines', 'idempotencyKey']);

function parseDuplicateQuoteBody(body: Record<string, unknown>): {
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
  standardRateForReducedLines?: boolean;
  idempotencyKey?: string | null;
} {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!DUPLICATE_QUOTE_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const rawContext = body['context'];
  let context: { housingOlderThan2y?: boolean; energyRenovation?: boolean } | undefined;
  if (rawContext !== undefined) {
    if (!isJsonRecord(rawContext)) {
      issues.push({ field: 'context', message: 'Contexte objet requis.' });
    } else {
      const unknownField = Object.keys(rawContext).find((f) => !CREATE_QUOTE_CONTEXT_FIELDS.has(f));
      if (unknownField !== undefined) {
        issues.push({ field: 'context', message: `Champ non autorisé : ${unknownField}.` });
      }
      for (const field of CREATE_QUOTE_CONTEXT_FIELDS) {
        if (rawContext[field] !== undefined && typeof rawContext[field] !== 'boolean') {
          issues.push({ field: `context.${field}`, message: 'Booléen attendu.' });
        }
      }
      context = {
        ...(typeof rawContext['housingOlderThan2y'] === 'boolean'
          ? { housingOlderThan2y: rawContext['housingOlderThan2y'] }
          : {}),
        ...(typeof rawContext['energyRenovation'] === 'boolean'
          ? { energyRenovation: rawContext['energyRenovation'] }
          : {}),
      };
    }
  }
  const rawStandard = body['standardRateForReducedLines'];
  if (rawStandard !== undefined && typeof rawStandard !== 'boolean') {
    issues.push({ field: 'standardRateForReducedLines', message: 'Booléen attendu.' });
  }
  const rawKey = body['idempotencyKey'];
  if (
    rawKey !== undefined &&
    rawKey !== null &&
    (typeof rawKey !== 'string' ||
      rawKey.trim().length === 0 ||
      rawKey.length > 200 ||
      hasControlCharacter(rawKey))
  ) {
    issues.push({
      field: 'idempotencyKey',
      message: "Clé d'idempotence invalide (1 à 200 caractères imprimables).",
    });
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    ...(context !== undefined ? { context } : {}),
    ...(typeof rawStandard === 'boolean' ? { standardRateForReducedLines: rawStandard } : {}),
    ...(rawKey !== undefined ? { idempotencyKey: rawKey as string | null } : {}),
  };
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
    typeof customerId !== 'string' ||
    customerId.length === 0 ||
    customerId.length > 240 ||
    customerId !== customerId.trim() ||
    hasControlCharacter(customerId)
  ) {
    issues.push({ field: 'customerId', message: 'Identifiant client invalide.' });
  }

  const rawKey = body['idempotencyKey'];
  if (
    rawKey !== undefined &&
    rawKey !== null &&
    (typeof rawKey !== 'string' ||
      rawKey.trim().length === 0 ||
      rawKey.length > 200 ||
      hasControlCharacter(rawKey))
  ) {
    issues.push({
      field: 'idempotencyKey',
      message: "Clé d'idempotence invalide (1 à 200 caractères imprimables).",
    });
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
        typeof label !== 'string' ||
        label.trim().length === 0 ||
        label.length > 500 ||
        hasControlCharacter(label)
      ) {
        issues.push({
          field: `${prefix}.label`,
          message: 'Libellé requis (500 caractères maximum).',
        });
      }
      const category = line['category'];
      if (typeof category !== 'string' || !QUOTE_LINE_CATEGORIES.has(category)) {
        issues.push({ field: `${prefix}.category`, message: 'Catégorie de ligne invalide.' });
      }
      const qty = line['qty'];
      if (
        typeof qty !== 'number' ||
        !Number.isFinite(qty) ||
        qty <= 0 ||
        qty > 1_000_000 ||
        Math.round(qty * 1_000) !== qty * 1_000
      ) {
        issues.push({
          field: `${prefix}.qty`,
          message: 'Quantité positive avec 3 décimales maximum requise.',
        });
      }
      const unit = line['unit'];
      if (
        unit !== undefined &&
        (typeof unit !== 'string' ||
          unit.trim().length === 0 ||
          unit.length > 80 ||
          hasControlCharacter(unit))
      ) {
        issues.push({
          field: `${prefix}.unit`,
          message: 'Unité invalide (80 caractères maximum).',
        });
      }
      const unitPriceHT = line['unitPriceHT'];
      if (
        !Number.isSafeInteger(unitPriceHT) ||
        (unitPriceHT as number) < 0 ||
        (unitPriceHT as number) > MAX_QUOTE_HT_CENTS
      ) {
        issues.push({ field: `${prefix}.unitPriceHT`, message: 'Prix HT en centimes invalide.' });
      }
      const vatRate = line['vatRate'];
      if (typeof vatRate !== 'number' || !QUOTE_VAT_RATES.has(vatRate)) {
        issues.push({ field: `${prefix}.vatRate`, message: 'Taux de TVA invalide.' });
      }

      if (
        typeof qty === 'number' &&
        Number.isFinite(qty) &&
        Number.isSafeInteger(unitPriceHT) &&
        (unitPriceHT as number) >= 0
      ) {
        totalHtCents += Math.round(qty * (unitPriceHT as number));
      }
      // B3 — remise de ligne : forme gardée ici, bornes et plafond validés par le domaine.
      const rawDiscount = line['discount'];
      let discount: Discount | undefined;
      if (rawDiscount !== undefined) {
        const parsed = parseDiscountField(rawDiscount, `${prefix}.discount`, issues);
        // `null` explicite à la CRÉATION = absence de remise (idempotent avec le champ absent).
        if (parsed !== undefined && parsed !== null) discount = parsed;
      }
      if (
        typeof label === 'string' &&
        typeof category === 'string' &&
        QUOTE_LINE_CATEGORIES.has(category) &&
        typeof qty === 'number' &&
        Number.isFinite(qty) &&
        Number.isSafeInteger(unitPriceHT) &&
        typeof vatRate === 'number' &&
        QUOTE_VAT_RATES.has(vatRate)
      ) {
        lines.push({
          label,
          category: category as CreateQuoteInput['lines'][number]['category'],
          qty,
          ...(typeof unit === 'string' ? { unit } : {}),
          unitPriceHT: unitPriceHT as number,
          vatRate: vatRate as CreateQuoteInput['lines'][number]['vatRate'],
          ...(discount !== undefined ? { discount } : {}),
        });
      }
    });
  }
  if (totalHtCents > MAX_QUOTE_HT_CENTS) {
    issues.push({ field: 'lines', message: 'Montant total HT du devis hors limite.' });
  }

  const depositPct = body['depositPct'];
  if (
    depositPct !== undefined &&
    (typeof depositPct !== 'number' ||
      !Number.isFinite(depositPct) ||
      depositPct < 0 ||
      depositPct > 100)
  ) {
    issues.push({ field: 'depositPct', message: "Pourcentage d'acompte invalide." });
  }

  const validUntil = body['validUntil'];
  if (
    validUntil !== undefined &&
    (typeof validUntil !== 'string' || !isValidDateOnly(validUntil))
  ) {
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
        (candidate['housingOlderThan2y'] === undefined ||
          typeof candidate['housingOlderThan2y'] === 'boolean') &&
        (candidate['energyRenovation'] === undefined ||
          typeof candidate['energyRenovation'] === 'boolean')
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

  // Exception dépannage urgent : booléen strict — `true` seul porte le fait (CreateQuote refuse
  // ensuite tout client non-b2c ; l'horodatage est SERVEUR, jamais fourni par le client).
  const urgentRepairRequested = body['urgentRepairRequested'];
  if (urgentRepairRequested !== undefined && typeof urgentRepairRequested !== 'boolean') {
    issues.push({ field: 'urgentRepairRequested', message: 'Booléen attendu.' });
  }

  // B3 — remise GLOBALE négociée au devis (source unique du marché, reprise sur les dérivées).
  let globalDiscount: Discount | null | undefined;
  if (body['globalDiscount'] !== undefined) {
    globalDiscount = parseDiscountField(body['globalDiscount'], 'globalDiscount', issues);
  }
  // B5 — retenue de garantie stipulée (forme : nombre fini ; borne 0 < taux ≤ 5 = domaine).
  const retenueGarantiePct = body['retenueGarantiePct'];
  if (
    retenueGarantiePct !== undefined &&
    retenueGarantiePct !== null &&
    (typeof retenueGarantiePct !== 'number' || !Number.isFinite(retenueGarantiePct))
  ) {
    issues.push({ field: 'retenueGarantiePct', message: 'Taux de retenue de garantie invalide.' });
  }

  // PR-08 — site de rattachement (forme seulement ; substance anti-IDOR au use case).
  const chantierId = parseChantierIdField(body, issues);

  if (issues.length > 0) throwValidationIssues(issues);
  return {
    customerId: customerId as string,
    lines,
    ...(rawKey !== undefined ? { idempotencyKey: rawKey as string | null } : {}),
    ...(typeof depositPct === 'number' ? { depositPct } : {}),
    ...(typeof validUntil === 'string' ? { validUntil } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(urgentRepairRequested === true ? { urgentRepairRequested: true } : {}),
    ...(globalDiscount !== undefined ? { globalDiscount } : {}),
    ...(retenueGarantiePct !== undefined
      ? { retenueGarantiePct: retenueGarantiePct as number | null }
      : {}),
    ...(chantierId !== undefined ? { chantierId } : {}),
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
  const chantierId = optionalExpenseString(body, 'chantierId', 200, issues);

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
    vatRatePct !== undefined &&
    vatRatePct !== null &&
    (typeof vatRatePct !== 'number' ||
      !Number.isFinite(vatRatePct) ||
      vatRatePct < 0 ||
      vatRatePct > 100)
  ) {
    issues.push({ field: 'vatRatePct', message: 'Taux de TVA attendu entre 0 et 100.' });
  }

  // Règlement déclaré (ticket de caisse) : date + moyen UNIQUEMENT. Référence et justificatif
  // sont sous autorité serveur — un champ surnuméraire est un contrat forgé, donc rejeté.
  let payment: { paidOn: string; method: PaymentMethod } | null | undefined;
  if (Object.hasOwn(body, 'payment') && allowedFields.has('payment')) {
    const rawPayment = body.payment;
    if (rawPayment === null) {
      payment = null;
    } else if (!isJsonRecord(rawPayment)) {
      issues.push({ field: 'payment', message: 'Règlement déclaré invalide.' });
    } else {
      if (Object.keys(rawPayment).some((field) => !DOCUMENT_EXPENSE_PAYMENT_FIELDS.has(field))) {
        issues.push({ field: 'payment', message: 'Le règlement contient un champ non autorisé.' });
      }
      const paidOn = rawPayment.paidOn;
      if (typeof paidOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
        issues.push({ field: 'payment.paidOn', message: 'Date de règlement AAAA-MM-JJ requise.' });
      }
      const method = rawPayment.method;
      if (typeof method !== 'string' || !EXPENSE_PAYMENT_METHODS.has(method as PaymentMethod)) {
        issues.push({ field: 'payment.method', message: 'Moyen de règlement inconnu.' });
      }
      payment = { paidOn: paidOn as string, method: method as PaymentMethod };
    }
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
    ...(source !== undefined
      ? { source: source as NonNullable<RecordExpenseInput['source']> }
      : {}),
    ...(supplierInvoiceNumber !== undefined ? { supplierInvoiceNumber } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(chantierId !== undefined ? { chantierId } : {}),
    ...(payment !== undefined ? { payment } : {}),
  };
}

/** PUT /expenses/:id/chantier — { chantierId } OBLIGATOIRE : un id canonique pour imputer,
 * null EXPLICITE pour délier. Aucun autre champ n'est toléré (frontière HTTP stricte). */
const ASSIGN_EXPENSE_CHANTIER_FIELDS = new Set(['chantierId']);
function parseAssignExpenseChantierBody(body: Record<string, unknown>): string | null {
  const issues: ValidationIssue[] = [];
  if (Object.keys(body).some((field) => !ASSIGN_EXPENSE_CHANTIER_FIELDS.has(field))) {
    issues.push({ field: 'body', message: 'Le corps contient un champ non autorisé.' });
  }
  if (!Object.hasOwn(body, 'chantierId')) {
    issues.push({
      field: 'chantierId',
      message: 'chantierId requis : identifiant de chantier, ou null explicite pour délier.',
    });
  }
  const chantierId = body.chantierId;
  if (
    chantierId !== null &&
    Object.hasOwn(body, 'chantierId') &&
    (typeof chantierId !== 'string' ||
      chantierId.length === 0 ||
      chantierId.length > 200 ||
      chantierId !== chantierId.trim() ||
      hasControlCharacter(chantierId))
  ) {
    issues.push({ field: 'chantierId', message: 'Identifiant de chantier canonique requis.' });
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return chantierId as string | null;
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
    typeof targetFolderId !== 'string' ||
    targetFolderId.length === 0 ||
    targetFolderId.length > 200 ||
    targetFolderId !== targetFolderId.trim() ||
    hasControlCharacter(targetFolderId)
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
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    hasControlCharacter(value)
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
  if (
    typeof contentBase64 !== 'string' ||
    contentBase64.trim().length === 0 ||
    contentBase64.length > 14_000_000
  ) {
    issues.push({ field: 'contentBase64', message: 'Document base64 requis (10 Mo maximum).' });
  }
  const mimeType = canonicalDocumentString(body.mimeType, 'mimeType', 120, issues);
  const filename = canonicalDocumentString(body.filename, 'filename', 255, issues);

  const kind = Object.hasOwn(body, 'kind') ? body.kind : undefined;
  if (
    kind !== undefined &&
    (typeof kind !== 'string' || !DOCUMENT_KINDS.has(kind as DocumentKind))
  ) {
    issues.push({ field: 'kind', message: 'Type de document inconnu.' });
  }

  const hasLinkedEntityType = Object.hasOwn(body, 'linkedEntityType');
  const hasLinkedEntityId = Object.hasOwn(body, 'linkedEntityId');
  const linkedEntityType = hasLinkedEntityType ? body.linkedEntityType : undefined;
  const linkedEntityId = hasLinkedEntityId ? body.linkedEntityId : undefined;
  if (hasLinkedEntityType !== hasLinkedEntityId) {
    issues.push({
      field: 'linkedEntity',
      message: 'Le type et l’identifiant de rattachement sont indissociables.',
    });
  } else if (hasLinkedEntityType) {
    const bothNull = linkedEntityType === null && linkedEntityId === null;
    const bothNonNull = linkedEntityType !== null && linkedEntityId !== null;
    if (!bothNull && !bothNonNull) {
      issues.push({
        field: 'linkedEntity',
        message: 'Le rattachement doit être null/null ou type/id.',
      });
    } else if (bothNonNull) {
      if (
        typeof linkedEntityType !== 'string' ||
        !DOCUMENT_LINK_TYPES.has(linkedEntityType as DocumentLinkedEntityType)
      ) {
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
    tags !== undefined &&
    (!Array.isArray(tags) ||
      tags.length > 16 ||
      tags.some(
        (tag) =>
          typeof tag !== 'string' ||
          tag.trim().length < 2 ||
          tag.trim().length > 32 ||
          hasControlCharacter(tag),
      ))
  ) {
    issues.push({
      field: 'tags',
      message: 'Au plus 16 tags texte de 2 à 32 caractères sont attendus.',
    });
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

type RenameDocumentBody = {
  displayName: string;
  expectedRevision: number;
};

const DOCUMENT_RENAME_FIELDS = new Set(['displayName', 'expectedRevision']);

/** PUT /documents/:id/name — le domaine (validateDocumentDisplayName) revalide derrière. */
function parseRenameDocumentBody(body: Record<string, unknown>): RenameDocumentBody {
  const issues: ValidationIssue[] = [];
  if (Object.keys(body).some((field) => !DOCUMENT_RENAME_FIELDS.has(field))) {
    issues.push({ field: 'body', message: 'Le corps contient un champ non autorisé.' });
  }
  const displayName = body.displayName;
  if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 512) {
    issues.push({ field: 'displayName', message: "Nom d'affichage requis." });
  }
  const expectedRevision = body.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    issues.push({ field: 'expectedRevision', message: 'Révision document positive attendue.' });
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    displayName: displayName as string,
    expectedRevision: expectedRevision as number,
  };
}

type AcknowledgeDocumentBody = {
  expectedRevision: number;
};

const DOCUMENT_ACKNOWLEDGE_FIELDS = new Set(['expectedRevision']);

/** POST /documents/:id/acknowledge — seule la révision optimiste est acceptée du client. */
function parseAcknowledgeDocumentBody(body: Record<string, unknown>): AcknowledgeDocumentBody {
  const issues: ValidationIssue[] = [];
  if (Object.keys(body).some((field) => !DOCUMENT_ACKNOWLEDGE_FIELDS.has(field))) {
    issues.push({ field: 'body', message: 'Le corps contient un champ non autorisé.' });
  }
  const expectedRevision = body.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    issues.push({ field: 'expectedRevision', message: 'Révision document positive attendue.' });
  }
  if (issues.length > 0) throwValidationIssues(issues);
  return { expectedRevision: expectedRevision as number };
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
  if (
    typeof linkedEntityType !== 'string' ||
    !DOCUMENT_LINK_TYPES.has(linkedEntityType as DocumentLinkedEntityType)
  ) {
    issues.push({ field: 'linkedEntityType', message: 'Type de rattachement inconnu.' });
  }
  const linkedEntityId = canonicalDocumentString(
    body.linkedEntityId,
    'linkedEntityId',
    200,
    issues,
  );
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
  constructor(
    private readonly backend: BackendService,
    @Inject(BOB_LIVE_RUNTIME_READINESS)
    private readonly bobLiveReadiness: BobLiveRuntimeReadinessPort,
  ) {}

  @Get()
  health() {
    return { ok: true, service: 'bob-pro-api', dataMode: 'postgresql' as const };
  }

  @Get('ready')
  async ready(@Req() request: Record<string, unknown>) {
    // C24b : sonde SANS tenant (aucun Principal sur /health ; plus de repli société de démo).
    const r = await this.backend.readiness();
    if (!r.ok)
      throw new HttpException({ ready: false, error: r.error }, HttpStatus.SERVICE_UNAVAILABLE);
    const bobLive = await this.bobLiveReadiness.check({ fresh: true });
    if (!bobLive.ready) {
      throw new HttpException(
        { ready: false, error: 'bob_live_runtime_unavailable' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      ready: true,
      customers: r.value.customers,
      dependencies: {
        bobLiveSpeechAudit: bobLive.speechAudit,
      },
      // Capacité de compatibilité mixed-version : cette révision refuse tout XML/Factur-X B2C
      // sur l'endpoint ET rend son PDF sans enveloppe hybride. Le pipeline vérifie ce marqueur
      // sur toutes les anciennes répliques avant d'appliquer les migrations archive V2.
      capabilities: {
        documentArchiveB2cHttpFence: 'v1' as const,
        // Un prédécesseur portant ce marqueur écrit le fence d'annulation durable sur tout
        // hangup. Le pipeline peut alors éviter un drain total lors des releases suivantes ;
        // son absence impose le cutover fermé et drainé.
        realtimeAdmissionCancellationFence: 'v1' as const,
        // Le client V1 acquitte durablement le bootstrap avant de prendre le micro ou
        // d'exposer son handle. Sans ce marqueur, le pipeline interdit la réouverture.
        agentMissionBootstrapReceipt: 'v1' as const,
      },
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
    return unwrap(await this.backend.createCustomer(parseCustomerBody(body)));
  }
  /** Édition post-création (C13/C40 TODO partagé) — remplacement complet revalidé, MÊME
   * allowlist que la création (parseCustomerBody), jamais un patch partiel côté domaine. */
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.updateCustomer(id, parseCustomerBody(body)));
  }
  // ── PR-09 — contacts multiples du client (label libre : demandeur, valideur, compta…) ──
  @Get(':id/contacts')
  async listContacts(@Param('id') id: string) {
    return unwrap(await this.backend.listCustomerContacts(id));
  }
  @Post(':id/contacts')
  async createContact(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.createCustomerContact(id, parseCustomerContactBody(body)));
  }
  @Patch(':id/contacts/:contactId')
  async updateContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
  ) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.updateCustomerContact(id, contactId, parseCustomerContactBody(body)),
    );
  }
  @Delete(':id/contacts/:contactId')
  async deleteContact(@Param('id') id: string, @Param('contactId') contactId: string) {
    return unwrap(await this.backend.deleteCustomerContact(id, contactId));
  }
}

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly backend: BackendService) {}
  /** @AllowsMissingCompanyRow : un JWT portant un company_id SANS ligne en base (NO_COMPANY)
   * doit pouvoir réparer son provisioning sur la MÊME company (id du JWT), sans la réécrire. */
  @Post('company')
  @AllowsMissingCompanyRow()
  async company(@Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.registerCompany(parseCompanyRegistrationBody(body)));
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
  @AllowsClosedCompany()
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
 * deriveFiscalCalendar (@bob/core) — mêmes règles pour l'API et l'outil agent.
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
      unknownField !== undefined ||
      typeof body.trade !== 'string' ||
      !TRADES.has(body.trade as Trade) ||
      typeof body.vatRegime !== 'string' ||
      !VAT_REGIMES.has(body.vatRegime as VatRegime) ||
      (body.customerPortfolio !== undefined &&
        (typeof body.customerPortfolio !== 'string' ||
          !CUSTOMER_PORTFOLIOS.has(body.customerPortfolio as CustomerPortfolio)))
    ) {
      throwValidationIssues([
        {
          field: unknownField ?? 'body',
          message:
            unknownField === undefined ? 'Profil entreprise invalide.' : 'Champ non autorisé.',
        },
      ]);
    }
    return unwrap(
      await this.backend.updateCompanyProfile({
        trade: body.trade as Trade,
        vatRegime: body.vatRegime as VatRegime,
        ...(body.customerPortfolio === undefined
          ? {}
          : { customerPortfolio: body.customerPortfolio as CustomerPortfolio }),
      }),
    );
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

  /** PATCH /company/legal — Réglages entreprise §Identité légale : capital social en centimes
   * (A6, art. R123-238 c. com. — sociétés uniquement, garde domaine) et médiateur de la
   * consommation (A2, art. L612-1/L616-1 c. conso). Partiel : champ absent = inchangé, `null`
   * explicite = effacé. La mention imprimée (bloc émetteur, mention B2C) relève de buildMentions
   * (lot Rendus) — ici on ne fait que porter la donnée. */
  @Patch('legal')
  async updateLegal(@Body() body: unknown) {
    assertJsonObjectBody(body);
    const unknownField = Object.keys(body).find((field) => !COMPANY_LEGAL_FIELDS.has(field));
    if (unknownField !== undefined) {
      throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
    }
    const issues: ValidationIssue[] = [];
    let capitalSocialCents: number | null | undefined;
    if ('capitalSocialCents' in body) {
      if (body.capitalSocialCents === null) {
        capitalSocialCents = null;
      } else if (
        typeof body.capitalSocialCents === 'number' &&
        Number.isSafeInteger(body.capitalSocialCents) &&
        body.capitalSocialCents > 0
      ) {
        capitalSocialCents = body.capitalSocialCents;
      } else {
        issues.push({
          field: 'capitalSocialCents',
          message: 'Capital social invalide (centimes entiers > 0, ou null).',
        });
      }
    }
    let mediateurConso: { nom: string; coordonnees: string } | null | undefined;
    if ('mediateurConso' in body) {
      if (body.mediateurConso === null) {
        mediateurConso = null;
      } else if (
        body.mediateurConso !== null &&
        typeof body.mediateurConso === 'object' &&
        !Array.isArray(body.mediateurConso)
      ) {
        const nested = body.mediateurConso as Record<string, unknown>;
        const unknownNested = Object.keys(nested).find((field) => !MEDIATEUR_CONSO_FIELDS.has(field));
        const nom = typeof nested.nom === 'string' ? nested.nom.trim() : '';
        const coordonnees = typeof nested.coordonnees === 'string' ? nested.coordonnees.trim() : '';
        if (
          unknownNested !== undefined ||
          nom.length === 0 ||
          nom.length > 200 ||
          coordonnees.length === 0 ||
          coordonnees.length > 500
        ) {
          issues.push({
            field: 'mediateurConso',
            message: 'Médiateur invalide : nom (≤ 200) et coordonnées (≤ 500) requis.',
          });
        } else {
          mediateurConso = { nom, coordonnees };
        }
      } else {
        issues.push({
          field: 'mediateurConso',
          message: 'Médiateur invalide : objet { nom, coordonnees } ou null requis.',
        });
      }
    }
    // A3 — coordonnées de l'entreprise pour les modèles R221-1/R221-3 : chaîne non vide ou null
    // (effacement explicite). La validation de FORME fine (format e-mail/téléphone) appartient
    // au domaine (Company.of) — ici seule la structure est contrôlée.
    let email: string | null | undefined;
    if ('email' in body) {
      if (body.email === null) email = null;
      else if (typeof body.email === 'string' && body.email.trim().length > 0 && body.email.length <= 254) {
        email = body.email.trim();
      } else {
        issues.push({ field: 'email', message: 'Adresse électronique invalide (chaîne non vide ou null).' });
      }
    }
    let phone: string | null | undefined;
    if ('phone' in body) {
      if (body.phone === null) phone = null;
      else if (typeof body.phone === 'string' && body.phone.trim().length > 0 && body.phone.length <= 30) {
        phone = body.phone.trim();
      } else {
        issues.push({ field: 'phone', message: 'Téléphone invalide (chaîne non vide ou null).' });
      }
    }
    // R123-237 — n° d'immatriculation (RCS société / RM artisan) : mention OBLIGATOIRE sur les
    // factures, exigée par Company.assertCanIssue(). Chaîne non vide ou `null` (effacement
    // explicite). Le FORMAT n'est pas contraint : les libellés de greffe et de chambre de métiers
    // sont trop variés pour un motif — imposer une regex rejetterait des mentions légitimes.
    let rcsOrRm: string | null | undefined;
    if ('rcsOrRm' in body) {
      if (body.rcsOrRm === null) rcsOrRm = null;
      else if (
        typeof body.rcsOrRm === 'string' &&
        body.rcsOrRm.trim().length > 0 &&
        body.rcsOrRm.trim().length <= 100
      ) {
        rcsOrRm = body.rcsOrRm.trim();
      } else {
        issues.push({
          field: 'rcsOrRm',
          message: 'N° d’immatriculation invalide (chaîne non vide ≤ 100 caractères, ou null).',
        });
      }
    }
    // Le numéro de TVA est un IDENTIFIANT ATTRIBUÉ, jamais calculé depuis le SIREN. La forme
    // exacte et la cohérence SIREN/clé sont validées par Company.of, autorité du domaine.
    let tvaIntracom: string | null | undefined;
    if ('tvaIntracom' in body) {
      if (body.tvaIntracom === null) {
        tvaIntracom = null;
      } else if (
        typeof body.tvaIntracom === 'string' &&
        body.tvaIntracom.trim().length > 0 &&
        body.tvaIntracom.trim().length <= 32
      ) {
        tvaIntracom = body.tvaIntracom.trim();
      } else {
        issues.push({
          field: 'tvaIntracom',
          message: 'Numéro de TVA intracommunautaire invalide (chaîne non vide ou null).',
        });
      }
    }
    // Adresse du siège : objet COMPLET uniquement (pas de patch par sous-champ — une adresse
    // partielle serait un état incohérent sur une pièce comptable). Non nullable : `address`
    // est requis sur CompanyProps, l'effacer n'a aucun sens légal.
    let address: { line1: string; zip: string; city: string } | undefined;
    if ('address' in body) {
      if (!isJsonRecord(body.address)) {
        issues.push({ field: 'address', message: 'Adresse objet { line1, zip, city } requise.' });
      } else {
        const unknownAddressField = Object.keys(body.address).find(
          (field) => !COMPANY_LEGAL_ADDRESS_FIELDS.has(field),
        );
        const line1 = typeof body.address.line1 === 'string' ? body.address.line1.trim() : '';
        const zip = typeof body.address.zip === 'string' ? body.address.zip.trim() : '';
        const city = typeof body.address.city === 'string' ? body.address.city.trim() : '';
        if (unknownAddressField !== undefined) {
          issues.push({ field: `address.${unknownAddressField}`, message: 'Champ non autorisé.' });
        } else if (line1.length === 0 || city.length === 0) {
          // `assertCanIssue` exige line1 ET city : les accepter vides ICI ne ferait que
          // reconduire le cul-de-sac que cet endpoint est censé ouvrir.
          issues.push({
            field: 'address',
            message: 'Adresse incomplète : rue et ville requises.',
          });
        } else if (line1.length > 200 || zip.length > 20 || city.length > 100) {
          issues.push({ field: 'address', message: 'Adresse trop longue.' });
        } else {
          address = { line1, zip, city };
        }
      }
    }
    if (issues.length > 0) throwValidationIssues(issues);
    return unwrap(
      await this.backend.updateCompanyLegal({
        capitalSocialCents,
        mediateurConso,
        email,
        phone,
        rcsOrRm,
        address,
        tvaIntracom,
      }),
    );
  }

  @Get('billing-settings')
  async billingSettings() {
    return unwrap(await this.backend.getCompanyBillingSettings());
  }

  /**
   * CAS obligatoire : un appareil qui édite une révision périmée reçoit 409 et doit recharger.
   * Les champs sans consommateur serveur (logo) sont volontairement absents du contrat.
   * Les conditions de paiement sont nullable tant que le propriétaire ne les a pas confirmées.
   */
  @Patch('billing-settings')
  async updateBillingSettings(@Body() body: unknown) {
    assertJsonObjectBody(body);
    const unknownField = Object.keys(body).find(
      (field) => !COMPANY_BILLING_SETTINGS_FIELDS.has(field),
    );
    if (unknownField !== undefined) {
      throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
    }
    const issues: ValidationIssue[] = [];
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
      issues.push({ field: 'expectedRevision', message: 'Révision invalide.' });
    }
    for (const field of ['showRibOnInvoices', 'showInsuranceOnInvoices'] as const) {
      if (field in body && typeof body[field] !== 'boolean') {
        issues.push({ field, message: 'Booléen requis.' });
      }
    }
    if (
      'pdfAccentColor' in body &&
      (typeof body.pdfAccentColor !== 'string' || !INVOICE_PDF_ACCENTS.has(body.pdfAccentColor))
    ) {
      issues.push({ field: 'pdfAccentColor', message: 'Couleur invalide.' });
    }
    for (const [field, min, max] of [
      ['defaultQuoteValidityDays', 1, 365],
      ['defaultDepositPercent', 0, 100],
    ] as const) {
      if (
        field in body &&
        (!Number.isSafeInteger(body[field]) ||
          Number(body[field]) < min ||
          Number(body[field]) > max)
      ) {
        issues.push({ field, message: `Entier entre ${min} et ${max} requis.` });
      }
    }
    if (
      'defaultInvoicePaymentTermsDays' in body &&
      body.defaultInvoicePaymentTermsDays !== null &&
      (!Number.isSafeInteger(body.defaultInvoicePaymentTermsDays) ||
        Number(body.defaultInvoicePaymentTermsDays) < 1 ||
        Number(body.defaultInvoicePaymentTermsDays) > 60)
    ) {
      issues.push({
        field: 'defaultInvoicePaymentTermsDays',
        message: 'Entier entre 1 et 60, ou null, requis.',
      });
    }
    // PR-06 — cadence : objet EXACT {4 seuils entiers} ou null (retour au défaut) ; la
    // cohérence fine (bornes, ordre strict) reste l'autorité du core (validate...Patch).
    let relancePolicy:
      | {
          cordialAfterDays: number;
          neutreAfterDays: number;
          fermeAfterDays: number;
          miseEnDemeureAfterDays: number;
        }
      | null
      | undefined;
    if ('relancePolicy' in body) {
      if (body.relancePolicy === null) {
        relancePolicy = null;
      } else if (!isJsonRecord(body.relancePolicy)) {
        issues.push({ field: 'relancePolicy', message: 'Objet { 4 paliers } ou null requis.' });
      } else {
        const policy = body.relancePolicy;
        const unknownPolicyField = Object.keys(policy).find((f) => !RELANCE_POLICY_FIELDS.has(f));
        const missingPolicyField = [...RELANCE_POLICY_FIELDS].find((f) => !(f in policy));
        if (
          unknownPolicyField !== undefined ||
          missingPolicyField !== undefined ||
          [...RELANCE_POLICY_FIELDS].some((f) => !Number.isSafeInteger(policy[f]))
        ) {
          issues.push({
            field: 'relancePolicy',
            message:
              'Cadence invalide ({ cordialAfterDays, neutreAfterDays, fermeAfterDays, miseEnDemeureAfterDays } entiers).',
          });
        } else {
          relancePolicy = {
            cordialAfterDays: policy.cordialAfterDays as number,
            neutreAfterDays: policy.neutreAfterDays as number,
            fermeAfterDays: policy.fermeAfterDays as number,
            miseEnDemeureAfterDays: policy.miseEnDemeureAfterDays as number,
          };
        }
      }
    }
    if ('relanceAutoEnabled' in body && typeof body.relanceAutoEnabled !== 'boolean') {
      issues.push({ field: 'relanceAutoEnabled', message: 'Booléen requis.' });
    }
    const patch = {
      ...('showRibOnInvoices' in body
        ? { showRibOnInvoices: body.showRibOnInvoices as boolean }
        : {}),
      ...('showInsuranceOnInvoices' in body
        ? { showInsuranceOnInvoices: body.showInsuranceOnInvoices as boolean }
        : {}),
      ...('pdfAccentColor' in body
        ? { pdfAccentColor: body.pdfAccentColor as 'navy' | 'green' | 'purple' | 'orange' }
        : {}),
      ...('defaultQuoteValidityDays' in body
        ? { defaultQuoteValidityDays: body.defaultQuoteValidityDays as number }
        : {}),
      ...('defaultDepositPercent' in body
        ? { defaultDepositPercent: body.defaultDepositPercent as number }
        : {}),
      ...('defaultInvoicePaymentTermsDays' in body
        ? {
            defaultInvoicePaymentTermsDays: body.defaultInvoicePaymentTermsDays as number | null,
          }
        : {}),
      ...(relancePolicy !== undefined ? { relancePolicy } : {}),
      ...('relanceAutoEnabled' in body
        ? { relanceAutoEnabled: body.relanceAutoEnabled as boolean }
        : {}),
    };
    if (Object.keys(patch).length === 0) {
      issues.push({ field: 'settings', message: 'Au moins un réglage est requis.' });
    }
    if (issues.length > 0) throwValidationIssues(issues);
    return unwrap(
      await this.backend.updateCompanyBillingSettings({
        expectedRevision: body.expectedRevision as number,
        patch,
      }),
    );
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

  /**
   * Renvoie la preuve bancaire qualifiée AUGMENTÉE de `position` (ajout strictement ADDITIF :
   * tous les champs historiques sont inchangés, un client antérieur ne casse pas).
   *
   * `position` porte les DEUX nombres dont le mobile a besoin — `observedBalanceCents` (le fait,
   * daté) et `estimatedBalanceCents` (le fait + les mouvements postérieurs) — plus le détail des
   * entrées/sorties qui explique l'écart. `position: null` = projection des mouvements indisponible ;
   * l'appelant s'en tient alors au solde constaté, jamais à un estimé partiel.
   */
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
  /** PR-14 « Refaire ce devis » — NOUVEAU brouillon repassant intégralement par CreateQuote
   * (TVA revalidée au régime du jour ; signature/urgence/n°/validité jamais copiés). Hors
   * transaction d'intercepteur : le coordinateur idempotent gère les siennes (patron POST /). */
  @Post(':id/duplicate')
  @WithoutTenantPersistenceTransaction()
  async duplicate(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.duplicateQuote(id, parseDuplicateQuoteBody(body)));
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
  /** Lien public de VISUALISATION (canal d'envoi universel, sans e-mail) — même doctrine SANS
   * AUCUN sortant que :id/signature-link. Tout statut sauf brouillon. */
  @Post(':id/view-link')
  async createViewLink(@Param('id') id: string) {
    return unwrap(await this.backend.createQuoteViewLink(id));
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
    return unwrap(
      await this.backend.generateInvoice({ quoteId: id, ...parseInvoiceGenerationBody(body) }),
    );
  }
  /** Embargo L221-10 — DÉFAUT légal du flow « encaisser » pendant la fenêtre : programme
   * l'envoi du message de règlement au client à J+7 (outbox planifiée, dédupée par devis).
   * Aucun corps : toute la décision (fenêtre, montant, message) est serveur. */
  @Post(':id/embargo-scheduled-payment')
  async scheduleEmbargoPayment(@Param('id') id: string) {
    return unwrap(await this.backend.scheduleEmbargoPayment(id));
  }
  /** R6 : édition d'une ligne de devis BROUILLON (le use case/l'agrégat gardent le statut). */
  @Patch(':id/lines/:lineId')
  async updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.updateQuoteLine({
        quoteId: id,
        lineId,
        patch: parseQuoteLinePatchBody(body),
      }),
    );
  }
  /** R6 : suppression d'une ligne de devis BROUILLON. */
  @Delete(':id/lines/:lineId')
  async removeLine(@Param('id') id: string, @Param('lineId') lineId: string) {
    return unwrap(await this.backend.removeQuoteLine({ quoteId: id, lineId }));
  }
  /** B8 : attache (ou remplace) le bon de commande client d'un devis NON FACTURÉ — le numéro
   * d'engagement est saisi UNE FOIS ici puis repris automatiquement sur la facture dérivée. */
  @Put(':id/purchase-order')
  async attachPurchaseOrder(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.attachQuotePurchaseOrder({
        quoteId: id,
        ...parsePurchaseOrderAttachBody(body),
      }),
    );
  }
  /** B8 : retrait EXPLICITE du bon de commande (devis non facturé uniquement). */
  @Delete(':id/purchase-order')
  async detachPurchaseOrder(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.detachQuotePurchaseOrder({
        quoteId: id,
        ...parsePurchaseOrderDetachBody(body),
      }),
    );
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
  /** B1 : facture DIRECTE sans devis signé (brouillon composé librement — dépannage urgent B2C
   * qualifié A3bis, régie TJM × jours, syndic/B2B). L'émission passe ensuite par POST :id/issue
   * (numéro, mentions, échéance B4, A7/A4) — aucun chemin parallèle. */
  @Post()
  async compose(@Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.composeStandaloneInvoice(parseComposeInvoiceBody(body)));
  }
  /** Suivi MANUEL de transmission d'une pièce ÉMISE vers le canal de facturation du client
   * (dates de dépôt/acceptation DÉCLARÉES — suivi honnête, additif, corrigeable). */
  @Patch(':id/transmission')
  async recordTransmission(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.recordInvoiceTransmission({
        invoiceId: id,
        ...parseInvoiceTransmissionBody(body),
      }),
    );
  }
  /** C25 ② : envoi RÉEL d'une relance ciblée (ton du plan @bob/core, mise en demeure incluse —
   * le geste utilisateur EST la validation). Throttlé : action sortante vers un tiers. */
  @Post(':id/relance')
  @Throttle({ default: { limit: 5, ttl: 10_000 } })
  async sendRelance(@Param('id') id: string) {
    return unwrap(await this.relances.sendRelance(id));
  }
  /** PR-01 « Encaisser » : envoi EMAIL réel de la facture ÉMISE (patron deliveryStatus de
   * sendQuote) — geste explicite confirmé côté client, lien public + PDF archivé joint,
   * expéditeur perçu = la société. Throttlé : action sortante vers un tiers. */
  @Post(':id/send')
  @Throttle({ default: { limit: 5, ttl: 10_000 } })
  async send(@Param('id') id: string, @Body() body: unknown) {
    return unwrap(await this.backend.sendInvoice(id, parseSendInvoiceBody(body)));
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
  async paymentAccountingPreview(
    @Param('id') id: string,
    @Query('amount') amount: string,
    @Query('method') method?: PaymentMethod,
  ) {
    return unwrap(
      await this.backend.paymentAccountingPreview({
        invoiceId: id,
        amountCents: Number(amount),
        method: method ?? 'transfer',
      }),
    );
  }
  /** A7 — corps OPTIONNEL (compat clients existants sans corps) : période de prestation si
   * distincte de l'émission + adresse de chantier/livraison si distincte de la facturation
   * (art. L441-9 c. com., 242 nonies A CGI). Validé ici en forme, puis revalidé et FIGÉ par le
   * domaine (Invoice.issue) — un rejet n'consomme aucun numéro. */
  @Post(':id/issue')
  async issue(@Param('id') id: string, @Body() body?: unknown) {
    const input: {
      invoiceId: string;
      servicePeriod?: { start: string; end: string | null };
      deliveryAddress?: string;
      operationCategory?: 'goods' | 'services' | 'mixed';
      embargoOverride?: boolean;
      purchaseOrderOverride?: boolean;
    } = { invoiceId: id };
    if (body !== undefined && body !== null) {
      assertJsonObjectBody(body);
      const unknownField = Object.keys(body).find((field) => !INVOICE_ISSUE_FIELDS.has(field));
      if (unknownField !== undefined) {
        throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
      }
      // L'id du chemin fait foi : un corps qui en désigne un AUTRE est une incohérence rejetée.
      if ('invoiceId' in body && body.invoiceId !== id) {
        throwValidationIssues([
          { field: 'invoiceId', message: 'Identifiant du corps incohérent avec le chemin.' },
        ]);
      }
      const issues: ValidationIssue[] = [];
      if ('servicePeriod' in body && body.servicePeriod !== null) {
        if (typeof body.servicePeriod !== 'object' || Array.isArray(body.servicePeriod)) {
          issues.push({ field: 'servicePeriod', message: 'Période de prestation invalide.' });
        } else {
          const nested = body.servicePeriod as Record<string, unknown>;
          const unknownNested = Object.keys(nested).find(
            (field) => !SERVICE_PERIOD_FIELDS.has(field),
          );
          const start = typeof nested.start === 'string' ? nested.start : '';
          const end = nested.end === undefined || nested.end === null ? null : nested.end;
          if (
            unknownNested !== undefined ||
            !isValidDateOnly(start) ||
            (end !== null && (typeof end !== 'string' || !isValidDateOnly(end)))
          ) {
            issues.push({
              field: 'servicePeriod',
              message: 'Période de prestation invalide ({ start: AAAA-MM-JJ, end: AAAA-MM-JJ | null }).',
            });
          } else {
            input.servicePeriod = { start, end: end as string | null };
          }
        }
      }
      if ('deliveryAddress' in body && body.deliveryAddress !== null) {
        const deliveryAddress =
          typeof body.deliveryAddress === 'string' ? body.deliveryAddress.trim() : '';
        if (deliveryAddress.length === 0 || deliveryAddress.length > 500) {
          issues.push({
            field: 'deliveryAddress',
            message: 'Adresse de chantier/livraison invalide (texte non vide, 500 caractères max).',
          });
        } else {
          input.deliveryAddress = deliveryAddress;
        }
      }
      if ('operationCategory' in body) {
        if (
          body.operationCategory !== 'goods'
          && body.operationCategory !== 'services'
          && body.operationCategory !== 'mixed'
        ) {
          issues.push({
            field: 'operationCategory',
            message: 'Nature attendue : goods, services ou mixed.',
          });
        } else {
          input.operationCategory = body.operationCategory;
        }
      }
      // Override L221-10 : `true` strict uniquement (jamais implicite, jamais par truthiness).
      if ('override' in body) {
        if (typeof body.override !== 'boolean') {
          issues.push({ field: 'override', message: 'Booléen attendu.' });
        } else if (body.override === true) {
          input.embargoOverride = true;
        }
      }
      // PR-04 — override de la garde « BC obligatoire » : même discipline (`true` strict).
      if ('purchaseOrderOverride' in body) {
        if (typeof body.purchaseOrderOverride !== 'boolean') {
          issues.push({ field: 'purchaseOrderOverride', message: 'Booléen attendu.' });
        } else if (body.purchaseOrderOverride === true) {
          input.purchaseOrderOverride = true;
        }
      }
      if (issues.length > 0) throwValidationIssues(issues);
    }
    return unwrap(await this.backend.issueInvoice(input));
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
  /** Lien public de VISUALISATION (canal d'envoi universel, sans e-mail) — même doctrine SANS
   * AUCUN sortant que quotes/:id/signature-link. Facture ÉMISE uniquement, jamais un brouillon. */
  @Post(':id/view-link')
  async createViewLink(@Param('id') id: string) {
    return unwrap(await this.backend.createInvoiceViewLink(id));
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
  /** B8 : attache (ou remplace) le bon de commande d'une facture BROUILLON — le numéro
   * d'engagement doit être posé AVANT émission (il figure sur la pièce légale figée). */
  @Put(':id/purchase-order')
  async attachPurchaseOrder(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.attachInvoicePurchaseOrder({
        invoiceId: id,
        ...parsePurchaseOrderAttachBody(body),
      }),
    );
  }
  /** B8 : retrait EXPLICITE du bon de commande (facture brouillon uniquement). */
  @Delete(':id/purchase-order')
  async detachPurchaseOrder(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.detachInvoicePurchaseOrder({
        invoiceId: id,
        ...parsePurchaseOrderDetachBody(body),
      }),
    );
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
  async fecDescription(
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<StreamableFile> {
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
    body: {
      contentBase64: string;
      mimeType: string;
      filename: string;
      idempotencyKey: string;
    },
  ) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.createDocumentIntake(body));
  }
  @Post(':id/classify')
  async classify(@Param('id') documentId: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.classifyDocument({ documentId, ...parseClassifyDocumentBody(body) }),
    );
  }
  /** « C'est bon, je valide » : pose reviewedAt SANS déplacer ni lier (AcknowledgeDocument @bob/core). */
  @Post(':id/acknowledge')
  async acknowledge(@Param('id') documentId: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(
      await this.backend.acknowledgeDocument({
        documentId,
        ...parseAcknowledgeDocumentBody(body),
      }),
    );
  }
  @Put(':id/expense')
  @WithoutTenantPersistenceTransaction()
  async recordExpenseFromDocument(@Param('id') documentId: string, @Body() body: unknown) {
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
  /** Renomme le libellé d'affichage (le filename d'archive reste immuable) — RenameDocument @bob/core. */
  @Put(':id/name')
  async rename(@Param('id') documentId: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.renameDocument({ documentId, ...parseRenameDocumentBody(body) }));
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
        {
          ok: false,
          error: {
            kind: 'validation',
            issues: [{ field: 'body', message: 'Une seule modification à la fois.' }],
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return body.name !== undefined
      ? unwrap(
          await this.backend.renameDocumentFolder({
            folderId,
            name: body.name,
            expectedRevision: body.expectedRevision,
          }),
        )
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
    return unwrap(
      await this.backend.executeDocumentFolderDeletion({ planId, strategy: body.strategy }),
    );
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
    return unwrap(
      await this.backend.publicSignQuote(
        token,
        parsed.signerName,
        parsed.proofDataUrl,
        // A3 — demande d'exécution anticipée cochée par le client B2C (L221-25), tracée serveur.
        parsed.earlyExecutionRequested,
      ),
    );
  }
}

/**
 * Consultation publique d'un devis OU d'une facture (lien sans e-mail, scope document_view) —
 * jamais de capacité de signature/paiement ici, lecture seule + PDF. Mêmes headers durcis que
 * PublicSignatureController (R4 challenge GPT) : no-store/no-referrer/noindex.
 */
@Controller('public/view')
export class PublicDocumentViewController {
  constructor(private readonly backend: BackendService) {}
  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async get(@Param('token') token: string) {
    return unwrap(await this.backend.publicDocumentView(token));
  }
  @Get(':token/pdf')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async pdf(@Param('token') token: string): Promise<StreamableFile> {
    const bytes = unwrap(await this.backend.publicDocumentPdf(token));
    return new StreamableFile(Buffer.from(bytes), {
      type: 'application/pdf',
      disposition: 'inline; filename="document.pdf"',
    });
  }
}

/** POST /public/retract/:token — déclaration de rétractation en ligne (D221-5, II c. conso). */
const RETRACTATION_EXERCISE_FIELDS = new Set(['declarantName', 'acknowledgmentEmail']);

/**
 * A3 — Fonctionnalité de RÉTRACTATION en ligne du consommateur (art. L221-21 dernier al.
 * c. conso, ordonnance n° 2026-2 du 05/01/2026 ; modalités art. D221-5, décret n° 2026-3 — en
 * vigueur depuis le 19/06/2026) : « Renoncer au contrat ici », accessible SANS FRAIS pendant
 * toute la durée du délai de rétractation, déclaration soumise via « Confirmer la
 * rétractation », accusé de réception sur support durable. Mêmes headers durcis et même
 * doctrine anti-énumération que la signature publique.
 */
@Controller('public/retract')
export class PublicRetractationController {
  constructor(private readonly backend: BackendService) {}
  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async get(@Param('token') token: string) {
    return unwrap(await this.backend.publicRetractationView(token));
  }
  @Post(':token')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async exercise(@Param('token') token: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    const unknownField = Object.keys(body).find((field) => !RETRACTATION_EXERCISE_FIELDS.has(field));
    if (unknownField !== undefined) {
      throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
    }
    const declarantName = typeof body.declarantName === 'string' ? body.declarantName : '';
    const acknowledgmentEmail =
      typeof body.acknowledgmentEmail === 'string' ? body.acknowledgmentEmail : '';
    // La validation de FOND (nom, format e-mail, fenêtre légale) appartient au use case pur
    // ExerciseRetractation — ici seule la structure du corps est contrôlée.
    return unwrap(await this.backend.publicExerciseRetractation(token, { declarantName, acknowledgmentEmail }));
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
    return unwrap(
      await this.backend.updateCatalogueItem({
        itemId,
        expectedRevision: parsed.expectedRevision as number,
        item: parsed.item,
      }),
    );
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
    return unwrap(
      await this.backend.deleteCatalogueItem({
        itemId,
        expectedRevision: body.expectedRevision as number,
      }),
    );
  }
}

/** PR-11 — hygiène de forme d'un id d'équipement (la SUBSTANCE — équipement du même site du
 * tenant — reste l'autorité du use case, fail-closed). */
function parseEquipmentIdField(
  body: Record<string, unknown>,
  issues: ValidationIssue[],
): string | null | undefined {
  if (!('equipmentId' in body)) return undefined;
  const value = body['equipmentId'];
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    issues.push({ field: 'equipmentId', message: 'Identifiant d’équipement invalide.' });
    return undefined;
  }
  return value;
}

function parseChantierNoteBody(body: Record<string, unknown>): {
  text: string;
  equipmentId?: string | null;
} {
  const issues: ValidationIssue[] = [];
  const unknownField = Object.keys(body).find((field) => field !== 'text' && field !== 'equipmentId');
  if (unknownField !== undefined)
    throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
  if (typeof body.text !== 'string' || body.text.trim().length === 0)
    throwValidationIssues([{ field: 'text', message: 'Texte de note requis.' }]);
  const equipmentId = parseEquipmentIdField(body, issues);
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    text: body.text as string,
    ...(equipmentId !== undefined ? { equipmentId } : {}),
  };
}

const WORKSITE_PHOTO_FIELDS = new Set(['contentBase64', 'mimeType', 'filename', 'equipmentId']);

function parseWorksitePhotoBody(body: Record<string, unknown>): {
  contentBase64: string;
  mimeType: string;
  filename: string;
  equipmentId?: string | null;
} {
  const issues: ValidationIssue[] = [];
  const unknownField = Object.keys(body).find((field) => !WORKSITE_PHOTO_FIELDS.has(field));
  if (unknownField !== undefined)
    throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
  if (
    typeof body.contentBase64 !== 'string' ||
    body.contentBase64.length === 0 ||
    typeof body.mimeType !== 'string' ||
    !body.mimeType.startsWith('image/') ||
    typeof body.filename !== 'string' ||
    body.filename.trim().length === 0
  ) {
    throwValidationIssues([{ field: 'body', message: 'Photo invalide.' }]);
  }
  const equipmentId = parseEquipmentIdField(body, issues);
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    contentBase64: body.contentBase64 as string,
    mimeType: body.mimeType as string,
    filename: body.filename as string,
    ...(equipmentId !== undefined ? { equipmentId } : {}),
  };
}

// ── PR-11 — frontière HTTP du parc d'équipements ──

const CREATE_EQUIPMENT_FIELDS = new Set([
  'label', 'kind', 'brand', 'serialNumber', 'location', 'installedAt', 'warrantyUntil', 'notes',
]);
const EQUIPMENT_PATCH_FIELDS = CREATE_EQUIPMENT_FIELDS;

function parseEquipmentFreeField(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  issues: ValidationIssue[],
  // [Revue train n°2] notes de terrain MULTILIGNES : \n/\t admis, autres contrôles refusés
  // (miroir du domaine hasForbiddenNotesCharacter et du CHECK SQL translate()).
  multiline = false,
): string | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null) return null;
  const controlProbe =
    typeof value === 'string' && multiline ? value.replaceAll('\n', '').replaceAll('\t', '') : value;
  if (
    typeof value !== 'string' ||
    typeof controlProbe !== 'string' ||
    value.length > maxLength ||
    hasControlCharacter(controlProbe)
  ) {
    issues.push({ field, message: `Champ invalide (${maxLength} caractères maximum).` });
    return undefined;
  }
  return value;
}

function parseEquipmentDateField(
  body: Record<string, unknown>,
  field: string,
  issues: ValidationIssue[],
): string | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push({ field, message: 'Date attendue (AAAA-MM-JJ).' });
    return undefined;
  }
  return value;
}

function parseEquipmentFields(body: Record<string, unknown>, issues: ValidationIssue[]) {
  const kind = parseEquipmentFreeField(body, 'kind', 200, issues);
  const brand = parseEquipmentFreeField(body, 'brand', 200, issues);
  const serialNumber = parseEquipmentFreeField(body, 'serialNumber', 200, issues);
  const location = parseEquipmentFreeField(body, 'location', 200, issues);
  const notes = parseEquipmentFreeField(body, 'notes', 2000, issues, true);
  const installedAt = parseEquipmentDateField(body, 'installedAt', issues);
  const warrantyUntil = parseEquipmentDateField(body, 'warrantyUntil', issues);
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(brand !== undefined ? { brand } : {}),
    ...(serialNumber !== undefined ? { serialNumber } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(installedAt !== undefined ? { installedAt } : {}),
    ...(warrantyUntil !== undefined ? { warrantyUntil } : {}),
  };
}

function parseCreateEquipmentBody(body: Record<string, unknown>): {
  label: string;
  kind?: string | null;
  brand?: string | null;
  serialNumber?: string | null;
  location?: string | null;
  installedAt?: string | null;
  warrantyUntil?: string | null;
  notes?: string | null;
} {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (!CREATE_EQUIPMENT_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const label = body['label'];
  if (
    typeof label !== 'string' ||
    label.trim().length === 0 ||
    label.length > 200 ||
    hasControlCharacter(label)
  ) {
    issues.push({ field: 'label', message: 'Nom d’équipement requis (200 caractères maximum).' });
  }
  const fields = parseEquipmentFields(body, issues);
  if (issues.length > 0) throwValidationIssues(issues);
  return { label: label as string, ...fields };
}

function parseUpdateEquipmentBody(body: Record<string, unknown>): {
  expectedRevision: number;
  patch: Record<string, unknown>;
} {
  const issues: ValidationIssue[] = [];
  for (const field of Object.keys(body)) {
    if (field !== 'expectedRevision' && !EQUIPMENT_PATCH_FIELDS.has(field)) {
      issues.push({ field: 'body', message: `Champ non autorisé : ${field}.` });
    }
  }
  const expectedRevision = body['expectedRevision'];
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    issues.push({ field: 'expectedRevision', message: 'Révision invalide.' });
  }
  const label = body['label'];
  if (
    label !== undefined &&
    (typeof label !== 'string' ||
      label.trim().length === 0 ||
      label.length > 200 ||
      hasControlCharacter(label))
  ) {
    issues.push({ field: 'label', message: 'Nom d’équipement invalide.' });
  }
  const fields = parseEquipmentFields(body, issues);
  if (issues.length > 0) throwValidationIssues(issues);
  return {
    expectedRevision: expectedRevision as number,
    patch: {
      ...(typeof label === 'string' ? { label } : {}),
      ...fields,
    },
  };
}

function parseExpectedRevisionBody(body: Record<string, unknown>): { expectedRevision: number } {
  const unknownField = Object.keys(body).find((field) => field !== 'expectedRevision');
  if (unknownField !== undefined)
    throwValidationIssues([{ field: unknownField, message: 'Champ non autorisé.' }]);
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1)
    throwValidationIssues([{ field: 'expectedRevision', message: 'Révision invalide.' }]);
  return { expectedRevision: body.expectedRevision as number };
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
  // ── Journal (notes horodatées) — fiche chantier, extension V1 ──
  @Get(':id/notes')
  async listNotes(@Param('id') id: string) {
    return unwrap(await this.backend.listChantierNotes(id));
  }
  @Post(':id/notes')
  async addNote(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.addChantierNote(id, parseChantierNoteBody(body)));
  }
  // ── Photos — grille de vignettes, fiche chantier, extension V1 ──
  @Get(':id/photos')
  async listPhotos(@Param('id') id: string) {
    return unwrap(await this.backend.listWorksitePhotos(id));
  }
  @Post(':id/photos')
  async uploadPhoto(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.uploadWorksitePhoto(id, parseWorksitePhotoBody(body)));
  }
  @Get('photos/:photoId/view-url')
  async photoViewUrl(@Param('photoId') photoId: string) {
    return unwrap(await this.backend.worksitePhotoViewUrl(photoId));
  }
  @Delete('photos/:photoId')
  async deletePhoto(@Param('photoId') photoId: string) {
    return unwrap(await this.backend.deleteWorksitePhoto(photoId));
  }
  // ── PR-11 — parc d'équipements du site (Bloc A) ──
  @Get(':id/equipments')
  async listEquipments(@Param('id') id: string) {
    return unwrap(await this.backend.listChantierEquipments(id));
  }
  @Post(':id/equipments')
  async createEquipment(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    return unwrap(await this.backend.createEquipment(id, parseCreateEquipmentBody(body)));
  }
  /** [Revue A12] — réponse au refus actionnable « site clôturé — rouvre-le » : la transition
   * inverse de la clôture, idempotente. */
  @Post(':id/reopen')
  async reopen(@Param('id') id: string) {
    return unwrap(await this.backend.reopenChantier(id));
  }
}

/** PR-11 — mutations/lectures d'un équipement PAR id (le site est porté par la fiche). */
@Controller('equipments')
export class EquipmentsController {
  constructor(private readonly backend: BackendService) {}
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    const parsed = parseUpdateEquipmentBody(body);
    return unwrap(
      await this.backend.updateEquipment({
        equipmentId: id,
        expectedRevision: parsed.expectedRevision,
        patch: parsed.patch,
      }),
    );
  }
  @Post(':id/retire')
  async retire(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    const parsed = parseExpectedRevisionBody(body);
    return unwrap(
      await this.backend.retireEquipment({ equipmentId: id, expectedRevision: parsed.expectedRevision }),
    );
  }
  @Post(':id/reactivate')
  async reactivate(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    const parsed = parseExpectedRevisionBody(body);
    return unwrap(
      await this.backend.reactivateEquipment({
        equipmentId: id,
        expectedRevision: parsed.expectedRevision,
      }),
    );
  }
  @Get(':id/history')
  async history(@Param('id') id: string) {
    return unwrap(await this.backend.getEquipmentHistory(id));
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
    return unwrap(
      await this.backend.confirmFacturXExpense({ xml: body.xml ?? '', decision: body.decision }),
    );
  }
  /** Enregistre un règlement fournisseur déjà effectué. Bob ne déclenche aucun virement : le
   * propriétaire fournit obligatoirement date + moyen, et peut rattacher une preuve du coffre. */
  @Post(':id/pay')
  async pay(@Param('id') id: string, @Body() body: unknown) {
    const evidence = parseExpensePaymentEvidenceBody(body);
    return unwrap(await this.backend.recordExpensePayment({ expenseId: id, ...evidence }));
  }
  /** Régularise une dépense HISTORIQUE « payée sans preuve » (migration lane preuves) : même
   * contrat de preuve que :id/pay, écriture 401/512-530 posée, la ligne sort de l'état legacy. */
  @Post(':id/regularize-payment')
  async regularizePayment(@Param('id') id: string, @Body() body: unknown) {
    const evidence = parseExpensePaymentEvidenceBody(body);
    return unwrap(await this.backend.regularizeExpensePayment({ expenseId: id, ...evidence }));
  }
  /** Impute la dépense à un chantier (rentabilité par chantier) — ou la délie avec
   * { chantierId: null } EXPLICITE. AssignExpenseToChantier (@bob/core) : tenant strict,
   * chantier prouvé dans le tenant (anti-IDOR fail-closed), idempotent. */
  @Put(':id/chantier')
  async assignChantier(@Param('id') id: string, @Body() body: unknown) {
    assertJsonObjectBody(body);
    const chantierId = parseAssignExpenseChantierBody(body);
    return unwrap(await this.backend.assignExpenseChantier({ expenseId: id, chantierId }));
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
  @Header('Cache-Control', 'no-store, private, max-age=0')
  @Header('Pragma', 'no-cache')
  async get() {
    return unwrap(await this.backend.getSubscription());
  }
  @Get('invoices')
  @Header('Cache-Control', 'no-store, private, max-age=0')
  @Header('Pragma', 'no-cache')
  async invoices() {
    return unwrap(await this.backend.listSubscriptionInvoices());
  }
  @Post('checkout')
  checkout(@Body() body: unknown) {
    assertJsonObjectBody(body);
    const unknownField = Object.keys(body).find(
      (field) => !SUBSCRIPTION_CHECKOUT_FIELDS.has(field),
    );
    if (unknownField !== undefined || !SUBSCRIPTION_CHECKOUT_TIERS.has(body.tier as PlanTier)) {
      throwValidationIssues([
        {
          field: unknownField ?? 'tier',
          message:
            unknownField === undefined
              ? 'Offre payante invalide.'
              : 'Champ non autorisé.',
        },
      ]);
    }
    return this.backend.startCheckout(body.tier as PlanTier);
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
    return unwrap(
      await this.backend.transcribe({
        audioBase64: body.audioBase64 ?? '',
        mimeType: body.mimeType ?? 'audio/m4a',
      }),
    );
  }
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('synthesize')
  async synthesize(@Body() body: { text?: string }) {
    return unwrap(await this.backend.synthesizeSpeech({ text: body.text ?? '' }));
  }
}
