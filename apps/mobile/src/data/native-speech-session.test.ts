import { describe, expect, it } from 'vitest';
import {
  advanceNativeSpeechTerminal,
  classifyNativeSpeechError,
  openNativeSpeechTerminal,
  supportsPrivateNativeSpeech,
  terminalEventForNativeSpeechError,
  type NativeSpeechTerminalEffect,
  type NativeSpeechTerminalEvent,
  type NativeSpeechTerminalFence,
  type NativeSpeechCommand,
} from './native-speech-session';

describe('supportsPrivateNativeSpeech', () => {
  const base = {
    platform: 'android',
    platformVersion: 33,
    supportsOnDeviceRecognition: true,
    installedLocales: ['fr-FR'],
    requestedLocale: 'fr-FR',
  } as const;

  it('refuse Android avant API 33 même si le moteur prétend préférer le hors-ligne', () => {
    expect(supportsPrivateNativeSpeech({ ...base, platformVersion: 32 })).toBe(false);
    expect(supportsPrivateNativeSpeech({ ...base, platformVersion: '33' })).toBe(false);
  });

  it('exige le support on-device et le modèle exact installé', () => {
    expect(supportsPrivateNativeSpeech({
      ...base,
      supportsOnDeviceRecognition: false,
    })).toBe(false);
    expect(supportsPrivateNativeSpeech({ ...base, installedLocales: ['en-US'] })).toBe(false);
    expect(supportsPrivateNativeSpeech({ ...base, installedLocales: ['fr_FR'] })).toBe(true);
  });

  it('accepte iOS avec fr-FR installé et refuse les plateformes sans preuve stricte', () => {
    expect(supportsPrivateNativeSpeech({
      ...base,
      platform: 'ios',
      platformVersion: '18.0',
    })).toBe(true);
    expect(supportsPrivateNativeSpeech({ ...base, platform: 'web' })).toBe(false);
  });
});

describe('classifyNativeSpeechError', () => {
  it.each([
    ['aborted', undefined, 'ignore'],
    ['no-speech', undefined, 'ignore'],
    ['speech-timeout', undefined, 'ignore'],
    ['not-allowed', undefined, 'denied'],
    ['service-not-allowed', 9, 'denied'],
    ['service-not-allowed', undefined, 'unavailable'],
    ['audio-capture', undefined, 'unavailable'],
    ['interrupted', undefined, 'unavailable'],
    ['language-not-supported', undefined, 'unavailable'],
    ['busy', undefined, 'unavailable'],
    ['network', undefined, 'failed'],
    ['bad-grammar', undefined, 'failed'],
    ['client', undefined, 'failed'],
    ['unknown', undefined, 'failed'],
    ['too-many-requests', undefined, 'failed'],
  ] as const)('%s / code %s → %s', (error, code, disposition) => {
    expect(classifyNativeSpeechError({ error, code, message: 'texte non fiable' })).toEqual({
      disposition,
      errorCode: error,
      nativeCode: code ?? null,
    });
  });

  it('normalise un code vide vers unknown sans utiliser le message localisé', () => {
    const french = classifyNativeSpeechError({ error: ' ', message: 'Autorisation refusée' });
    const english = classifyNativeSpeechError({ error: ' ', message: 'Network failed' });
    expect(french).toEqual({ disposition: 'failed', errorCode: 'unknown', nativeCode: null });
    expect(english).toEqual(french);
    expect(classifyNativeSpeechError({ error: 404, code: Number.POSITIVE_INFINITY })).toEqual({
      disposition: 'failed',
      errorCode: 'unknown',
      nativeCode: null,
    });
    expect(classifyNativeSpeechError({
      error: 'future-platform-code client@example.test',
      code: 72,
    })).toEqual({
      disposition: 'failed',
      errorCode: 'unknown',
      nativeCode: 72,
    });
  });

  it('convertit uniquement les erreurs silencieuses en événements non issue', () => {
    expect(terminalEventForNativeSpeechError(classifyNativeSpeechError({ error: 'aborted' })))
      .toBe('aborted');
    expect(terminalEventForNativeSpeechError(classifyNativeSpeechError({ error: 'no-speech' })))
      .toBe('silence');
    expect(terminalEventForNativeSpeechError(classifyNativeSpeechError({ error: 'network' })))
      .toBe('issue');
  });
});

function runSequence(
  generation: number,
  events: readonly NativeSpeechTerminalEvent[],
): {
  readonly state: NativeSpeechTerminalFence;
  readonly effects: readonly NativeSpeechTerminalEffect[];
  readonly commands: readonly NativeSpeechCommand[];
} {
  let state = openNativeSpeechTerminal(generation);
  const effects: NativeSpeechTerminalEffect[] = [];
  const commands: NativeSpeechCommand[] = [];
  for (const event of events) {
    const transition = advanceNativeSpeechTerminal(state, generation, event);
    state = transition.next;
    if (transition.effect !== 'none') effects.push(transition.effect);
    if (transition.command !== 'none') commands.push(transition.command);
  }
  return { state, effects, commands };
}

describe('advanceNativeSpeechTerminal', () => {
  it('cancel → aborted → issue → end : aucun effet tardif', () => {
    expect(runSequence(1, ['start', 'cancel_requested', 'aborted', 'issue', 'end'])).toEqual({
      state: {
        generation: 1,
        state: 'cancelled',
        lifecycle: 'ended',
        command: 'abort',
        commandDispatched: true,
      },
      effects: [],
      commands: ['abort'],
    });
  });

  it('final → issue → end : un transcript, aucune issue', () => {
    expect(runSequence(2, ['start', 'final', 'issue', 'end'])).toEqual({
      state: {
        generation: 2,
        state: 'final',
        lifecycle: 'ended',
        command: 'none',
        commandDispatched: false,
      },
      effects: ['transcript'],
      commands: [],
    });
  });

  it('une erreur pré-start est légitime et deux erreurs terminalisent une seule fois', () => {
    expect(runSequence(3, ['issue', 'issue', 'end'])).toEqual({
      state: {
        generation: 3,
        state: 'issue',
        lifecycle: 'ended',
        command: 'none',
        commandDispatched: false,
      },
      effects: ['issue'],
      commands: [],
    });
  });

  it('stop → silence → end conserve un silence, sans issue', () => {
    expect(runSequence(4, ['start', 'stop_requested', 'silence', 'end'])).toEqual({
      state: {
        generation: 4,
        state: 'silent',
        lifecycle: 'ended',
        command: 'stop',
        commandDispatched: true,
      },
      effects: ['silence'],
      commands: ['stop'],
    });
  });

  it('stop → issue → end conserve la vraie panne', () => {
    expect(runSequence(5, ['start', 'stop_requested', 'issue', 'end'])).toEqual({
      state: {
        generation: 5,
        state: 'issue',
        lifecycle: 'ended',
        command: 'stop',
        commandDispatched: true,
      },
      effects: ['issue'],
      commands: ['stop'],
    });
  });

  it('end → final garde le résultat final tardif', () => {
    expect(runSequence(6, ['start', 'end', 'final'])).toEqual({
      state: {
        generation: 6,
        state: 'final',
        lifecycle: 'ended',
        command: 'none',
        commandDispatched: false,
      },
      effects: ['transcript'],
      commands: [],
    });
  });

  it('nomatch puis end reste silencieux et end seul terminalise à la fin de grâce', () => {
    expect(runSequence(7, ['start', 'silence', 'end', 'grace_expired']).effects)
      .toEqual(['silence']);
    expect(runSequence(8, ['start', 'end', 'grace_expired'])).toEqual({
      state: {
        generation: 8,
        state: 'silent',
        lifecycle: 'ended',
        command: 'none',
        commandDispatched: false,
      },
      effects: ['silence'],
      commands: [],
    });
  });

  it('ignore un événement N après ouverture de N+1', () => {
    const current = openNativeSpeechTerminal(10);
    expect(advanceNativeSpeechTerminal(current, 9, 'issue')).toEqual({
      next: current,
      changed: false,
      effect: 'none',
      command: 'none',
    });
  });

  it('cancel → final ne livre aucun transcript', () => {
    expect(runSequence(11, ['start', 'cancel_requested', 'final']).effects).toEqual([]);
  });

  it('deux résultats finals ne livrent qu’un transcript', () => {
    expect(runSequence(12, ['start', 'final', 'final']).effects).toEqual(['transcript']);
  });

  it('diffère cancel pendant arming puis n’émet abort qu’une fois au start', () => {
    const sequence = runSequence(13, [
      'cancel_requested',
      'cancel_requested',
      'start',
      'cancel_requested',
    ]);
    expect(sequence.commands).toEqual(['abort']);
    expect(sequence.state.commandDispatched).toBe(true);
  });

  it('distingue un start natif émis de son accusé tardif', () => {
    const sequence = runSequence(15, [
      'start_requested',
      'cancel_requested',
      'start',
      'end',
    ]);
    expect(sequence.commands).toEqual(['abort']);
    expect(sequence.state).toEqual({
      generation: 15,
      state: 'cancelled',
      lifecycle: 'ended',
      command: 'abort',
      commandDispatched: true,
    });
  });

  it('une activité native observée par le watchdog remplace l’ack start perdu', () => {
    const sequence = runSequence(16, [
      'start_requested',
      'cancel_requested',
      'native_active',
      'end',
    ]);
    expect(sequence.commands).toEqual(['abort']);
    expect(sequence.state.lifecycle).toBe('ended');
    expect(sequence.state.commandDispatched).toBe(true);
  });

  it('un abort natif durable termine un start émis sans dépendre d’un snapshot inactive', () => {
    const sequence = runSequence(17, [
      'start_requested',
      'cancel_requested',
      'abort_completed',
    ]);
    expect(sequence.commands).toEqual(['abort']);
    expect(sequence.state.lifecycle).toBe('ended');
  });

  it('stop → cancel promeut une seule fois la commande native', () => {
    expect(runSequence(14, [
      'start',
      'stop_requested',
      'stop_requested',
      'cancel_requested',
      'cancel_requested',
    ]).commands).toEqual(['stop', 'abort']);
  });
});
