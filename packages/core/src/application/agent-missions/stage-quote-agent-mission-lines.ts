import {
  AGENT_MISSION_PROTOCOL_M2A,
  type AgentMission,
} from '../../domain/agent/agent-mission';
import { type Instant } from '../../shared-kernel/time';
import { type Result, err, ok } from '../../shared-kernel/result';
import {
  type AgentMissionQuoteLineCandidateV1,
  createQueuedAgentMissionQuoteLineWork,
  normalizeAgentMissionQuoteLineCandidate,
} from './quote-line-candidate';
import {
  AGENT_MISSION_QUOTE_LINE_MAX_ORDINAL,
  AGENT_MISSION_QUOTE_LINE_MAX_WORK_ITEMS,
  type AgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWorkOrigin,
} from './quote-line-work';
import { type AgentMissionOwner } from '../ports/agent-mission-repository';
import { type AgentMissionTransaction } from '../ports/agent-mission-unit-of-work';
import { type IdGeneratorPort } from '../ports/services';
import { type AppError, appConflict } from '../result';
import { MAX_BILLING_LINES } from '../billing/line-input-validation';

export interface StageQuoteAgentMissionLinesInTransactionInput {
  readonly transaction: AgentMissionTransaction;
  readonly owner: AgentMissionOwner;
  readonly mission: AgentMission;
  readonly confirmedLineCount: number;
  readonly candidates: readonly AgentMissionQuoteLineCandidateV1[];
  readonly origin: AgentMissionQuoteLineWorkOrigin;
  readonly occurredAt: Instant;
  readonly ids: IdGeneratorPort;
}

export interface StagedQuoteAgentMissionLines {
  readonly workItems: readonly AgentMissionQuoteLineWork[];
  readonly firstQueueOrdinal: number;
  readonly lastQueueOrdinal: number;
}

function validation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

function invalidPersistedQueue(cause: string): Result<never, AppError> {
  return err({
    kind: 'dependency',
    port: 'agent_mission_quote_line_work',
    cause,
  });
}

function invalidPersistedDraft(cause: string): Result<never, AppError> {
  return err({
    kind: 'dependency',
    port: 'quote_draft_slot',
    cause,
  });
}

/**
 * Primitive transactionnelle partagée par start, choix client, append et choix catalogue.
 *
 * L'appelant a déjà vérifié le replay et acquis mission → draft. Cette primitive verrouille
 * ensuite la file, borne le NOMBRE d'items présents à 20, refuse de dépasser la capacité
 * autoritaire du brouillon et alloue des ordinals INT4 monotones.
 */
export async function stageQuoteAgentMissionLinesInTransaction(
  input: StageQuoteAgentMissionLinesInTransactionInput,
): Promise<Result<StagedQuoteAgentMissionLines, AppError>> {
  const missionSnapshot = input.mission.toSnapshot();
  if (
    input.mission.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A
    || missionSnapshot.companyId !== input.owner.companyId
    || missionSnapshot.ownerUserId !== input.owner.ownerUserId
    || input.mission.status !== 'active'
  ) {
    return err(appConflict('agent_mission_protocol', 'upgrade_required'));
  }
  if (
    !Array.isArray(input.candidates)
    || input.candidates.length < 1
    || input.candidates.length > AGENT_MISSION_QUOTE_LINE_MAX_WORK_ITEMS
  ) {
    return err(validation('lines', 'Entre une et vingt lignes sont requises.'));
  }
  if (
    !Number.isSafeInteger(input.confirmedLineCount)
    || Object.is(input.confirmedLineCount, -0)
    || input.confirmedLineCount < 0
    || input.confirmedLineCount > MAX_BILLING_LINES
  ) {
    return invalidPersistedDraft('invalid_confirmed_line_count');
  }
  for (let index = 0; index < input.candidates.length; index += 1) {
    const normalized = normalizeAgentMissionQuoteLineCandidate(input.candidates[index]);
    if (!normalized.ok) {
      return err(validation(
        `lines[${index}].${normalized.error.field}`,
        `Ligne invalide (${normalized.error.reason}).`,
      ));
    }
  }

  const existing = await input.transaction.quoteLineWork.listForUpdate({
    ...input.owner,
    missionId: input.mission.id,
  });
  if (
    existing.length > AGENT_MISSION_QUOTE_LINE_MAX_WORK_ITEMS
    || existing.some((item) => (
      item.companyId !== input.owner.companyId
      || item.ownerUserId !== input.owner.ownerUserId
      || item.missionId !== input.mission.id
    ))
    || new Set(existing.map((item) => item.id)).size !== existing.length
    || new Set(existing.map((item) => item.ordinal)).size !== existing.length
  ) {
    return invalidPersistedQueue('invalid_locked_queue');
  }
  if (
    input.confirmedLineCount
      + existing.length
      + input.candidates.length
    > MAX_BILLING_LINES
  ) {
    return err(appConflict(
      'agent_mission_quote_draft',
      'line_limit_reached',
    ));
  }
  if (
    existing.length + input.candidates.length
    > AGENT_MISSION_QUOTE_LINE_MAX_WORK_ITEMS
  ) {
    return err(appConflict('agent_mission_quote_line_work', 'queue_full'));
  }
  const maximumOrdinal = existing.reduce(
    (maximum, item) => Math.max(maximum, item.ordinal),
    0,
  );
  if (
    maximumOrdinal > AGENT_MISSION_QUOTE_LINE_MAX_ORDINAL - input.candidates.length
  ) {
    return err(appConflict('agent_mission_quote_line_work', 'ordinal_overflow'));
  }
  const firstQueueOrdinal = maximumOrdinal + 1;
  const workItems: AgentMissionQuoteLineWork[] = [];
  for (let index = 0; index < input.candidates.length; index += 1) {
    const created = createQueuedAgentMissionQuoteLineWork({
      id: input.ids.newId(),
      companyId: input.owner.companyId,
      ownerUserId: input.owner.ownerUserId,
      missionId: input.mission.id,
      ordinal: firstQueueOrdinal + index,
      origin: input.origin,
      candidate: input.candidates[index],
      occurredAt: input.occurredAt,
    });
    if (!created.ok) {
      return invalidPersistedQueue(
        `normalized_candidate_drift:${created.error.field}:${created.error.reason}`,
      );
    }
    workItems.push(created.value);
  }
  const inserted = await input.transaction.quoteLineWork.insertMany({
    ...input.owner,
    missionId: input.mission.id,
    workItems,
  });
  if (inserted !== 'inserted') {
    return err(appConflict('agent_mission_quote_line_work', 'concurrent_insert'));
  }
  return ok(Object.freeze({
    workItems: Object.freeze(workItems),
    firstQueueOrdinal,
    lastQueueOrdinal: firstQueueOrdinal + workItems.length - 1,
  }));
}
