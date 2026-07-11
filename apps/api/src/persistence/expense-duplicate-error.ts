/**
 * C-EXP-FIX1 (Bug 1 — DOUBLON TOCTOU) — sentinelle de violation d'unicité « facture fournisseur
 * déjà enregistrée », miroir de l'index UNIQUE PARTIEL Postgres
 *   (companyId, supplierSiren, supplierInvoiceNumber) WHERE supplierInvoiceNumber IS NOT NULL
 * (cf. migration 20260705120000_expense_facturx_reception).
 *
 * Émise par les DEUX adapters de persistence — Prisma (traduction du code P2002) et in-memory
 * (garde fidèle, pour que les tests soient réalistes) — afin que BackendService.recordExpense la
 * traduise UNE seule fois en erreur métier « doublon » (canal facturx.doublon), JAMAIS en 500.
 * Le contrôle applicatif reste la première ligne (message amical) ; cette contrainte est le filet
 * concurrentiel réel (double-tap/retry simultanés qui passent tous deux le read-then-write).
 */
export class DuplicateExpenseInvoiceError extends Error {
  constructor(
    readonly companyId: string,
    readonly supplierSiren: string | null,
    readonly supplierInvoiceNumber: string | null,
  ) {
    super(
      `Facture fournisseur déjà enregistrée (SIREN ${supplierSiren ?? '?'} / n° ${supplierInvoiceNumber ?? '?'}) — ` +
        `enregistrement refusé (anti double-paiement/double-déduction, contrainte base).`,
    );
    this.name = 'DuplicateExpenseInvoiceError';
  }
}
