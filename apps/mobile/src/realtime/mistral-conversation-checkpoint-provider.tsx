import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { useAuth } from '../data/auth';
import { companyIdFromAppMetadata } from '../data/tenant-identity';
import {
  createNativeMistralConversationCheckpointStore,
} from './mistral-conversation-checkpoint-store';
import type { MistralConversationCheckpointBinding } from './mistral-conversation-runtime';

interface PublishedBinding {
  readonly identityKey: string;
  readonly identity: MistralConversationCheckpointBinding['fence']['identity'];
  readonly binding: MistralConversationCheckpointBinding;
}

const CheckpointBindingContext = createContext<MistralConversationCheckpointBinding | null>(null);
const CheckpointRecoveryRetryContext = createContext<(() => void) | null>(null);
const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 8;
const RECOVERY_RETRY_BASE_MS = 500;
const RECOVERY_RETRY_MAX_MS = 30_000;

function recoveryRetryDelayMs(failedAttempt: number): number {
  return Math.min(
    RECOVERY_RETRY_MAX_MS,
    RECOVERY_RETRY_BASE_MS * 2 ** Math.max(0, failedAttempt - 1),
  );
}

function sameIdentity(
  left: MistralConversationCheckpointBinding['fence']['identity'],
  right: MistralConversationCheckpointBinding['fence']['identity'],
): boolean {
  return left.subjectId === right.subjectId && left.companyId === right.companyId;
}

function checkpointStoreErrorCode(error: unknown): string | null {
  if (
    !(error instanceof Error)
    || error.name !== 'MistralConversationCheckpointStoreError'
    || !('code' in error)
    || typeof error.code !== 'string'
  ) return null;
  return error.code;
}

async function purgeBindingForAuthBoundary(
  binding: MistralConversationCheckpointBinding,
): Promise<void> {
  try {
    await binding.store.purgeForAuthBoundary(binding.fence);
  } catch (error) {
    if (checkpointStoreErrorCode(error) !== 'terminal_clear_in_progress') throw error;

    // La preuve terminale a déjà été validée et verrouillée par le store avant son premier I/O.
    // Lors d'un logout/switch, on doit achever cette suppression avec l'ANCIENNE fence avant de
    // purger le slot et d'activer le nouvel owner. Aucune requête réseau sous la nouvelle identité
    // n'est autorisée à reconstruire ou remplacer cette preuve.
    await binding.store.retryInterruptedTerminalClear(binding.fence);
    await binding.store.purgeForAuthBoundary(binding.fence);
  }
}

/**
 * Frontière auth LOCALE du checkpoint terminal Mistral v2.
 *
 * Elle reste montée au-dessus d'AuthGate : logout/switch purge et invalide l'ancien owner avant
 * d'en activer un autre. Elle ne lit et ne reprend JAMAIS le checkpoint réseau : seul
 * `MistralConversationTransport.connect()`, construit après la négociation serveur autoritaire,
 * peut le drainer. Un compte OpenAI conserve donc au plus une fence locale inerte et n'émet
 * aucune requête ni aucun socket Mistral.
 */
export function MistralConversationCheckpointProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { enabled, session } = useAuth();
  const companyId = enabled && session
    ? companyIdFromAppMetadata(session.user.app_metadata)
    : null;
  const subjectId = enabled && session ? session.user.id : null;
  const identity = useMemo(
    () => subjectId !== null && companyId !== null
      ? Object.freeze({ subjectId, companyId })
      : null,
    [companyId, subjectId],
  );
  const identityKey = identity === null ? null : `${identity.subjectId}\u0000${identity.companyId}`;
  const storeRef = useRef(createNativeMistralConversationCheckpointStore());
  const activeBindingRef = useRef<MistralConversationCheckpointBinding | null>(null);
  const operationTailRef = useRef<Promise<void>>(Promise.resolve());
  const transitionRef = useRef(0);
  const recoveryAbortRef = useRef<AbortController | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const [published, setPublished] = useState<PublishedBinding | null>(null);

  const retryRecovery = useCallback((): void => {
    if (identityKey === null) return;
    recoveryAbortRef.current?.abort();
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    retryCountRef.current = 0;
    setPublished(null);
    setRetryRevision((value) => value + 1);
  }, [identityKey]);

  useEffect(() => {
    const transition = ++transitionRef.current;
    recoveryAbortRef.current?.abort();
    const recoveryAbort = new AbortController();
    recoveryAbortRef.current = recoveryAbort;
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;

    const scheduleRetry = (): void => {
      if (transitionRef.current !== transition || recoveryAbort.signal.aborted) return;
      setPublished(null);
      retryCountRef.current += 1;
      if (retryCountRef.current >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) return;
      const delayMs = recoveryRetryDelayMs(retryCountRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        setRetryRevision((value) => value + 1);
      }, delayMs);
    };

    operationTailRef.current = operationTailRef.current
      .catch(() => undefined)
      .then(async () => {
        let binding = activeBindingRef.current;
        if (binding === null) {
          const store = storeRef.current;
          const inheritedFence = store.activeOwnerFence();
          if (inheritedFence !== null) {
            // Hot reload/remount React ne recree pas le singleton natif. Reprendre sa capability
            // permet de la purger avant B au lieu de boucler sur auth_boundary_purge_required.
            binding = Object.freeze({ store, fence: inheritedFence });
            activeBindingRef.current = binding;
          }
        }
        if (binding !== null && (identity === null || !sameIdentity(binding.fence.identity, identity))) {
          // Conserver la fence tant que la purge + désactivation ne sont pas toutes deux
          // attestées. La perdre sur une panne SecureStore rendrait le coordinateur natif
          // irrécupérable jusqu'au redémarrage et empêcherait toute activation du tenant suivant.
          await purgeBindingForAuthBoundary(binding);
          binding.store.deactivateOwner(binding.fence);
          if (activeBindingRef.current === binding) activeBindingRef.current = null;
          binding = null;
        }
        if (identity === null || identityKey === null || recoveryAbort.signal.aborted) return;
        if (binding === null) {
          const store = storeRef.current;
          binding = Object.freeze({ store, fence: store.activateOwner(identity) });
          activeBindingRef.current = binding;
          retryCountRef.current = 0;
        }

        if (
          transitionRef.current !== transition
          || recoveryAbort.signal.aborted
          || activeBindingRef.current !== binding
        ) return;
        retryCountRef.current = 0;
        setPublished(Object.freeze({ identityKey, identity, binding }));
      })
      .catch(() => {
        scheduleRetry();
      });

    return () => {
      recoveryAbort.abort();
      if (recoveryAbortRef.current === recoveryAbort) recoveryAbortRef.current = null;
      if (transitionRef.current === transition) transitionRef.current += 1;
    };
  }, [identity, identityKey, retryRevision]);

  useEffect(() => {
    if (identityKey === null || published?.identityKey === identityKey) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      // Un retour au premier plan réarme uniquement la frontière SecureStore locale. La reprise
      // réseau reste enfermée dans le transport Mistral V2 après négociation.
      if (state === 'active') retryRecovery();
    });
    return () => subscription.remove();
  }, [identityKey, published?.identityKey, retryRecovery]);

  useEffect(() => () => {
    transitionRef.current += 1;
    recoveryAbortRef.current?.abort();
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
  }, []);

  const value = useMemo(
    () => published !== null
      && published.identityKey === identityKey
      && published.identity === identity
      ? published.binding
      : null,
    [identity, identityKey, published],
  );
  return (
    <CheckpointRecoveryRetryContext.Provider value={retryRecovery}>
      <CheckpointBindingContext.Provider value={value}>
        {children}
      </CheckpointBindingContext.Provider>
    </CheckpointRecoveryRetryContext.Provider>
  );
}

export function useMistralConversationCheckpointBinding(
): MistralConversationCheckpointBinding | null {
  return useContext(CheckpointBindingContext);
}

/** Retry explicite (tap Bob / CTA erreur), en plus du rearmement au retour foreground. */
export function useRetryMistralConversationCheckpointRecovery(): (() => void) | null {
  return useContext(CheckpointRecoveryRetryContext);
}
