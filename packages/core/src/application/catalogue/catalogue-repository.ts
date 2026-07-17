import { type CustomPrestation } from './derive-catalogue';
import { type Instant } from '../../shared-kernel/time';

/**
 * Ligne d'autorité du catalogue d'une entreprise.
 *
 * Le `companyId` fait partie du modèle persistant : un identifiant de ligne seul ne constitue
 * jamais une frontière d'accès suffisante. Les dates restent des chaînes ISO afin que le port et
 * les vues soient sérialisables sans dépendre d'un ORM ni de `Date`.
 */
export interface CatalogueItemRecord extends CustomPrestation {
  readonly companyId: string;
  readonly revision: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

/** Remplacement complet des champs métier ; `createdAt` reste sous l'autorité de la BDD. */
export interface CatalogueItemReplacement extends CustomPrestation {
  readonly companyId: string;
  readonly revision: number;
  readonly updatedAt: Instant;
}

export type CatalogueCreateWriteResult =
  | { readonly status: 'created'; readonly item: CatalogueItemRecord }
  | { readonly status: 'id_conflict' };

export type CatalogueUpdateWriteResult =
  | { readonly status: 'updated'; readonly item: CatalogueItemRecord }
  | { readonly status: 'not_found' }
  | { readonly status: 'revision_conflict' };

export type CatalogueDeleteWriteResult =
  | { readonly status: 'deleted' }
  | { readonly status: 'not_found' }
  | { readonly status: 'revision_conflict' };

/**
 * Port framework-free du catalogue propriétaire.
 *
 * Les adapters DOIVENT inclure `companyId` dans chaque prédicat SQL. `update` et `delete`
 * effectuent un compare-and-swap atomique sur `(companyId, id, expectedRevision)` ; un adapter ne
 * doit donc jamais implémenter ces méthodes par un `find` suivi d'une écriture non conditionnelle.
 */
export interface CatalogueRepository {
  listByCompany(companyId: string): Promise<readonly CatalogueItemRecord[]>;

  create(item: CatalogueItemRecord): Promise<CatalogueCreateWriteResult>;

  update(input: {
    readonly companyId: string;
    readonly id: string;
    readonly expectedRevision: number;
    /** État métier complet après le CAS, avec `revision = expectedRevision + 1`. */
    readonly item: CatalogueItemReplacement;
  }): Promise<CatalogueUpdateWriteResult>;

  delete(input: {
    readonly companyId: string;
    readonly id: string;
    readonly expectedRevision: number;
  }): Promise<CatalogueDeleteWriteResult>;
}
