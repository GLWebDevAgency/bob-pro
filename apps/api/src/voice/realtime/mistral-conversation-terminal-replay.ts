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
import type { MistralConversationBootstrapTicketAuthority } from './mistral-conversation-bootstrap-ticket';
import type { MistralConversationAdmissionAuthority } from './mistral-conversation-admission';
import type { MistralConversationReaperTerminationAuthority } from './mistral-conversation-reaper-termination';
import type { MistralConversationResumeAuthority } from './mistral-conversation-resume-ticket';

/**
 * Les deux autorités partagent impérativement la même connexion Prisma et le même agrégat
 * durable. Le resume HTTP et le redeem WSS ne doivent jamais être composés sur deux stores.
 */
export interface MistralConversationTerminalReplayAuthorities {
  readonly durable: MistralConversationDurableAuthority;
  readonly resume: MistralConversationResumeAuthority;
  readonly initialBootstrap: MistralConversationBootstrapTicketAuthority | null;
  readonly admission: MistralConversationAdmissionAuthority;
  readonly termination: MistralConversationReaperTerminationAuthority;
  /** Admission de boot durable : doit réussir avant d'exposer le runtime au gateway. */
  readonly assertCurrentKeyVersion: () => Promise<void>;
}

/** Contrat minimal consommé par l'API avant toute annonce ou émission d'une route v2 live. */
export interface MistralConversationRuntimeCapability {
  readonly liveTurnsAvailable: boolean;
}

export interface MistralConversationTerminalReplayRuntime
extends MistralConversationRuntimeCapability {
  /** Un runtime de replay terminal ne doit jamais être annoncé comme une route live. */
  readonly liveTurnsAvailable: false;
  readonly resume: MistralConversationResumeAuthority;
  readonly initialBootstrap: MistralConversationBootstrapTicketAuthority | null;
  readonly termination: MistralConversationReaperTerminationAuthority;
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
  redeemAndOpenInitial: async () => ({ status: 'unavailable' as const }),
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

function terminalReplayOnlyResumeAuthority(
  authority: MistralConversationResumeAuthority,
): MistralConversationResumeAuthority {
  const wrapped: MistralConversationResumeAuthority = {
    issue: async (input: Parameters<MistralConversationResumeAuthority['issue']>[0]) => {
      const result = await authority.issue(input);
      return result.status === 'issued' && result.bootstrap.scope !== 'terminal_replay'
        ? { status: 'unavailable' as const }
        : result;
    },
    // Une ambiguïté de bootstrap initial ne peut produire que retry_initial/live_takeover :
    // aucun de ces deux chemins n'est sûr sans provider et pipeline live attestés.
    reconcileInitialBootstrap: async () => ({ status: 'unavailable' as const }),
    redeemAndOpen: async (
      input: Parameters<MistralConversationResumeAuthority['redeemAndOpen']>[0],
    ) => {
      if (input.expectedScope !== 'terminal_replay') return { status: 'unavailable' as const };
      const result = await authority.redeemAndOpen(input);
      return result.status === 'live_takeover' ? { status: 'unavailable' as const } : result;
    },
    acknowledgeTerminal: (
      input: Parameters<MistralConversationResumeAuthority['acknowledgeTerminal']>[0],
    ) => authority.acknowledgeTerminal(input),
  };
  return Object.freeze(wrapped);
}

/**
 * Composition étroite du canary v2 : les fonctions live existent pour satisfaire le contrat du
 * noyau, mais chacune échoue fermée. Un ticket `terminal_replay` peut franchir l'authentification ;
 * l'unique exception live est la réconciliation initiale attestée en BDD, limitée au shell sans
 * fournisseur ni action métier.
 */
export function createMistralConversationTerminalReplayRuntime(
  authorities: Pick<
  MistralConversationTerminalReplayAuthorities,
  'durable' | 'resume' | 'initialBootstrap'
  | 'admission' | 'termination'
  >,
): MistralConversationTerminalReplayRuntime {
  if (
    !authorities
    || typeof authorities.durable?.open !== 'function'
    || typeof authorities.durable.transition !== 'function'
    || typeof authorities.resume?.issue !== 'function'
    || typeof authorities.resume.reconcileInitialBootstrap !== 'function'
    || typeof authorities.resume.redeemAndOpen !== 'function'
    || typeof authorities.resume.acknowledgeTerminal !== 'function'
    || typeof authorities.admission?.renewOwner !== 'function'
    || typeof authorities.admission.releaseClosed !== 'function'
    || typeof authorities.termination?.terminateReaping !== 'function'
  ) throw new Error('Mistral conversation terminal replay authorities are unavailable.');

  const terminalResume = terminalReplayOnlyResumeAuthority(authorities.resume);
  return Object.freeze({
    liveTurnsAvailable: false as const,
    resume: terminalResume,
    initialBootstrap: null,
    termination: authorities.termination,
    gatewayDependencies: Object.freeze({
      bootstrap: terminalReplayOnlyBootstrap,
      resume: terminalResume,
      authority: authorities.durable,
      context: terminalReplayOnlyContext,
      provider: terminalReplayOnlyProvider,
      pipeline: terminalReplayOnlyPipeline,
      admission: authorities.admission,
    }),
  });
}
