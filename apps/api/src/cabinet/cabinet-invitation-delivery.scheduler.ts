import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppLogger } from '../observability/logger';
import { requestContext } from '../observability/logger';
import { randomUUID } from 'node:crypto';
import { jobCabinetIds } from '../config/env';
import { CabinetApiService } from './cabinet-api.service';

@Injectable()
export class CabinetInvitationDeliveryScheduler {
  private running = false;

  constructor(
    private readonly cabinet: CabinetApiService,
    private readonly logger: AppLogger,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async deliverPending(): Promise<void> {
    if (this.running) return;
    if (process.env.CABINET_INVITATION_WORKER_ENABLED !== 'true') return;
    // Cette identité technique doit être admin active de CHAQUE cabinet pilote listé ; une simple
    // membership manager ne voit pas les invitations manager/admin sous la RLS.
    const workerUserId = process.env.CABINET_INVITATION_WORKER_USER_ID?.trim();
    const cabinetIds = jobCabinetIds().slice(0, 100);
    if (!workerUserId || cabinetIds.length === 0) return;

    this.running = true;
    try {
      for (const cabinetId of cabinetIds) {
        try {
          await requestContext.run(
            {
              correlationId: `cabinet-worker-${randomUUID()}`,
              principal: { userId: workerUserId, companyId: null },
            },
            () => this.cabinet.processInvitationDeliveries(cabinetId, workerUserId, 10),
          );
        } catch {
          // Aucun payload/provider error ici : le scheduler ne logue que le tenant et un code fixe.
          this.logger.warn(`Outbox invitations indisponible pour cabinet=${cabinetId}.`, 'CabinetInvitationScheduler');
        }
      }
    } finally {
      this.running = false;
    }
  }
}
