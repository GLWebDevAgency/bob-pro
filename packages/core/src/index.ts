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
