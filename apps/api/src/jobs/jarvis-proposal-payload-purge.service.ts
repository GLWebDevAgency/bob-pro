/**
 * Jarvis U1-d — PURGE DE RÉTENTION DU MAGASIN PII DES PROPOSITIONS (spec Jarvis §5.5, revue C1).
 *
 * `jarvis_proposal_payloads` porte le SEUL contenu personnel du vertical fiche client : nom,
 * adresse, e-mail, téléphone, n° de TVA (jarvis-proposal-payloads.persistence.ts). Sans ce
 * balayage, `retentionExpiresAt` ne serait qu'une colonne décorative et `purgeExpired` du code
 * mort : la lecture cesserait de montrer la charge échue (filtre `> statement_timestamp()`) mais
 * la ligne resterait EN BASE, indéfiniment. On n'écrit ce genre de données que si on sait aussi
 * les faire disparaître — c'est le pendant NON NÉGOCIABLE de la décision d'écrire du PII.
 *
 * Patron : `voice-trace-purge.service.ts`, à la ligne près — @Cron horaire, annuaire de tenants
 * `ScheduledTenantDirectory`, même rotation bornée, garde de réentrance, un échec par tenant qui
 * n'arrête jamais les suivants, aucune horloge ambiante dans la décision d'effacer.
 *
 * LA POLITIQUE N'EST PAS REJOUÉE ICI : chaque ligne porte SON échéance, posée à l'écriture. Le
 * balayage ne fait que demander ce qui est échu ; et c'est la POLICY DELETE (migration
 * 20260819100000, `retentionExpiresAt <= statement_timestamp()`) qui décide vraiment — une borne
 * `before` future ne supprime rien, quoi qu'en demande l'applicatif. La base reste l'autorité de
 * l'effacement, jamais le `WHERE` d'un job.
 *
 * OWNER-SCOPÉ, comme la table : la purge s'exécute sous les GUC (company, owner) de la ligne
 * cible et ne voit donc QUE le PII de ce propriétaire — un GC qui verrait tout serait un
 * privilège que rien ne justifie. Les propriétaires viennent d'un ANNUAIRE SERVEUR borné
 * (précédent `PrismaRealtimeReaperDirectory` / `JARVIS_DISPATCH_RUN_DIRECTORY`), jamais d'un
 * client : aucune table lisible par le rôle applicatif ne peut énumérer les propriétaires d'un
 * tenant (toutes les policies concernées sont owner-scopées, par construction).
 *
 * DÉPENDANCE ABSENTE = NO-OP AUDITÉ, jamais un balayage approximatif : tant que l'annuaire
 * (SECURITY DEFINER, lot suivant) n'est pas lié, le tick s'arrête sur `owner_directory_absent`
 * et le dit une fois — le PII échu reste illisible pour l'applicatif, mais il n'est pas encore
 * effacé. Rien n'est perdu : la rétention est portée par les lignes, le rattrapage est immédiat
 * dès la liaison (même doctrine que `dependencies_absent` du worker de dispatch U1-c).
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { JarvisProposalPayloadStorePort } from '@bob/core';
import { AppLogger } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { ScheduledTenantDirectory } from './tenant-directory';
// MÊME loi de rotation horaire que la purge des traces vocales : une seule pagination bornée
// pour tous les balayages de rétention (stable, sans curseur mémoire, sans famine), prouvée par
// ses propres tests. La dupliquer créerait deux lois qui divergeraient au premier réglage.
import { selectVoiceTracePurgeTenantBatch } from './voice-trace-purge.service';

/**
 * Annuaire SERVEUR des propriétaires à balayer. Implémentation PostgreSQL livrée en U1-e :
 * `PrismaJarvisProposalPayloadStore.listRetentionOwners` (fonction SECURITY DEFINER
 * `list_jarvis_payload_retention_owners_v1`, rôle d'autorité NOLOGIN/NOBYPASSRLS, GRANT par
 * colonne excluant `payload`). Le jeton reste @Optional : une persistance non durable ne le
 * fournit pas, et le tick redevient alors le no-op audité décrit plus haut.
 */
export const JARVIS_PROPOSAL_PAYLOAD_RETENTION_OWNERS = Symbol(
  'JARVIS_PROPOSAL_PAYLOAD_RETENTION_OWNERS',
);

/** Travail borné par propriétaire et par balayage (plafond dur du magasin : 500). */
export const JARVIS_PROPOSAL_PAYLOAD_PURGE_LIMIT_PER_OWNER = 500;
/** Bornes du balayage : le rythme de purge doit dépasser celui d'écriture, pas tout vider. */
export const JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT = 50;

/**
 * Surface EXACTE consommée sur le magasin : la purge vit HORS du port métier
 * (`JarvisProposalPayloadStorePort`) — les appelants métier n'effacent jamais de PII, seul un
 * balayage d'exploitation le fait. L'implémentation durable
 * (`PrismaJarvisProposalPayloadStore.purgeExpired`) la porte ; ce service la reconnaît
 * STRUCTURELLEMENT plutôt que d'élargir un port de lecture/écriture avec un droit d'effacer.
 */
export interface JarvisProposalPayloadRetentionPort {
  purgeExpired(input: {
    readonly companyId: string;
    readonly ownerUserId: string;
    readonly before: string;
    readonly limit: number;
  }): Promise<number>;
}

/**
 * Annuaire borné des propriétaires d'un tenant dont des charges sont encore stockées. Il ne
 * peut PAS être une lecture du rôle applicatif : les policies de `jarvis_proposal_payloads`
 * (comme celles d'`agent_missions`) exigent le GUC owner, donc une lecture sans propriétaire ne
 * voit rien — l'énumération est nécessairement une autorité serveur bornée, séparée de toute
 * mutation tenantée.
 */
export interface JarvisProposalPayloadRetentionOwnersPort {
  listRetentionOwners(companyId: string, limit: number): Promise<readonly string[]>;
}

export interface JarvisProposalPayloadPurgeSummary {
  readonly skipped: 'running' | 'retention_absent' | 'owner_directory_absent' | null;
  readonly tenants: number;
  readonly owners: number;
  readonly purged: number;
  readonly failures: number;
}

/**
 * Reconnaissance structurelle du magasin durable : les persistances non durables rendent
 * déjà `null` pour ce port, et tout adapter incapable de prouver la policy de rétention
 * reste NULL ici — fail-closed, jamais une purge simulée.
 */
export function asJarvisProposalPayloadRetention(
  store: JarvisProposalPayloadStorePort | null,
): JarvisProposalPayloadRetentionPort | null {
  if (store === null) return null;
  const candidate = store as unknown as { readonly purgeExpired?: unknown };
  return typeof candidate.purgeExpired === 'function'
    ? (store as unknown as JarvisProposalPayloadRetentionPort)
    : null;
}

/**
 * MÊME reconnaissance structurelle pour l'annuaire (U1-e §4) : l'énumération des propriétaires
 * vit hors du port métier, sur le seul adapter capable de la prouver (autorité SECURITY DEFINER).
 * Une persistance qui n'en porte pas reste `null` — fail-closed, jamais un annuaire simulé qui
 * ferait conclure « rien à effacer » sur du PII réellement échu.
 */
export function asJarvisProposalPayloadRetentionOwners(
  store: JarvisProposalPayloadStorePort | null,
): JarvisProposalPayloadRetentionOwnersPort | null {
  if (store === null) return null;
  const candidate = store as unknown as { readonly listRetentionOwners?: unknown };
  return typeof candidate.listRetentionOwners === 'function'
    ? (store as unknown as JarvisProposalPayloadRetentionOwnersPort)
    : null;
}

function emptySummary(
  skipped: JarvisProposalPayloadPurgeSummary['skipped'],
): JarvisProposalPayloadPurgeSummary {
  return { skipped, tenants: 0, owners: 0, purged: 0, failures: 0 };
}

@Injectable()
export class JarvisProposalPayloadPurgeService {
  private running = false;
  private dependenciesAudited = false;
  private readonly retention: JarvisProposalPayloadRetentionPort | null;

  constructor(
    @Inject(PERSISTENCE) p: Persistence,
    private readonly tenants: ScheduledTenantDirectory,
    private readonly logger: AppLogger,
    @Optional()
    @Inject(JARVIS_PROPOSAL_PAYLOAD_RETENTION_OWNERS)
    private readonly owners: JarvisProposalPayloadRetentionOwnersPort | null = null,
    // @Optional() OBLIGATOIRE : cf. VoiceTracePurgeService — un paramètre fonction non optionnel
    // ferait échouer la résolution Nest au boot.
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {
    this.retention = asJarvisProposalPayloadRetention(p.createJarvisProposalPayloadStore());
  }

  /**
   * Cadence horaire : la rétention d'un magasin PII se compte en jours, pas en minutes — un
   * balayage par heure suffit largement à ce que le rythme de purge dépasse celui d'écriture.
   */
  @Cron(CronExpression.EVERY_HOUR)
  scheduled(): void {
    void this.sweep()
      .then((summary) => {
        if (summary.purged > 0 || summary.failures > 0) {
          this.logger.audit('jarvis.proposal_payload.purge', { ...summary });
        }
      })
      .catch((cause: unknown) => {
        this.logger.warn(
          `Purge des payloads Jarvis inattendue : ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          'jarvis-payload-purge',
        );
      });
  }

  async sweep(): Promise<JarvisProposalPayloadPurgeSummary> {
    if (this.running) return emptySummary('running');
    const retention = this.retention;
    const owners = this.owners;
    if (retention === null || owners === null) {
      // Une seule fois : une dépendance absente est un état de déploiement, pas un incident
      // périodique (patron `jarvis.dispatch.dependencies_absent`).
      if (!this.dependenciesAudited) {
        this.dependenciesAudited = true;
        this.logger.audit('jarvis.proposal_payload.purge_dependencies_absent', {
          retention: retention !== null,
          ownerDirectory: owners !== null,
        });
      }
      return emptySummary(retention === null ? 'retention_absent' : 'owner_directory_absent');
    }
    this.running = true;
    try {
      const now = this.now();
      // Borne demandée = l'instant du balayage. La base n'efface de toute façon QUE des lignes
      // déjà échues à SON horloge : une borne applicative en avance ne peut rien élargir.
      const before = now.toISOString();
      const companyIds = selectVoiceTracePurgeTenantBatch(await this.tenants.listCompanyIds(), now);
      let sweptOwners = 0;
      let purged = 0;
      let failures = 0;
      for (const companyId of companyIds) {
        let ownerIds: readonly string[];
        try {
          ownerIds = await owners.listRetentionOwners(
            companyId,
            JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
          );
        } catch {
          failures += 1;
          // Ni propriétaire ni payload dans le journal : un échec de purge PII se diagnostique
          // par le tenant seul (patron voice-trace).
          this.logger.warn(
            `Annuaire de rétention des payloads Jarvis indisponible (${companyId}).`,
            'jarvis-payload-purge',
          );
          continue;
        }
        // Déduplication + borne dure : un annuaire bavard ne fait jamais déborder le tick.
        const bounded = [...new Set(ownerIds)].slice(
          0,
          JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
        );
        for (const ownerUserId of bounded) {
          sweptOwners += 1;
          try {
            purged += await retention.purgeExpired({
              companyId,
              ownerUserId,
              before,
              limit: JARVIS_PROPOSAL_PAYLOAD_PURGE_LIMIT_PER_OWNER,
            });
          } catch {
            failures += 1;
            this.logger.warn(
              `Purge des payloads Jarvis impossible (${companyId}).`,
              'jarvis-payload-purge',
            );
          }
        }
      }
      return { skipped: null, tenants: companyIds.length, owners: sweptOwners, purged, failures };
    } finally {
      this.running = false;
    }
  }
}
