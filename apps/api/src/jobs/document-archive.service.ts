import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BackendService } from '../backend.service';
import { AppLogger } from '../observability/logger';
import { PERSISTENCE, type Persistence } from '../persistence/persistence';

/** Retry durable de l'archivage documentaire. V1 in-process ; prod multi-tenant = worker service-role dédié. */
@Injectable()
export class DocumentArchiveService {
  constructor(
    private readonly backend: BackendService,
    @Inject(PERSISTENCE) private readonly p: Persistence,
    private readonly logger: AppLogger,
  ) {}

  @Cron('*/5 * * * *')
  scheduled(): void {
    void this.runAllCompanies(10)
      .then((r) => {
        if (r.scanned > 0) this.logger.audit('document.archive_jobs.scheduled', r);
      })
      .catch((e: unknown) => {
        this.logger.warn(`Retry archivage documents inattendu: ${e instanceof Error ? e.message : String(e)}`, 'documents');
      });
  }

  run() {
    return this.backend.runDocumentArchiveJobs({ limit: 25 });
  }

  async runAllCompanies(limitPerCompany = 10): Promise<{ companies: number; scanned: number; archived: number; failed: number }> {
    const companies = await this.p.companies.list();
    let scanned = 0;
    let archived = 0;
    let failed = 0;
    for (const company of companies) {
      const result = await this.backend.runDocumentArchiveJobs({ companyId: company.id, limit: limitPerCompany });
      if (result.ok) {
        scanned += result.value.scanned;
        archived += result.value.archived;
        failed += result.value.failed;
      } else {
        failed += 1;
        this.logger.warn(`Retry archivage documents impossible (${company.id}): ${JSON.stringify(result.error)}`, 'documents');
      }
    }
    return { companies: companies.length, scanned, archived, failed };
  }
}
