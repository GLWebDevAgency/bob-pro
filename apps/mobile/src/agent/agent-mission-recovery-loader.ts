import type {
  AppError,
  QuoteAgentMissionResumeView,
  QuoteAgentMissionResumeViewV2,
  Result,
} from '@bob/core';
import type { QuoteAgentMissionRecoveryView } from './agent-mission-recovery-state';

export interface QuoteAgentMissionRecoveryClient {
  getCurrentQuoteAgentMissionResume(
    signal?: AbortSignal,
  ): Promise<Result<QuoteAgentMissionResumeView, AppError>>;
  getCurrentQuoteAgentMissionResumeV2(
    signal?: AbortSignal,
  ): Promise<Result<QuoteAgentMissionResumeViewV2, AppError>>;
}

function requiresLegacyProtocol(error: AppError): boolean {
  return error.kind === 'conflict'
    && error.entity === 'agent_mission_protocol'
    && error.reason === 'upgrade_required';
}

function normalizeV2(
  value: QuoteAgentMissionResumeViewV2,
): QuoteAgentMissionRecoveryView {
  return value.mission === null
    ? { protocolVersion: null, mission: null, presentation: null }
    : { ...value, protocolVersion: 2 };
}

function normalizeV1(
  value: QuoteAgentMissionResumeView,
): QuoteAgentMissionRecoveryView {
  return value.mission === null
    ? { protocolVersion: null, mission: null, presentation: null }
    : { ...value, protocolVersion: 1, presentation: null };
}

/**
 * Reprise froide versionnée :
 * - V2 est l'unique lecture normale ;
 * - V1 n'est interrogé que si le serveur prouve qu'une mission historique exige ce protocole ;
 * - toute autre erreur échoue fermée, sans masquer une panne par un downgrade.
 */
export async function loadQuoteAgentMissionRecovery(
  client: QuoteAgentMissionRecoveryClient,
  signal?: AbortSignal,
): Promise<QuoteAgentMissionRecoveryView> {
  const current = await client.getCurrentQuoteAgentMissionResumeV2(signal);
  if (current.ok) return normalizeV2(current.value);
  if (!requiresLegacyProtocol(current.error)) throw current.error;

  const legacy = await client.getCurrentQuoteAgentMissionResume(signal);
  if (!legacy.ok) throw legacy.error;
  return normalizeV1(legacy.value);
}
