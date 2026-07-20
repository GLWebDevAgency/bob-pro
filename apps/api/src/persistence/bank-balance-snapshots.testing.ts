import {
  BankBalanceSnapshot,
  type AppendBankBalanceSnapshotOutcome,
  type BankBalanceSnapshotProps,
  type BankBalanceSnapshotRepository,
} from '@bob/core';

function compareLatest(left: BankBalanceSnapshot, right: BankBalanceSnapshot): number {
  const a = left.toProps();
  const b = right.toProps();
  return (
    b.observedAt.localeCompare(a.observedAt)
    || b.recordedAt.localeCompare(a.recordedAt)
    || b.id.localeCompare(a.id)
  );
}

/** Double déterministe réservé au harness de tests API. */
export class InMemoryBankBalanceSnapshotRepository implements BankBalanceSnapshotRepository {
  private readonly byId = new Map<string, BankBalanceSnapshotProps>();

  async append(snapshot: BankBalanceSnapshot): Promise<AppendBankBalanceSnapshotOutcome> {
    if (this.byId.has(snapshot.id)) return 'id_conflict';
    this.byId.set(snapshot.id, snapshot.toProps());
    return 'created';
  }

  async findLatestByCompanyId(companyId: string): Promise<BankBalanceSnapshot | null> {
    const candidates = [...this.byId.values()]
      .filter((snapshot) => snapshot.companyId === companyId)
      .map((props) => BankBalanceSnapshot.record(props))
      .flatMap((result) => (result.ok ? [result.value] : []))
      .sort(compareLatest);
    return candidates[0] ?? null;
  }
}
