import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MERCIER_PROPS } from '@bob/core';
import { BackendService } from '../backend.service';
import { AppLogger } from '../observability/logger';

/** Retry durable de l'archivage documentaire. V1 in-process ; prod multi-tenant = worker service-role dédié. */
@Injectable()
export class DocumentArchiveService {
  constructor(
    private readonly backend: BackendService,
    private readonly logger: AppLogger,
  ) {}

  @Cron('*/5 * * * *')
  scheduled(): void {
    void this.backend
      .runDocumentArchiveJobs({ companyId: MERCIER_PROPS.id, limit: 10 })
      .then((r) => {
        if (r.ok && r.value.scanned > 0) this.logger.audit('document.archive_jobs.scheduled', r.value);
        if (!r.ok) this.logger.warn(`Retry archivage documents impossible: ${JSON.stringify(r.error)}`, 'documents');
      })
      .catch((e: unknown) => {
        this.logger.warn(`Retry archivage documents inattendu: ${e instanceof Error ? e.message : String(e)}`, 'documents');
      });
  }

  run() {
    return this.backend.runDocumentArchiveJobs({ limit: 25 });
  }
}
