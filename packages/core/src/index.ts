// Shared kernel (VOs, Result, time, aggregate)
export * from './shared-kernel/index';

// Formatage (présentation)
export * from './format/money';

// Domaine — value objects billing
export * from './domain/billing/shared/vat-rate';
export * from './domain/billing/shared/doc-number';
export * from './domain/billing/shared/quantity';
export * from './domain/billing/shared/line-item';
export * from './domain/billing/shared/billing-unit-reference';
export * from './domain/billing/shared/totals';
export * from './domain/billing/shared/purchase-order-ref';
export * from './domain/billing/shared/discount';

// Domaine — catalogue des actions publiques (spec Jarvis §6, FD-2026-0817-02)
export * from './domain/action-catalog/types';
export * from './domain/action-catalog/policy';
export * from './domain/action-catalog/invariants';
export * from './domain/action-catalog/catalog.data';
export * from './domain/action-catalog/rollout';

// Domaine — entités
export * from './domain/company/company';
export * from './domain/customer/customer';
export * from './domain/customer/score';

// Domaine — services purs (cœur déterministe)
export * from './domain/services/compute-totals';
export * from './domain/services/suggest-vat-rate';
export * from './domain/services/build-mentions';
export * from './domain/services/veille-mentions-legales';
export * from './domain/services/propose-situation';
export * from './domain/services/quote-billing-engagement';
export * from './domain/services/retenue-garantie';
export * from './domain/services/billing-transmission';
export * from './domain/services/international-emission-guard';
export * from './domain/services/payment-terms-legal';
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
export * from './domain/document/document-folder';
export * from './domain/document/document-analysis';
export * from './domain/document/document-destination';
export * from './domain/chantier/chantier';
export * from './domain/chantier/chantier-note';
export * from './domain/equipment/equipment';
export * from './domain/contract/maintenance-contract';
export * from './domain/contract/printable-words';
export * from './domain/contract/annual-invoice-designation';
export * from './domain/intervention/intervention';
export * from './domain/dunning/relance-plan';
export * from './domain/compliance/einvoice-transmission';
export * from './domain/compliance/diagnostic';
export * from './domain/compliance/vat-thresholds';
export * from './domain/compliance/facturx';
export * from './domain/compliance/french-billing-mode';
export * from './domain/compliance/billing-unit';
export * from './domain/compliance/facturx-validation';
export * from './domain/compliance/parse-facturx';
export * from './domain/compliance/einvoice-inbound';
export * from './domain/compliance/retractation';
export * from './domain/company/trade-profile';
export * from './domain/company/naf-to-trade';
export * from './domain/company/nature-juridique';
export * from './domain/company/registration-number';
export * from './domain/ocr/ocr-extraction';
export * from './domain/banking/bank-balance-snapshot';
export * from './domain/banking/bank-balance-freshness';
export * from './domain/agent/agent-mission';
// Domaine — Jarvis U1-b (vocabulaire, work items, reducer racine)
export * from './domain/agent/customer-contact-duplicate-review';
export * from './domain/agent/jarvis-run';
export * from './domain/agent/jarvis-work-item';
export * from './domain/agent/jarvis-run-reducer';
export * from './domain/agent/definitions/single-business-action-v1';
export * from './domain/agent/definitions/customer-contact-v1';
export * from './domain/agent/jarvis-command-id';
export * from './domain/agent/customer-contact-semantic-frame';
export * from './application/ports/jarvis-admission';
export * from './application/ports/jarvis-proposal-payload-store';
export * from './domain/agent/agent-mission-event';
export * from './domain/agent/mission-kind';

// Domaine Cabinet — tenant, memberships, invitations, RBAC et release flags
export * from './domain/cabinet/cabinet-permissions';
export * from './domain/cabinet/cabinet-member';
export * from './domain/cabinet/cabinet';
export * from './domain/cabinet/cabinet-invitation';
export * from './domain/cabinet/release-flag';

// Flows — machines à états UI-consommables (C20 voix, C21 devis)
export * from './flows/devis';
export * from './flows/devis-proposal';
export * from './flows/voice-invoice';
export * from './flows/voice-quote-line';

// Couche Application — use cases et ports de production
export * from './application/result';
export * from './application/ports/repositories';
export * from './application/ports/services';
export * from './application/ports/company-lookup';
export * from './application/ports/vat-validation';
export * from './application/ports/address-autocomplete';
export * from './application/ports/public-access-token';
export * from './application/ports/document-repository';
export * from './application/ports/document-storage';
export * from './application/ports/document-folder-repository';
export * from './application/ports/document-intelligence';
export * from './application/ports/document-link-target';
export * from './application/ports/accounting-entry-repository';
export * from './application/ports/chart-of-accounts-repository';
export * from './application/ports/cabinet-repository';
export * from './application/ports/cabinet-invitation-repository';
export * from './application/ports/cabinet-invitation-token';
export * from './application/ports/cabinet-invitation-dispatch';
export * from './application/ports/release-flag-repository';
export * from './application/ports/subscription-repository';
export * from './application/ports/bank-balance-snapshot-repository';
export * from './application/ports/cash-movement-projection';
export * from './application/subscription/get-subscription-status';
export * from './application/banking/create-bank-balance-snapshot';
export * from './application/banking/get-latest-qualified-bank-balance';
export * from './application/banking/derive-cash-position';
export * from './application/billing/create-quote';
export * from './application/billing/duplicate-quote';
export * from './application/billing/compose-standalone-invoice';
export * from './application/billing/line-input-validation';
export * from './application/billing/send-quote';
export * from './application/billing/send-invoice';
export * from './application/billing/sign-quote';
export * from './application/billing/exercise-retractation';
export * from './application/billing/refuse-quote';
export * from './application/billing/expire-quote';
export * from './application/billing/create-credit-note';
export * from './application/billing/generate-invoice-from-quote';
export * from './application/billing/record-invoice-transmission';
export * from './application/billing/issue-invoice';
export * from './application/billing/register-payment';
export * from './application/billing/delete-draft-invoice';
export * from './application/billing/update-quote-line';
export * from './application/billing/remove-quote-line';
export * from './application/billing/attach-purchase-order';
export * from './application/billing/update-invoice-service-period';
export * from './application/billing/list-invoiceable-quotes';
export * from './application/billing/company-billing-settings';
export * from './application/public-access/create-quote-signature-token';
export * from './application/public-access/create-quote-signature-link';
export * from './application/public-access/resolve-quote-signature-token';
export * from './application/public-access/resolve-quote-retractation-token';
export * from './application/public-access/create-document-view-link';
export * from './application/public-access/resolve-document-view-token';
export * from './application/queries/list-customers';
export * from './application/queries/get-cashflow';
export * from './application/today/derive-today-priorities';
export * from './application/relances/derive-relance-plan';
export * from './application/diagnostic/derive-diagnostic';
export * from './application/diagnostic/diagnostic-assessment';
export * from './application/onboarding/derive-trade-profile';
export * from './application/catalogue/derive-catalogue';
export * from './application/catalogue/catalogue-repository';
export * from './application/catalogue/catalogue-items';
export * from './application/compte/derive-account-view';
export * from './application/account/close-account';
export * from './application/argent/build-ledger-view';
export * from './application/argent/derive-vat-position';
export * from './application/argent/derive-known-receivables';
export * from './application/billing/build-piece-view';
export * from './application/clients/derive-customer-standings';
export * from './application/clients/derive-aged-balance';
export * from './application/clients/derive-customer-financial-metrics';
export * from './application/clients/update-customer';
export * from './application/clients/customer-contacts';
export * from './domain/customer/customer-contact';
export * from './application/quote-drafts/quote-draft-slot';
export * from './application/ports/agent-mission-fingerprint';
export * from './application/ports/agent-mission-repository';
export * from './application/ports/agent-mission-quote-line-work';
export * from './application/ports/agent-mission-unit-of-work';
export * from './application/ports/quote-vat-context';
export * from './application/ports/catalogue-candidate-search';
export * from './application/ports/customer-candidate-search';
export * from './application/agent-missions/agent-mission-application';
export * from './application/agent-missions/agent-mission-identifiers';
export * from './application/agent-missions/get-resumable-quote-agent-mission';
export * from './application/agent-missions/get-resumable-quote-agent-mission-v2';
export * from './application/ports/agent-mission-resume-unit-of-work';
export * from './application/agent-missions/agent-mission-bootstrap-policy';
export * from './application/agent-missions/start-quote-agent-mission';
export * from './application/agent-missions/get-active-agent-mission';
export * from './application/agent-missions/cancel-quote-agent-mission';
export * from './application/agent-missions/acknowledge-quote-screen';
export * from './application/agent-missions/advance-quote-agent-mission';
export * from './application/agent-missions/decide-quote-agent-mission';
export * from './application/agent-missions/resolve-customer-reference';
export * from './application/agent-missions/quote-line-work';
export * from './application/agent-missions/derive-quote-vat-decision-options';
export * from './application/agent-missions/derive-quote-line-proposal';
export * from './application/agent-missions/quote-line-patch';
export * from './application/agent-missions/quote-line-candidate';
export * from './application/agent-missions/stage-quote-agent-mission-lines';
export * from './application/agent-missions/stage-quote-agent-mission-lines-command';
export * from './application/agent-missions/continue-quote-agent-mission-line-queue';
export * from './application/agent-missions/decide-quote-agent-mission-catalogue-choice';
export * from './application/agent-missions/patch-quote-agent-mission-line';
export * from './application/agent-missions/cancel-quote-agent-mission-pending-line';
export * from './application/agent-missions/continue-quote-agent-mission-line-resolution';
export * from './application/agent-missions/decide-quote-agent-mission-line-proposal';
export * from './application/quote-drafts/apply-quote-draft-transition';
export * from './application/accounting/derive-sig';
export * from './application/accounting/derive-closing-review';
export * from './application/pilotage/derive-business-review';
export * from './application/expenses/record-expense';
export * from './application/expenses/assign-expense-to-chantier';
export * from './application/expenses/import-facturx-expense';
export * from './application/expenses/pay-expense';
export * from './application/expenses/record-expense-payment';
export * from './application/expenses/regularize-legacy-expense-payment';
export * from './application/expenses/summarize-expenses';
export * from './application/chantier/chantier-list-item';
export * from './application/chantier/create-chantier';
export * from './application/chantier/reopen-chantier';
export * from './application/chantier/add-chantier-note';
export * from './application/chantier/derive-chantier-pieces';
export * from './application/chantier/upload-worksite-photo';
export * from './application/chantier/delete-worksite-photo';
export * from './application/equipment/equipment-repository';
export * from './application/equipment/create-equipment';
export * from './application/equipment/update-equipment';
export * from './application/equipment/retire-equipment';
export * from './application/equipment/derive-equipment-history';
export * from './application/contracts/maintenance-contract-repository';
export * from './application/contracts/derive-contract-schedule';
export * from './application/contracts/contract-use-cases';
export * from './application/contracts/prepare-annual-invoice-draft';
export * from './application/intervention/intervention-repository';
export * from './application/intervention/create-intervention';
export * from './application/intervention/start-intervention';
export * from './application/intervention/complete-intervention';
export * from './application/intervention/cancel-intervention';
export * from './application/intervention/update-intervention';
export * from './application/intervention/sign-intervention';
export * from './application/intervention/generate-intervention-report';
export * from './application/intervention/send-intervention-report';
export * from './application/intervention/prepare-intervention-invoice-draft';
export * from './application/intervention/update-company-intervention-settings';
export * from './application/intervention/derive-intervention-billing';
export * from './application/ports/worksite-media';
export * from './application/company/autofill-company';
export * from './application/company/validate-vat';
export * from './application/company/search-address';
export * from './application/documents/acknowledge-document';
export * from './application/documents/classify-document';
export * from './application/documents/rename-document';
export * from './application/documents/document-folders';
export * from './application/documents/analyze-document';
export * from './application/documents/derive-vault-view';
export * from './application/documents/document-view';
export * from './application/documents/get-document-download-url';
export * from './application/documents/list-documents';
export * from './application/documents/search-vault';
export * from './application/search/search-global';
export * from './application/sales/parse-french-period';
export * from './application/sales/search-sales-documents';
export * from './application/ports/sales-document-search';
export * from './application/documents/storage-key';
export * from './application/documents/store-document';
export * from './application/documents/verified-stored-object';
export * from './application/accounting/initialize-chart-of-accounts';
export * from './application/accounting/list-accounting-entries';
export * from './application/accounting/summarize-accounting-entries';
export * from './application/accounting/derive-trial-balance';
export * from './application/accounting/derive-income-statement';
export * from './application/accounting/derive-balance-sheet';
export * from './application/accounting/build-closing-dossier';
export * from './application/accounting/export-fec';
export * from './application/accounting/preview-payment-accounting-entry';
export * from './application/accounting/record-accounting-entry';
export * from './application/accounting/record-expense-accounting-entries';
export * from './application/accounting/record-issued-invoice-accounting-entry';
export * from './application/accounting/record-payment-accounting-entry';
export * from './application/cabinet/cabinet-view';
export * from './application/cabinet/create-cabinet';
export * from './application/cabinet/invite-cabinet-member';
export * from './application/cabinet/accept-cabinet-invitation';
export * from './application/cabinet/manage-cabinet-member';
export * from './application/cabinet/revoke-cabinet-invitation';
export * from './application/cabinet/query-cabinets';
export * from './application/cabinet/evaluate-release-flag';

// Monétisation
export * from './domain/monetization/paywall';
export * from './domain/monetization/paywall-pressure';
export * from './domain/monetization/plan-diff';
export * from './domain/compliance/professional-advance-recovery';
export * from './domain/monetization/trial-report';
export * from './domain/monetization/trial';
export * from './domain/engagement/value-ledger';
export * from './domain/engagement/win-back';
export * from './domain/engagement/analytics';
export * from './domain/subscription/plan';
export * from './domain/subscription/subscription';
export * from './application/ports/payment';

// Ports de sortie (PDF, notification)
export * from './application/ports/output';

// OCR documents (port + use case de production)
export * from './application/ports/ocr';
export * from './application/ocr/extract-document';

// Échéancier fiscal (C-EXP5 v1 — P09 : deriveFiscalCalendar)
export * from './application/fiscal/derive-fiscal-calendar';

// Recouvrement conforme (C-EXP2 vA — P12 pénalités chiffrées + P04 chrono prescription)
export * from './domain/dunning/late-penalties';
export * from './domain/dunning/prescription';

// Provision URSSAF micro (C-EXP5c — P03 : taux D613-4 CSS versionnés + déclaration pré-calculée)
export * from './domain/fiscal/micro-social';
export * from './application/fiscal/derive-urssaf-provision';

// Profil fiscal & référentiel temporel (BOB EXPERT FISCAL, Phase 1A — SPEC_EXPERT_FISCAL.md §V2)
export * from './domain/fiscal/fiscal-profile';
export * from './domain/fiscal/fiscal-field-rules';
export * from './domain/fiscal/referentiel';
export * from './application/ports/fiscal-profile-repository';
export * from './application/fiscal/get-fiscal-profile';
export * from './application/fiscal/update-fiscal-profile-field';

// Langage & montant du prélèvement selon le profil confirmé (Phase 1C — SPEC_EXPERT_FISCAL §V2 pt. 1+6)
export * from './application/fiscal/derive-owner-pay-guidance';

// Minimisation de la télémétrie de plantage (B4 observabilité — politique partagée API + mobile)
export * from './observability/telemetry-scrubbing';
export * from './observability/voice-trace';
export * from './observability/realtime-voice-trace';
export * from './observability/realtime-voice-client-diagnostic';
export * from './observability/crash-reporting-region';
