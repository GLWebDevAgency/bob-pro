import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BackendService } from '../backend.service';
import { AppLogger } from '../observability/logger';
import { ScheduledTenantDirectory } from './tenant-directory';

/** Retry durable de l'archivage documentaire. V1 in-process ; prod multi-tenant = worker service-role dédié. */
@Injectable()
export class DocumentArchiveService {
  constructor(
    private readonly backend: BackendService,
    private readonly tenants: ScheduledTenantDirectory,
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
    const companyIds = await this.tenants.listCompanyIds();
    let scanned = 0;
    let archived = 0;
    let failed = 0;
    for (const companyId of companyIds) {
      const result = await this.backend.runDocumentArchiveJobs({ companyId, limit: limitPerCompany });
      if (result.ok) {
        scanned += result.value.scanned;
        archived += result.value.archived;
        failed += result.value.failed;
      } else {
        failed += 1;
        this.logger.warn(`Retry archivage documents impossible (${companyId}): ${JSON.stringify(result.error)}`, 'documents');
      }
    }
    return { companies: companyIds.length, scanned, archived, failed };
  }
}
