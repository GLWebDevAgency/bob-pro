import { type Company } from '../../domain/company/company';
import { type Customer } from '../../domain/customer/customer';
import { type Quote } from '../../domain/billing/quote/quote';
import { type Invoice, type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type Payment } from '../../domain/payment/payment';
import { type Expense } from '../../domain/expense/expense';
import { type Chantier } from '../../domain/chantier/chantier';
import { type ChantierNote } from '../../domain/chantier/chantier-note';

export interface CompanyRepository {
  findById(id: string): Promise<Company | null>;
  list(): Promise<Company[]>;
  save(c: Company): Promise<void>;
}

export interface CustomerRepository {
  findById(id: string): Promise<Customer | null>;
  listByCompany(companyId: string): Promise<Customer[]>;
  save(c: Customer): Promise<void>;
}

export interface QuoteRepository {
  findById(id: string): Promise<Quote | null>;
  /** Verrouille la ligne (SELECT ... FOR UPDATE) DANS une transaction et renvoie une copie fraîche.
   * Sérialise les envois concurrents d'un même devis avant allocation du numéro. */
  lockById(id: string): Promise<Quote | null>;
  listByCompany(companyId: string): Promise<Quote[]>;
  save(q: Quote): Promise<void>;
}

export interface InvoiceRepository {
  findById(id: string): Promise<Invoice | null>;
  /** Verrouille la ligne (SELECT … FOR UPDATE) DANS une transaction et renvoie une copie fraîche.
   * Sérialise les opérations concurrentes (encaissement, émission) sur une même facture. */
  lockById(id: string): Promise<Invoice | null>;
  findByParentQuoteId(companyId: string, parentQuoteId: string, kind: InvoiceKind): Promise<Invoice | null>;
  /** Retrouve l'avoir total de CETTE facture source, sans collision avec ses pièces sœurs du devis. */
  findCreditNoteBySourceInvoiceId(companyId: string, sourceInvoiceId: string): Promise<Invoice | null>;
  listByCompany(companyId: string): Promise<Invoice[]>;
  save(i: Invoice): Promise<void>;
  /** R6 : supprime définitivement une facture BROUILLON (le use case garde le statut avant appel). */
  deleteById(id: string): Promise<void>;
}

export interface PaymentRepository {
  save(p: Payment): Promise<void>;
  findById(companyId: string, id: string): Promise<Payment | null>;
  listByInvoice(invoiceId: string): Promise<Payment[]>;
  /** Projection tenant-wide utilisée par les métriques client ; une seule lecture, sans N+1. */
  listByCompany(companyId: string): Promise<Payment[]>;
  /** Idempotence : retrouve un paiement déjà enregistré avec cette clé (null si aucun). */
  findByIdempotencyKey(companyId: string, key: string): Promise<Payment | null>;
}

export interface ExpenseRepository {
  save(e: Expense): Promise<void>;
  findById(id: string): Promise<Expense | null>;
  /** Verrou pessimiste dans l'unité de travail courante pour les transitions comptables. */
  lockById?(id: string): Promise<Expense | null>;
  listByCompany(companyId: string): Promise<Expense[]>;
}

export interface ChantierRepository {
  save(c: Chantier): Promise<void>;
  findById(id: string): Promise<Chantier | null>;
  listByCompany(companyId: string): Promise<Chantier[]>;
}

export interface ChantierNoteRepository {
  save(n: ChantierNote): Promise<void>;
  listByChantier(companyId: string, chantierId: string): Promise<ChantierNote[]>;
  /** Agrégat bulk (1 requête, groupBy) : nombre de notes par chantier pour TOUT le tenant —
   * alimente la liste des chantiers (compteurs de rangée) sans repasser en N+1 par chantier.
   * Ne contient que les chantiers ayant au moins une note (absent = 0). */
  countByCompany(companyId: string): Promise<Map<string, number>>;
}
