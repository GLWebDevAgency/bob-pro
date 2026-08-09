import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (event: Record<string, unknown>) => void;

const speechRuntime = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  abortAndWaitAsync: vi.fn(),
  getStateAsync: vi.fn(),
  getSupportedLocales: vi.fn(),
  supportsOnDeviceRecognition: vi.fn(),
  supportsOnDeviceRecognitionForLocale: vi.fn(),
  requestMicrophonePermissionsAsync: vi.fn(),
}));
const platformRuntime = vi.hoisted(() => ({
  OS: 'ios' as 'ios' | 'android',
  Version: '18.0' as string | number,
}));
const audioRuntime = vi.hoisted(() => ({
  generation: 0,
  current: null as { generation: number; token: string } | null,
  acquire: vi.fn(),
  release: vi.fn(),
}));
const speechOutput = vi.hoisted(() => ({
  speak: vi.fn(),
  stop: vi.fn(),
  isSpeakingAsync: vi.fn(),
  getAvailableVoicesAsync: vi.fn(),
}));
vi.mock('./native-speech-recognition-adapter', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    speechRecognitionAvailable: true,
    nativeSpeechRecognitionModule: {
      start: speechRuntime.start,
      stop: speechRuntime.stop,
      abort: speechRuntime.abort,
      abortAndWaitAsync: speechRuntime.abortAndWaitAsync,
      getStateAsync: speechRuntime.getStateAsync,
      getSupportedLocales: speechRuntime.getSupportedLocales,
      supportsOnDeviceRecognition: speechRuntime.supportsOnDeviceRecognition,
      supportsOnDeviceRecognitionForLocale:
        speechRuntime.supportsOnDeviceRecognitionForLocale,
      requestMicrophonePermissionsAsync: speechRuntime.requestMicrophonePermissionsAsync,
    },
    useNativeSpeechRecognitionEvent: (name: string, listener: Listener) => {
      useEffect(() => {
        speechRuntime.listeners.set(name, listener);
        return () => {
          if (speechRuntime.listeners.get(name) === listener) speechRuntime.listeners.delete(name);
        };
      }, [listener, name]);
    },
    supportsStrictOnDeviceSpeechLocale: (locale: string) =>
      speechRuntime.supportsOnDeviceRecognitionForLocale(locale) === true,
    abortNativeSpeechAndWait: async () => {
      await speechRuntime.abortAndWaitAsync();
      return true;
    },
  };
});
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: platformRuntime,
}));
vi.mock('expo-speech', () => ({
  speak: speechOutput.speak,
  stop: speechOutput.stop,
  getAvailableVoicesAsync: speechOutput.getAvailableVoicesAsync,
  isSpeakingAsync: speechOutput.isSpeakingAsync,
}));
vi.mock('../audio', () => ({
  processAudioSession: {
    acquire: (...args: unknown[]) => audioRuntime.acquire(...args),
    isCurrent: vi.fn((lease: { generation: number; token: string }) =>
      audioRuntime.current?.generation === lease.generation),
    release: audioRuntime.release.mockImplementation((lease: {
      generation: number;
      token: string;
    } | null) => {
      if (lease !== null && audioRuntime.current?.generation === lease.generation) {
        audioRuntime.current = null;
      }
    }),
    withPermissionRequest: vi.fn(async (run: () => Promise<unknown>) => run()),
    permissionRequestInFlight: vi.fn(() => false),
    waitForPermissionRequests: vi.fn(async () => undefined),
  },
}));
vi.mock('./settings', () => ({
  neutralizeLegacyCloudVoiceMode: vi.fn(async () => false),
}));
import {
  useSpeak,
  useVoiceInput,
  type VoiceInputIssue,
  type VoiceOutputOutcome,
} from './voice';

describe('useVoiceInput — cycle natif réel avec emitter contrôlé', () => {
  let renderer: ReactTestRenderer | null = null;
  let voice: ReturnType<typeof useVoiceInput> | null = null;
  let speaker: ReturnType<typeof useSpeak> | null = null;
  let transcripts: string[] = [];
  let issues: VoiceInputIssue[] = [];

  function Probe() {
    voice = useVoiceInput(
      (text) => transcripts.push(text),
      { owner: 'voice-runtime-test', onIssue: (issue) => issues.push(issue) },
    );
    speaker = useSpeak();
    return null;
  }

  const emit = (name: string, event: Record<string, unknown> = {}): void => {
    const listener = speechRuntime.listeners.get(name);
    if (listener === undefined) throw new Error(`listener ${name} absent`);
    listener(event);
  };

  const start = async (ack = true): Promise<void> => {
    await act(async () => {
      await expect(voice!.start()).resolves.toBe(true);
    });
    if (ack) act(() => emit('start'));
  };

  const endAndRelease = async (): Promise<void> => {
    act(() => emit('end'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    speechRuntime.listeners.clear();
    speechRuntime.getStateAsync.mockResolvedValue('inactive');
    speechRuntime.getSupportedLocales.mockResolvedValue({
      locales: ['fr-FR'],
      installedLocales: ['fr-FR'],
    });
    speechRuntime.supportsOnDeviceRecognition.mockReturnValue(true);
    speechRuntime.supportsOnDeviceRecognitionForLocale.mockReturnValue(true);
    speechRuntime.requestMicrophonePermissionsAsync.mockResolvedValue({ granted: true });
    speechRuntime.abortAndWaitAsync.mockImplementation(async () => {
      speechRuntime.abort();
    });
    speechOutput.getAvailableVoicesAsync.mockResolvedValue([{
      identifier: 'fr-local',
      name: 'Français',
      quality: 'Default',
      language: 'fr-FR',
      networkConnectionRequired: false,
      installed: true,
    }]);
    speechOutput.stop.mockResolvedValue(undefined);
    speechOutput.isSpeakingAsync.mockResolvedValue(false);
    platformRuntime.OS = 'ios';
    platformRuntime.Version = '18.0';
    audioRuntime.current = null;
    audioRuntime.acquire.mockImplementation(async () => {
      if (audioRuntime.current !== null) {
        return { ok: false, reason: 'audio_busy' as const };
      }
      audioRuntime.generation += 1;
      const lease = {
        generation: audioRuntime.generation,
        token: `lease-${audioRuntime.generation}`,
      };
      audioRuntime.current = lease;
      return { ok: true, lease };
    });
    transcripts = [];
    issues = [];
    await act(async () => {
      renderer = create(createElement(Probe));
    });
  });

  afterEach(async () => {
    if (audioRuntime.current !== null && speechRuntime.listeners.has('end')) {
      await endAndRelease();
    }
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    vi.useRealTimers();
  });

  it('force le STT local et ne rend le lease qu’après end + grâce', async () => {
    await start();
    expect(speechRuntime.start).toHaveBeenCalledWith(expect.objectContaining({
      lang: 'fr-FR',
      requiresOnDeviceRecognition: true,
    }));
    expect(speechRuntime.requestMicrophonePermissionsAsync).toHaveBeenCalledTimes(1);

    act(() => emit('error', { error: 'network', message: 'secret fournisseur' }));
    expect(issues).toEqual(['failed']);
    expect(audioRuntime.release).not.toHaveBeenCalled();
    act(() => emit('error', { error: 'network', message: 'duplicate' }));
    expect(issues).toEqual(['failed']);
    expect(audioRuntime.release).not.toHaveBeenCalled();

    act(() => emit('end'));
    expect(audioRuntime.release).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(349);
    });
    expect(audioRuntime.release).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(audioRuntime.release).toHaveBeenCalledTimes(1);
  });

  it('accepte une erreur de démarrage, nomatch reste silencieux', async () => {
    await start(false);
    act(() => emit('error', { error: 'not-allowed', message: 'permission text' }));
    expect(issues).toEqual(['denied']);
    await endAndRelease();

    await start();
    act(() => emit('nomatch'));
    expect(issues).toEqual(['denied']);
    expect(transcripts).toEqual([]);
    await endAndRelease();
  });

  it('émet abort une seule fois sur cancel×2 et stop→cancel promeut une fois', async () => {
    await start();
    let firstCancel!: Promise<boolean>;
    let secondCancel!: Promise<boolean>;
    act(() => {
      firstCancel = voice!.cancel();
      secondCancel = voice!.cancel();
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(350);
    });
    await expect(Promise.all([firstCancel, secondCancel])).resolves.toEqual([true, true]);
    expect(speechRuntime.abort).toHaveBeenCalledTimes(1);

    await start();
    await act(async () => voice!.stop());
    let promotedCancel!: Promise<boolean>;
    act(() => { promotedCancel = voice!.cancel(); });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(350);
    });
    await expect(promotedCancel).resolves.toBe(true);
    expect(speechRuntime.stop).toHaveBeenCalledTimes(1);
    expect(speechRuntime.abort).toHaveBeenCalledTimes(2);
  });

  it('sans end ni preuve inactive, garde N en quarantaine et bloque toute libération timer', async () => {
    await start();
    speechRuntime.getStateAsync.mockResolvedValue('recognizing');
    act(() => emit('error', { error: 'network' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(audioRuntime.release).not.toHaveBeenCalled();
    const secondStart = voice!.start();
    let secondStartResult: boolean | null = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      secondStartResult = await secondStart;
    });
    expect(secondStartResult).toBe(false);
    expect(speechRuntime.start).toHaveBeenCalledTimes(1);

    await endAndRelease();
    expect(audioRuntime.release).toHaveBeenCalledTimes(1);
  });

  it('refuse avant toute permission Android < 13 et Android 13 sans modèle fr-FR', async () => {
    platformRuntime.OS = 'android';
    platformRuntime.Version = 32;
    await act(async () => {
      await expect(voice!.start()).resolves.toBe(false);
    });
    expect(issues).toEqual(['unavailable']);
    expect(speechRuntime.requestMicrophonePermissionsAsync).not.toHaveBeenCalled();
    expect(speechRuntime.start).not.toHaveBeenCalled();

    platformRuntime.Version = 33;
    speechRuntime.getSupportedLocales.mockResolvedValue({
      locales: ['fr-FR'],
      installedLocales: [],
    });
    await act(async () => {
      await expect(voice!.start()).resolves.toBe(false);
    });
    expect(issues).toEqual(['unavailable', 'unavailable']);
    expect(speechRuntime.requestMicrophonePermissionsAsync).not.toHaveBeenCalled();
    expect(speechRuntime.start).not.toHaveBeenCalled();
    expect(speechRuntime.getSupportedLocales).toHaveBeenCalledTimes(1);

    await act(async () => {
      await expect(voice!.start()).resolves.toBe(false);
    });
    expect(speechRuntime.getSupportedLocales).toHaveBeenCalledTimes(1);
  });

  it('refuse iOS avant permission quand fr-FR n’a pas de recognizer strictement local', async () => {
    speechRuntime.supportsOnDeviceRecognitionForLocale.mockReturnValue(false);
    await act(async () => {
      await expect(voice!.start()).resolves.toBe(false);
    });
    expect(issues).toEqual(['unavailable']);
    expect(speechRuntime.requestMicrophonePermissionsAsync).not.toHaveBeenCalled();
    expect(speechRuntime.start).not.toHaveBeenCalled();
  });

  it('autorise Android 13 seulement avec le modèle fr-FR installé', async () => {
    platformRuntime.OS = 'android';
    platformRuntime.Version = 33;
    await start();
    expect(speechRuntime.requestMicrophonePermissionsAsync).toHaveBeenCalledTimes(1);
    expect(speechRuntime.start).toHaveBeenCalledWith(expect.objectContaining({
      lang: 'fr-FR',
      requiresOnDeviceRecognition: true,
    }));
    await endAndRelease();
  });

  it('mémorise la preuve locale positive pendant les tours Android successifs', async () => {
    platformRuntime.OS = 'android';
    platformRuntime.Version = 33;
    await start();
    await endAndRelease();
    await start();
    await endAndRelease();
    expect(speechRuntime.getSupportedLocales).toHaveBeenCalledTimes(1);
    expect(speechRuntime.supportsOnDeviceRecognitionForLocale).toHaveBeenCalledTimes(1);
    expect(speechRuntime.start).toHaveBeenCalledTimes(2);
  });

  it('partage un start en vol au lieu d’invalider sa propre génération', async () => {
    let finishCapability!: (value: {
      locales: string[];
      installedLocales: string[];
    }) => void;
    speechRuntime.getSupportedLocales.mockImplementationOnce(() => new Promise((resolve) => {
      finishCapability = resolve;
    }));

    const first = voice!.start();
    await act(async () => { await Promise.resolve(); });
    const second = voice!.start();
    expect(second).toBe(first);
    await act(async () => {
      finishCapability({ locales: ['fr-FR'], installedLocales: ['fr-FR'] });
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    });
    expect(audioRuntime.acquire).toHaveBeenCalledTimes(1);
    expect(speechRuntime.start).toHaveBeenCalledTimes(1);
    await endAndRelease();
  });

  it('ignore un rejet async post-cancel sans repeindre une erreur', async () => {
    let rejectCapability!: (reason: Error) => void;
    speechRuntime.getSupportedLocales.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectCapability = reject;
    }));

    const pending = voice!.start();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await voice!.cancel(); });
    await act(async () => {
      rejectCapability(new Error('late capability failure'));
      await expect(pending).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(issues).toEqual([]);
    expect(speechRuntime.requestMicrophonePermissionsAsync).not.toHaveBeenCalled();
    expect(speechRuntime.start).not.toHaveBeenCalled();
    expect(audioRuntime.release).toHaveBeenCalledTimes(1);
  });

  it('accepte un restart immédiat après cancel sans attendre la continuation périmée', async () => {
    let finishFirstPermission!: (value: { granted: boolean }) => void;
    speechRuntime.requestMicrophonePermissionsAsync.mockImplementationOnce(
      () => new Promise((resolve) => { finishFirstPermission = resolve; }),
    );

    const first = voice!.start();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(speechRuntime.requestMicrophonePermissionsAsync).toHaveBeenCalledTimes(1);
    await act(async () => { await voice!.cancel(); });
    expect(audioRuntime.release).toHaveBeenCalledTimes(1);

    const restarted = voice!.start();
    await act(async () => {
      await expect(restarted).resolves.toBe(true);
    });
    expect(speechRuntime.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirstPermission({ granted: true });
      await expect(first).resolves.toBe(false);
    });
    expect(issues).toEqual([]);
    await endAndRelease();
  });

  it('attend la barrière abort native avant de rendre un start sans ack', async () => {
    let finishAbort!: () => void;
    speechRuntime.abortAndWaitAsync.mockImplementationOnce(() => {
      speechRuntime.abort();
      return new Promise<void>((resolve) => { finishAbort = resolve; });
    });
    await start(false);
    let pendingCancel!: Promise<boolean>;
    act(() => { pendingCancel = voice!.cancel(); });
    await act(async () => { await Promise.resolve(); });
    expect(speechRuntime.abort).toHaveBeenCalledTimes(1);
    expect(speechRuntime.abortAndWaitAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(audioRuntime.release).not.toHaveBeenCalled();
    const secondStart = voice!.start();
    let secondStartResult: boolean | null = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      secondStartResult = await secondStart;
    });
    expect(secondStartResult).toBe(false);
    expect(speechRuntime.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishAbort();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(350);
    });
    await expect(pendingCancel).resolves.toBe(true);
    expect(audioRuntime.release).toHaveBeenCalledTimes(1);
  });

  it('ne prend jamais inactive pour une fin pendant un abort encore en vol', async () => {
    speechRuntime.abortAndWaitAsync.mockImplementationOnce(() => {
      speechRuntime.abort();
      return new Promise<void>(() => undefined);
    });
    speechRuntime.getStateAsync.mockResolvedValue('inactive');
    await start();

    let pendingCancel!: Promise<boolean>;
    act(() => { pendingCancel = voice!.cancel(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600);
    });
    await expect(pendingCancel).resolves.toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(speechRuntime.abortAndWaitAsync).toHaveBeenCalledTimes(1);
    expect(speechRuntime.getStateAsync).toHaveBeenCalled();
    expect(audioRuntime.release).not.toHaveBeenCalled();
  });

  it('après unmount, la barrière annule puis converge sans dépendre des listeners', async () => {
    let finishAbort!: () => void;
    speechRuntime.abortAndWaitAsync.mockImplementationOnce(() => {
      speechRuntime.abort();
      return new Promise<void>((resolve) => { finishAbort = resolve; });
    });
    await start(false);
    await act(async () => renderer?.unmount());
    renderer = null;
    expect(speechRuntime.listeners.size).toBe(0);
    expect(speechRuntime.abort).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(audioRuntime.release).not.toHaveBeenCalled();
    await act(async () => {
      finishAbort();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(audioRuntime.release).toHaveBeenCalledTimes(1);
  });

  it('invalide un start démonté pendant acquire et rend le lease tardif sans ouvrir le micro', async () => {
    let finishAcquire!: (value: {
      ok: true;
      lease: { generation: number; token: string };
    }) => void;
    audioRuntime.acquire.mockImplementationOnce(() => new Promise((resolve) => {
      finishAcquire = resolve;
    }));

    const pendingStart = voice!.start();
    await act(async () => { await Promise.resolve(); });
    expect(audioRuntime.acquire).toHaveBeenCalledTimes(1);
    await act(async () => renderer?.unmount());
    renderer = null;

    const lateLease = { generation: 91, token: 'late-input' };
    audioRuntime.current = lateLease;
    await act(async () => {
      finishAcquire({ ok: true, lease: lateLease });
      await expect(pendingStart).resolves.toBe(false);
    });
    expect(audioRuntime.release).toHaveBeenCalledWith(lateLease);
    expect(speechRuntime.getSupportedLocales).not.toHaveBeenCalled();
    expect(speechRuntime.requestMicrophonePermissionsAsync).not.toHaveBeenCalled();
    expect(speechRuntime.start).not.toHaveBeenCalled();
  });

  it('livre un seul final et n’expose jamais le message libre au log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await start();
    act(() => emit('result', {
      isFinal: true,
      results: [{ transcript: 'devis toiture' }],
    }));
    act(() => emit('result', {
      isFinal: true,
      results: [{ transcript: 'duplicata' }],
    }));
    expect(transcripts).toEqual(['devis toiture']);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('duplicata');
    await endAndRelease();
    warn.mockRestore();
  });

  it('synthétise le canal classique uniquement avec le moteur natif et rend son lease', async () => {
    let finishNative: (() => void) | undefined;
    speechOutput.speak.mockImplementation((_text: string, options: { onDone?: () => void }) => {
      finishNative = options.onDone;
    });

    let completion!: Promise<VoiceOutputOutcome>;
    act(() => {
      completion = speaker!.speakAndWait('  Bonjour chantier  ');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(speechOutput.speak).toHaveBeenCalledWith('Bonjour chantier', expect.objectContaining({
      language: 'fr-FR',
      rate: 1,
    }));
    expect(finishNative).toBeTypeOf('function');
    act(() => finishNative?.());
    await expect(completion).resolves.toBe('completed');
    expect(audioRuntime.release).toHaveBeenCalledTimes(1);
  });

  it('échoue proprement sans voix fr-FR et borne un callback TTS perdu', async () => {
    speechOutput.getAvailableVoicesAsync.mockResolvedValue([]);
    let missingVoice!: Promise<unknown>;
    act(() => {
      missingVoice = speaker!.speakAndWait('Réponse');
    });
    await expect(missingVoice).resolves.toBe('failed');
    expect(speechOutput.speak).not.toHaveBeenCalled();

    speechOutput.getAvailableVoicesAsync.mockResolvedValue([{
      identifier: 'fr-local',
      name: 'Français',
      quality: 'Default',
      language: 'fr_FR',
      networkConnectionRequired: false,
      installed: true,
    }]);
    let timedOut!: Promise<unknown>;
    act(() => {
      timedOut = speaker!.speakAndWait('Réponse sans callback');
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_520);
    });
    await expect(timedOut).resolves.toBe('timed_out');
    expect(audioRuntime.release).toHaveBeenCalledTimes(2);
  });

  it('refuse une voix Android réseau et ne parle qu’avec une voix fr-FR locale prouvée', async () => {
    platformRuntime.OS = 'android';
    platformRuntime.Version = 33;
    speechOutput.getAvailableVoicesAsync.mockResolvedValueOnce([{
      identifier: 'fr-network',
      name: 'Français réseau',
      quality: 'Default',
      language: 'fr-FR',
      networkConnectionRequired: true,
      installed: true,
    }]);
    await expect(speaker!.speakAndWait('Montant confidentiel')).resolves.toBe('failed');
    expect(speechOutput.speak).not.toHaveBeenCalled();

    speechOutput.getAvailableVoicesAsync.mockResolvedValueOnce([{
      identifier: 'fr-downloading',
      name: 'Français non installé',
      quality: 'Default',
      language: 'fr-FR',
      networkConnectionRequired: false,
      installed: false,
    }]);
    await expect(speaker!.speakAndWait('Montant confidentiel')).resolves.toBe('failed');
    expect(speechOutput.speak).not.toHaveBeenCalled();

    let done: (() => void) | undefined;
    speechOutput.getAvailableVoicesAsync.mockResolvedValueOnce([{
      identifier: 'fr-offline',
      name: 'Français local',
      quality: 'Default',
      language: 'fr_FR',
      networkConnectionRequired: false,
      installed: true,
    }]);
    speechOutput.speak.mockImplementationOnce((
      _text: string,
      options: { onDone?: () => void },
    ) => { done = options.onDone; });
    const local = speaker!.speakAndWait('Montant confidentiel');
    await act(async () => { await Promise.resolve(); });
    expect(speechOutput.speak).toHaveBeenCalledWith(
      'Montant confidentiel',
      expect.objectContaining({ voice: 'fr-offline', requiresOfflineVoice: true }),
    );
    act(() => done?.());
    await expect(local).resolves.toBe('completed');
  });

  it('un stop sans callback règle N immédiatement et son ancien timer ne coupe jamais N+1', async () => {
    const callbacks: Array<{ onDone?: () => void }> = [];
    speechOutput.speak.mockImplementation((
      _text: string,
      options: { onDone?: () => void },
    ) => { callbacks.push(options); });

    const first = speaker!.speakAndWait('N');
    await act(async () => { await Promise.resolve(); });
    act(() => speaker!.stopSpeaking());
    await expect(first).resolves.toBe('interrupted');
    await act(async () => { await Promise.resolve(); });
    expect(speechOutput.stop).toHaveBeenCalledTimes(1);

    const secondText = 'Deuxième réponse '.repeat(20);
    const second = speaker!.speakAndWait(secondText);
    await act(async () => { await Promise.resolve(); });
    expect(callbacks).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(speechOutput.stop).toHaveBeenCalledTimes(1);
    act(() => callbacks[1]?.onDone?.());
    await expect(second).resolves.toBe('completed');
  });

  it('libère une quarantaine TTS quand un callback terminal natif arrive tardivement', async () => {
    let stopped: (() => void) | undefined;
    speechOutput.speak.mockImplementation((
      _text: string,
      options: { onStopped?: () => void },
    ) => { stopped = options.onStopped; });
    speechOutput.stop.mockRejectedValueOnce(new Error('bridge timeout'));
    speechOutput.isSpeakingAsync.mockResolvedValueOnce(true);

    const pending = speaker!.speakAndWait('Réponse interrompue');
    await act(async () => { await Promise.resolve(); });
    act(() => speaker!.stopSpeaking());
    await expect(pending).resolves.toBe('interrupted');
    await act(async () => { await Promise.resolve(); });
    expect(audioRuntime.release).not.toHaveBeenCalled();

    act(() => stopped?.());
    expect(audioRuntime.release).toHaveBeenCalledTimes(1);
    act(() => stopped?.());
    expect(audioRuntime.release).toHaveBeenCalledTimes(1);
  });

  it('invalide une synthèse arrêtée pendant acquire et ne parle jamais après le stop', async () => {
    let finishAcquire!: (value: {
      ok: true;
      lease: { generation: number; token: string };
    }) => void;
    audioRuntime.acquire.mockImplementationOnce(() => new Promise((resolve) => {
      finishAcquire = resolve;
    }));

    const pendingSpeech = speaker!.speakAndWait('Ne doit jamais être prononcé');
    await act(async () => { await Promise.resolve(); });
    expect(audioRuntime.acquire).toHaveBeenCalledTimes(1);
    act(() => speaker!.stopSpeaking());

    const lateLease = { generation: 92, token: 'late-output' };
    audioRuntime.current = lateLease;
    await act(async () => {
      finishAcquire({ ok: true, lease: lateLease });
      await expect(pendingSpeech).resolves.toBe('interrupted');
    });
    expect(audioRuntime.release).toHaveBeenCalledWith(lateLease);
    expect(speechOutput.getAvailableVoicesAsync).not.toHaveBeenCalled();
    expect(speechOutput.speak).not.toHaveBeenCalled();
  });

  it('attend la libération réelle du micro avant de démarrer la synthèse', async () => {
    let finishAbort!: () => void;
    speechRuntime.abortAndWaitAsync.mockImplementationOnce(() => {
      speechRuntime.abort();
      return new Promise<void>((resolve) => { finishAbort = resolve; });
    });
    let finishSpeech: (() => void) | undefined;
    speechOutput.speak.mockImplementationOnce((
      _text: string,
      options: { onDone?: () => void },
    ) => { finishSpeech = options.onDone; });
    await start();

    let transition!: Promise<VoiceOutputOutcome>;
    act(() => {
      transition = (async (): Promise<VoiceOutputOutcome> => {
        const released = await voice!.cancel();
        if (!released) return 'failed';
        return speaker!.speakAndWait('Guidage après écoute');
      })();
    });
    await act(async () => { await Promise.resolve(); });
    expect(speechOutput.speak).not.toHaveBeenCalled();
    expect(audioRuntime.acquire).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishAbort();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(349);
    });
    expect(speechOutput.speak).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(audioRuntime.acquire).toHaveBeenCalledTimes(2);
    expect(speechOutput.speak).toHaveBeenCalledWith(
      'Guidage après écoute',
      expect.objectContaining({ voice: 'fr-local' }),
    );
    act(() => finishSpeech?.());
    await expect(transition).resolves.toBe('completed');
  });
});
