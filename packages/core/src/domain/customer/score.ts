import { type DomainResult, ok, err } from '../../shared-kernel/result';

export type ScoreBand = 'green' | 'orange' | 'red';

export class Score {
  private constructor(readonly value: number) {}
  static of(v: number): DomainResult<Score> {
    if (!Number.isInteger(v) || v < 0 || v > 100)
      return err({ code: 'VALIDATION', field: 'score', message: 'Score 0..100.' });
    return ok(new Score(v));
  }
  band(): ScoreBand {
    return this.value >= 85 ? 'green' : this.value >= 65 ? 'orange' : 'red';
  }
}
