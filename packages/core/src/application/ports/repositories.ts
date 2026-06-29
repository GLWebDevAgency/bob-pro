import { type Company } from '../../domain/company/company';
import { type Customer } from '../../domain/customer/customer';
import { type Quote } from '../../domain/billing/quote/quote';
import { type Invoice } from '../../domain/billing/invoice/invoice';
import { type Payment } from '../../domain/payment/payment';
import { type Expense } from '../../domain/expense/expense';

export interface CompanyRepository {
  findById(id: string): Promise<Company | null>;
  save(c: Company): Promise<void>;
}

export interface CustomerRepository {
  findById(id: string): Promise<Customer | null>;
  listByCompany(companyId: string): Promise<Customer[]>;
  save(c: Customer): Promise<void>;
}

export interface QuoteRepository {
  findById(id: string): Promise<Quote | null>;
  listByCompany(companyId: string): Promise<Quote[]>;
  save(q: Quote): Promise<void>;
}

export interface InvoiceRepository {
  findById(id: string): Promise<Invoice | null>;
  listByCompany(companyId: string): Promise<Invoice[]>;
  save(i: Invoice): Promise<void>;
}

export interface PaymentRepository {
  save(p: Payment): Promise<void>;
  listByInvoice(invoiceId: string): Promise<Payment[]>;
}

export interface ExpenseRepository {
  save(e: Expense): Promise<void>;
  findById(id: string): Promise<Expense | null>;
  listByCompany(companyId: string): Promise<Expense[]>;
}
