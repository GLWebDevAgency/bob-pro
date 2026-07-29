import {
  type DocumentLinkedEntityType,
  type DocumentLinkTargetInput,
  type DocumentLinkTargetPort,
} from '@bob/core';

type TenantOwnedTarget = { readonly companyId: string };
type CompanyTarget = { readonly id: string };
type TenantLinkedEntityType = Exclude<DocumentLinkedEntityType, 'company'>;
// PR-16 — `equipment` rejoint les cibles tenantées : la fiche de passage archivée suit
// l'équipement du parc quand le passage en vise un (historique par équipement, PR-11).
const TENANT_LINKED_ENTITY_TYPES = new Set<TenantLinkedEntityType>([
  'invoice', 'quote', 'expense', 'chantier', 'equipment',
]);

interface Lookup<T> {
  findById(id: string): Promise<T | null>;
}

export type DocumentLinkTargetRepositories = {
  company: Lookup<CompanyTarget>;
} & Record<TenantLinkedEntityType, Lookup<TenantOwnedTarget>>;

/**
 * Adaptateur anti-IDOR des liens polymorphes du coffre.
 *
 * Les repositories historiques trouvent par id global ; cette frontière revalide donc toujours
 * companyId après lecture. Une cible absente et une cible d'un autre tenant donnent exactement
 * la même réponse false. Le cas company exige en plus que l'id lié soit le tenant courant.
 */
export class RepositoryDocumentLinkTargets implements DocumentLinkTargetPort {
  constructor(private readonly repositories: DocumentLinkTargetRepositories) {}

  async exists(input: DocumentLinkTargetInput): Promise<boolean> {
    if (input.linkedEntityType === 'company') {
      if (input.linkedEntityId !== input.companyId) return false;
      const company = await this.repositories.company.findById(input.linkedEntityId);
      return company?.id === input.companyId;
    }

    if (!TENANT_LINKED_ENTITY_TYPES.has(input.linkedEntityType as TenantLinkedEntityType)) return false;
    const lookup = this.repositories[input.linkedEntityType as TenantLinkedEntityType];
    const target = await lookup.findById(input.linkedEntityId);
    return target?.companyId === input.companyId;
  }
}
