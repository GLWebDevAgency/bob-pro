export type NativeSpeechErrorDisposition =
  | 'ignore'
  | 'denied'
  | 'unavailable'
  | 'failed';

export interface NativeSpeechErrorEventLike {
  readonly error?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

export interface NativeSpeechErrorDecision {
  readonly disposition: NativeSpeechErrorDisposition;
  readonly errorCode: string;
  readonly nativeCode: number | null;
}

export interface PrivateNativeSpeechCapability {
  readonly platform: string;
  readonly platformVersion: unknown;
  readonly supportsOnDeviceRecognition: boolean;
  readonly installedLocales: readonly string[];
  readonly requestedLocale: string;
}

function canonicalSpeechLocale(locale: string): string {
  return locale.trim().replaceAll('_', '-').toLowerCase();
}

/**
 * Autorité fail-closed avant permission/capture. Android ne possède un recognizer strictement
 * on-device qu'à partir de l'API 33 ; avant, `EXTRA_PREFER_OFFLINE` peut être ignoré.
 */
export function supportsPrivateNativeSpeech(
  capability: PrivateNativeSpeechCapability,
): boolean {
  if (!capability.supportsOnDeviceRecognition) return false;
  if (capability.platform === 'android') {
    if (
      typeof capability.platformVersion !== 'number'
      || !Number.isInteger(capability.platformVersion)
      || capability.platformVersion < 33
    ) return false;
  } else if (capability.platform !== 'ios') {
    return false;
  }
  const requested = canonicalSpeechLocale(capability.requestedLocale);
  return requested !== '' && capability.installedLocales.some(
    (locale) => canonicalSpeechLocale(locale) === requested,
  );
}

const SILENT_ERROR_CODES = new Set(['aborted', 'no-speech', 'speech-timeout']);
const UNAVAILABLE_ERROR_CODES = new Set([
  'audio-capture',
  'interrupted',
  'language-not-supported',
  'busy',
]);
const FAILED_ERROR_CODES = new Set([
  'network',
  'bad-grammar',
  'client',
  'unknown',
  // Android peut l'émettre alors que l'union TypeScript de la version 56.0.1 l'omet.
  'too-many-requests',
]);
const KNOWN_ERROR_CODES = new Set([
  ...SILENT_ERROR_CODES,
  ...UNAVAILABLE_ERROR_CODES,
  ...FAILED_ERROR_CODES,
  'not-allowed',
  'service-not-allowed',
]);

/**
 * Classe une erreur native sans dépendre de son message libre, variable selon OS et moteur.
 * Une valeur future reste visible comme panne au lieu de disparaître silencieusement.
 */
export function classifyNativeSpeechError(
  event: NativeSpeechErrorEventLike,
): NativeSpeechErrorDecision {
  const candidate =
    typeof event.error === 'string' ? event.error.trim().toLowerCase() || 'unknown' : 'unknown';
  // Le bridge actuel expose un enum, mais un futur moteur peut injecter un message libre dans
  // `error`. Aucun texte potentiellement sensible ne traverse donc le diagnostic normalisé.
  const errorCode = KNOWN_ERROR_CODES.has(candidate) ? candidate : 'unknown';
  const nativeCode =
    typeof event.code === 'number' && Number.isSafeInteger(event.code) ? event.code : null;

  if (SILENT_ERROR_CODES.has(errorCode)) {
    return Object.freeze({ disposition: 'ignore', errorCode, nativeCode });
  }
  if (errorCode === 'not-allowed' || (errorCode === 'service-not-allowed' && nativeCode === 9)) {
    return Object.freeze({ disposition: 'denied', errorCode, nativeCode });
  }
  if (errorCode === 'service-not-allowed' || UNAVAILABLE_ERROR_CODES.has(errorCode)) {
    return Object.freeze({ disposition: 'unavailable', errorCode, nativeCode });
  }
  if (FAILED_ERROR_CODES.has(errorCode)) {
    return Object.freeze({ disposition: 'failed', errorCode, nativeCode });
  }
  return Object.freeze({ disposition: 'failed', errorCode, nativeCode });
}

export type NativeSpeechTerminalState = 'open' | 'cancelled' | 'final' | 'silent' | 'issue';
export type NativeSpeechLifecycle = 'arming' | 'starting' | 'started' | 'ended';
export type NativeSpeechCommand = 'none' | 'stop' | 'abort';

export interface NativeSpeechTerminalFence {
  readonly generation: number;
  readonly state: NativeSpeechTerminalState;
  readonly lifecycle: NativeSpeechLifecycle;
  /** Dernière commande demandée ; `abort` est l'unique promotion possible après `stop`. */
  readonly command: NativeSpeechCommand;
  /** Empêche deux appels au singleton natif pour la même commande/génération. */
  readonly commandDispatched: boolean;
}

export type NativeSpeechTerminalEvent =
  | 'start'
  | 'native_active'
  | 'abort_completed'
  | 'start_requested'
  | 'stop_requested'
  | 'end'
  | 'grace_expired'
  | 'cancel_requested'
  | 'aborted'
  | 'silence'
  | 'final'
  | 'issue';

export type NativeSpeechTerminalEffect = 'none' | 'transcript' | 'silence' | 'issue';

export interface NativeSpeechTerminalTransition {
  readonly next: NativeSpeechTerminalFence;
  readonly changed: boolean;
  readonly effect: NativeSpeechTerminalEffect;
  /** Commande à envoyer maintenant ; `none` signifie qu'elle reste différée ou déjà envoyée. */
  readonly command: NativeSpeechCommand;
}

export function openNativeSpeechTerminal(generation: number): NativeSpeechTerminalFence {
  return Object.freeze({
    generation,
    state: 'open',
    lifecycle: 'arming',
    command: 'none',
    commandDispatched: false,
  });
}

/**
 * Fence exactement-une-fois du cycle ET des commandes. Le contrat Expo 56.0.1 garantit que
 * `end` est le dernier événement natif ; Bob conserve pourtant une courte grâce JS avant de
 * libérer le lease, afin d'absorber une livraison bridge tardive déjà observée sur le terrain.
 *
 * `stop`/`abort` demandés pendant `arming` restent différés jusqu'au `start` natif. Cela ferme la
 * course iOS entre les Tasks non structurées de `start()` et `abort()`.
 */
export function advanceNativeSpeechTerminal(
  current: NativeSpeechTerminalFence,
  generation: number,
  event: NativeSpeechTerminalEvent,
): NativeSpeechTerminalTransition {
  const unchanged = (): NativeSpeechTerminalTransition => Object.freeze({
    next: current,
    changed: false,
    effect: 'none',
    command: 'none',
  });
  if (current.generation !== generation) return unchanged();

  if (
    event === 'start'
    || event === 'native_active'
  ) {
    if (current.lifecycle !== 'arming' && current.lifecycle !== 'starting') return unchanged();
    const command = current.command !== 'none' && !current.commandDispatched
      ? current.command
      : 'none';
    return Object.freeze({
      next: Object.freeze({
        ...current,
        lifecycle: 'started',
        commandDispatched: command !== 'none' ? true : current.commandDispatched,
      }),
      changed: true,
      effect: 'none',
      command,
    });
  }

  if (event === 'start_requested') {
    if (current.lifecycle !== 'arming') return unchanged();
    return Object.freeze({
      next: Object.freeze({ ...current, lifecycle: 'starting' }),
      changed: true,
      effect: 'none',
      command: 'none',
    });
  }

  if (event === 'end') {
    if (current.lifecycle === 'ended') return unchanged();
    return Object.freeze({
      next: Object.freeze({ ...current, lifecycle: 'ended' }),
      changed: true,
      effect: 'none',
      command: 'none',
    });
  }

  if (event === 'abort_completed') {
    if (current.lifecycle === 'ended' || current.command !== 'abort') return unchanged();
    return Object.freeze({
      next: Object.freeze({
        ...current,
        state: current.state === 'open' ? 'cancelled' : current.state,
        lifecycle: 'ended',
        commandDispatched: true,
      }),
      changed: true,
      effect: 'none',
      command: 'none',
    });
  }

  if (event === 'stop_requested') {
    if (current.command !== 'none') return unchanged();
    const dispatchNow = current.lifecycle === 'started';
    return Object.freeze({
      next: Object.freeze({
        ...current,
        command: 'stop',
        commandDispatched: dispatchNow,
      }),
      changed: true,
      effect: 'none',
      command: dispatchNow ? 'stop' : 'none',
    });
  }

  if (event === 'cancel_requested') {
    const commandChanged = current.command !== 'abort';
    const terminalChanged = current.state === 'open';
    if (!commandChanged && !terminalChanged) return unchanged();
    // Après `start_requested`, seul le barrier natif `abortAndWaitAsync` peut conclure la
    // commande. Il invalide d'abord le start en attente, puis résout après le reset natif.
    const dispatchNow = commandChanged
      && (current.lifecycle === 'starting' || current.lifecycle === 'started');
    return Object.freeze({
      next: Object.freeze({
        ...current,
        state: terminalChanged ? 'cancelled' : current.state,
        command: 'abort',
        commandDispatched: commandChanged ? dispatchNow : current.commandDispatched,
      }),
      changed: true,
      effect: 'none',
      command: dispatchNow ? 'abort' : 'none',
    });
  }

  if (event === 'grace_expired') {
    if (current.lifecycle !== 'ended' || current.state !== 'open') return unchanged();
    return Object.freeze({
      next: Object.freeze({ ...current, state: 'silent' }),
      changed: true,
      effect: 'silence',
      command: 'none',
    });
  }

  if (current.state !== 'open') return unchanged();

  const state: NativeSpeechTerminalState =
    event === 'aborted'
      ? 'cancelled'
      : event === 'silence'
        ? 'silent'
        : event === 'final'
          ? 'final'
          : 'issue';
  const effect: NativeSpeechTerminalEffect =
    state === 'final'
      ? 'transcript'
      : state === 'silent'
        ? 'silence'
        : state === 'issue'
          ? 'issue'
          : 'none';
  return Object.freeze({
    next: Object.freeze({ ...current, state }),
    changed: true,
    effect,
    command: 'none',
  });
}

export function terminalEventForNativeSpeechError(
  decision: NativeSpeechErrorDecision,
): Extract<NativeSpeechTerminalEvent, 'aborted' | 'silence' | 'issue'> {
  if (decision.errorCode === 'aborted') return 'aborted';
  if (decision.errorCode === 'no-speech' || decision.errorCode === 'speech-timeout') {
    return 'silence';
  }
  return 'issue';
}
