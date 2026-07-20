import { Inject, Injectable, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { isVoiceTraceEnabled } from '../config/env';
import { AppLogger } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { ScheduledTenantDirectory } from './tenant-directory';

/**
 * Travail borné par tenant et par balayage. Le stock visé est petit (quelques centaines de tours
 * par testeur et par mois) : inutile de vider d'un coup, il suffit que le rythme de purge dépasse
 * durablement le rythme d'écriture.
 */
export const VOICE_TRACE_PURGE_LIMIT_PER_TENANT = 500;
export const VOICE_TRACE_PURGE_MAX_TENANTS = 100;

export interface VoiceTracePurgeSummary {
  readonly skipped: boolean;
  readonly tenants: number;
  readonly purged: number;
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

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    private readonly tenants: ScheduledTenantDirectory,
    private readonly logger: AppLogger,
    // @Optional() OBLIGATOIRE : cf. VoiceTraceRecorder — un paramètre fonction non optionnel
    // ferait échouer la résolution Nest au boot.
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

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
    if (this.running) return { skipped: true, tenants: 0, purged: 0, failures: 0 };
    this.running = true;
    const before = this.now().toISOString();
    let tenants = 0;
    let purged = 0;
    let failures = 0;
    try {
      const companyIds = (await this.tenants.listCompanyIds()).slice(
        0,
        VOICE_TRACE_PURGE_MAX_TENANTS,
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
      return { skipped: false, tenants, purged, failures };
    } finally {
      this.running = false;
    }
  }

  /** Exposé pour l'exploitation : sait-on encore écrire des traces ? (diagnostic du script) */
  static tracingEnabled(): boolean {
    return isVoiceTraceEnabled();
  }
}
