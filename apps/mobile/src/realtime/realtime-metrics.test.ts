import { describe, expect, it } from 'vitest';
import { RealtimeMetricsTracker } from './realtime-metrics';

describe('Bob Live — métriques monotones', () => {
  it('mesure bootstrap, premier signal audio et interruption sans contenu métier', () => {
    let now = 1_000;
    const metrics = new RealtimeMetricsTracker(() => now);
    metrics.markConnectStarted();
    now += 80;
    metrics.markPermissionGranted();
    now += 20;
    metrics.markOfferSent();
    now += 300;
    metrics.markAnswerReceived();
    now += 100;
    metrics.markDataChannelOpened();
    now += 50;
    metrics.markSessionReady();
    now += 500;
    metrics.markSpeechStopped();
    now += 420;
    metrics.markFirstAudioSignal();
    now += 30;
    metrics.markFirstInboundRtp();
    now += 200;
    metrics.markBargeIn();
    now += 90;
    metrics.markAudioCleared();
    metrics.updateWebRtcStats({ roundTripTimeMs: 44, jitterMs: 8, packetsLost: 0 });

    expect(metrics.snapshot()).toEqual({
      permissionToTrackMs: 80,
      offerToAnswerMs: 300,
      connectToDataChannelOpenMs: 500,
      sessionReadyMs: 550,
      speechStoppedEventToFirstAudioSignalMs: 420,
      speechStoppedToFirstInboundRtpMs: 450,
      bargeInToAudioClearedMs: 90,
      reconnectCount: 0,
      roundTripTimeMs: 44,
      jitterMs: 8,
      packetsLost: 0,
    });
  });

  it('reinitialise toutes les valeurs quand le meme transport ouvre une nouvelle session', () => {
    let now = 1_000;
    const metrics = new RealtimeMetricsTracker(() => now);
    metrics.markConnectStarted();
    now += 10;
    metrics.markSessionReady();
    metrics.markReconnect();
    metrics.updateWebRtcStats({ roundTripTimeMs: 42, packetsLost: 3 });

    now += 100;
    metrics.markConnectStarted();

    expect(metrics.snapshot()).toMatchObject({
      sessionReadyMs: null,
      reconnectCount: 0,
      roundTripTimeMs: null,
      packetsLost: null,
    });
  });

  it('conserve le premier instant d un barge-in dupliqué puis réarme à la réponse suivante', () => {
    let now = 1_000;
    const metrics = new RealtimeMetricsTracker(() => now);
    metrics.markConnectStarted();
    metrics.markResponseStarted();
    metrics.markBargeIn();
    now += 40;
    metrics.markBargeIn();
    now += 60;
    metrics.markAudioCleared();
    expect(metrics.snapshot().bargeInToAudioClearedMs).toBe(100);

    now += 200;
    metrics.markResponseStarted();
    metrics.markBargeIn();
    now += 30;
    metrics.markAudioCleared();
    expect(metrics.snapshot().bargeInToAudioClearedMs).toBe(30);
  });
});
