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
  supportsOnDeviceRecognitionForLocale: vi.fn(),
  requestMicrophonePermissionsAsync: vi.fn(),
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
      supportsOnDeviceRecognitionForLocale:
        speechRuntime.supportsOnDeviceRecognitionForLocale,
      requestMicrophonePermissionsAsync: speechRuntime.requestMicrophonePermissionsAsync,
    },
    useNativeSpeechRecognitionEvent: (name: string, listener: Listener) => {
      useEffect(() => {
        speechRuntime.listeners.set(name, listener);
        return () => {
          if (speechRuntime.listeners.get(name) === listener) {
            speechRuntime.listeners.delete(name);
          }
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
  Platform: { OS: 'ios', Version: '18.0' },
}));

vi.mock('expo-speech', () => ({
  speak: speechOutput.speak,
  stop: speechOutput.stop,
  getAvailableVoicesAsync: speechOutput.getAvailableVoicesAsync,
  isSpeakingAsync: speechOutput.isSpeakingAsync,
}));

vi.mock('./settings', () => ({
  neutralizeLegacyCloudVoiceMode: vi.fn(async () => false),
}));

import { processAudioSession } from '../audio';
import { useSpeak, useVoiceInput, type VoiceOutputOutcome } from './voice';

describe('voice input → output — vrai coordinateur audio de production', () => {
  let renderer: ReactTestRenderer | null = null;
  let voice: ReturnType<typeof useVoiceInput> | null = null;
  let speaker: ReturnType<typeof useSpeak> | null = null;

  function Probe() {
    voice = useVoiceInput(() => undefined, { owner: 'voice-production-coordinator-test' });
    speaker = useSpeak();
    return null;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    speechRuntime.listeners.clear();
    speechRuntime.getStateAsync.mockResolvedValue('inactive');
    speechRuntime.getSupportedLocales.mockResolvedValue({
      locales: ['fr-FR'],
      installedLocales: ['fr-FR'],
    });
    speechRuntime.supportsOnDeviceRecognitionForLocale.mockReturnValue(true);
    speechRuntime.requestMicrophonePermissionsAsync.mockResolvedValue({ granted: true });
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
    expect(processAudioSession.snapshot().active).toBeNull();
    await act(async () => {
      renderer = create(createElement(Probe));
    });
  });

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    vi.useRealTimers();
  });

  it('attend abort, end logique et grâce avant que le vrai coordinateur accorde le TTS', async () => {
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

    await act(async () => {
      await expect(voice!.start()).resolves.toBe(true);
    });
    act(() => speechRuntime.listeners.get('start')?.({}));
    expect(processAudioSession.snapshot().active).toMatchObject({
      mode: 'legacy_input',
      owner: 'voice-production-coordinator-test',
    });

    let transition!: Promise<VoiceOutputOutcome>;
    act(() => {
      transition = (async (): Promise<VoiceOutputOutcome> => {
        const released = await voice!.cancel();
        if (!released) return 'failed';
        return speaker!.speakAndWait('Guidage après écoute');
      })();
    });
    await act(async () => { await Promise.resolve(); });

    await expect(processAudioSession.acquire({
      owner: 'probe-output-before-release',
      mode: 'legacy_output',
    })).resolves.toEqual({ ok: false, reason: 'audio_busy' });
    expect(speechOutput.speak).not.toHaveBeenCalled();

    await act(async () => {
      finishAbort();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(349);
    });
    expect(processAudioSession.snapshot().active).toMatchObject({ mode: 'legacy_input' });
    expect(speechOutput.speak).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(processAudioSession.snapshot().active).toMatchObject({
      mode: 'legacy_output',
      owner: 'bob-legacy-output',
    });
    expect(speechOutput.speak).toHaveBeenCalledWith(
      'Guidage après écoute',
      expect.objectContaining({ voice: 'fr-local' }),
    );

    act(() => finishSpeech?.());
    await expect(transition).resolves.toBe('completed');
    expect(processAudioSession.snapshot().active).toBeNull();
  });
});
