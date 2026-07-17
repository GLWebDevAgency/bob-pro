import {
  BankBalanceSnapshot,
  type AppendBankBalanceSnapshotOutcome,
  type BankBalanceReconciliationStatus,
  type BankBalanceSnapshotRepository,
  type BankBalanceSource,
} from '@bob/core';
import type { PrismaService } from './prisma.service';

interface BankBalanceSnapshotRow {
  id: string;
  companyId: string;
  amountCents: bigint;
  currency: string;
  source: string;
  reconciliationStatus: string;
  observedAt: Date;
  recordedAt: Date;
}

function fromRow(row: BankBalanceSnapshotRow): BankBalanceSnapshot {
  const amountCents = Number(row.amountCents);
  const restored = BankBalanceSnapshot.record({
    id: row.id,
    companyId: row.companyId,
    amountCents,
    currency: row.currency as 'EUR',
    source: row.source as BankBalanceSource,
    reconciliationStatus: row.reconciliationStatus as BankBalanceReconciliationStatus,
    observedAt: row.observedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  });
  if (!restored.ok) {
    throw new Error(`BANK_BALANCE_SNAPSHOT_CORRUPT:${restored.error.code}`);
  }
  return restored.value;
}

/** Adapter PostgreSQL append-only ; chaque requête reste tenantée et soumise à FORCE RLS. */
export class PrismaBankBalanceSnapshotRepository implements BankBalanceSnapshotRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(snapshot: BankBalanceSnapshot): Promise<AppendBankBalanceSnapshotOutcome> {
    const props = snapshot.toProps();
    const created = await this.prisma.client().bankBalanceSnapshot.createMany({
      data: [{
        id: props.id,
        companyId: props.companyId,
        amountCents: BigInt(props.amountCents),
        currency: props.currency,
        source: props.source,
        reconciliationStatus: props.reconciliationStatus,
        observedAt: new Date(props.observedAt),
        recordedAt: new Date(props.recordedAt),
      }],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'created' : 'id_conflict';
  }

  async findLatestByCompanyId(companyId: string): Promise<BankBalanceSnapshot | null> {
    const row = await this.prisma.client().bankBalanceSnapshot.findFirst({
      where: { companyId },
      orderBy: [{ observedAt: 'desc' }, { recordedAt: 'desc' }, { id: 'desc' }],
    });
    return row === null ? null : fromRow(row);
  }
}
