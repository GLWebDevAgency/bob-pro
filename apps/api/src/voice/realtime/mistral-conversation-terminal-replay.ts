import type { Prisma } from '@prisma/client';
import type {
  MistralConversationBootstrapAuthority,
  MistralConversationBobAuditPipeline,
  MistralConversationContextAuthority,
  MistralConversationDurableAuthority,
  MistralConversationGatewayV2Dependencies,
  MistralConversationProvider,
} from './mistral-conversation-gateway-v2';
import type {
  MistralConversationCompletionInput,
  MistralConversationCompletionResult,
  MistralConversationCompletionTransactionPort,
} from './mistral-conversation-completion';
import type { MistralConversationResumeAuthority } from './mistral-conversation-resume-ticket';

/**
 * Les deux autorités partagent impérativement la même connexion Prisma et le même agrégat
 * durable. Le resume HTTP et le redeem WSS ne doivent jamais être composés sur deux stores.
 */
export interface MistralConversationTerminalReplayAuthorities {
  readonly durable: MistralConversationDurableAuthority;
  readonly resume: MistralConversationResumeAuthority;
  /** Admission de boot durable : doit réussir avant d'exposer le runtime au gateway. */
  readonly assertCurrentKeyVersion: () => Promise<void>;
}

export interface MistralConversationTerminalReplayRuntime {
  readonly resume: MistralConversationResumeAuthority;
  readonly gatewayDependencies: MistralConversationGatewayV2Dependencies;
}

/**
 * La completion live v2 n'est pas encore certifiée. Cet adapter de production refuse donc
 * explicitement toute ouverture d'artefact au lieu de simuler un succès ou une donnée.
 */
export class TerminalReplayOnlyMistralConversationCompletion
implements MistralConversationCompletionTransactionPort {
  async authorizeAndOpen(
    _tx: Prisma.TransactionClient,
    _input: MistralConversationCompletionInput,
  ): Promise<MistralConversationCompletionResult> {
    return { status: 'unavailable' };
  }
}

const terminalReplayOnlyBootstrap: MistralConversationBootstrapAuthority = Object.freeze({
  consume: async () => ({ status: 'unavailable' as const }),
});

const terminalReplayOnlyContext: MistralConversationContextAuthority = Object.freeze({
  authorize: async () => ({ status: 'unavailable' as const }),
});

function terminalReplayOnlyFailure(): never {
  throw new Error('mistral_conversation_terminal_replay_only');
}

const terminalReplayOnlyProvider: MistralConversationProvider = Object.freeze({
  openTurn: async () => terminalReplayOnlyFailure(),
});

const terminalReplayOnlyPipeline: MistralConversationBobAuditPipeline = Object.freeze({
  reason: async () => terminalReplayOnlyFailure(),
  auditAndRender: async () => terminalReplayOnlyFailure(),
  stageDelivery: async () => terminalReplayOnlyFailure(),
});

/**
 * Composition étroite du canary v2 : les fonctions live existent pour satisfaire le contrat du
 * noyau, mais chacune échoue fermée. Seul un ticket `r2_` que `resume` qualifie lui-même de
 * `terminal_replay` peut franchir l'authentification.
 */
export function createMistralConversationTerminalReplayRuntime(
  authorities: Pick<MistralConversationTerminalReplayAuthorities, 'durable' | 'resume'>,
): MistralConversationTerminalReplayRuntime {
  if (
    !authorities
    || typeof authorities.durable?.open !== 'function'
    || typeof authorities.durable.transition !== 'function'
    || typeof authorities.resume?.issue !== 'function'
    || typeof authorities.resume.redeemAndOpen !== 'function'
    || typeof authorities.resume.acknowledgeTerminal !== 'function'
  ) throw new Error('Mistral conversation terminal replay authorities are unavailable.');

  return Object.freeze({
    resume: authorities.resume,
    gatewayDependencies: Object.freeze({
      bootstrap: terminalReplayOnlyBootstrap,
      resume: authorities.resume,
      authority: authorities.durable,
      context: terminalReplayOnlyContext,
      provider: terminalReplayOnlyProvider,
      pipeline: terminalReplayOnlyPipeline,
    }),
  });
}
