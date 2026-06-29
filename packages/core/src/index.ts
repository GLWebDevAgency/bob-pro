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
export * from './domain/services/build-relance';

// Domaine — agrégats billing & machines à états
export * from './domain/billing/shared/signature';
export * from './domain/billing/shared/line';
export * from './domain/billing/shared/state-machines';
export * from './domain/billing/quote/quote';
export * from './domain/billing/invoice/invoice';
export * from './domain/payment/payment';
export * from './domain/dunning/relance-plan';
export * from './domain/compliance/einvoice-transmission';

// Couche Application — use cases, ports, fixtures
export * from './application/result';
export * from './application/ports/repositories';
export * from './application/ports/services';
export * from './application/billing/create-quote';
export * from './application/billing/send-quote';
export * from './application/billing/sign-quote';
export * from './application/billing/refuse-quote';
export * from './application/billing/generate-invoice-from-quote';
export * from './application/billing/issue-invoice';
export * from './application/billing/register-payment';
export * from './application/queries/list-customers';
export * from './application/queries/get-cashflow';
export * from './application/fixtures/index';

// Monétisation
export * from './domain/subscription/plan';
export * from './domain/subscription/subscription';
export * from './application/ports/payment';
