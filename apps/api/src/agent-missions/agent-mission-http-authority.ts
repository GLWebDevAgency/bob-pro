import type { Provider } from '@nestjs/common';
import {
  appForbidden,
  appUnavailable,
  err,
  ok,
  type AgentMissionOwner,
  type AgentMissionRealtimeAuthorityProof,
  type AppError,
  type Result,
} from '@bob/core';
import { loadEnv } from '../config/env';
import { getPrincipal } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import {
  agentMissionPrincipalBindingHash,
} from '../voice/realtime/realtime-agent-mission-admission';
import {
  hashRealtimeAgentMissionCapability,
  isRealtimeAgentMissionCapability,
} from '../voice/realtime/realtime-agent-mission-negotiation';
import { isRealtimeCompanyId } from '../voice/realtime/realtime-admission';
import {
  realtimeSubjectBindings,
} from '../voice/realtime/realtime-principal-binding';
import { REALTIME_VOICE_SETTINGS } from '../voice/realtime/realtime.tokens';
import type { RealtimeVoiceSettings } from '../voice/realtime/realtime.types';

export const AGENT_MISSION_HTTP_AUTHORITY = Symbol('AGENT_MISSION_HTTP_AUTHORITY');

export type AgentMissionHttpOperation =
  | 'get_current_quote_creation'
  | 'start_quote_creation'
  | 'acknowledge_quote_screen'
  | 'cancel_quote_creation';

export type AgentMissionCapabilityMetricOperation =
  | 'get'
  | 'start'
  | 'cancel'
  | 'screen_ack';

export function agentMissionCapabilityMetricOperation(
  operation: AgentMissionHttpOperation,
): AgentMissionCapabilityMetricOperation {
  switch (operation) {
    case 'get_current_quote_creation': return 'get';
    case 'start_quote_creation': return 'start';
    case 'cancel_quote_creation': return 'cancel';
    case 'acknowledge_quote_screen': return 'screen_ack';
  }
}

export interface AgentMissionHttpAuthorization {
  readonly operation: AgentMissionHttpOperation;
  readonly owner: AgentMissionOwner;
  readonly proof: AgentMissionRealtimeAuthorityProof;
}

export interface AgentMissionHttpAuthority {
  prepare(
    operation: AgentMissionHttpOperation,
    presentedCapability: unknown,
  ): Result<AgentMissionHttpAuthorization, AppError>;
}

function validOwnerUserId(value: string): boolean {
  return value.length >= 1
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= 512
    && !value.includes('\u0000');
}

export class DurableAgentMissionHttpAuthority implements AgentMissionHttpAuthority {
  constructor(
    private readonly settings: RealtimeVoiceSettings,
    private readonly metrics: Pick<Metrics, 'agentMissionCapabilityRejections'>,
  ) {}

  prepare(
    operation: AgentMissionHttpOperation,
    presentedCapability: unknown,
  ): Result<AgentMissionHttpAuthorization, AppError> {
    const principal = getPrincipal();
    if (
      principal === undefined
      || principal.companyId === null
      || !isRealtimeCompanyId(principal.companyId)
      || typeof principal.userId !== 'string'
      || !validOwnerUserId(principal.userId)
    ) {
      return err(appForbidden('authenticated_agent_mission_owner_required'));
    }
    if (!isRealtimeAgentMissionCapability(presentedCapability)) {
      this.metrics.agentMissionCapabilityRejections.inc({
        operation: agentMissionCapabilityMetricOperation(operation),
        reason: presentedCapability === undefined ? 'missing' : 'malformed',
      });
      return err(appForbidden('agent_mission_capability_invalid'));
    }
    const bindings = realtimeSubjectBindings(
      this.settings,
      principal.companyId,
      principal.userId,
    );
    if (bindings === null) {
      return err(appUnavailable('agent_mission_http_capability'));
    }
    return ok(Object.freeze({
      operation,
      owner: Object.freeze({
        companyId: principal.companyId,
        ownerUserId: principal.userId,
      }),
      proof: Object.freeze({
        subjectHashCandidates: Object.freeze([
          bindings.subjectHash,
          ...bindings.historicalSubjectBindings.map((binding) => binding.subjectHash),
        ]),
        principalBindingHash: agentMissionPrincipalBindingHash(
          principal.companyId,
          principal.userId,
        ),
        capabilityHash: hashRealtimeAgentMissionCapability(presentedCapability),
      }),
    }));
  }
}

export class DisabledAgentMissionHttpAuthority implements AgentMissionHttpAuthority {
  prepare(
    _operation: AgentMissionHttpOperation,
    _presentedCapability: unknown,
  ): Result<AgentMissionHttpAuthorization, AppError> {
    return err(appUnavailable('agent_mission_http_capability'));
  }
}

export const agentMissionHttpAuthorityProvider: Provider = {
  provide: AGENT_MISSION_HTTP_AUTHORITY,
  inject: [REALTIME_VOICE_SETTINGS, Metrics],
  useFactory: (settings: RealtimeVoiceSettings, metrics: Metrics) => (
    loadEnv().BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED === 'true'
      ? new DurableAgentMissionHttpAuthority(settings, metrics)
      : new DisabledAgentMissionHttpAuthority()
  ),
};
