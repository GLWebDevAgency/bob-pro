/**
 * Jarvis U1-f — L'AUTORITÉ MÉTIER DE L'EFFET FICHE CLIENT (SPEC_U1F §1).
 *
 * Le livrable que U1-d avait nommé « à part » : sans lui, `buildJarvisCustomerEffectExecutors`
 * rend une Map VIDE, le worker règle `executor_unregistered`, et une confirmation d'artisan
 * n'écrit JAMAIS sa fiche — le run reste en `committing`, où même `cancel_run` ne fait
 * qu'observer un reçu qui ne viendra pas. C'est le dernier maillon manquant du parcours.
 *
 * CE QU'IL EST, ET CE QU'IL N'EST PAS. La création appelle `Customer.of`. La modification
 * délègue à l'autorité applicative CANONIQUE partagée avec `BackendService` : même verrou société,
 * même refus de clôture, mêmes preuves d'archives, même `UpdateCustomer.executeAtRevision` et même
 * CAS. Cet adapter ne porte aucune de ces règles et ne constitue pas un use case Jarvis parallèle.
 *
 * TENANT. Chaque geste s'exécute sous `withTenant(target.companyId)` : les GUC de RLS sont posés
 * par la persistance, jamais devinés ici. Le `companyId` vient du work item (donc de l'admission
 * qui l'a scellé), jamais d'un appelant.
 *
 * REFUS. Un refus du domaine devient un `refused` NOMMÉ (`domain_*`), jamais une exception nue :
 * le worker doit pouvoir régler l'effet en `failed_terminal` avec une cause lisible. Une panne
 * d'infrastructure, elle, remonte telle quelle — le worker la traduit en `outcome_unknown` et la
 * met en quarantaine pour réconciliation purpose-specific, sans rejeu aveugle.
 */
import { Customer } from '@bob/core';

import type { CustomerUpdateAuthorityPort } from '../customers/customer-update.authority';
import { PrismaService } from '../persistence/prisma/prisma.service';
import { PrismaCustomerRepository } from '../persistence/prisma/repositories';
import type {
  JarvisCustomerEffectAuthority,
  JarvisCustomerEffectTarget,
  JarvisCustomerFields,
  JarvisCustomerSnapshot,
  JarvisCustomerWriteResult,
} from '../jobs/jarvis-customer-effect.executor';

export class PrismaJarvisCustomerEffectAuthority implements JarvisCustomerEffectAuthority {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customerUpdates: CustomerUpdateAuthorityPort,
  ) {}

  /**
   * Lecture de la fiche pour la RÉCONCILIATION d'une reprise indécidable : le worker compare
   * l'état réel à l'effet attendu plutôt que de rejouer une écriture à l'aveugle. Fiche absente
   * ⇒ `null` (l'effet n'a pas eu lieu), jamais un snapshot inventé.
   */
  async readCustomer(target: JarvisCustomerEffectTarget): Promise<JarvisCustomerSnapshot | null> {
    const customer = await this.prisma.withTenant(target.companyId, () =>
      new PrismaCustomerRepository(this.prisma).findById(target.customerId),
    );
    if (customer === null) return null;
    const { id, companyId, ...fields } = customer.toProps();
    void id;
    void companyId;
    return { customerId: target.customerId, fields };
  }

  /**
   * Révision persistée — lue SOUS TENANT, jamais devinée. Le reçu de succès du run la porte : un
   * run refermé sur une révision fausse rendrait la garde §9.1 aveugle pour la proposition
   * suivante. Fiche absente ⇒ `null` : le signal reste dû plutôt que d'acquitter un fantôme.
   */
  async readCustomerRevision(target: JarvisCustomerEffectTarget): Promise<number | null> {
    const rows = await this.prisma.withTenant(target.companyId, () =>
      this.prisma.client().customer.findFirst({
        where: { id: target.customerId, companyId: target.companyId },
        select: { revision: true },
      }),
    );
    return rows === null ? null : rows.revision;
  }

  async createCustomer(
    target: JarvisCustomerEffectTarget,
    fields: JarvisCustomerFields,
  ): Promise<JarvisCustomerWriteResult> {
    // L'agrégat valide AVANT toute écriture : un refus du domaine est un refus de Bob, porté
    // jusqu'au reçu avec son code — l'artisan saura POURQUOI sa fiche n'a pas été créée.
    const created = Customer.of({ id: target.customerId, companyId: target.companyId, ...fields });
    if (!created.ok) {
      return { status: 'refused', reasonCode: `domain_${created.error.code.toLowerCase()}` };
    }
    await this.prisma.withTenant(target.companyId, () =>
      new PrismaCustomerRepository(this.prisma).save(created.value),
    );
    return { status: 'written' };
  }

  async updateCustomerAtRevision(
    target: JarvisCustomerEffectTarget,
    fields: JarvisCustomerFields,
    expectedRevision: number,
  ): Promise<JarvisCustomerWriteResult> {
    const result = await this.customerUpdates.executeAtRevision(
      { id: target.customerId, companyId: target.companyId, ...fields },
      expectedRevision,
    );
    if (result.ok) return { status: 'written' };
    if (result.error.kind === 'conflict' && result.error.reason === 'stale_revision') {
      return { status: 'refused', reasonCode: 'target_revision_stale' };
    }
    if (
      result.error.kind === 'conflict'
      && result.error.reason === 'signed_quote_archive_missing'
    ) {
      return { status: 'refused', reasonCode: 'signed_quote_archive_missing' };
    }
    if (
      result.error.kind === 'conflict'
      && result.error.reason === 'issued_invoice_archive_missing'
    ) {
      return { status: 'refused', reasonCode: 'issued_invoice_archive_missing' };
    }
    if (result.error.kind === 'not_found') {
      return {
        status: 'refused',
        reasonCode: result.error.entity === 'company' ? 'company_missing' : 'customer_missing',
      };
    }
    if (result.error.kind === 'forbidden' && result.error.reason === 'Compte clôturé.') {
      return { status: 'refused', reasonCode: 'company_closed' };
    }
    if (result.error.kind === 'dependency' || result.error.kind === 'unavailable') {
      return { status: 'unavailable' };
    }
    // Le use case rend une erreur fermée : on la NOMME plutôt que de rendre un « refused » muet.
    const code = result.error.kind === 'domain' ? result.error.error.code : undefined;
    return {
      status: 'refused',
      reasonCode: typeof code === 'string' ? `domain_${code.toLowerCase()}` : 'domain_refused',
    };
  }
}
