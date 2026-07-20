import { type ReleaseFlagEnvironment } from '../../domain/cabinet/release-flag';
import { type Result, ok } from '../../shared-kernel/result';
import { type ReleaseFlagRepository } from '../ports/release-flag-repository';
import { type AppError } from '../result';

export type SafeReleaseFlagDecisionSource =
  | 'kill_switch'
  | 'user'
  | 'cabinet'
  | 'global'
  | 'missing'
  | 'unavailable';

export interface SafeReleaseFlagDecision {
  enabled: boolean;
  source: SafeReleaseFlagDecisionSource;
  flagVersion: number | null;
}

/** Toute absence ou panne du store ferme l'accès. */
export class EvaluateReleaseFlag {
  constructor(private readonly flags: ReleaseFlagRepository) {}

  async execute(input: {
    environment: ReleaseFlagEnvironment;
    key: string;
    userId?: string;
    cabinetId?: string;
  }): Promise<Result<SafeReleaseFlagDecision, AppError>> {
    try {
      const flag = await this.flags.findByKey(input.environment, input.key);
      if (!flag) return ok({ enabled: false, source: 'missing', flagVersion: null });
      return ok(flag.evaluate({
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        ...(input.cabinetId === undefined ? {} : { cabinetId: input.cabinetId }),
      }));
    } catch {
      return ok({ enabled: false, source: 'unavailable', flagVersion: null });
    }
  }
}
