import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import {
  type CustomerRepository,
  type InvoiceRepository,
  type QuoteRepository,
} from '../ports/repositories';
import { Customer, type CustomerProps } from '../../domain/customer/customer';

/**
 * Édition post-création de la fiche client (C13/C40 TODO partagé) — la création mobile est
 * volontairement MINIMALE (nom + type) ; cet use case permet de compléter/corriger ensuite
 * adresse, SIREN, contact, etc. Remplacement complet (mêmes invariants que la création,
 * revalidés via Customer.of) plutôt qu'un merge partiel côté domaine — le formulaire hôte
 * détient déjà l'état complet de la fiche.
 *
 * GARDE LÉGALE (A3/A4) : le TYPE du client (b2c/b2b/b2g) devient IMMUABLE dès qu'un devis
 * signé ou une facture émise existe pour ce client. La qualité de consommateur s'apprécie à la
 * CONCLUSION du contrat (art. L221-1 et art. liminaire c. conso) : basculer b2c→b2b lèverait
 * le gel de rétractation et l'embargo L221-10 d'un contrat en cours (contournement en une
 * édition de fiche), et b2b→b2c gèlerait rétroactivement des pièces professionnelles — dans
 * les deux sens, l'édition fabriquerait un régime légal que le contrat n'a jamais eu.
 * Fail-closed : le doute (pièce signée/émise présente) bloque, jamais l'inverse.
 */
export type UpdateCustomerInput = { id: string; companyId: string } & Omit<CustomerProps, 'id' | 'companyId'>;

export interface UpdateCustomerDeps {
  customers: CustomerRepository;
  /** Garde du type : la présence d'un devis SIGNÉ de ce client rend le type immuable. */
  quotes: Pick<QuoteRepository, 'listByCompany'>;
  /** Garde du type : la présence d'une facture ÉMISE (non-brouillon) le rend immuable aussi. */
  invoices: Pick<InvoiceRepository, 'listByCompany'>;
}

export class UpdateCustomer {
  constructor(private readonly deps: UpdateCustomerDeps) {}

  async execute(input: UpdateCustomerInput): Promise<Result<{ id: string }, AppError>> {
    const existing = await this.deps.customers.findById(input.id);
    if (!existing || existing.companyId !== input.companyId) return err(appNotFound('customer', input.id));
    if (input.type !== existing.type) {
      const [quotes, invoices] = await Promise.all([
        this.deps.quotes.listByCompany(input.companyId),
        this.deps.invoices.listByCompany(input.companyId),
      ]);
      const hasSignedQuote = quotes.some(
        (quote) => quote.customerId === input.id && quote.signature !== null,
      );
      const hasIssuedInvoice = invoices.some(
        (invoice) =>
          invoice.customerId === input.id
          && invoice.status !== 'draft'
          && invoice.status !== 'cancelled',
      );
      if (hasSignedQuote || hasIssuedInvoice) {
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'type',
            message:
              'Le type de ce client (particulier/professionnel) ne peut plus changer : un devis ' +
              'signé ou une facture émise existe — le régime légal du contrat (rétractation, ' +
              'TVA) est apprécié à sa conclusion. Créez une nouvelle fiche client si son statut ' +
              'a réellement changé.',
          }),
        );
      }
    }
    const r = Customer.of({ ...input });
    if (!r.ok) return err(appDomain(r.error));
    await this.deps.customers.save(r.value);
    return ok({ id: input.id });
  }
}
