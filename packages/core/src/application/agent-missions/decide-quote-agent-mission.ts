import {
  AGENT_MISSION_PROTOCOL_M2A,
  type AgentMission,
  type AgentMissionTransition,
} from '../../domain/agent/agent-mission';
import {
  isCanonicalAgentMissionUserCommandId,
  type AgentMissionEventSnapshot,
  type AgentMissionEventType,
} from '../../domain/agent/agent-mission-event';
import { hasAsciiControlCharacter } from '../../shared-kernel/control-characters';
import { type Result, err, ok } from '../../shared-kernel/result';
import { applyQuoteDraftCustomerSelection } from '../quote-drafts/apply-quote-draft-transition';
import {
  isCanonicalCustomerReference,
  resolveCustomerReference,
} from './resolve-customer-reference';
import { type AgentMissionFingerprintPort } from '../ports/agent-mission-fingerprint';
import {
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionUnitOfWorkPort,
} from '../ports/agent-mission-unit-of-work';
import { type IdGeneratorPort } from '../ports/services';
import { type AppError, appConflict, appGone } from '../result';
import {
  agentMissionDomainError,
  canonicalAgentMissionCustomerDecisionCommand,
  expireAgentMissionInTransaction,
  guardAgentMissionReplayForeground,
  isCanonicalAgentMissionOwner,
  isCanonicalAgentMissionUserCommandOrigin,
  isCanonicalAgentMissionUuid,
  isCanonicalCustomerCandidateReference,
  missingAgentMission,
  recordAgentMissionEvent,
  rejectedAgentMissionCapability,
  resolveAgentMissionEventCorrelation,
  requireAgentMissionFingerprint,
  resolveQuoteAgentMissionEventLookup,
  resolveQuoteAgentMissionLookup,
  resolveQuoteAgentMissionForUpdate,
  toAgentMissionView,
  unavailableAgentMissionCompany,
  unavailableAgentMissionForeground,
  verifyAgentMissionFingerprint,
  type AgentMissionUserCommandOrigin,
  type AgentMissionViewV1,
} from './agent-mission-application';
import { isCanonicalAgentMissionDraftSessionId } from './agent-mission-identifiers';
import {
  type AgentMissionQuoteLineCandidateV1,
  type NormalizedAgentMissionQuoteLineCandidateV1,
  normalizeAgentMissionQuoteLineCandidate,
} from './quote-line-candidate';
import {
  stageQuoteAgentMissionLinesInTransaction,
} from './stage-quote-agent-mission-lines';

const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_IDENTIFIER_LENGTH = 200;

export type QuoteAgentMissionCustomerDecision =
  | {
      readonly action: 'choose_presented_option';
      readonly decisionId: string;
      readonly choiceSetRevision: number;
      readonly choiceId: string;
    }
  | {
      readonly action: 'select_screen_customer';
      readonly customerId: string;
    }
  | {
      readonly action: 'resolve_customer_reference';
      readonly customerReference: string;
    };

export interface DecideQuoteAgentMissionInput extends AgentMissionOwner {
  readonly authority: AgentMissionRealtimeAuthorityProof;
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly decision: QuoteAgentMissionCustomerDecision;
  /** Lignes comprises dans le même tour M2-A ; absentes chez le writer V1. */
  readonly lines?: readonly AgentMissionQuoteLineCandidateV1[];
}

export type QuoteAgentMissionCustomerDecisionEffect =
  | { readonly kind: 'selected' }
  | {
      readonly kind: 'invalidated';
      readonly reason: 'candidate_unavailable' | 'draft_changed' | 'choice_set_stale';
    }
  | {
      readonly kind: 'presented';
      readonly candidateCount: number;
    }
  | {
      readonly kind: 'not_found';
      readonly result: 'none' | 'too_many';
    };

type FreshDecisionOutput = {
  readonly [Kind in QuoteAgentMissionCustomerDecisionEffect['kind']]: {
    readonly outcome: Kind;
    readonly effect: Extract<QuoteAgentMissionCustomerDecisionEffect, { readonly kind: Kind }>;
    readonly mission: AgentMissionViewV1;
  };
}[QuoteAgentMissionCustomerDecisionEffect['kind']];

export type DecideQuoteAgentMissionOutput =
  | FreshDecisionOutput
  | {
      readonly outcome: 'replayed';
      /** Effet immuable de l'événement acquis, jamais inféré depuis la phase courante. */
      readonly effect: QuoteAgentMissionCustomerDecisionEffect;
      readonly mission: AgentMissionViewV1;
    };

export interface DecideQuoteAgentMissionDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class DecideQuoteAgentMissionAbort extends Error {
  constructor(readonly appError: AppError) {
    super('decide-quote-agent-mission-abort');
  }
}

function abort(error: AppError): never {
  throw new DecideQuoteAgentMissionAbort(error);
}

function validation(field: string, message: string): Result<never, AppError> {
  return err({ kind: 'validation', issues: [{ field, message }] });
}

function isRevision(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && (value as number) >= (allowZero ? 0 : 1)
    && (value as number) <= POSTGRES_INT_MAX;
}

function isCanonicalIdentifier(
  value: unknown,
  maxLength = MAX_IDENTIFIER_LENGTH,
): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maxLength
    && value === value.trim()
    && !hasAsciiControlCharacter(value);
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function parseDecision(
  value: unknown,
): Result<QuoteAgentMissionCustomerDecision, AppError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return validation('decision', 'Décision client objet requise.');
  }
  const action = (value as Record<string, unknown>)['action'];
  if (action === 'choose_presented_option') {
    if (!isExactRecord(value, [
      'action',
      'decisionId',
      'choiceSetRevision',
      'choiceId',
    ])) {
      return validation('decision', 'Décision de choix invalide.');
    }
    if (!isCanonicalAgentMissionUuid(value['decisionId'])) {
      return validation('decisionId', 'UUID canonique requis.');
    }
    if (!isRevision(value['choiceSetRevision'])) {
      return validation('choiceSetRevision', 'Révision positive requise.');
    }
    if (!isCanonicalAgentMissionUuid(value['choiceId'])) {
      return validation('choiceId', 'UUID canonique requis.');
    }
    return ok({
      action,
      decisionId: value['decisionId'],
      choiceSetRevision: value['choiceSetRevision'],
      choiceId: value['choiceId'],
    });
  }
  if (action === 'select_screen_customer') {
    if (!isExactRecord(value, ['action', 'customerId'])) {
      return validation('decision', 'Sélection client écran invalide.');
    }
    if (!isCanonicalIdentifier(value['customerId'])) {
      return validation('customerId', 'Identifiant client canonique requis.');
    }
    return ok({ action, customerId: value['customerId'] });
  }
  if (action === 'resolve_customer_reference') {
    if (!isExactRecord(value, ['action', 'customerReference'])) {
      return validation('decision', 'Résolution de référence client invalide.');
    }
    if (!isCanonicalCustomerReference(value['customerReference'])) {
      return validation('customerReference', 'Référence client canonique requise.');
    }
    return ok({ action, customerReference: value['customerReference'] });
  }
  return validation('action', 'Action de décision client inconnue.');
}

function replayEventMatchesDecision(
  decision: QuoteAgentMissionCustomerDecision,
  eventType: AgentMissionEventType,
): boolean {
  if (decision.action === 'select_screen_customer') {
    return eventType === 'customer_selected';
  }
  if (decision.action === 'choose_presented_option') {
    return eventType === 'customer_selected' || eventType === 'decision_invalidated';
  }
  return (
    eventType === 'customer_selected'
    || eventType === 'customer_choice_presented'
    || eventType === 'customer_not_found'
  );
}

function decisionEffectForEvent(
  snapshot: Pick<AgentMissionEventSnapshot, 'eventType' | 'data'>,
): QuoteAgentMissionCustomerDecisionEffect | null {
  switch (snapshot.data.kind) {
    case 'customer_selected':
      return snapshot.eventType === snapshot.data.kind
        ? Object.freeze({ kind: 'selected' })
        : null;
    case 'decision_invalidated':
      return snapshot.eventType === snapshot.data.kind
        ? Object.freeze({
            kind: 'invalidated',
            reason: snapshot.data.reason,
          })
        : null;
    case 'customer_choice_presented':
      return snapshot.eventType === snapshot.data.kind
        ? Object.freeze({
            kind: 'presented',
            candidateCount: snapshot.data.candidateCount,
          })
        : null;
    case 'customer_not_found':
      return snapshot.eventType === snapshot.data.kind
        ? Object.freeze({
            kind: 'not_found',
            result: snapshot.data.result,
          })
        : null;
    default:
      return null;
  }
}

function draftReference(slot: AgentMissionQuoteDraftSlot): {
  readonly sessionId: string;
  readonly slotRevision: number;
  readonly contentRevision: number;
} {
  return {
    sessionId: slot.payload.draft.sessionId,
    slotRevision: slot.revision,
    contentRevision: slot.payload.draft.contentRevision,
  };
}

function draftMatches(
  slot: AgentMissionQuoteDraftSlot,
  mission: AgentMission,
  input: Pick<
    DecideQuoteAgentMissionInput,
    | 'expectedDraftSessionId'
    | 'expectedDraftSlotRevision'
    | 'expectedDraftContentRevision'
  >,
): boolean {
  const reference = mission.payload.draft;
  return reference !== null
    && slot.agentMissionId === mission.id
    && slot.payload.draft.sessionId === reference.sessionId
    && slot.revision === reference.slotRevision
    && slot.payload.draft.contentRevision === reference.contentRevision
    && slot.payload.draft.sessionId === input.expectedDraftSessionId
    && slot.revision === input.expectedDraftSlotRevision
    && slot.payload.draft.contentRevision === input.expectedDraftContentRevision
    && slot.payload.draft.step === 'client'
    && slot.payload.draft.customer === null;
}

function customerIdForDecision(
  mission: AgentMission,
  decision: Exclude<
    QuoteAgentMissionCustomerDecision,
    { readonly action: 'resolve_customer_reference' }
  >,
): string {
  if (decision.action === 'select_screen_customer') return decision.customerId;
  const presented = mission.payload.decision;
  if (presented?.kind !== 'customer') {
    abort(appConflict('agent_mission', 'choice_set_stale'));
  }
  if (presented.decisionId !== decision.decisionId) {
    abort(appConflict('agent_mission', 'decision_id'));
  }
  if (presented.choiceSetRevision !== decision.choiceSetRevision) {
    abort(appConflict('agent_mission', 'choice_set_revision'));
  }
  const choice = presented.candidates.find(
    (candidate) => candidate.choiceId === decision.choiceId,
  );
  if (choice === undefined) abort(appConflict('agent_mission', 'choice_id'));
  return choice.customerId;
}

function transitionValue(
  transition: ReturnType<AgentMission['selectCustomer']>,
) {
  if (!transition.ok) abort(agentMissionDomainError(transition.error));
  return transition.value;
}

function invalidationValue(
  transition: ReturnType<AgentMission['invalidateCustomerDecision']>,
) {
  if (!transition.ok) abort(agentMissionDomainError(transition.error));
  return transition.value;
}

function normalizeDecisionLines(
  input: unknown,
): Result<readonly NormalizedAgentMissionQuoteLineCandidateV1[], AppError> {
  if (!Array.isArray(input) || input.length > 20) {
    return validation('lines', 'Vingt lignes maximum.');
  }
  const normalized: NormalizedAgentMissionQuoteLineCandidateV1[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const parsed = normalizeAgentMissionQuoteLineCandidate(input[index]);
    if (!parsed.ok) {
      return validation(
        `lines[${index}].${parsed.error.field}`,
        `Ligne invalide (${parsed.error.reason}).`,
      );
    }
    normalized.push(parsed.value);
  }
  return ok(Object.freeze(normalized));
}

function canonicalDecisionLine(
  line: NormalizedAgentMissionQuoteLineCandidateV1,
): readonly unknown[] {
  return [
    line.serviceReference,
    line.category,
    line.quantityMilli,
    line.unit,
    line.unitPriceCents,
    line.requestedVatRate,
    line.priceBasis,
  ];
}

export function canonicalAgentMissionCustomerDecisionCommandM2A(input: {
  readonly baseCanonical: string;
  readonly normalizedLines: readonly NormalizedAgentMissionQuoteLineCandidateV1[];
}): string {
  return JSON.stringify([
    'bob.agent-mission.command.customer-decision.m2a.v1',
    input.baseCanonical,
    input.normalizedLines.map(canonicalDecisionLine),
  ]);
}

export class DecideQuoteAgentMission {
  constructor(private readonly deps: DecideQuoteAgentMissionDeps) {}

  async execute(
    input: DecideQuoteAgentMissionInput,
  ): Promise<Result<DecideQuoteAgentMissionOutput, AppError>> {
    if (!isCanonicalAgentMissionOwner(input)) {
      return validation('identity', 'Identité mission invalide.');
    }
    if (!isCanonicalAgentMissionUuid(input.missionId)) {
      return validation('missionId', 'UUID canonique requis.');
    }
    if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
      return validation('commandId', 'UUID v4 canonique requis.');
    }
    if (!isRevision(input.expectedMissionRevision)) {
      return validation('expectedMissionRevision', 'Révision positive requise.');
    }
    if (!isCanonicalAgentMissionDraftSessionId(input.expectedDraftSessionId)) {
      return validation('expectedDraftSessionId', 'Session de brouillon canonique requise.');
    }
    if (!isRevision(input.expectedDraftSlotRevision)) {
      return validation('expectedDraftSlotRevision', 'Révision de slot positive requise.');
    }
    if (!isRevision(input.expectedDraftContentRevision, true)) {
      return validation(
        'expectedDraftContentRevision',
        'Révision de contenu positive ou nulle requise.',
      );
    }
    if (!isCanonicalAgentMissionUserCommandOrigin(input.origin)) {
      return validation('origin', 'Origine de commande invalide.');
    }
    const parsedDecision = parseDecision(input.decision);
    if (!parsedDecision.ok) return parsedDecision;
    const lines = normalizeDecisionLines(input.lines ?? []);
    if (!lines.ok) return lines;
    if (
      lines.value.length > 0
      && input.authority.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A
    ) {
      return err(appConflict('agent_mission_protocol', 'upgrade_required'));
    }
    if (
      input.origin.actor === 'user_voice'
      && parsedDecision.value.action === 'select_screen_customer'
    ) {
      return validation(
        'decision',
        'Une commande vocale ne peut pas fournir directement un identifiant client.',
      );
    }
    if (
      input.origin.actor === 'user_tap'
      && parsedDecision.value.action === 'resolve_customer_reference'
    ) {
      return validation(
        'decision',
        'Une sélection tactile doit fournir un choix opaque ou un client affiché.',
      );
    }

    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };
    const baseCanonical = canonicalAgentMissionCustomerDecisionCommand({
      ...owner,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      origin: input.origin,
      decision: parsedDecision.value,
    });
    const canonical = input.authority.protocolVersion === AGENT_MISSION_PROTOCOL_M2A
      ? canonicalAgentMissionCustomerDecisionCommandM2A({
          baseCanonical,
          normalizedLines: lines.value,
        })
      : baseCanonical;

    try {
      const execution = await this.deps.unitOfWork.runQuoteCreationOwner(
        owner,
        input.authority,
        async (transaction) => {
          const now = await transaction.databaseNow();
          const consumedLookup = await transaction.events.findByCommandId({
            ...owner,
            commandId: input.commandId,
          });
          const consumedResult = resolveQuoteAgentMissionEventLookup(consumedLookup);
          if (!consumedResult.ok) abort(consumedResult.error);
          const consumed = consumedResult.value;
          if (consumed !== null) {
            const snapshot = consumed.toSnapshot();
            if (
              snapshot.missionId !== input.missionId
              || !replayEventMatchesDecision(parsedDecision.value, snapshot.eventType)
              || snapshot.actor !== input.origin.actor
            ) {
              abort(appConflict('agent_mission_command', 'already_used'));
            }
            const effect = decisionEffectForEvent(snapshot);
            if (effect === null) {
              abort(appConflict('agent_mission_command', 'already_used'));
            }
            const verified = verifyAgentMissionFingerprint(
              this.deps.fingerprints,
              canonical,
              snapshot,
            );
            if (!verified.ok) abort(verified.error);
            if (!verified.value) {
              abort(appConflict('agent_mission_command', 'fingerprint_mismatch'));
            }
            const missionLookup = await transaction.missions.findById({
              ...owner,
              missionId: input.missionId,
            });
            const missionResult = resolveQuoteAgentMissionLookup(missionLookup);
            if (!missionResult.ok) abort(missionResult.error);
            const mission = missionResult.value;
            if (mission === null) {
              abort({
                kind: 'dependency',
                port: 'agent_mission_repository',
                cause: 'customer_decision_event_without_mission',
              });
            }
            const replayGuard = await guardAgentMissionReplayForeground({
              transaction,
              owner,
              replayedMissionId: mission.id,
            });
            if (!replayGuard.ok) abort(replayGuard.error);
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              outcome: 'replayed',
              effect,
              mission: view.value,
            } satisfies DecideQuoteAgentMissionOutput;
          }

          const resolvedMission = await resolveQuoteAgentMissionForUpdate({
            transaction,
            owner,
            missionId: input.missionId,
          });
          if (!resolvedMission.ok) abort(resolvedMission.error);
          const mission = resolvedMission.value;
          if (mission === null) abort(missingAgentMission(input.missionId));
          if (mission.status !== 'active') {
            return { kind: 'gone', reason: mission.status } as const;
          }
          const expired = mission.isExpiredAt(now);
          if (!expired.ok) abort(agentMissionDomainError(expired.error));
          if (expired.value) {
            const terminalized = await expireAgentMissionInTransaction({
              transaction,
              owner,
              mission,
              occurredAt: now,
              fingerprints: this.deps.fingerprints,
              ids: this.deps.ids,
            });
            if (!terminalized.ok) abort(terminalized.error);
            return { kind: 'gone', reason: 'expired' } as const;
          }
          if (mission.revision !== input.expectedMissionRevision) {
            abort(appConflict('agent_mission', 'stale_revision'));
          }
          const correlationResult = resolveAgentMissionEventCorrelation(
            transaction,
            mission,
            input.origin,
          );
          if (!correlationResult.ok) abort(correlationResult.error);
          const correlation = correlationResult.value;
          const slot = await transaction.quoteDrafts.getForUpdate(owner);
          if (slot === null || !draftMatches(slot, mission, input)) {
            abort(appConflict('agent_mission_quote_draft', 'draft_stale'));
          }
          if (lines.value.length > 0) {
            const staged = await stageQuoteAgentMissionLinesInTransaction({
              transaction,
              owner,
              mission,
              confirmedLineCount: slot.payload.draft.lines.length,
              candidates: input.lines ?? [],
              origin: input.origin.actor,
              occurredAt: now,
              ids: this.deps.ids,
            });
            if (!staged.ok) abort(staged.error);
          }

          const commitMissionOnly = async (
            transition: AgentMissionTransition,
            outcome: 'presented' | 'not_found',
          ): Promise<DecideQuoteAgentMissionOutput> => {
            const updated = await transaction.missions.updateCas({
              mission: transition.mission,
              expectedRevision: mission.revision,
            });
            if (updated !== 'updated') {
              abort(appConflict('agent_mission', 'stale_revision'));
            }
            const fingerprint = requireAgentMissionFingerprint(
              this.deps.fingerprints,
              canonical,
            );
            if (!fingerprint.ok) abort(fingerprint.error);
            const reference = draftReference(slot);
            const event = recordAgentMissionEvent({
              owner,
              transition,
              actor: input.origin.actor,
              commandId: input.commandId,
              fingerprint: fingerprint.value,
              ids: this.deps.ids,
              draftBefore: reference,
              draftAfter: reference,
              ...(correlation === undefined ? {} : { correlation }),
            });
            if (!event.ok) abort(event.error);
            await transaction.events.append(event.value);
            const view = toAgentMissionView(transition.mission, now);
            if (!view.ok) abort(view.error);
            const effect = decisionEffectForEvent({
              eventType: transition.event.eventType,
              data: transition.event.data,
            });
            if (effect === null || effect.kind !== outcome) {
              abort({
                kind: 'dependency',
                port: 'agent_mission',
                cause: 'customer_decision_effect_mismatch',
              });
            }
            return { outcome, effect, mission: view.value } as DecideQuoteAgentMissionOutput;
          };

          let customerId: string;
          let resolvedPresentedChoice: {
            readonly decisionId: string;
            readonly choiceSetRevision: number;
            readonly choiceId: string;
          } | null = null;
          if (parsedDecision.value.action === 'resolve_customer_reference') {
            const resolved = await resolveCustomerReference({
              companyId: owner.companyId,
              query: parsedDecision.value.customerReference,
              customers: transaction.customers,
              ids: this.deps.ids,
            });
            if (!resolved.ok) abort(resolved.error);
            if (
              resolved.value.kind === 'none'
              || resolved.value.kind === 'too_many'
            ) {
              return commitMissionOnly(
                transitionValue(mission.recordCustomerNotFound({
                  expectedRevision: input.expectedMissionRevision,
                  result: resolved.value.kind,
                  occurredAt: now,
                })),
                'not_found',
              );
            }
            if (resolved.value.kind === 'choices') {
              const available = await transaction.customers.findByIds({
                companyId: owner.companyId,
                customerIds: resolved.value.candidates.map(
                  (candidate) => candidate.customerId,
                ),
              });
              const resolvedIds = new Set(
                resolved.value.candidates.map((candidate) => candidate.customerId),
              );
              if (
                !Array.isArray(available)
                || available.length > resolved.value.candidates.length
                || available.some(
                  (candidate) => (
                    !isCanonicalCustomerCandidateReference(candidate)
                    || !resolvedIds.has(candidate.customerId)
                  ),
                )
                || new Set(available.map((candidate) => candidate.customerId)).size
                  !== available.length
              ) {
                abort({
                  kind: 'dependency',
                  port: 'customer_candidate_search',
                  cause: 'invalid_customer_read',
                });
              }
              const availableIds = new Set(
                available.map((candidate) => candidate.customerId),
              );
              const candidates = resolved.value.candidates.filter(
                (candidate) => availableIds.has(candidate.customerId),
              );
              if (candidates.length === 0) {
                return commitMissionOnly(
                  transitionValue(mission.recordCustomerNotFound({
                    expectedRevision: input.expectedMissionRevision,
                    result: 'none',
                    occurredAt: now,
                  })),
                  'not_found',
                );
              }
              return commitMissionOnly(
                transitionValue(mission.presentCustomerChoices({
                  expectedRevision: input.expectedMissionRevision,
                  decisionId: resolved.value.decisionId,
                  candidates,
                  occurredAt: now,
                })),
                'presented',
              );
            }
            customerId = resolved.value.customerId;
            const presented = mission.payload.decision;
            const existingCandidate = presented?.kind === 'customer'
              ? presented.candidates.find(
                  (candidate) => candidate.customerId === customerId,
                )
              : undefined;
            if (presented?.kind === 'customer' && existingCandidate !== undefined) {
              resolvedPresentedChoice = {
                decisionId: presented.decisionId,
                choiceSetRevision: presented.choiceSetRevision,
                choiceId: existingCandidate.choiceId,
              };
            }
          } else {
            customerId = customerIdForDecision(mission, parsedDecision.value);
          }
          const customer = await transaction.customers.findById({
            companyId: owner.companyId,
            customerId,
          });
          if (
            customer !== null
            && (
              !isCanonicalCustomerCandidateReference(customer)
              || customer.customerId !== customerId
            )
          ) {
            abort({
              kind: 'dependency',
              port: 'customer_candidate_search',
              cause: 'invalid_customer_read',
            });
          }
          if (customer === null) {
            if (parsedDecision.value.action === 'resolve_customer_reference') {
              return commitMissionOnly(
                transitionValue(mission.recordCustomerNotFound({
                  expectedRevision: input.expectedMissionRevision,
                  result: 'none',
                  occurredAt: now,
                })),
                'not_found',
              );
            }
            if (parsedDecision.value.action === 'select_screen_customer') {
              abort(appConflict('agent_mission_customer', 'unavailable'));
            }
            const fingerprint = requireAgentMissionFingerprint(
              this.deps.fingerprints,
              canonical,
            );
            if (!fingerprint.ok) abort(fingerprint.error);
            const invalidated = invalidationValue(mission.invalidateCustomerDecision({
              expectedRevision: input.expectedMissionRevision,
              reason: 'candidate_unavailable',
              occurredAt: now,
            }));
            const updated = await transaction.missions.updateCas({
              mission: invalidated.mission,
              expectedRevision: mission.revision,
            });
            if (updated !== 'updated') {
              abort(appConflict('agent_mission', 'stale_revision'));
            }
            const reference = draftReference(slot);
            const event = recordAgentMissionEvent({
              owner,
              transition: invalidated,
              actor: input.origin.actor,
              commandId: input.commandId,
              fingerprint: fingerprint.value,
              ids: this.deps.ids,
              draftBefore: reference,
              draftAfter: reference,
              ...(correlation === undefined ? {} : { correlation }),
            });
            if (!event.ok) abort(event.error);
            await transaction.events.append(event.value);
            const view = toAgentMissionView(invalidated.mission, now);
            if (!view.ok) abort(view.error);
            return {
              outcome: 'invalidated',
              effect: {
                kind: 'invalidated',
                reason: 'candidate_unavailable',
              },
              mission: view.value,
            } satisfies DecideQuoteAgentMissionOutput;
          }

          const payload = applyQuoteDraftCustomerSelection(slot.payload, {
            id: customer.customerId,
            name: customer.canonicalName,
          });
          if (!payload.ok) {
            abort({
              kind: 'dependency',
              port: 'agent_mission_quote_draft',
              cause: `${payload.error.code}:${payload.error.path}`,
            });
          }
          const expectedDraftAfter = {
            sessionId: slot.payload.draft.sessionId,
            slotRevision: slot.revision + 1,
            contentRevision: slot.payload.draft.contentRevision + 1,
          };
          const selectedPresentedChoice =
            parsedDecision.value.action === 'choose_presented_option'
              ? {
                  decisionId: parsedDecision.value.decisionId,
                  choiceSetRevision: parsedDecision.value.choiceSetRevision,
                  choiceId: parsedDecision.value.choiceId,
                }
              : resolvedPresentedChoice;
          const transition = transitionValue(mission.selectCustomer(
            selectedPresentedChoice !== null
              ? {
                  expectedRevision: input.expectedMissionRevision,
                  source: 'presented_choice',
                  customerId: customer.customerId,
                  updatedDraft: expectedDraftAfter,
                  decisionId: selectedPresentedChoice.decisionId,
                  choiceSetRevision: selectedPresentedChoice.choiceSetRevision,
                  choiceId: selectedPresentedChoice.choiceId,
                  occurredAt: now,
                }
              : parsedDecision.value.action === 'select_screen_customer'
                ? {
                  expectedRevision: input.expectedMissionRevision,
                  source: 'screen_selection',
                  customerId: customer.customerId,
                  updatedDraft: expectedDraftAfter,
                  occurredAt: now,
                  }
                : {
                    expectedRevision: input.expectedMissionRevision,
                    source: 'exact_match',
                    customerId: customer.customerId,
                    updatedDraft: expectedDraftAfter,
                    occurredAt: now,
                  },
          ));
          const selected = await transaction.quoteDrafts.selectCustomerCas({
            ...owner,
            missionId: mission.id,
            expectedSlotRevision: slot.revision,
            expectedDraftSessionId: slot.payload.draft.sessionId,
            expectedDraftContentRevision: slot.payload.draft.contentRevision,
            payload: payload.value,
          });
          if (selected === null) {
            abort(appConflict('agent_mission_quote_draft', 'stale_revision'));
          }
          const selectedReference = draftReference(selected);
          if (
            selectedReference.sessionId !== expectedDraftAfter.sessionId
            || selectedReference.slotRevision !== expectedDraftAfter.slotRevision
            || selectedReference.contentRevision !== expectedDraftAfter.contentRevision
          ) {
            abort({
              kind: 'dependency',
              port: 'agent_mission_quote_draft',
              cause: 'invalid_customer_selection_write',
            });
          }
          const updated = await transaction.missions.updateCas({
            mission: transition.mission,
            expectedRevision: mission.revision,
          });
          if (updated !== 'updated') {
            abort(appConflict('agent_mission', 'stale_revision'));
          }
          const fingerprint = requireAgentMissionFingerprint(
            this.deps.fingerprints,
            canonical,
          );
          if (!fingerprint.ok) abort(fingerprint.error);
          const event = recordAgentMissionEvent({
            owner,
            transition,
            actor: input.origin.actor,
            commandId: input.commandId,
            fingerprint: fingerprint.value,
            ids: this.deps.ids,
            draftBefore: draftReference(slot),
            draftAfter: selectedReference,
            ...(correlation === undefined ? {} : { correlation }),
          });
          if (!event.ok) abort(event.error);
          await transaction.events.append(event.value);
          const view = toAgentMissionView(transition.mission, now);
          if (!view.ok) abort(view.error);
          return {
            outcome: 'selected',
            effect: { kind: 'selected' },
            mission: view.value,
          } satisfies DecideQuoteAgentMissionOutput;
        },
      );
      if (execution.status === 'company_unavailable') {
        return err(unavailableAgentMissionCompany(execution.reason));
      }
      if (execution.status === 'foreground_unavailable') {
        return err(unavailableAgentMissionForeground(execution.reason));
      }
      if (execution.status === 'capability_rejected') {
        return err(rejectedAgentMissionCapability(execution.reason));
      }
      if ('kind' in execution.value) {
        return err(appGone('agent_mission', execution.value.reason));
      }
      return ok(execution.value);
    } catch (cause) {
      if (cause instanceof DecideQuoteAgentMissionAbort) return err(cause.appError);
      throw cause;
    }
  }
}
