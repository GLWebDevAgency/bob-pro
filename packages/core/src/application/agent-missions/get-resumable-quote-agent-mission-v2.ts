import {
  AGENT_MISSION_PROTOCOL_M2A,
  type CatalogueDecisionV1,
  type LineConfirmationDecisionV1,
} from '../../domain/agent/agent-mission';
import { type VatRate } from '../../domain/billing/shared/vat-rate';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type CatalogueCategory } from '../catalogue/derive-catalogue';
import {
  type QuoteDraftPayloadLine,
  type QuoteDraftStep,
} from '../quote-drafts/quote-draft-slot';
import {
  type AgentMissionOwner,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionResumeV2UnitOfWorkPort,
} from '../ports/agent-mission-resume-unit-of-work';
import { type CatalogueCandidateRecord } from '../ports/catalogue-candidate-search';
import { computeQuoteVatContextDigest } from '../ports/quote-vat-context';
import { type AppError, appConflict, appUnavailable } from '../result';
import {
  draftReferenceForMission,
  isCanonicalAgentMissionOwner,
  isCanonicalCustomerCandidateReference,
  toAgentMissionView,
  type AgentMissionViewV1,
} from './agent-mission-application';
import {
  deriveQuoteLineProposal,
  type QuoteLineAppendDiff,
} from './derive-quote-line-proposal';
import {
  type AgentMissionQuoteLineRequiredFact,
  type AgentMissionQuoteLineWork,
} from './quote-line-work';
import {
  lineConfirmationDecisionMatchesWork,
} from './quote-line-confirmation-fences';
import {
  type CustomerMissionChoiceView,
  type ResumableQuoteAgentMissionView,
} from './get-resumable-quote-agent-mission';

export interface QuoteAgentMissionCatalogueDecisionPresentationV1
extends Omit<CatalogueDecisionV1, 'candidates'> {
  readonly choices: readonly {
    readonly choiceId: string;
    readonly catalogueItemId: string;
    readonly expectedCatalogueRevision: number;
  }[];
}

export type QuoteAgentMissionPresentationDecisionV1 =
  | null
  | QuoteAgentMissionCatalogueDecisionPresentationV1
  | LineConfirmationDecisionV1;

export interface QuoteAgentMissionCatalogueChoicePresentationV1 {
  readonly choiceId: string;
  readonly available: boolean;
  readonly label: string | null;
  readonly category: CatalogueCategory | null;
  readonly unit: string | null;
  readonly unitPriceCents: number | null;
  readonly vatRate: VatRate | null;
}

export type QuoteAgentMissionProposalStatusV1 =
  | { readonly kind: 'absent' }
  | { readonly kind: 'available' }
  | {
      readonly kind: 'stale';
      readonly reason: 'catalogue_changed' | 'vat_context_changed';
    };

export interface QuoteAgentMissionPresentationV1 {
  readonly schema: 'bob.agent-mission.quote-presentation';
  readonly version: 1;
  readonly requiredFact: AgentMissionQuoteLineRequiredFact | null;
  readonly pendingLine:
    | {
        readonly pendingLineId: string;
        readonly expectedWorkRevision: number;
      }
    | null;
  readonly decision: QuoteAgentMissionPresentationDecisionV1;
  readonly catalogueChoices:
    readonly QuoteAgentMissionCatalogueChoicePresentationV1[];
  readonly freeLineChoiceId: string | null;
  readonly proposalStatus: QuoteAgentMissionProposalStatusV1;
  readonly proposal:
    | {
        readonly proposalId: string;
        readonly diffHash: string;
        readonly diff: QuoteLineAppendDiff;
        readonly line: QuoteDraftPayloadLine;
        readonly catalogue:
          | {
              readonly itemId: string;
              readonly revision: number;
              readonly label: string;
            }
          | null;
      }
    | null;
}

export type QuoteAgentMissionResumeViewV2 =
  | {
      readonly mission: null;
      readonly presentation: null;
    }
  | {
      readonly mission: ResumableQuoteAgentMissionView;
      readonly draft: {
        readonly sessionId: string;
        readonly slotRevision: number;
        readonly contentRevision: number;
        readonly step: QuoteDraftStep;
      };
      readonly customerChoices: readonly CustomerMissionChoiceView[];
      readonly presentation: QuoteAgentMissionPresentationV1;
    };

/**
 * Projection serveur réservée au planificateur sémantique.
 *
 * Elle reste hors du wire HTTP/mobile : les valeurs proviennent de la tête durable relue dans le
 * même snapshot que `resume`, tandis que les IDs ne servent qu'à vérifier la cohérence côté
 * serveur avant de produire le contexte borné et sans autorité envoyé au LLM.
 */
export interface QuoteAgentMissionPlannerCurrentLineV1 {
  readonly pendingLineId: string;
  readonly expectedWorkRevision: number;
  readonly serviceReference: string | null;
  readonly category: CatalogueCategory | null;
  readonly quantityMilli: number | null;
  readonly unit: string | null;
  readonly unitPriceCents: number | null;
  readonly requestedVatRate: VatRate | null;
  readonly priceBasis: AgentMissionQuoteLineWork['priceBasis'];
  readonly housingOlderThan2y: boolean | null;
  readonly energyRenovation: boolean | null;
}

export interface QuoteAgentMissionPlannerResumeV2 {
  readonly resume: QuoteAgentMissionResumeViewV2;
  readonly currentLine: QuoteAgentMissionPlannerCurrentLineV1 | null;
  /** Comptes bornés issus du même snapshot transactionnel que la mission et la tête courante. */
  readonly confirmedLineCount: number;
  readonly pendingLineCount: number;
}

export interface GetResumableQuoteAgentMissionV2Deps {
  readonly unitOfWork: AgentMissionResumeV2UnitOfWorkPort;
}

function unavailable(cause: string): Result<never, AppError> {
  return err({
    kind: 'dependency',
    port: 'agent_mission_resume_v2_snapshot',
    cause,
  });
}

function sameDraft(
  left: {
    readonly sessionId: string;
    readonly slotRevision: number;
    readonly contentRevision: number;
  },
  right: {
    readonly sessionId: string;
    readonly slotRevision: number;
    readonly contentRevision: number;
  },
): boolean {
  return left.sessionId === right.sessionId
    && left.slotRevision === right.slotRevision
    && left.contentRevision === right.contentRevision;
}

function validateWorkQueue(
  workItems: readonly AgentMissionQuoteLineWork[],
  owner: AgentMissionOwner,
  missionId: string,
): readonly AgentMissionQuoteLineWork[] | null {
  if (
    workItems.length > 20
    || workItems.some((item) => (
      item.companyId !== owner.companyId
      || item.ownerUserId !== owner.ownerUserId
      || item.missionId !== missionId
    ))
    || new Set(workItems.map((item) => item.id)).size !== workItems.length
    || new Set(workItems.map((item) => item.ordinal)).size !== workItems.length
  ) {
    return null;
  }
  const sorted = [...workItems].sort((left, right) => (
    left.ordinal - right.ordinal || left.id.localeCompare(right.id)
  ));
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index - 1]?.ordinal ?? 0) >= (sorted[index]?.ordinal ?? 0)) {
      return null;
    }
  }
  return Object.freeze(sorted);
}

function catalogueDecisionForPresentation(
  decision: CatalogueDecisionV1,
): QuoteAgentMissionCatalogueDecisionPresentationV1 {
  return Object.freeze({
    kind: decision.kind,
    decisionId: decision.decisionId,
    choiceSetRevision: decision.choiceSetRevision,
    pendingLineId: decision.pendingLineId,
    expectedDraft: Object.freeze({ ...decision.expectedDraft }),
    expectedWorkRevision: decision.expectedWorkRevision,
    choices: Object.freeze(
      decision.candidates.map((candidate) => Object.freeze({ ...candidate })),
    ),
    freeLineChoiceId: decision.freeLineChoiceId,
    choiceSetHash: decision.choiceSetHash,
  });
}

function cloneLineConfirmationDecision(
  decision: LineConfirmationDecisionV1,
): LineConfirmationDecisionV1 {
  const choices: LineConfirmationDecisionV1['choices'] = Object.freeze([
    Object.freeze({ ...decision.choices[0] }),
    Object.freeze({ ...decision.choices[1] }),
    Object.freeze({ ...decision.choices[2] }),
  ]);
  return Object.freeze({
    ...decision,
    expectedDraft: Object.freeze({ ...decision.expectedDraft }),
    expectedCatalogue: decision.expectedCatalogue === null
      ? null
      : Object.freeze({ ...decision.expectedCatalogue }),
    choices,
  });
}

function decisionForPresentation(
  decision: AgentMissionViewV1['payload']['decision'],
): QuoteAgentMissionPresentationDecisionV1 {
  if (decision?.kind === 'catalogue') {
    return catalogueDecisionForPresentation(decision);
  }
  if (decision?.kind === 'line_confirmation') {
    return cloneLineConfirmationDecision(decision);
  }
  return null;
}

function phaseAndWorkAreCoherent(input: {
  readonly mission: AgentMissionViewV1;
  readonly workItems: readonly AgentMissionQuoteLineWork[];
}): boolean {
  const head = input.workItems[0] ?? null;
  if (input.workItems.slice(1).some((item) => (
    item.state !== 'queued' || item.catalogueResolution !== 'pending'
  ))) {
    return false;
  }
  const decision = input.mission.payload.decision;
  switch (input.mission.phase) {
    case 'awaiting_draft_decision':
    case 'awaiting_draft_discard_confirmation':
    case 'awaiting_quote_screen':
    case 'awaiting_customer':
    case 'awaiting_customer_choice':
      return head === null
        || (head.state === 'queued' && head.catalogueResolution === 'pending');
    case 'awaiting_lines':
      return decision === null
        && (head === null || head.state === 'queued');
    case 'awaiting_catalogue_choice':
      return (
        decision?.kind === 'catalogue'
        && head !== null
        && head.id === decision.pendingLineId
        && head.revision === decision.expectedWorkRevision
        && head.state === 'awaiting_catalogue_choice'
      );
    case 'awaiting_line_details':
      return decision === null
        && head !== null
        && head.state === 'awaiting_details';
    case 'awaiting_line_confirmation':
      return (
        decision?.kind === 'line_confirmation'
        && head !== null
        && lineConfirmationDecisionMatchesWork(decision, head)
      );
  }
}

function phaseRequiresLineDraftStep(
  phase: AgentMissionViewV1['phase'],
): boolean {
  return phase === 'awaiting_lines'
    || phase === 'awaiting_catalogue_choice'
    || phase === 'awaiting_line_details'
    || phase === 'awaiting_line_confirmation';
}

function catalogueRowsAreAuthoritative(
  rows: readonly CatalogueCandidateRecord[],
  expectedIds: ReadonlySet<string>,
): boolean {
  return (
    new Set(rows.map((row) => row.id)).size === rows.length
    && rows.every((row) => expectedIds.has(row.id))
  );
}

function availableCatalogueChoice(
  choice: CatalogueDecisionV1['candidates'][number],
  row: CatalogueCandidateRecord | undefined,
): QuoteAgentMissionCatalogueChoicePresentationV1 {
  if (row === undefined || row.revision !== choice.expectedCatalogueRevision) {
    return Object.freeze({
      choiceId: choice.choiceId,
      available: false,
      label: null,
      category: null,
      unit: null,
      unitPriceCents: null,
      vatRate: null,
    });
  }
  return Object.freeze({
    choiceId: choice.choiceId,
    available: true,
    label: row.label,
    category: row.category,
    unit: row.unit,
    unitPriceCents: row.unitPriceHT,
    vatRate: row.vatRate,
  });
}

/**
 * Reprise froide V2 sans capability et sans mutation.
 *
 * La projection est toujours reconstruite depuis un unique snapshot SQL. Les IDs et choix
 * viennent de la décision scellée ; tous les libellés, prix et taux viennent des lignes réelles
 * relues dans ce snapshot.
 */
export class GetResumableQuoteAgentMissionV2 {
  constructor(private readonly deps: GetResumableQuoteAgentMissionV2Deps) {}

  async execute(
    owner: AgentMissionOwner,
  ): Promise<Result<QuoteAgentMissionResumeViewV2, AppError>> {
    const snapshot = await this.executeSnapshot(owner);
    return snapshot.ok ? ok(snapshot.value.resume) : snapshot;
  }

  async executeForPlanner(
    owner: AgentMissionOwner,
  ): Promise<Result<QuoteAgentMissionPlannerResumeV2, AppError>> {
    return this.executeSnapshot(owner);
  }

  private async executeSnapshot(
    owner: AgentMissionOwner,
  ): Promise<Result<QuoteAgentMissionPlannerResumeV2, AppError>> {
    if (!isCanonicalAgentMissionOwner(owner)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'identity', message: 'Identité mission invalide.' }],
      });
    }

    const execution = await this.deps.unitOfWork.readQuoteCreationOwnerV2(
      owner,
      async (transaction) => {
        const now = await transaction.databaseNow();
        const foreground = await transaction.missions.findForeground(owner);
        const slot = await transaction.quoteDrafts.get(owner);
        if (foreground === null) {
          return slot?.agentMissionId == null
            ? ok(Object.freeze({
                resume: Object.freeze({
                  mission: null,
                  presentation: null,
                }),
                currentLine: null,
                confirmedLineCount: 0,
                pendingLineCount: 0,
              }) satisfies QuoteAgentMissionPlannerResumeV2)
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
        if (mission.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A) {
          return err(appConflict('agent_mission_protocol', 'upgrade_required'));
        }
        const missionViewResult = toAgentMissionView(mission, now);
        if (!missionViewResult.ok) return missionViewResult;
        const missionView = missionViewResult.value;
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

        const workItems = validateWorkQueue(
          await transaction.quoteLineWork.list({
            ...owner,
            missionId: mission.id,
          }),
          owner,
          mission.id,
        );
        if (workItems === null) return unavailable('invalid_quote_line_work_queue');
        const head = workItems[0] ?? null;
        if (!phaseAndWorkAreCoherent({ mission: missionView, workItems })) {
          return unavailable('phase_work_decision_mismatch');
        }
        if (
          phaseRequiresLineDraftStep(missionView.phase)
          && slot.payload.draft.step !== 'lignes'
        ) {
          return unavailable('phase_draft_step_mismatch');
        }

        const persistedDecision = missionView.payload.decision;
        const catalogueDecision = persistedDecision?.kind === 'catalogue'
          ? persistedDecision
          : null;
        const lineDecision = persistedDecision?.kind === 'line_confirmation'
          ? persistedDecision
          : null;
        if (
          (catalogueDecision !== null
            && !sameDraft(catalogueDecision.expectedDraft, expectedDraft))
          || (lineDecision !== null
            && !sameDraft(lineDecision.expectedDraft, expectedDraft))
        ) {
          return unavailable('decision_draft_fence_mismatch');
        }

        const catalogueIds = new Set<string>();
        for (const candidate of catalogueDecision?.candidates ?? []) {
          catalogueIds.add(candidate.catalogueItemId);
        }
        if (lineDecision?.expectedCatalogue !== null
          && lineDecision?.expectedCatalogue !== undefined) {
          catalogueIds.add(lineDecision.expectedCatalogue.itemId);
        }
        const catalogueRows = await transaction.catalogue.findByIds({
          companyId: owner.companyId,
          catalogueItemIds: [...catalogueIds],
        });
        if (!catalogueRowsAreAuthoritative(catalogueRows, catalogueIds)) {
          return unavailable('non_authoritative_catalogue_projection');
        }
        const catalogueById = new Map(
          catalogueRows.map((row) => [row.id, row] as const),
        );
        const catalogueChoices = Object.freeze(
          (catalogueDecision?.candidates ?? []).map((choice) => (
            availableCatalogueChoice(choice, catalogueById.get(choice.catalogueItemId))
          )),
        );

        let proposalStatus: QuoteAgentMissionProposalStatusV1 =
          Object.freeze({ kind: 'absent' });
        let proposal: QuoteAgentMissionPresentationV1['proposal'] = null;
        if (lineDecision !== null && head !== null) {
          const expectedCatalogue = lineDecision.expectedCatalogue;
          const selectedCatalogue = expectedCatalogue === null
            ? null
            : catalogueById.get(expectedCatalogue.itemId) ?? null;
          const catalogueStale = expectedCatalogue !== null
            && (
              selectedCatalogue === null
              || selectedCatalogue.revision !== expectedCatalogue.revision
            );
          if (catalogueStale) {
            proposalStatus = Object.freeze({
              kind: 'stale',
              reason: 'catalogue_changed',
            });
          } else {
            const customerId = slot.payload.draft.customer?.id;
            if (customerId === undefined) {
              return unavailable('proposal_customer_missing');
            }
            const vatContext = await transaction.quoteVatContext.get({
              companyId: owner.companyId,
              customerId,
            });
            if (vatContext === null || vatContext.customerId !== customerId) {
              return unavailable('proposal_vat_context_missing');
            }
            if (
              computeQuoteVatContextDigest(vatContext)
              !== lineDecision.expectedVatContextDigest
            ) {
              proposalStatus = Object.freeze({
                kind: 'stale',
                reason: 'vat_context_changed',
              });
            } else {
              const derived = deriveQuoteLineProposal({
                workItem: head,
                payload: slot.payload,
                selectedCatalogue,
                vatContext,
              });
              if (
                derived.kind === 'resolved'
                && derived.proposal.diffHash === lineDecision.diffHash
                && derived.proposal.diffHash === head.proposalDiffHash
              ) {
                proposalStatus = Object.freeze({ kind: 'available' });
                proposal = Object.freeze({
                  proposalId: lineDecision.proposalId,
                  diffHash: derived.proposal.diffHash,
                  diff: Object.freeze({
                    kind: derived.proposal.diff.kind,
                    before: Object.freeze({ ...derived.proposal.diff.before }),
                    after: Object.freeze({ ...derived.proposal.diff.after }),
                  }),
                  line: Object.freeze({ ...derived.proposal.line }),
                  catalogue: expectedCatalogue === null
                    ? null
                    : Object.freeze({
                        itemId: expectedCatalogue.itemId,
                        revision: expectedCatalogue.revision,
                        label: (selectedCatalogue as CatalogueCandidateRecord).label,
                      }),
                });
              } else if (
                derived.kind === 'rejected'
                && derived.reason === 'invalid_draft'
              ) {
                return unavailable('invalid_proposal_draft');
              } else {
                return unavailable('proposal_redrive_mismatch');
              }
            }
          }
        }

        const customerDecision = persistedDecision?.kind === 'customer'
          ? persistedDecision
          : null;
        const customerIds = customerDecision?.candidates.map(
          (candidate) => candidate.customerId,
        ) ?? [];
        const customerRows = await transaction.customers.findByIds({
          companyId: owner.companyId,
          customerIds,
        });
        if (
          !Array.isArray(customerRows)
          || customerRows.some(
            (customer) => !isCanonicalCustomerCandidateReference(customer),
          )
          || new Set(customerRows.map((customer) => customer.customerId)).size
            !== customerRows.length
          || customerRows.some((customer) => !customerIds.includes(customer.customerId))
        ) {
          return unavailable('invalid_customer_projection');
        }
        const customersById = new Map(
          customerRows.map((customer) => [customer.customerId, customer] as const),
        );
        const customerChoices = Object.freeze(
          (customerDecision?.candidates ?? []).map((candidate) => {
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
          }),
        );

        const presentation: QuoteAgentMissionPresentationV1 = Object.freeze({
          schema: 'bob.agent-mission.quote-presentation',
          version: 1,
          requiredFact:
            missionView.phase === 'awaiting_line_details'
              ? head?.requiredFact ?? null
              : null,
          pendingLine: head === null
            ? null
            : Object.freeze({
                pendingLineId: head.id,
                expectedWorkRevision: head.revision,
              }),
          decision: decisionForPresentation(persistedDecision),
          catalogueChoices,
          freeLineChoiceId: catalogueDecision?.freeLineChoiceId ?? null,
          proposalStatus,
          proposal,
        });
        const projectedMission: ResumableQuoteAgentMissionView =
          Object.freeze({
            id: missionView.id,
            status: missionView.status as 'active' | 'expired',
            phase: missionView.phase,
            revision: missionView.revision,
            actionable: missionView.actionable,
            draft: Object.freeze({ ...expectedDraft }),
            idleExpiresAt: missionView.idleExpiresAt,
            hardExpiresAt: missionView.hardExpiresAt,
          });
        const resume = Object.freeze({
          mission: projectedMission,
          draft: Object.freeze({
            sessionId: slot.payload.draft.sessionId,
            slotRevision: slot.revision,
            contentRevision: slot.payload.draft.contentRevision,
            step: slot.payload.draft.step,
          }),
          customerChoices,
          presentation,
        }) satisfies QuoteAgentMissionResumeViewV2;
        const currentLine: QuoteAgentMissionPlannerCurrentLineV1 | null =
          head === null
            ? null
            : Object.freeze({
                pendingLineId: head.id,
                expectedWorkRevision: head.revision,
                serviceReference: head.serviceReference,
                category: head.category,
                quantityMilli: head.quantityMilli,
                unit: head.unit,
                unitPriceCents: head.unitPriceCents,
                requestedVatRate: head.requestedVatRate,
                priceBasis: head.priceBasis,
                housingOlderThan2y: head.housingOlderThan2y,
                energyRenovation: head.energyRenovation,
              });
        return ok(Object.freeze({
          resume,
          currentLine,
          confirmedLineCount: slot.payload.draft.lines.length,
          pendingLineCount: workItems.length,
        }) satisfies QuoteAgentMissionPlannerResumeV2);
      },
    );

    return execution.status === 'company_unavailable'
      ? err(appUnavailable(`agent_mission_resume_company_${execution.reason}`))
      : execution.value;
  }
}
