import { Inject, Injectable } from '@nestjs/common';
import { jobCompanyIds } from '../config/env';
import { AppLogger } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';

@Injectable()
export class ScheduledTenantDirectory {
  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    private readonly logger: AppLogger,
  ) {}

  async listCompanyIds(): Promise<string[]> {
    const configured = jobCompanyIds();
    if (configured.length > 0) return configured;

    const companies = await this.p.companies.list();
    const ids = companies.map((c) => c.id);
    if (ids.length === 0) {
      this.logger.warn(
        'Aucun tenant disponible pour les jobs planifiés. Configure JOB_COMPANY_IDS en prod avec RLS runtime.',
        'jobs',
      );
    }
    return ids;
  }
}
