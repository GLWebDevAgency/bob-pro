import { type ReleaseFlag, type ReleaseFlagEnvironment } from '../../domain/cabinet/release-flag';

export interface ReleaseFlagRepository {
  findByKey(environment: ReleaseFlagEnvironment, key: string): Promise<ReleaseFlag | null>;
  lockByKey(environment: ReleaseFlagEnvironment, key: string): Promise<ReleaseFlag | null>;
  save(flag: ReleaseFlag, expectedVersion: number | null): Promise<void>;
}
