// Shared kernel (VOs, Result, time, aggregate)
export * from './shared-kernel/index';

// Formatage (présentation)
export * from './format/money';

// Domaine — value objects billing
export * from './domain/billing/shared/vat-rate';
export * from './domain/billing/shared/doc-number';
export * from './domain/billing/shared/quantity';
export * from './domain/billing/shared/line-item';
export * from './domain/billing/shared/totals';

// Domaine — entités
export * from './domain/company/company';
export * from './domain/customer/customer';
export * from './domain/customer/score';

// Domaine — services purs (cœur déterministe)
export * from './domain/services/compute-totals';
export * from './domain/services/suggest-vat-rate';
export * from './domain/services/build-mentions';
export * from './domain/services/score-customer';
export * from './domain/services/einvoice-for';
export * from './domain/services/project-cashflow';
export * from './domain/services/cashflow-band';
export * from './domain/services/build-relance';

// Domaine — agrégats billing & machines à états
export * from './domain/billing/shared/signature';
export * from './domain/billing/shared/line';
export * from './domain/billing/shared/state-machines';
export * from './domain/billing/quote/quote';
export * from './domain/billing/invoice/invoice';
export * from './domain/payment/payment';
export * from './domain/expense/expense';
export * from './domain/accounting/chart-of-accounts';
export * from './domain/accounting/accounting-entry';
export * from './domain/accounting/invoice-accounting';
export * from './domain/accounting/expense-accounting';
export * from './domain/accounting/payment-accounting';
export * from './domain/document/document';
export * from './domain/chantier/chantier';
export * from './domain/dunning/relance-plan';
export * from './domain/compliance/einvoice-transmission';
export * from './domain/compliance/diagnostic';
export * from './domain/compliance/vat-thresholds';
export * from './domain/compliance/facturx';
export * from './domain/compliance/facturx-validation';
export * from './domain/company/trade-profile';
export * from './domain/company/naf-to-trade';
export * from './domain/company/nature-juridique';
export * from './domain/ocr/ocr-extraction';

// Flows — machines à états UI-consommables (C20 voix, C21 devis)
export * from './flows/devis';
export * from './flows/voice-invoice';

// Couche Application — use cases, ports, fixtures
export * from './application/result';
export * from './application/ports/repositories';
export * from './application/ports/services';
export * from './application/ports/company-lookup';
export * from './application/ports/vat-validation';
export * from './application/ports/address-autocomplete';
export * from './application/ports/public-access-token';
export * from './application/ports/document-repository';
export * from './application/ports/document-storage';
export * from './application/ports/accounting-entry-repository';
export * from './application/ports/chart-of-accounts-repository';
export * from './application/billing/create-quote';
export * from './application/billing/send-quote';
export * from './application/billing/sign-quote';
export * from './application/billing/refuse-quote';
export * from './application/billing/expire-quote';
export * from './application/billing/create-credit-note';
export * from './application/billing/generate-invoice-from-quote';
export * from './application/billing/issue-invoice';
export * from './application/billing/register-payment';
export * from './application/public-access/create-quote-signature-token';
export * from './application/public-access/resolve-quote-signature-token';
export * from './application/queries/list-customers';
export * from './application/queries/get-cashflow';
export * from './application/today/derive-today-priorities';
export * from './application/relances/derive-relance-plan';
export * from './application/diagnostic/derive-diagnostic';
export * from './application/onboarding/derive-trade-profile';
export * from './application/catalogue/derive-catalogue';
export * from './application/compte/derive-account-view';
export * from './application/argent/build-ledger-view';
export * from './application/argent/derive-vat-position';
export * from './application/billing/build-piece-view';
export * from './application/clients/derive-customer-standings';
export * from './application/clients/derive-aged-balance';
export * from './application/expenses/record-expense';
export * from './application/expenses/pay-expense';
export * from './application/expenses/summarize-expenses';
export * from './application/chantier/create-chantier';
export * from './application/company/autofill-company';
export * from './application/company/validate-vat';
export * from './application/company/search-address';
export * from './application/documents/classify-document';
export * from './application/documents/derive-vault-view';
export * from './application/documents/document-view';
export * from './application/documents/get-document-download-url';
export * from './application/documents/list-documents';
export * from './application/documents/search-vault';
export * from './application/search/search-global';
export * from './application/documents/storage-key';
export * from './application/documents/store-document';
export * from './application/accounting/initialize-chart-of-accounts';
export * from './application/accounting/list-accounting-entries';
export * from './application/accounting/summarize-accounting-entries';
export * from './application/accounting/derive-trial-balance';
export * from './application/accounting/derive-income-statement';
export * from './application/accounting/derive-balance-sheet';
export * from './application/accounting/export-fec';
export * from './application/accounting/preview-payment-accounting-entry';
export * from './application/accounting/record-accounting-entry';
export * from './application/accounting/record-expense-accounting-entries';
export * from './application/accounting/record-issued-invoice-accounting-entry';
export * from './application/accounting/record-payment-accounting-entry';
export * from './application/fixtures/index';

// Monétisation
export * from './domain/subscription/plan';
export * from './domain/subscription/subscription';
export * from './application/ports/payment';

// Ports de sortie (PDF, notification)
export * from './application/ports/output';

// OCR documents (port + use case + adapter démo déterministe)
export * from './application/ports/ocr';
export * from './application/ocr/extract-document';
export * from './application/ocr/demo-ocr-adapter';

// Échéancier fiscal (C-EXP5 v1 — P09 : deriveFiscalCalendar)
export * from './application/fiscal/derive-fiscal-calendar';

// Recouvrement conforme (C-EXP2 vA — P12 pénalités chiffrées + P04 chrono prescription)
export * from './domain/dunning/late-penalties';
export * from './domain/dunning/prescription';

// Provision URSSAF micro (C-EXP5c — P03 : taux D613-4 CSS versionnés + déclaration pré-calculée)
export * from './domain/fiscal/micro-social';
export * from './application/fiscal/derive-urssaf-provision';
