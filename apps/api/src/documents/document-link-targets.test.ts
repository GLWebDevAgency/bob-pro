import { describe, expect, it } from 'vitest';
import { type DocumentLinkedEntityType } from '@bob/core';
import {
  RepositoryDocumentLinkTargets,
  type DocumentLinkTargetRepositories,
} from './document-link-targets';

const COMPANY = 'company-a';
const OTHER_COMPANY = 'company-b';
const TYPES: readonly DocumentLinkedEntityType[] = ['invoice', 'quote', 'expense', 'chantier', 'company'];

function repositories(): DocumentLinkTargetRepositories {
  const tenantLookup = (prefix: string) => ({
    findById: async (id: string) => {
      if (id === `${prefix}-same`) return { companyId: COMPANY };
      if (id === `${prefix}-cross`) return { companyId: OTHER_COMPANY };
      return null;
    },
  });
  return {
    invoice: tenantLookup('invoice'),
    quote: tenantLookup('quote'),
    expense: tenantLookup('expense'),
    chantier: tenantLookup('chantier'),
    company: {
      findById: async (id: string) => {
        if (id === COMPANY || id === OTHER_COMPANY) return { id };
        return null;
      },
    },
  };
}

function targetId(type: DocumentLinkedEntityType, scope: 'same' | 'cross' | 'missing'): string {
  if (type === 'company') {
    if (scope === 'same') return COMPANY;
    if (scope === 'cross') return OTHER_COMPANY;
    return 'company-missing';
  }
  return `${type}-${scope}`;
}

describe('RepositoryDocumentLinkTargets — preuve d’existence tenant-scoped', () => {
  it.each(TYPES)('accepte une cible %s existante du même tenant', async (linkedEntityType) => {
    const targets = new RepositoryDocumentLinkTargets(repositories());

    await expect(targets.exists({
      companyId: COMPANY,
      linkedEntityType,
      linkedEntityId: targetId(linkedEntityType, 'same'),
    })).resolves.toBe(true);
  });

  it.each(TYPES)('masque une cible %s d’un autre tenant comme introuvable', async (linkedEntityType) => {
    const targets = new RepositoryDocumentLinkTargets(repositories());

    await expect(targets.exists({
      companyId: COMPANY,
      linkedEntityType,
      linkedEntityId: targetId(linkedEntityType, 'cross'),
    })).resolves.toBe(false);
  });

  it.each(TYPES)('refuse une cible %s absente', async (linkedEntityType) => {
    const targets = new RepositoryDocumentLinkTargets(repositories());

    await expect(targets.exists({
      companyId: COMPANY,
      linkedEntityType,
      linkedEntityId: targetId(linkedEntityType, 'missing'),
    })).resolves.toBe(false);
  });

  it('échoue fermé face à un type runtime forgé sans consulter un prototype JavaScript', async () => {
    const targets = new RepositoryDocumentLinkTargets(repositories());

    await expect(targets.exists({
      companyId: COMPANY,
      linkedEntityType: '__proto__' as DocumentLinkedEntityType,
      linkedEntityId: 'forged',
    })).resolves.toBe(false);
  });
});
