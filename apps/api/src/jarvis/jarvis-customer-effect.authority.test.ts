import {
  appConflict,
  appDomain,
  appForbidden,
  appNotFound,
  appUnavailable,
  err,
  ok,
  type AppError,
  type Result,
} from '@bob/core';
import { describe, expect, it, vi } from 'vitest';

import type { CustomerUpdateAuthorityPort } from '../customers/customer-update.authority';
import type {
  JarvisCustomerEffectTarget,
  JarvisCustomerFields,
  JarvisCustomerWriteResult,
} from '../jobs/jarvis-customer-effect.executor';
import type { PrismaService } from '../persistence/prisma/prisma.service';
import { PrismaJarvisCustomerEffectAuthority } from './jarvis-customer-effect.authority';

const target: JarvisCustomerEffectTarget = {
  companyId: 'company-jarvis-update',
  ownerUserId: 'owner-jarvis-update',
  customerId: 'customer-jarvis-update',
};

const fields: JarvisCustomerFields = {
  type: 'b2b',
  name: 'Client Jarvis',
  address: { line1: '4 rue du Test', zip: '75004', city: 'Paris' },
  email: 'client@example.fr',
};

function adapter(result: Result<{ id: string }, AppError>) {
  const updates: CustomerUpdateAuthorityPort = {
    execute: vi.fn(),
    executeAtRevision: vi.fn(async () => result),
  };
  return {
    authority: new PrismaJarvisCustomerEffectAuthority({} as PrismaService, updates),
    updates,
  };
}

describe('PrismaJarvisCustomerEffectAuthority — modification partagée', () => {
  it('transmet la cible, les champs et la révision à l’autorité canonique sans use case local', async () => {
    const { authority, updates } = adapter(ok({ id: target.customerId }));

    await expect(authority.updateCustomerAtRevision(target, fields, 12)).resolves.toEqual({
      status: 'written',
    });
    expect(updates.executeAtRevision).toHaveBeenCalledWith(
      { id: target.customerId, companyId: target.companyId, ...fields },
      12,
    );
    expect(updates.executeAtRevision).toHaveBeenCalledTimes(1);
    expect(updates.execute).not.toHaveBeenCalled();
  });

  it.each<{
    readonly label: string;
    readonly error: AppError;
    readonly expected: JarvisCustomerWriteResult;
  }>([
    {
      label: 'CAS stale',
      error: appConflict('customer', 'stale_revision'),
      expected: { status: 'refused', reasonCode: 'target_revision_stale' },
    },
    {
      label: 'archive devis',
      error: appConflict('company_billing_settings', 'signed_quote_archive_missing'),
      expected: { status: 'refused', reasonCode: 'signed_quote_archive_missing' },
    },
    {
      label: 'archive facture',
      error: appConflict('company_billing_settings', 'issued_invoice_archive_missing'),
      expected: { status: 'refused', reasonCode: 'issued_invoice_archive_missing' },
    },
    {
      label: 'société absente',
      error: appNotFound('company', target.companyId),
      expected: { status: 'refused', reasonCode: 'company_missing' },
    },
    {
      label: 'client absent',
      error: appNotFound('customer', target.customerId),
      expected: { status: 'refused', reasonCode: 'customer_missing' },
    },
    {
      label: 'société clôturée',
      error: appForbidden('Compte clôturé.'),
      expected: { status: 'refused', reasonCode: 'company_closed' },
    },
    {
      label: 'dépendance indisponible',
      error: { kind: 'dependency', port: 'CustomerRepository.saveIfRevision', cause: 'missing' },
      expected: { status: 'unavailable' },
    },
    {
      label: 'service indisponible',
      error: appUnavailable('document-archive'),
      expected: { status: 'unavailable' },
    },
    {
      label: 'refus domaine',
      error: appDomain({ code: 'VALIDATION', field: 'name', message: 'Nom invalide.' }),
      expected: { status: 'refused', reasonCode: 'domain_validation' },
    },
  ])('mappe le refus nommé : $label', async ({ error, expected }) => {
    const { authority, updates } = adapter(err(error));

    await expect(authority.updateCustomerAtRevision(target, fields, 12)).resolves.toEqual(expected);
    expect(updates.executeAtRevision).toHaveBeenCalledTimes(1);
  });
});
