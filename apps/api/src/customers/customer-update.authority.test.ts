import {
  Company,
  Customer,
  appConflict,
  err,
  ok,
  type CustomerRepository,
  type UpdateCustomerInput,
} from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { DocumentArchiveMutationBarrier } from '../documents/document-archive-integrity.authority';
import type { Persistence } from '../persistence/persistence';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import { CustomerUpdateAuthority } from './customer-update.authority';

const COMPANY_ID = 'company-customer-update';
const CUSTOMER_ID = 'customer-update';

const customerInput: UpdateCustomerInput = {
  id: CUSTOMER_ID,
  companyId: COMPANY_ID,
  type: 'b2b',
  name: 'Client après',
  address: { line1: '2 rue Après', zip: '75002', city: 'Paris' },
  email: 'apres@example.fr',
};

function company(closed = false): Company {
  const result = Company.of({
    ...MERCIER_PROPS,
    id: COMPANY_ID,
    ...(closed ? { closedAt: '2026-08-20T12:00:00.000Z' } : {}),
  });
  if (!result.ok) throw new Error('Company fixture invalide.');
  return result.value;
}

function customer(): Customer {
  const result = Customer.of({
    ...customerInput,
    name: 'Client avant',
    address: { line1: '1 rue Avant', zip: '75001', city: 'Paris' },
    email: 'avant@example.fr',
  });
  if (!result.ok) throw new Error('Customer fixture invalide.');
  return result.value;
}

type ArchiveOutcome = 'ok' | 'quote_missing' | 'invoice_missing';

function setup(input: {
  readonly closed?: boolean;
  readonly companyMissing?: boolean;
  readonly archives?: ArchiveOutcome;
} = {}) {
  const trace: string[] = [];
  const persistence = new InMemoryPersistence();
  persistence.companies.seed(company(input.closed ?? false));
  persistence.customers.seed([customer()]);

  vi.spyOn(persistence, 'runWithTenant').mockImplementation(async (companyId, run) => {
    trace.push(`tenant:${companyId}`);
    return run();
  });
  vi.spyOn(persistence, 'runInTransaction').mockImplementation(async (run) => {
    trace.push('transaction');
    return run();
  });
  vi.spyOn(persistence.companies, 'lockById').mockImplementation(async (id) => {
    trace.push(`company.lock:${id}`);
    return id === COMPANY_ID && input.companyMissing !== true
      ? company(input.closed ?? false)
      : null;
  });

  const originalSave = persistence.customers.save.bind(persistence.customers);
  vi.spyOn(persistence.customers, 'save').mockImplementation(async (value) => {
    trace.push('customer.save');
    await originalSave(value);
  });
  const saveIfRevision = vi.fn(async (
    value: Customer,
    revision: number,
  ): Promise<'saved' | 'revision_conflict'> => {
    trace.push(`customer.saveIfRevision:${revision}`);
    await originalSave(value);
    return 'saved' as const;
  });
  (persistence.customers as CustomerRepository).saveIfRevision = saveIfRevision;

  const archives: DocumentArchiveMutationBarrier = {
    assertSignedQuoteArchivesComplete: vi.fn(async () => {
      trace.push('archives.signed_quotes');
      return input.archives === 'quote_missing'
        ? err(appConflict('company_billing_settings', 'signed_quote_archive_missing'))
        : ok(undefined);
    }),
    assertIssuedInvoiceArchivesComplete: vi.fn(async () => {
      trace.push('archives.issued_invoices');
      return input.archives === 'invoice_missing'
        ? err(appConflict('company_billing_settings', 'issued_invoice_archive_missing'))
        : ok(undefined);
    }),
  };

  return {
    authority: new CustomerUpdateAuthority(persistence as Persistence, archives),
    persistence,
    archives,
    saveIfRevision,
    trace,
  };
}

describe('CustomerUpdateAuthority', () => {
  it('porte le chemin manuel dans l’ordre tenant -> tx -> société -> archives -> use case', async () => {
    const { authority, trace } = setup();

    await expect(authority.execute(customerInput)).resolves.toEqual({
      ok: true,
      value: { id: CUSTOMER_ID },
    });
    expect(trace).toEqual([
      `tenant:${COMPANY_ID}`,
      'transaction',
      `company.lock:${COMPANY_ID}`,
      'archives.signed_quotes',
      'archives.issued_invoices',
      'customer.save',
    ]);
  });

  it('porte le chemin Jarvis CAS dans exactement le même ordre', async () => {
    const { authority, trace, saveIfRevision } = setup();

    await expect(authority.executeAtRevision(customerInput, 7)).resolves.toEqual({
      ok: true,
      value: { id: CUSTOMER_ID },
    });
    expect(trace).toEqual([
      `tenant:${COMPANY_ID}`,
      'transaction',
      `company.lock:${COMPANY_ID}`,
      'archives.signed_quotes',
      'archives.issued_invoices',
      'customer.saveIfRevision:7',
    ]);
    expect(saveIfRevision).toHaveBeenCalledTimes(1);
  });

  it('refuse un compte clôturé avant toute archive et toute écriture', async () => {
    const { authority, trace, persistence, saveIfRevision } = setup({ closed: true });

    await expect(authority.executeAtRevision(customerInput, 7)).resolves.toEqual({
      ok: false,
      error: { kind: 'forbidden', reason: 'Compte clôturé.' },
    });
    expect(trace).toEqual([
      `tenant:${COMPANY_ID}`,
      'transaction',
      `company.lock:${COMPANY_ID}`,
    ]);
    expect(persistence.customers.save).not.toHaveBeenCalled();
    expect(saveIfRevision).not.toHaveBeenCalled();
  });

  it('refuse une société absente avant toute archive et toute écriture', async () => {
    const { authority, trace, persistence, saveIfRevision } = setup({ companyMissing: true });

    await expect(authority.executeAtRevision(customerInput, 7)).resolves.toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'company', id: COMPANY_ID },
    });
    expect(trace).toEqual([
      `tenant:${COMPANY_ID}`,
      'transaction',
      `company.lock:${COMPANY_ID}`,
    ]);
    expect(persistence.customers.save).not.toHaveBeenCalled();
    expect(saveIfRevision).not.toHaveBeenCalled();
  });

  it('arrête une archive de devis manquante avant factures et écriture', async () => {
    const { authority, trace, persistence, saveIfRevision } = setup({
      archives: 'quote_missing',
    });

    await expect(authority.executeAtRevision(customerInput, 7)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'company_billing_settings',
        reason: 'signed_quote_archive_missing',
      },
    });
    expect(trace).toEqual([
      `tenant:${COMPANY_ID}`,
      'transaction',
      `company.lock:${COMPANY_ID}`,
      'archives.signed_quotes',
    ]);
    expect(persistence.customers.save).not.toHaveBeenCalled();
    expect(saveIfRevision).not.toHaveBeenCalled();
  });

  it('arrête une archive de facture manquante avant écriture', async () => {
    const { authority, trace, persistence, saveIfRevision } = setup({
      archives: 'invoice_missing',
    });

    await expect(authority.execute(customerInput)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'company_billing_settings',
        reason: 'issued_invoice_archive_missing',
      },
    });
    expect(trace).toEqual([
      `tenant:${COMPANY_ID}`,
      'transaction',
      `company.lock:${COMPANY_ID}`,
      'archives.signed_quotes',
      'archives.issued_invoices',
    ]);
    expect(persistence.customers.save).not.toHaveBeenCalled();
    expect(saveIfRevision).not.toHaveBeenCalled();
  });

  it('conserve le conflit CAS comme dernier arbitre, sans second essai', async () => {
    const { authority, saveIfRevision, persistence } = setup();
    saveIfRevision.mockResolvedValueOnce('revision_conflict');

    await expect(authority.executeAtRevision(customerInput, 7)).resolves.toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'customer', reason: 'stale_revision' },
    });
    expect(saveIfRevision).toHaveBeenCalledTimes(1);
    expect(persistence.customers.save).not.toHaveBeenCalled();
  });
});
