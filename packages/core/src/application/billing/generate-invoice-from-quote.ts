import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { type QuoteRepository, type InvoiceRepository } from '../ports/repositories';
import { type IdGeneratorPort } from '../ports/services';

export interface GenerateInvoiceDeps {
  quotes: QuoteRepository;
  invoices: InvoiceRepository;
  ids: IdGeneratorPort;
}

/** Génère la facture (acompte si depositPct, sinon finale) depuis un devis signé. */
export class GenerateInvoiceFromQuote {
  constructor(private readonly deps: GenerateInvoiceDeps) {}

  async execute(input: { quoteId: string; mode?: 'deposit' | 'final' }): Promise<Result<{ invoiceId: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));

    const explicitMode = input.mode;
    let mode: 'deposit' | 'final' = explicitMode ?? (quote.depositPct !== null ? 'deposit' : 'final');
    let kind: 'deposit' | 'final' = mode === 'deposit' ? 'deposit' : 'final';
    if (quote.status !== 'signed')
      return err(appDomain({ code: 'VALIDATION', field: 'quote', message: 'Le devis doit etre signe.' }));

    let existing = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, kind);
    // Mode INFÉRÉ (jamais fourni par l'appelant) sur un devis dont l'acompte est déjà facturé,
    // sans finale : le "prochain pas" naturel est la finale, pas un rejeu silencieux de l'acompte
    // (R3 : le bouton disait « générée » sans rien créer). Idempotence STRICTE préservée quand le
    // mode est explicite (facture/[id].tsx envoie mode:'final' pour le solde d'un acompte).
    if (existing && explicitMode === undefined && kind === 'deposit') {
      const finalExisting = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, 'final');
      if (!finalExisting) {
        mode = 'final';
        kind = 'final';
        existing = null;
      }
    }
    if (existing) return ok({ invoiceId: existing.id });

    // Facture FINALE : TOUT ce qui a déjà été facturé sur ce devis (acompte ET situations
    // ÉMISES — situations successives BTP, A5) est déduit du net à payer. Le flow reste
    // corrélé de bout en bout : devis → acompte → situations → solde exact.
    let depositDeduction: { amountCents: number; invoiceId: string | null } | undefined;
    if (mode === 'final') {
      const alreadyInvoiced = (await this.deps.invoices.listByCompany(quote.companyId)).filter(
        (i) =>
          i.parentQuoteId === quote.id &&
          (i.kind === 'deposit' || i.kind === 'situation') &&
          i.status !== 'draft' &&
          i.status !== 'cancelled',
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
