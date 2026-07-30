import {
  type QuoteCreationMissionPhase,
} from '../../domain/agent/agent-mission';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type QuoteDraftStep } from '../quote-drafts/quote-draft-slot';
import { type AgentMissionOwner } from '../ports/agent-mission-repository';
import { type AgentMissionResumeUnitOfWorkPort } from '../ports/agent-mission-resume-unit-of-work';
import { type AppError, appConflict, appUnavailable } from '../result';
import {
  draftReferenceForMission,
  isCanonicalAgentMissionOwner,
  isCanonicalCustomerCandidateReference,
  toAgentMissionView,
} from './agent-mission-application';

export type CustomerMissionChoiceView =
  | {
      readonly status: 'available';
      readonly choiceId: string;
      readonly label: string;
    }
  | {
      readonly status: 'unavailable';
      readonly choiceId: string;
    };

export interface ResumableQuoteAgentMissionView {
  readonly id: string;
  readonly status: 'active' | 'expired';
  readonly phase: QuoteCreationMissionPhase;
  readonly revision: number;
  readonly actionable: boolean;
  readonly draft: {
    readonly sessionId: string;
    readonly slotRevision: number;
    readonly contentRevision: number;
  };
  readonly idleExpiresAt: string;
  readonly hardExpiresAt: string;
}

export type QuoteAgentMissionResumeView =
  | { readonly mission: null }
  | {
      readonly mission: ResumableQuoteAgentMissionView;
      readonly draft: {
        readonly sessionId: string;
        readonly slotRevision: number;
        readonly contentRevision: number;
        readonly step: QuoteDraftStep;
      };
      readonly customerChoices: readonly CustomerMissionChoiceView[];
    };

export interface GetResumableQuoteAgentMissionDeps {
  readonly unitOfWork: AgentMissionResumeUnitOfWorkPort;
}

function unavailable(cause: string): Result<never, AppError> {
  return err({
    kind: 'dependency',
    port: 'agent_mission_resume_snapshot',
    cause,
  });
}

/**
 * Lecture froide, sans capability et sans effet.
 *
 * La cohérence mission/slot/clients est validée dans le même snapshot. Un marqueur orphelin ou
 * une projection incohérente bloque le mode manuel : une absence de preuve n'est jamais une
 * preuve d'absence de mission.
 */
export class GetResumableQuoteAgentMission {
  constructor(private readonly deps: GetResumableQuoteAgentMissionDeps) {}

  async execute(
    owner: AgentMissionOwner,
  ): Promise<Result<QuoteAgentMissionResumeView, AppError>> {
    if (!isCanonicalAgentMissionOwner(owner)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'identity', message: 'Identité mission invalide.' }],
      });
    }

    const execution = await this.deps.unitOfWork.readQuoteCreationOwner(
      owner,
      async (transaction) => {
        const now = await transaction.databaseNow();
        const foreground = await transaction.missions.findForeground(owner);
        const slot = await transaction.quoteDrafts.get(owner);

        if (foreground === null) {
          return slot?.agentMissionId == null
            ? ok(Object.freeze({ mission: null }) as QuoteAgentMissionResumeView)
            : unavailable('orphaned_draft_mission_owner');
        }
        if (foreground.status !== 'known') {
          return err(appConflict(
            foreground.status === 'unsupported_protocol'
              ? 'agent_mission_protocol'
              : 'agent_mission_foreground',
            foreground.status === 'unsupported_protocol'
              ? 'upgrade_required'
              : 'active_mission_exists',
          ));
        }
        const mission = foreground.mission;

        const missionView = toAgentMissionView(mission, now);
        if (!missionView.ok) return missionView;
        if (slot === null) return unavailable('missing_quote_draft_slot');

        let expectedDraft: ReturnType<typeof draftReferenceForMission>;
        try {
          expectedDraft = draftReferenceForMission(mission);
        } catch {
          return unavailable('missing_mission_draft_reference');
        }
        const missionOwnsSlot = mission.payload.draft !== null;
        if (
          slot.companyId !== owner.companyId
          || slot.ownerUserId !== owner.ownerUserId
          || slot.payload.draft.sessionId !== expectedDraft.sessionId
          || slot.revision !== expectedDraft.slotRevision
          || slot.payload.draft.contentRevision !== expectedDraft.contentRevision
          || (
            missionOwnsSlot
              ? slot.agentMissionId !== mission.id
              : slot.agentMissionId !== null
          )
        ) {
          return unavailable('mission_draft_fence_mismatch');
        }

        const decision = mission.payload.decision;
        const candidates = decision?.kind === 'customer'
          ? decision.candidates
          : [];
        const candidateIds = candidates.map((candidate) => candidate.customerId);
        const customerRows = await transaction.customers.findByIds({
          companyId: owner.companyId,
          customerIds: candidateIds,
        });
        if (
          !Array.isArray(customerRows)
          || customerRows.some(
            (customer) => !isCanonicalCustomerCandidateReference(customer),
          )
        ) {
          return unavailable('invalid_customer_projection');
        }
        const expectedIds = new Set(candidateIds);
        const returnedIds = customerRows.map((customer) => customer.customerId);
        if (
          new Set(returnedIds).size !== returnedIds.length
          || returnedIds.some((customerId) => !expectedIds.has(customerId))
        ) {
          return unavailable('non_authoritative_customer_projection');
        }
        const customersById = new Map(
          customerRows.map((customer) => [customer.customerId, customer] as const),
        );
        const customerChoices = Object.freeze(candidates.map((candidate) => {
          const customer = customersById.get(candidate.customerId);
          return customer === undefined
            ? Object.freeze({
                status: 'unavailable' as const,
                choiceId: candidate.choiceId,
              })
            : Object.freeze({
                status: 'available' as const,
                choiceId: candidate.choiceId,
                label: customer.canonicalName,
              });
        }));
        const projected = missionView.value;
        return ok(Object.freeze({
          mission: Object.freeze({
            id: projected.id,
            status: projected.status as 'active' | 'expired',
            phase: projected.phase,
            revision: projected.revision,
            actionable: projected.actionable,
            draft: Object.freeze({ ...expectedDraft }),
            idleExpiresAt: projected.idleExpiresAt,
            hardExpiresAt: projected.hardExpiresAt,
          }),
          draft: Object.freeze({
            sessionId: slot.payload.draft.sessionId,
            slotRevision: slot.revision,
            contentRevision: slot.payload.draft.contentRevision,
            step: slot.payload.draft.step,
          }),
          customerChoices,
        }) satisfies QuoteAgentMissionResumeView);
      },
    );

    return execution.status === 'company_unavailable'
      ? err(appUnavailable(`agent_mission_resume_company_${execution.reason}`))
      : execution.value;
  }
}
