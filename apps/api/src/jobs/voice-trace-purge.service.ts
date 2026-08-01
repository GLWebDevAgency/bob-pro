import { Inject, Injectable, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { isVoiceTraceEnabled } from '../config/env';
import { AppLogger } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import type { RealtimeVoiceTraceRetention } from '../voice/realtime/realtime-voice-trace.repository';
import { ScheduledTenantDirectory } from './tenant-directory';

/**
 * Travail borné par tenant et par balayage. Le stock visé est petit (quelques centaines de tours
 * par testeur et par mois) : inutile de vider d'un coup, il suffit que le rythme de purge dépasse
 * durablement le rythme d'écriture.
 */
export const VOICE_TRACE_PURGE_LIMIT_PER_TENANT = 500;
export const VOICE_TRACE_PURGE_MAX_TENANTS = 100;
export const REALTIME_VOICE_TRACE_V2_PURGE_LIMIT = 500;
const ONE_HOUR_MS = 60 * 60 * 1_000;

/**
 * Sélection bornée, stable et sans curseur mémoire : deux replicas/restarts dans la même heure
 * choisissent la même page, puis l'heure suivante avance. Le tri rend la rotation indépendante
 * de l'ordre renvoyé par PostgreSQL et la déduplication évite qu'une configuration répétée ne
 * consomme plusieurs places du quota.
 */
export function selectVoiceTracePurgeTenantBatch(
  companyIds: readonly string[],
  at: Date,
): string[] {
  const stableIds = [...new Set(companyIds)].sort((left, right) => left.localeCompare(right));
  if (stableIds.length <= VOICE_TRACE_PURGE_MAX_TENANTS) return stableIds;

  const pageCount = Math.ceil(stableIds.length / VOICE_TRACE_PURGE_MAX_TENANTS);
  const hourBucket = Math.floor(at.getTime() / ONE_HOUR_MS);
  const pageIndex = ((hourBucket % pageCount) + pageCount) % pageCount;
  const start = pageIndex * VOICE_TRACE_PURGE_MAX_TENANTS;
  return stableIds.slice(start, start + VOICE_TRACE_PURGE_MAX_TENANTS);
}

export interface VoiceTracePurgeSummary {
  readonly skipped: boolean;
  readonly tenants: number;
  readonly purged: number;
  readonly realtimeV2Purged: number;
  readonly realtimeV2Due: number;
  readonly realtimeV2OldestExpiredAt: string | null;
  readonly failures: number;
}

/**
 * PURGE DE RÉTENTION DES TRACES VOCALES — 30 jours (VOICE_TRACE_RETENTION_DAYS, @bob/core).
 *
 * La politique n'est PAS rejouée ici : chaque ligne porte sa propre échéance
 * (`retentionExpiresAt`, posée à l'écriture). La purge ne fait que balayer ce qui est échu, donc
 * un changement de politique n'a jamais d'effet rétroactif sur des traces déjà écrites.
 *
 * Sans ce service, `retentionExpiresAt` ne serait qu'une colonne décorative et la base
 * accumulerait indéfiniment des transcripts en clair. C'est le pendant NON NÉGOCIABLE de la
 * décision d'enregistrer du contenu vocal en base : on n'écrit ce genre de données que si on
 * sait aussi les faire disparaître.
 *
 * La purge s'exécute PAR TENANT, sous le rôle applicatif et le GUC tenant — les mêmes politiques
 * RLS que l'écriture, jamais un rôle privilégié qui pourrait balayer toute la table.
 */
@Injectable()
export class VoiceTracePurgeService {
  private running = false;
  private readonly realtimeV2Retention: RealtimeVoiceTraceRetention | null;

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    private readonly tenants: ScheduledTenantDirectory,
    private readonly logger: AppLogger,
    // @Optional() OBLIGATOIRE : cf. VoiceTraceRecorder — un paramètre fonction non optionnel
    // ferait échouer la résolution Nest au boot.
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {
    this.realtimeV2Retention = p.createRealtimeVoiceTraceAuthorities()?.retention ?? null;
  }

  @Cron(CronExpression.EVERY_HOUR)
  scheduled(): void {
    void this.sweep()
      .then((summary) => {
        if (summary.purged > 0) this.logger.audit('voice.trace.purge', { ...summary });
      })
      .catch((cause: unknown) => {
        this.logger.warn(
          `Purge des traces vocales inattendue : ${cause instanceof Error ? cause.message : String(cause)}`,
          'VoiceTrace',
        );
      });
  }

  async sweep(): Promise<VoiceTracePurgeSummary> {
    // Le flag éteint, plus rien ne s'écrit — mais le stock déjà écrit doit CONTINUER d'expirer.
    // On ne balaie donc pas seulement quand le traçage est actif : on refuse seulement de faire
    // tourner ce cron sur une base qui n'a jamais rien tracé et n'en tracera pas.
    if (this.running) {
      return {
        skipped: true,
        tenants: 0,
        purged: 0,
        realtimeV2Purged: 0,
        realtimeV2Due: 0,
        realtimeV2OldestExpiredAt: null,
        failures: 0,
      };
    }
    this.running = true;
    const now = this.now();
    const before = now.toISOString();
    let tenants = 0;
    let purged = 0;
    let realtimeV2Purged = 0;
    let realtimeV2Due = 0;
    let realtimeV2OldestExpiredAt: string | null = null;
    let failures = 0;
    try {
      // V2 est un journal global protégé par une autorité NOLOGIN. Il ne dépend donc pas de la
      // page des tenants V1. Le flag OFF arrête les écritures, jamais la disparition du stock déjà
      // conservé. Un échec V2 ne doit pas figer les purges tenantées historiques.
      if (this.realtimeV2Retention !== null) {
        try {
          realtimeV2Purged = await this.realtimeV2Retention.purgeExpired(
            REALTIME_VOICE_TRACE_V2_PURGE_LIMIT,
          );
          purged += realtimeV2Purged;
          const lag = await this.realtimeV2Retention.inspectLag();
          realtimeV2Due = lag.due;
          realtimeV2OldestExpiredAt = lag.oldestExpiredAt;
        } catch {
          failures += 1;
          this.logger.warn('Purge du journal Realtime Voice Trace V2 impossible.', 'VoiceTrace');
        }
      }
      const companyIds = selectVoiceTracePurgeTenantBatch(
        await this.tenants.listCompanyIds(),
        now,
      );
      tenants = companyIds.length;
      for (const companyId of companyIds) {
        try {
          purged += await this.p.runWithTenant(companyId, () =>
            this.p.voiceTraces.purgeExpired({
              companyId,
              before,
              limit: VOICE_TRACE_PURGE_LIMIT_PER_TENANT,
            }),
          );
        } catch {
          failures += 1;
          // Ni tenant, ni payload : un échec de purge se diagnostique par le tenant seul.
          this.logger.warn(`Purge des traces vocales impossible (${companyId}).`, 'VoiceTrace');
        }
      }
      return {
        skipped: false,
        tenants,
        purged,
        realtimeV2Purged,
        realtimeV2Due,
        realtimeV2OldestExpiredAt,
        failures,
      };
    } finally {
      this.running = false;
    }
  }

  /** Exposé pour l'exploitation : sait-on encore écrire des traces ? (diagnostic du script) */
  static tracingEnabled(): boolean {
    return isVoiceTraceEnabled();
  }
}
