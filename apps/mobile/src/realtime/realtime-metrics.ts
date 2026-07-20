import type { RealtimeTransportMetrics } from './realtime-transport';

export class RealtimeMetricsTracker {
  private connectStartedAt: number | null = null;
  private permissionGrantedAt: number | null = null;
  private offerSentAt: number | null = null;
  private answerReceivedAt: number | null = null;
  private dataChannelOpenedAt: number | null = null;
  private sessionReadyAt: number | null = null;
  private speechStoppedAt: number | null = null;
  private firstAudioSignalAt: number | null = null;
  private firstInboundRtpAt: number | null = null;
  private bargeInAt: number | null = null;
  private audioClearedAt: number | null = null;
  private reconnectCount = 0;
  private roundTripTimeMs: number | null = null;
  private jitterMs: number | null = null;
  private packetsLost: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Une instance de transport peut etre reutilisee : chaque connexion repart d'un snapshot vierge. */
  markConnectStarted(): void {
    this.connectStartedAt = this.now();
    this.permissionGrantedAt = null;
    this.offerSentAt = null;
    this.answerReceivedAt = null;
    this.dataChannelOpenedAt = null;
    this.sessionReadyAt = null;
    this.speechStoppedAt = null;
    this.firstAudioSignalAt = null;
    this.firstInboundRtpAt = null;
    this.bargeInAt = null;
    this.audioClearedAt = null;
    this.reconnectCount = 0;
    this.roundTripTimeMs = null;
    this.jitterMs = null;
    this.packetsLost = null;
  }
  markPermissionGranted(): void { this.permissionGrantedAt = this.now(); }
  markOfferSent(): void { this.offerSentAt = this.now(); }
  markAnswerReceived(): void { this.answerReceivedAt = this.now(); }
  markDataChannelOpened(): void { this.dataChannelOpenedAt = this.now(); }
  markSessionReady(): void { this.sessionReadyAt ??= this.now(); }
  markResponseStarted(): void {
    // Chaque réponse ouvre une nouvelle fenêtre d'interruption. Cela empêche un accusé tardif
    // du tour précédent de polluer la latence du tour courant.
    this.bargeInAt = null;
    this.audioClearedAt = null;
  }
  markSpeechStopped(): void {
    this.speechStoppedAt = this.now();
    this.firstAudioSignalAt = null;
    this.firstInboundRtpAt = null;
  }
  markFirstAudioSignal(): void { this.firstAudioSignalAt ??= this.now(); }
  markFirstInboundRtp(): void { this.firstInboundRtpAt ??= this.now(); }
  markBargeIn(): void {
    // Le VAD provider et le geste UI peuvent signaler la même interruption. Le premier instant
    // est l'origine utile ; le réécrire sous-estimerait artificiellement la latence perçue.
    if (this.bargeInAt === null) this.bargeInAt = this.now();
  }
  markAudioCleared(): void { this.audioClearedAt ??= this.now(); }
  markReconnect(): void { this.reconnectCount += 1; }
  updateWebRtcStats(input: { roundTripTimeMs?: number; jitterMs?: number; packetsLost?: number }): void {
    if (input.roundTripTimeMs !== undefined) this.roundTripTimeMs = input.roundTripTimeMs;
    if (input.jitterMs !== undefined) this.jitterMs = input.jitterMs;
    if (input.packetsLost !== undefined) this.packetsLost = input.packetsLost;
  }

  snapshot(): RealtimeTransportMetrics {
    const duration = (start: number | null, end: number | null): number | null =>
      start !== null && end !== null ? Math.max(0, end - start) : null;
    return {
      permissionToTrackMs: duration(this.connectStartedAt, this.permissionGrantedAt),
      offerToAnswerMs: duration(this.offerSentAt, this.answerReceivedAt),
      connectToDataChannelOpenMs: duration(this.connectStartedAt, this.dataChannelOpenedAt),
      sessionReadyMs: duration(this.connectStartedAt, this.sessionReadyAt),
      speechStoppedEventToFirstAudioSignalMs: duration(this.speechStoppedAt, this.firstAudioSignalAt),
      speechStoppedToFirstInboundRtpMs: duration(this.speechStoppedAt, this.firstInboundRtpAt),
      bargeInToAudioClearedMs: duration(this.bargeInAt, this.audioClearedAt),
      reconnectCount: this.reconnectCount,
      roundTripTimeMs: this.roundTripTimeMs,
      jitterMs: this.jitterMs,
      packetsLost: this.packetsLost,
    };
  }
}
