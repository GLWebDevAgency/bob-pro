import { describe, expect, it } from 'vitest';
import { planLiveSilenceRecovery, type LiveSilenceInput } from './live-silence';

const silence = (overrides: Partial<LiveSilenceInput> = {}): LiveSilenceInput => ({
  live: true,
  state: 'listening',
  voiceListening: false,
  earWasOpen: true,
  echoRelistenInFlight: false,
  nativeRecognition: true,
  alreadyRetried: false,
  ...overrides,
});

describe('planLiveSilenceRecovery — relance unique après le premier silence (S4)', () => {
  it('1er silence natif : UNE relance parlée + UNE ré-écoute', () => {
    expect(planLiveSilenceRecovery(silence())).toEqual({ kind: 'relaunch' });
  });

  it('2e silence d’affilée : repos SILENCIEUX — Bob ne harcèle jamais', () => {
    expect(planLiveSilenceRecovery(silence({ alreadyRetried: true }))).toEqual({ kind: 'rest' });
  });

  it('latence d’ouverture (permission, getVoiceMode) : jamais prise pour un silence', () => {
    // L'oreille n'a jamais été observée ouverte : ce n'est PAS une fin d'écoute.
    expect(planLiveSilenceRecovery(silence({ earWasOpen: false }))).toEqual({ kind: 'none' });
  });

  it('ré-écoute post-écho en vol : on ne parle pas pendant la grâce du lease', () => {
    expect(planLiveSilenceRecovery(silence({ echoRelistenInFlight: true }))).toEqual({ kind: 'none' });
  });

  it('reco cloud : repos silencieux — le transcript arrive APRÈS la fermeture du micro', () => {
    expect(planLiveSilenceRecovery(silence({ nativeRecognition: false }))).toEqual({ kind: 'rest' });
  });

  it('hors écoute annoncée ou oreille encore ouverte : rien à rattraper', () => {
    expect(planLiveSilenceRecovery(silence({ live: false }))).toEqual({ kind: 'none' });
    expect(planLiveSilenceRecovery(silence({ state: 'thinking' }))).toEqual({ kind: 'none' });
    expect(planLiveSilenceRecovery(silence({ state: 'speaking' }))).toEqual({ kind: 'none' });
    expect(planLiveSilenceRecovery(silence({ state: 'idle' }))).toEqual({ kind: 'none' });
    expect(planLiveSilenceRecovery(silence({ voiceListening: true }))).toEqual({ kind: 'none' });
  });
});
