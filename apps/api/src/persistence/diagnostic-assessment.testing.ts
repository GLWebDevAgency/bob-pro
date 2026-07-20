import type {
  DiagnosticAssessmentRecord,
  DiagnosticAssessmentRepository,
  DiagnosticAssessmentSaveInput,
  DiagnosticAssessmentSaveResult,
} from '@bob/core';

function cloneAxes(
  axes: DiagnosticAssessmentRecord['axes'],
): DiagnosticAssessmentRecord['axes'] {
  return [{ ...axes[0] }, { ...axes[1] }, { ...axes[2] }];
}

function clone(value: DiagnosticAssessmentRecord): DiagnosticAssessmentRecord {
  return {
    ...value,
    answers: { ...value.answers },
    axes: cloneAxes(value.axes),
  };
}

/** Double transactionnel strict, réservé aux tests et exclu de l'artefact API. */
export class InMemoryDiagnosticAssessmentRepository implements DiagnosticAssessmentRepository {
  private readonly rows = new Map<string, DiagnosticAssessmentRecord>();

  async findByCompanyId(companyId: string): Promise<DiagnosticAssessmentRecord | null> {
    const row = this.rows.get(companyId);
    return row === undefined ? null : clone(row);
  }

  async save(input: DiagnosticAssessmentSaveInput): Promise<DiagnosticAssessmentSaveResult> {
    const current = this.rows.get(input.companyId);
    if (input.expectedRevision === 0) {
      if (current !== undefined) {
        return { status: 'revision_conflict', currentRevision: current.revision };
      }
      const now = new Date().toISOString();
      const created: DiagnosticAssessmentRecord = {
        companyId: input.companyId,
        revision: 1,
        answers: { ...input.answers },
        score: input.score,
        axes: cloneAxes(input.axes),
        sourceFingerprint: input.sourceFingerprint,
        rulesetVersion: input.rulesetVersion,
        sourceAsOf: input.sourceAsOf,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(input.companyId, created);
      return { status: 'created', assessment: clone(created) };
    }
    if (current === undefined || current.revision !== input.expectedRevision) {
      return { status: 'revision_conflict', currentRevision: current?.revision ?? null };
    }
    const updated: DiagnosticAssessmentRecord = {
      ...current,
      revision: current.revision + 1,
      answers: { ...input.answers },
      score: input.score,
      axes: cloneAxes(input.axes),
      sourceFingerprint: input.sourceFingerprint,
      rulesetVersion: input.rulesetVersion,
      sourceAsOf: input.sourceAsOf,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(input.companyId, updated);
    return { status: 'updated', assessment: clone(updated) };
  }

  snapshot(): DiagnosticAssessmentRecord[] {
    return [...this.rows.values()].map(clone);
  }

  restore(snapshot: readonly DiagnosticAssessmentRecord[]): void {
    this.rows.clear();
    for (const row of snapshot) this.rows.set(row.companyId, clone(row));
  }
}
