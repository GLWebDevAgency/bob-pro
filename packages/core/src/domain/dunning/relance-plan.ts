import { AggregateRoot } from '../../shared-kernel/aggregate';
import { type RelanceTone } from '../services/build-relance';

export interface RelanceStep {
  tone: RelanceTone;
  offsetDays: number;
}

/** Cadence de relance : J+7 cordial -> J+15 neutre -> J+30 ferme -> J+45 mise en demeure. */
export class RelancePlan extends AggregateRoot<string> {
  private constructor(
    id: string,
    readonly docId: string,
    private _stepIndex: number,
    readonly steps: readonly RelanceStep[],
  ) {
    super(id);
  }

  static defaultCadence(id: string, docId: string): RelancePlan {
    const steps: RelanceStep[] = [
      { tone: 'cordial', offsetDays: 7 },
      { tone: 'neutre', offsetDays: 15 },
      { tone: 'ferme', offsetDays: 30 },
      { tone: 'miseendemeure', offsetDays: 45 },
    ];
    return new RelancePlan(id, docId, 0, steps);
  }

  currentTone(): RelanceTone {
    return this.steps[this._stepIndex]?.tone ?? 'miseendemeure';
  }

  escalate(): RelanceTone {
    if (this._stepIndex < this.steps.length - 1) this._stepIndex++;
    return this.currentTone();
  }
}
