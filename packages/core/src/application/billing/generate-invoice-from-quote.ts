import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { Invoice } from '../../domain/billing/invoice/invoice';
import {
  deriveRetractation,
  offPremisesEmbargoOverrideRisk,
  offPremisesPaymentEmbargo,
  offPremisesPaymentEmbargoMessage,
  retractationFreeze,
  retractationFreezeMessage,
} from '../../domain/compliance/retractation';
import {
  type QuoteRepository,
  type InvoiceRepository,
  type CustomerRepository,
} from '../ports/repositories';
import {
  type ClockPort,
  type EmbargoOverrideAuditPort,
  type IdGeneratorPort,
} from '../ports/services';

export interface GenerateInvoiceDeps {
  quotes: QuoteRepository;
  invoices: InvoiceRepository;
  /** A3 — le type du client (b2c) et la signature décident du gel de rétractation. */
  customers: Pick<CustomerRepository, 'findById'>;
  ids: IdGeneratorPort;
  /** A3 — « maintenant » du gel : le délai est comparé à l'horloge injectée, jamais Date.now(). */
  clock: ClockPort;
  /**
   * Journal de l'override L221-10 — FAIL-CLOSED : sans port câblé, `embargoOverride` est
   * refusé comme un embargo ordinaire (jamais d'override sans trace écrite).
   */
  audit?: EmbargoOverrideAuditPort;
}

export interface GenerateInvoiceInput {
  quoteId: string;
  mode: 'deposit' | 'final';
  /**
   * Override RESPONSABILISÉ de l'embargo L221-10 — flag EXPLICITE uniquement (`true` strict,
   * jamais implicite) : l'artisan a vu le risque concret (contrat annulable, remboursement
   * exigible) et l'a confirmé dans la feuille dédiée. L'événement payment.embargo_overridden
   * est journalisé AVANT de produire la pièce. Ne lève JAMAIS le gel de rétractation de la
   * facture finale (protection du CLIENT, non contournable) ni un devis rétracté.
   */
  embargoOverride?: boolean;
}

/** Génère la facture (acompte si depositPct, sinon finale) depuis un devis signé. */
export class GenerateInvoiceFromQuote {
  constructor(private readonly deps: GenerateInvoiceDeps) {}

  async execute(input: GenerateInvoiceInput): Promise<Result<{ invoiceId: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));

    const mode = input.mode;
    const kind: 'deposit' | 'final' = mode === 'deposit' ? 'deposit' : 'final';
    if (quote.status !== 'signed')
      return err(appDomain({ code: 'VALIDATION', field: 'quote', message: 'Le devis doit etre signe.' }));

    const existing = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, kind);
    if (existing) return ok({ invoiceId: existing.id });

    // A3 — un contrat RÉTRACTÉ (fonctionnalité en ligne, art. L221-21 c. conso) ne produit plus
    // aucune pièce : ni acompte ni finale (le remboursement relève de l'avoir, flux dédié).
    if (quote.retractedAt !== null) {
      return err(
        appDomain({
          code: 'QUOTE_RETRACTED',
          quoteId: quote.id,
          message:
            'Le client a exercé son droit de rétractation sur ce devis (art. L221-18 s. du code ' +
            'de la consommation) : aucune facture ne peut en être générée.',
        }),
      );
    }

    // La qualité du client à la CONCLUSION (Signature.customerType, figée par SignQuote) et la
    // signature décident des deux gardes légales ci-dessous. Fail-closed : sans client prouvé
    // dans le tenant, impossible de connaître le régime — on refuse au lieu de facturer dans le
    // doute (le type courant reste le fallback des signatures antérieures au figeage).
    const customer = await this.deps.customers.findById(quote.customerId);
    if (!customer || customer.companyId !== quote.companyId)
      return err(appNotFound('customer', quote.customerId));
    const now = this.deps.clock.now();

    // L221-10 — contrat HORS ÉTABLISSEMENT (signature `onsite_draw` chez le client, ou
    // `legacy_declared` fail-closed) avec un CONSOMMATEUR : AUCUN paiement ne peut être reçu
    // pendant 7 jours à compter de la conclusion — l'ACOMPTE COMPRIS (« aucun paiement ou
    // aucune contrepartie, sous quelque forme que ce soit »). Émettre une pièce exigible,
    // c'est demander un paiement : acompte ET finale sont bloqués pendant la fenêtre. Le
    // contrat À DISTANCE (`remote_link`) n'est pas visé par L221-10 (aucun embargo). Sanction
    // du manquement : nullité du contrat (art. L242-1 ; Civ. 1re, 20/12/2023, n° 22-13.014).
    // Exception L221-10, al. 2 : intervention urgente sollicitée et TRACÉE à la création du
    // devis → pas d'embargo. Sans trace : fail-closed, embargo plein.
    const embargo = offPremisesPaymentEmbargo(
      { customerType: customer.type, signature: quote.signature, urgentRepair: quote.urgentRepair },
      now,
    );
    if (embargo.active) {
      if (input.embargoOverride === true && this.deps.audit !== undefined) {
        // Override responsabilisé : l'artisan informé assume — TRACÉ AVANT la pièce (si le
        // journal échoue, l'action échoue : jamais d'override silencieux ; port absent →
        // refus fail-closed dans la branche else).
        await this.deps.audit.embargoOverridden({
          type: 'payment.embargo_overridden',
          quoteId: quote.id,
          companyId: quote.companyId,
          invoiceKind: kind,
          embargoExpiresAt: embargo.expiresAt,
          occurredAt: now,
        });
      } else {
        return err(
          appDomain({
            code: 'OFF_PREMISES_PAYMENT_EMBARGO',
            quoteId: quote.id,
            expiresAt: embargo.expiresAt,
            availableFrom: embargo.availableFrom,
            message: offPremisesPaymentEmbargoMessage(embargo.availableFrom),
            overridable: true,
            overrideRisk: offPremisesEmbargoOverrideRisk(embargo.availableFrom),
          }),
        );
      }
    }

    // A3 — GEL LÉGAL de la FACTURE FINALE pendant le délai de rétractation d'un devis B2C signé
    // via l'app (contrat à distance ou hors établissement, art. L221-18 s. c. conso), sauf
    // demande d'exécution anticipée tracée à la signature (art. L221-25). B2B/B2G : rien ne
    // change. L'ACOMPTE reste facturable hors embargo L221-10 ci-dessus (contrat à distance :
    // la loi n'interdit pas l'acompte ; l'app n'invente pas une interdiction non écrite).
    if (mode === 'final') {
      const freeze = retractationFreeze(
        deriveRetractation({ customerType: customer.type, signature: quote.signature }),
        now,
      );
      if (freeze.active) {
        return err(
          appDomain({
            code: 'RETRACTATION_PERIOD_ACTIVE',
            quoteId: quote.id,
            expiresAt: freeze.expiresAt,
            availableFrom: freeze.availableFrom,
            message: retractationFreezeMessage(freeze.availableFrom),
          }),
        );
      }
    }

    // Facture FINALE : TOUT ce qui a déjà été facturé sur ce devis (acompte ET situations
    // ÉMISES — situations successives BTP, A5) est déduit du net à payer. Le flow reste
    // corrélé de bout en bout : devis → acompte → situations → solde exact.
    let depositDeduction: { amountCents: number; invoiceId: string | null } | undefined;
    if (mode === 'final') {
      const companyInvoices = await this.deps.invoices.listByCompany(quote.companyId);
      // Un avoir TOTAL n'annule la déduction qu'une fois émis. Un brouillon d'avoir n'a aucun
      // effet fiscal ; l'identité source durable évite toute heuristique par devis ou montant.
      const totallyCreditedSourceIds = new Set(
        companyInvoices
          .filter(
            (invoice) =>
              invoice.kind === 'credit_note' &&
              invoice.status !== 'draft' &&
              invoice.status !== 'cancelled' &&
              invoice.creditNoteSource !== null,
          )
          .map((invoice) => invoice.creditNoteSource!.invoiceId),
      );
      const alreadyInvoiced = companyInvoices.filter(
        (i) =>
          i.parentQuoteId === quote.id &&
          (i.kind === 'deposit' || i.kind === 'situation') &&
          i.status !== 'draft' &&
          i.status !== 'cancelled' &&
          !totallyCreditedSourceIds.has(i.id),
      );
      const amountCents = alreadyInvoiced.reduce((sum, i) => sum + i.totals().netToPay, 0);
      if (amountCents > 0) {
        // Réf de nav : la pièce source si UNIQUE — composite (plusieurs pièces) sinon.
        depositDeduction = {
          amountCents,
          invoiceId: alreadyInvoiced.length === 1 ? (alreadyInvoiced[0]?.id ?? null) : null,
        };
      }
    }

    const created = Invoice.fromSignedQuote(quote, mode, this.deps.ids.newId(), depositDeduction ? { depositDeduction } : undefined);
    if (!created.ok) return err(appDomain(created.error));

    try {
      await this.deps.invoices.save(created.value);
    } catch (e) {
      const raced = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, kind);
      if (raced) return ok({ invoiceId: raced.id });
      throw e;
    }
    return ok({ invoiceId: created.value.id });
  }
}
