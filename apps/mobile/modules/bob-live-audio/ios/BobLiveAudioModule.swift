@preconcurrency import AVFoundation
import ExpoModulesCore

private let targetSampleRate = 16_000.0
private let targetChannels: AVAudioChannelCount = 1
private let targetFrameDurationMs = 40
private let targetFrameBytes = 1_280 // 16 kHz * 40 ms * Int16 mono
private let targetFrameDurationNanoseconds: UInt64 = 40_000_000
private let pcm16SampleDurationNanoseconds: UInt64 = 62_500
private let javascriptMaximumSafeInteger = BobLiveVadBridgeContract.javascriptMaximumSafeInteger
private let nativeMaxInFlightFrames: Int64 = 16
private let defaultMaxCaptureDurationMs = 900_000
private let maximumMaxCaptureDurationMs = 900_000
private let minimumMaxCaptureDurationMs = 1_000
private let preparationWatchdogMs = 10_000
private let captureHeartbeatIntervalMs = 2_000
private let maximumPcmSilenceMs = 5_000.0
private let bobAudioSessionOptions: AVAudioSession.CategoryOptions = [
  .defaultToSpeaker,
  .allowBluetoothHFP
]

private enum CaptureStopReason: String {
  case requested
  case background
  case contextDestroyed = "context_destroyed"
  case captureError = "capture_error"
  case backpressure
  case watchdogTimeout = "watchdog_timeout"
  case interruption
}

private enum CaptureFailure: String, CodedError {
  case microphonePermissionDenied = "microphone_permission_denied"
  case captureBusy = "capture_busy"
  case captureInitializationFailed = "capture_initialization_failed"
  case captureProtocolFailed = "capture_protocol_failed"

  var code: String { "ERR_BOB_LIVE_AUDIO" }
  var description: String { rawValue }
}

private struct CaptureCancellationRequested: Error {}

private struct AudioSessionSnapshot {
  let category: AVAudioSession.Category
  let mode: AVAudioSession.Mode
  let options: AVAudioSession.CategoryOptions
  let preferredSampleRate: Double
  let preferredIOBufferDuration: TimeInterval
}

private struct AudioSessionLease {
  let generation: UInt64
  let snapshot: AudioSessionSnapshot
  let activationOwned: Bool
}

private struct BobLiveVadLease {
  let audioGeneration: UInt64
  let captureId: String
  let generation: BobLiveVadGeneration
}

// AVAudioConverter invoque ce bloc de maniere synchrone et sequentielle pour une conversion.
// La boite de reference evite neanmoins une capture mutable interdite par Swift 6.
private final class ConversionInputState: @unchecked Sendable {
  var supplied = false
}

private struct BobLiveAudioCapabilitiesRecord: Record {
  @Field var sessionId: String = ""
  @Field var captureId: String = ""
  @Field var encoding: String = "pcm_s16le"
  @Field var sampleRateHz: Int = Int(targetSampleRate)
  @Field var channels: Int = Int(targetChannels)
  @Field var frameDurationMs: Int = targetFrameDurationMs
  @Field var maxInFlightFrames: Int = Int(nativeMaxInFlightFrames)
  @Field var maxCaptureDurationMs: Int = defaultMaxCaptureDurationMs
  @Field var acousticEchoCancellation: String = "unknown"
  @Field var noiseSuppression: String = "unknown"
  @Field var automaticGainControl: String = "unknown"
  @Field var vadConfigVersion: String = ""
  @Field var vadEventOrdering: String = "pcm_before_vad"
  @Field var vadAnalysisWindowMs: Int = 0
  @Field var vadPreRollMs: Int = 0
  @Field var vadSpeechStartMs: Int = 0
  @Field var vadSpeechEndMs: Int = 0
  @Field var vadMaximumUtteranceMs: Int = 0
  @Field var fullDuplexCertified: Bool = false
}

// Toute mutation est serialisee sur captureQueue. Cette declaration permet aux callbacks
// AVFoundation/GCD d'etre compiles sous le mode de concurrence strict de Swift 6.
public final class BobLiveAudioModule: Module, @unchecked Sendable {
  private let captureQueue = DispatchQueue(
    label: "fr.bobpro.live-audio.capture",
    qos: .userInteractive
  )

  private var engine: AVAudioEngine?
  private var tapInstalled = false
  private var voiceProcessingEnabled = false
  private var activeSessionId: String?
  private var activeCaptureId: String?
  private var activeGeneration: UInt64 = 0
  private var nextSequence: Int64 = 0
  private var lastAcknowledgedSequence: Int64 = -1
  private var pendingPcm = Data()
  private var nextFrameStartedAtNanoseconds: UInt64?
  private var vad = BobLiveVad()
  private var vadLease: BobLiveVadLease?
  private var vadPcmScratch = [Int16](
    repeating: 0,
    count: targetFrameBytes / MemoryLayout<Int16>.size
  )
  private var capabilities: BobLiveAudioCapabilitiesRecord?
  private var captureRunning = false
  private var activeRouteSignature: String?
  private var lastPcmAtMonotonicMs: Double?
  private var audioSessionLease: AudioSessionLease?
  private var watchdog: DispatchWorkItem?
  private var watchdogFence = BobLiveAudioWatchdogFence()
  private var heartbeatWatchdog: DispatchSourceTimer?
  private var acceptingStarts = true
  private var eventsEnabled = true
  private var contextDestroyed = false
  private var notificationObservers: [NSObjectProtocol] = []
  private let cancellationFence = BobLiveAudioCancellationFence()

  public func definition() -> ModuleDefinition {
    Name("BobLiveAudio")

    Events("onPcmChunk", "onVadEvent", "onCaptureError", "onCaptureStopped")

    OnCreate {
      self.captureQueue.async {
        self.installAudioObserversOnQueue()
      }
    }

    AsyncFunction("prepareAsync") {
      (sessionId: String, requestedMaxCaptureDurationMs: Int?) -> BobLiveAudioCapabilitiesRecord in
      try self.captureQueue.sync {
        try self.prepareOnQueue(
          sessionId: sessionId,
          requestedMaxCaptureDurationMs: requestedMaxCaptureDurationMs
        )
      }
    }

    AsyncFunction("startPreparedAsync") { (sessionId: String, captureId: String) in
      try self.captureQueue.sync {
        try self.startPreparedOnQueue(sessionId: sessionId, captureId: captureId)
      }
    }

    AsyncFunction("acknowledgePcmAsync") {
      (sessionId: String, captureId: String, throughSequence: Int64) in
      try self.captureQueue.sync {
        try self.acknowledgeOnQueue(
          sessionId: sessionId,
          captureId: captureId,
          throughSequence: throughSequence
        )
      }
    }

    AsyncFunction("stopAsync") { (sessionId: String, captureId: String) in
      self.captureQueue.sync {
        guard self.activeSessionId == sessionId,
              self.activeCaptureId == captureId else { return }
        self.stopOnQueue(reason: .requested, emitEvent: true)
      }
    }

    AsyncFunction("prepareCaptureV2Async") {
      (
        sessionId: String,
        captureId: String,
        requestedMaxCaptureDurationMs: Int?
      ) -> BobLiveAudioCapabilitiesRecord in
      guard Self.isValidSessionId(sessionId), Self.isValidSessionId(captureId) else {
        throw CaptureFailure.captureProtocolFailed
      }
      guard self.cancellationFence.beginPrepare(sessionId: sessionId, captureId: captureId) else {
        // Un replay actif est rejeté sans devenir une commande d'arrêt. Seul le tombstone créé
        // par cancel-before-prepare doit encore être réconcilié sur la file audio.
        if self.cancellationFence.phase(sessionId: sessionId, captureId: captureId) == .cancelling {
          self.captureQueue.async {
            self.releaseV2OnQueue(sessionId: sessionId, captureId: captureId)
          }
        }
        throw CaptureFailure.captureProtocolFailed
      }
      return try self.captureQueue.sync {
        try self.prepareV2OnQueue(
          sessionId: sessionId,
          captureId: captureId,
          requestedMaxCaptureDurationMs: requestedMaxCaptureDurationMs
        )
      }
    }

    AsyncFunction("startPreparedCaptureV2Async") { (sessionId: String, captureId: String) in
      try self.captureQueue.sync {
        try self.startPreparedV2OnQueue(sessionId: sessionId, captureId: captureId)
      }
    }

    // Ce chemin ne doit jamais attendre captureQueue. Il pose d'abord le tombstone atomique,
    // puis planifie seulement un nettoyage best-effort sur l'autorité audio sérialisée.
    Function("cancelCaptureV2") { (sessionId: String, captureId: String) -> Bool in
      guard Self.isValidSessionId(sessionId), Self.isValidSessionId(captureId) else { return false }
      let fenced = self.cancellationFence.requestCancellation(
        sessionId: sessionId,
        captureId: captureId
      )
      if fenced {
        self.captureQueue.async {
          self.releaseV2OnQueue(sessionId: sessionId, captureId: captureId)
        }
      }
      return fenced
    }

    OnAppEntersForeground {
      self.captureQueue.async {
        if !self.contextDestroyed {
          self.acceptingStarts = true
        }
      }
    }

    OnAppEntersBackground {
      self.captureQueue.async {
        self.acceptingStarts = false
        self.stopOnQueue(reason: .background, emitEvent: true)
      }
    }

    OnAppContextDestroys {
      self.captureQueue.async {
        self.contextDestroyed = true
        self.acceptingStarts = false
        self.eventsEnabled = false
        self.removeAudioObserversOnQueue()
        self.stopOnQueue(reason: .contextDestroyed, emitEvent: false)
      }
    }

    OnDestroy {
      self.captureQueue.async {
        self.contextDestroyed = true
        self.acceptingStarts = false
        self.eventsEnabled = false
        self.removeAudioObserversOnQueue()
        self.stopOnQueue(reason: .contextDestroyed, emitEvent: false)
      }
    }
  }

  private func prepareOnQueue(
    sessionId: String,
    requestedMaxCaptureDurationMs: Int?,
    requestedCaptureId: String? = nil
  ) throws -> BobLiveAudioCapabilitiesRecord {
    guard acceptingStarts, !contextDestroyed, Self.isValidSessionId(sessionId) else {
      throw CaptureFailure.captureInitializationFailed
    }
    let maxCaptureDurationMs = requestedMaxCaptureDurationMs ?? defaultMaxCaptureDurationMs
    guard maxCaptureDurationMs >= minimumMaxCaptureDurationMs,
          maxCaptureDurationMs <= maximumMaxCaptureDurationMs else {
      throw CaptureFailure.captureInitializationFailed
    }
    if activeSessionId == sessionId, let capabilities {
      if let requestedCaptureId, capabilities.captureId != requestedCaptureId {
        throw CaptureFailure.captureBusy
      }
      guard capabilities.maxCaptureDurationMs == maxCaptureDurationMs else {
        throw CaptureFailure.captureProtocolFailed
      }
      let routeUnchanged = activeRouteSignature
        == Self.audioRouteSignature(AVAudioSession.sharedInstance())
      let vadLeaseMatches = vadLease?.audioGeneration == activeGeneration
        && vadLease?.captureId == capabilities.captureId
      guard routeUnchanged,
            vadLeaseMatches,
            ownsAudioSessionConfigurationOnQueue(generation: activeGeneration) else {
        let generation = activeGeneration
        failOnQueue(
          generation: generation,
          errorCode: "capture_interrupted",
          reason: .interruption
        )
        throw CaptureFailure.captureInitializationFailed
      }
      return capabilities
    }
    guard activeSessionId == nil else {
      throw CaptureFailure.captureBusy
    }

    let audioSession = AVAudioSession.sharedInstance()
    guard Self.hasMicrophonePermission(audioSession) else {
      throw CaptureFailure.microphonePermissionDenied
    }

    let snapshot = AudioSessionSnapshot(
      category: audioSession.category,
      mode: audioSession.mode,
      options: audioSession.categoryOptions,
      preferredSampleRate: audioSession.preferredSampleRate,
      preferredIOBufferDuration: audioSession.preferredIOBufferDuration
    )
    let captureId = requestedCaptureId ?? UUID().uuidString.lowercased()
    // AVAudioSession ne publie pas son etat actif. Une configuration voiceChat deja en place
    // est donc traitee conservativement comme appartenant a un autre composant: Bob la
    // restaurera mais ne la desactivera pas.
    let inheritedCompatibleActivation = snapshot.category == .playAndRecord
      && snapshot.mode == .voiceChat
    activeGeneration &+= 1
    let generation = activeGeneration
    guard let vadGeneration = vad.reset() else {
      throw CaptureFailure.captureInitializationFailed
    }
    vadLease = BobLiveVadLease(
      audioGeneration: generation,
      captureId: captureId,
      generation: vadGeneration
    )
    nextFrameStartedAtNanoseconds = nil
    audioSessionLease = AudioSessionLease(
      generation: generation,
      snapshot: snapshot,
      activationOwned: false
    )

    do {
      try throwIfV2Cancelled(sessionId: sessionId, captureId: requestedCaptureId)
      if let requestedCaptureId,
         !cancellationFence.markResourcesMayBeAllocated(
           sessionId: sessionId,
           captureId: requestedCaptureId
         ) {
        throw CaptureCancellationRequested()
      }
      try audioSession.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: bobAudioSessionOptions
      )
      try audioSession.setPreferredSampleRate(targetSampleRate)
      try audioSession.setPreferredIOBufferDuration(0.02)
      try audioSession.setActive(true)
      try throwIfV2Cancelled(sessionId: sessionId, captureId: requestedCaptureId)
      audioSessionLease = AudioSessionLease(
        generation: generation,
        snapshot: snapshot,
        activationOwned: !inheritedCompatibleActivation
      )

      let engine = AVAudioEngine()
      let input = engine.inputNode
      var voiceProcessingAvailable = false
      do {
        try input.setVoiceProcessingEnabled(true)
        voiceProcessingAvailable = input.isVoiceProcessingEnabled
      } catch {
        // Certaines routes ne proposent pas VoiceProcessingIO. La capacité reste
        // explicitement indisponible au lieu d'être déduite ou inventée.
        voiceProcessingAvailable = false
      }
      try throwIfV2Cancelled(sessionId: sessionId, captureId: requestedCaptureId)

      self.engine = engine
      voiceProcessingEnabled = voiceProcessingAvailable

      let sourceFormat = input.outputFormat(forBus: 0)
      guard sourceFormat.sampleRate > 0, sourceFormat.channelCount > 0,
            let targetFormat = AVAudioFormat(
              commonFormat: .pcmFormatInt16,
              sampleRate: targetSampleRate,
              channels: targetChannels,
              interleaved: true
            ),
            let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
        throw CaptureFailure.captureInitializationFailed
      }

      activeSessionId = sessionId
      activeCaptureId = captureId
      captureRunning = false
      nextSequence = 0
      lastAcknowledgedSequence = -1
      pendingPcm.removeAll(keepingCapacity: true)
      nextFrameStartedAtNanoseconds = nil

      let result = BobLiveAudioCapabilitiesRecord()
      result.sessionId = sessionId
      result.captureId = captureId
      result.maxCaptureDurationMs = maxCaptureDurationMs
      // VoiceProcessingIO regroupe plusieurs traitements sans publier un etat AEC/NS
      // certifiable par route. "unknown" est volontairement plus honnete que "enabled".
      result.acousticEchoCancellation = voiceProcessingAvailable ? "unknown" : "unavailable"
      result.noiseSuppression = voiceProcessingAvailable ? "unknown" : "unavailable"
      // VoiceProcessingIO ne publie pas un état AGC fiable par route.
      result.automaticGainControl = "unknown"
      let vadConfiguration = vad.configuration
      result.vadConfigVersion = vadConfiguration.version
      result.vadAnalysisWindowMs = vadConfiguration.analysisWindowMs
      result.vadPreRollMs = vadConfiguration.preRollMs
      result.vadSpeechStartMs = vadConfiguration.speechStartWindows
        * vadConfiguration.analysisWindowMs
      result.vadSpeechEndMs = vadConfiguration.speechEndWindows
        * vadConfiguration.analysisWindowMs
      result.vadMaximumUtteranceMs = vadConfiguration.maximumUtteranceMs
      capabilities = result

      input.installTap(onBus: 0, bufferSize: 1_024, format: sourceFormat) { [weak self] buffer, _ in
        guard let self else { return }
        do {
          if let pcm = try Self.convert(buffer: buffer, converter: converter, targetFormat: targetFormat) {
            let capturedAtEndNanoseconds = Self.monotonicNanoseconds()
            self.captureQueue.async {
              self.acceptPcmOnQueue(
                pcm,
                capturedAtEndNanoseconds: capturedAtEndNanoseconds,
                generation: generation
              )
            }
          }
        } catch {
          self.captureQueue.async {
            self.failOnQueue(generation: generation)
          }
        }
      }
      tapInstalled = true

      engine.prepare()
      try throwIfV2Cancelled(sessionId: sessionId, captureId: requestedCaptureId)
      activeRouteSignature = Self.audioRouteSignature(audioSession)
      // Une capture preparee mais jamais demarree ne doit pas conserver indefiniment
      // l'AVAudioSession, le tap et le microphone logique si JavaScript disparait.
      installWatchdogOnQueue(
        generation: generation,
        durationMs: min(maxCaptureDurationMs, preparationWatchdogMs),
        phase: .prepared
      )
      return result
    } catch {
      invalidateVadOnQueue(audioGeneration: generation, captureId: captureId)
      activeGeneration &+= 1
      cancelWatchdogOnQueue()
      cleanupEngineOnQueue()
      restoreAudioSessionOnQueue(generation: generation)
      activeSessionId = nil
      activeCaptureId = nil
      captureRunning = false
      activeRouteSignature = nil
      lastPcmAtMonotonicMs = nil
      capabilities = nil
      pendingPcm.removeAll(keepingCapacity: false)
      nextFrameStartedAtNanoseconds = nil
      nextSequence = 0
      lastAcknowledgedSequence = -1
      if let requestedCaptureId {
        completeV2ReleaseOnQueue(
          sessionId: sessionId,
          captureId: requestedCaptureId,
          physicalReleaseProven: true,
          reason: .requested,
          emitEvent: true
        )
      }
      if let failure = error as? CaptureFailure {
        throw failure
      }
      throw CaptureFailure.captureInitializationFailed
    }
  }

  private func startPreparedOnQueue(sessionId: String, captureId: String) throws {
    guard acceptingStarts,
          !contextDestroyed,
          Self.isValidSessionId(sessionId),
          Self.isValidSessionId(captureId),
          activeSessionId == sessionId,
          activeCaptureId == captureId,
          let engine,
          let capabilities else {
      throw CaptureFailure.captureProtocolFailed
    }
    if captureRunning {
      let routeUnchanged = activeRouteSignature
        == Self.audioRouteSignature(AVAudioSession.sharedInstance())
      guard engine.isRunning,
            routeUnchanged,
            ownsAudioSessionConfigurationOnQueue(generation: activeGeneration) else {
        let generation = activeGeneration
        failOnQueue(
          generation: generation,
          errorCode: "capture_interrupted",
          reason: .interruption
        )
        throw CaptureFailure.captureInitializationFailed
      }
      return
    }
    let generation = activeGeneration
    let routeUnchanged = activeRouteSignature
      == Self.audioRouteSignature(AVAudioSession.sharedInstance())
    guard routeUnchanged,
          ownsAudioSessionConfigurationOnQueue(generation: generation) else {
      failOnQueue(
        generation: generation,
        errorCode: "capture_interrupted",
        reason: .interruption
      )
      throw CaptureFailure.captureInitializationFailed
    }
    do {
      try throwIfV2Cancelled(
        sessionId: sessionId,
        captureId: cancellationFence.contains(sessionId: sessionId, captureId: captureId)
          ? captureId
          : nil
      )
      try engine.start()
      guard engine.isRunning else {
        throw CaptureFailure.captureInitializationFailed
      }
      try throwIfV2Cancelled(
        sessionId: sessionId,
        captureId: cancellationFence.contains(sessionId: sessionId, captureId: captureId)
          ? captureId
          : nil
      )
      captureRunning = true
      activeRouteSignature = Self.audioRouteSignature(AVAudioSession.sharedInstance())
      lastPcmAtMonotonicMs = ProcessInfo.processInfo.systemUptime * 1_000
      installWatchdogOnQueue(
        generation: generation,
        durationMs: capabilities.maxCaptureDurationMs,
        phase: .capturing
      )
      installHeartbeatWatchdogOnQueue(generation: generation)
    } catch is CaptureCancellationRequested {
      stopOnQueue(reason: .requested, emitEvent: true)
      throw CaptureFailure.captureInitializationFailed
    } catch {
      failOnQueue(
        generation: generation,
        errorCode: "capture_initialization_failed",
        reason: .captureError
      )
      throw CaptureFailure.captureInitializationFailed
    }
  }

  private func acceptPcmOnQueue(
    _ pcm: Data,
    capturedAtEndNanoseconds: UInt64,
    generation: UInt64
  ) {
    guard generation == activeGeneration,
          captureRunning,
          let activeSessionId,
          let activeCaptureId,
          !pcm.isEmpty else { return }
    if cancellationFence.isCancellationRequested(
      sessionId: activeSessionId,
      captureId: activeCaptureId
    ) { return }
    guard pcm.count.isMultiple(of: MemoryLayout<Int16>.size) else {
      failOnQueue(
        generation: generation,
        errorCode: "capture_protocol_failed",
        reason: .captureError
      )
      return
    }
    lastPcmAtMonotonicMs = Self.monotonicMilliseconds(capturedAtEndNanoseconds)
    pendingPcm.append(pcm)

    if nextFrameStartedAtNanoseconds == nil,
       pendingPcm.count >= targetFrameBytes {
      let pendingSampleCount = UInt64(pendingPcm.count / MemoryLayout<Int16>.size)
      let (pendingDurationNanoseconds, durationOverflow) = pendingSampleCount
        .multipliedReportingOverflow(by: pcm16SampleDurationNanoseconds)
      guard !durationOverflow else {
        failOnQueue(
          generation: generation,
          errorCode: "capture_protocol_failed",
          reason: .captureError
        )
        return
      }
      // The capture callback timestamp denotes the end of all currently pending samples.
      // Anchor the first complete frame at its acoustic start, then advance by exactly 40 ms.
      nextFrameStartedAtNanoseconds = capturedAtEndNanoseconds >= pendingDurationNanoseconds
        ? capturedAtEndNanoseconds - pendingDurationNanoseconds
        : 0
    }

    while pendingPcm.count >= targetFrameBytes {
      let chunk = Data(pendingPcm.prefix(targetFrameBytes))
      pendingPcm.removeFirst(targetFrameBytes)
      guard let frameStartedAtNanoseconds = nextFrameStartedAtNanoseconds else {
        failOnQueue(
          generation: generation,
          errorCode: "capture_protocol_failed",
          reason: .captureError
        )
        return
      }
      let (nextFrameStart, timelineOverflow) = frameStartedAtNanoseconds
        .addingReportingOverflow(targetFrameDurationNanoseconds)
      guard !timelineOverflow else {
        failOnQueue(
          generation: generation,
          errorCode: "capture_protocol_failed",
          reason: .captureError
        )
        return
      }
      nextFrameStartedAtNanoseconds = nextFrameStart
      guard emitChunkOnQueue(
        chunk,
        frameStartedAtNanoseconds: frameStartedAtNanoseconds,
        generation: generation
      ) else { return }
    }
  }

  @discardableResult
  private func emitChunkOnQueue(
    _ pcm: Data,
    frameStartedAtNanoseconds: UInt64,
    generation: UInt64
  ) -> Bool {
    // A callback from a previous AVAudioEngine generation is expected after teardown and must
    // remain completely inert. All other active-generation inconsistencies fail closed.
    guard generation == activeGeneration else { return false }
    guard let sessionId = activeSessionId,
          let captureId = activeCaptureId,
          pcm.count == targetFrameBytes,
          let vadLease,
          vadLease.audioGeneration == generation,
          vadLease.captureId == captureId else {
      failOnQueue(
        generation: generation,
        errorCode: "capture_protocol_failed",
        reason: .captureError
      )
      return false
    }
    let outstandingAfterEmission = nextSequence - lastAcknowledgedSequence
    guard outstandingAfterEmission <= nativeMaxInFlightFrames else {
      failOnQueue(
        generation: generation,
        errorCode: "capture_backpressure_exhausted",
        reason: .backpressure
      )
      return false
    }

    let decoded = pcm.withUnsafeBytes { rawBytes in
      vadPcmScratch.withUnsafeMutableBufferPointer { samples in
        BobLivePcm16LittleEndian.decode(rawBytes, into: samples)
      }
    }
    guard decoded else {
      failOnQueue(
        generation: generation,
        errorCode: "capture_protocol_failed",
        reason: .captureError
      )
      return false
    }
    let vadResult: BobLiveVadProcessResult = vadPcmScratch.withUnsafeBufferPointer { samples in
      // Until capture and playback share a certified native audio engine, playback activity is
      // intentionally false. This integration is VAD-ready but never claims full duplex/AEC.
      return vad.process(
        pcm16: samples,
        capturedAtNanoseconds: frameStartedAtNanoseconds,
        generation: vadLease.generation,
        playbackActive: false
      )
    }
    guard vadResult.disposition == .accepted,
          vadResult.analysisWindowsProcessed == 2,
          vadResult.bufferedSamples == 0,
          validateVadEventsOnQueue(vadResult.events, lease: vadLease),
          Self.isJavascriptSafeTimestamp(frameStartedAtNanoseconds),
          nextSequence >= 0,
          UInt64(nextSequence) <= javascriptMaximumSafeInteger else {
      failOnQueue(
        generation: generation,
        errorCode: "capture_protocol_failed",
        reason: .captureError
      )
      return false
    }

    let sequence = nextSequence
    nextSequence += 1
    emitOnQueue("onPcmChunk", [
      "sessionId": sessionId,
      "captureId": captureId,
      "sequence": sequence,
      // Historical field name retained for JS compatibility; the value is now the first sample
      // timestamp, never the later event-emission timestamp.
      "capturedAtMonotonicMs": Self.monotonicMilliseconds(frameStartedAtNanoseconds),
      "pcmBase64": pcm.base64EncodedString()
    ])
    // PCM is always visible first so the JavaScript ring can retain pre-roll before a transition.
    if let event = vadResult.events.first {
      emitVadEventOnQueue(event, sessionId: sessionId, captureId: captureId)
    }
    if let event = vadResult.events.second {
      emitVadEventOnQueue(event, sessionId: sessionId, captureId: captureId)
    }
    return true
  }

  private func validateVadEventsOnQueue(
    _ events: BobLiveVadEventBatch,
    lease: BobLiveVadLease
  ) -> Bool {
    if events.first == nil, events.second != nil { return false }
    if let first = events.first,
       !validateVadEventOnQueue(first, lease: lease) {
      return false
    }
    if let second = events.second {
      guard validateVadEventOnQueue(second, lease: lease),
            let first = events.first,
            first.detectedAtNanoseconds <= second.detectedAtNanoseconds else {
        return false
      }
    }
    return true
  }

  private func validateVadEventOnQueue(
    _ event: BobLiveVadEvent,
    lease: BobLiveVadLease
  ) -> Bool {
    BobLiveVadBridgeContract.isValid(
      event,
      expectedGeneration: lease.generation,
      configuration: vad.configuration
    )
  }

  private func emitVadEventOnQueue(
    _ event: BobLiveVadEvent,
    sessionId: String,
    captureId: String
  ) {
    guard let utteranceIndex = Int(exactly: event.utteranceIndex) else { return }
    let kind: String
    switch event.kind {
    case .speechStarted:
      kind = "speech_started"
    case .speechEnded:
      kind = "speech_ended"
    }
    emitOnQueue("onVadEvent", [
      "sessionId": sessionId,
      "captureId": captureId,
      "kind": kind,
      "configVersion": event.configurationVersion,
      "utteranceIndex": utteranceIndex,
      "detectedAtMonotonicMs": Self.monotonicMilliseconds(event.detectedAtNanoseconds),
      "preRollMs": event.preRollMs,
      "startedAtMonotonicMs": Self.monotonicMilliseconds(event.startedAtNanoseconds),
      // NSNull impose la présence de la clé côté JS pour le contrat strict start/end.
      "endedAtMonotonicMs": event.endedAtNanoseconds
        .map(Self.monotonicMilliseconds) ?? NSNull(),
      "forcedEnd": event.forcedEnd,
      "energyDbfs": event.energyDbfs,
      "noiseFloorDbfs": event.noiseFloorDbfs
    ])
  }

  private func invalidateVadOnQueue(audioGeneration: UInt64, captureId: String) {
    guard let lease = vadLease,
          lease.audioGeneration == audioGeneration,
          lease.captureId == captureId else { return }
    _ = vad.invalidate(generation: lease.generation)
    vadLease = nil
    nextFrameStartedAtNanoseconds = nil
  }

  private func acknowledgeOnQueue(
    sessionId: String,
    captureId: String,
    throughSequence: Int64
  ) throws {
    guard Self.isValidSessionId(sessionId),
          Self.isValidSessionId(captureId),
          throughSequence >= 0 else {
      throw CaptureFailure.captureProtocolFailed
    }
    guard let activeSessionId else {
      // Acquittement en retard d'une capture deja terminee: idempotent et sans effet.
      return
    }
    guard activeSessionId == sessionId, activeCaptureId == captureId else {
      // Ne jamais arreter la nouvelle capture a cause d'un ACK retarde d'une ancienne session.
      throw CaptureFailure.captureProtocolFailed
    }
    if throughSequence <= lastAcknowledgedSequence { return }
    guard throughSequence < nextSequence else {
      let generation = activeGeneration
      failOnQueue(
        generation: generation,
        errorCode: "capture_protocol_failed",
        reason: .captureError
      )
      throw CaptureFailure.captureProtocolFailed
    }
    lastAcknowledgedSequence = throughSequence
  }

  private func failOnQueue(
    generation: UInt64,
    errorCode: String = "capture_runtime_failed",
    reason: CaptureStopReason = .captureError
  ) {
    guard generation == activeGeneration,
          let sessionId = activeSessionId,
          let captureId = activeCaptureId else { return }
    emitOnQueue("onCaptureError", [
      "sessionId": sessionId,
      "captureId": captureId,
      "code": errorCode
    ])
    stopOnQueue(reason: reason, emitEvent: true)
  }

  private func stopOnQueue(reason: CaptureStopReason, emitEvent: Bool) {
    guard let sessionId = activeSessionId, let captureId = activeCaptureId else { return }
    let stoppedGeneration = activeGeneration
    invalidateVadOnQueue(audioGeneration: stoppedGeneration, captureId: captureId)
    activeGeneration &+= 1
    cancelWatchdogOnQueue()
    cancelHeartbeatWatchdogOnQueue()
    cleanupEngineOnQueue()
    restoreAudioSessionOnQueue(generation: stoppedGeneration)
    activeSessionId = nil
    activeCaptureId = nil
    captureRunning = false
    activeRouteSignature = nil
    lastPcmAtMonotonicMs = nil
    capabilities = nil
    pendingPcm.removeAll(keepingCapacity: false)
    nextFrameStartedAtNanoseconds = nil
    nextSequence = 0
    lastAcknowledgedSequence = -1
    let v2Capture = cancellationFence.contains(sessionId: sessionId, captureId: captureId)
    if v2Capture {
      completeV2ReleaseOnQueue(
        sessionId: sessionId,
        captureId: captureId,
        physicalReleaseProven: true,
        reason: reason,
        emitEvent: emitEvent
      )
    } else if emitEvent {
      emitOnQueue("onCaptureStopped", [
        "sessionId": sessionId,
        "captureId": captureId,
        "reason": reason.rawValue
      ])
    }
  }

  private func prepareV2OnQueue(
    sessionId: String,
    captureId: String,
    requestedMaxCaptureDurationMs: Int?
  ) throws -> BobLiveAudioCapabilitiesRecord {
    do {
      guard !cancellationFence.isCancellationRequested(
        sessionId: sessionId,
        captureId: captureId
      ) else { throw CaptureCancellationRequested() }
      let result = try prepareOnQueue(
        sessionId: sessionId,
        requestedMaxCaptureDurationMs: requestedMaxCaptureDurationMs,
        requestedCaptureId: captureId
      )
      guard cancellationFence.transition(
        sessionId: sessionId,
        captureId: captureId,
        to: .prepared
      ) else { throw CaptureCancellationRequested() }
      return result
    } catch {
      releaseV2OnQueue(sessionId: sessionId, captureId: captureId)
      if let failure = error as? CaptureFailure { throw failure }
      throw CaptureFailure.captureInitializationFailed
    }
  }

  private func startPreparedV2OnQueue(sessionId: String, captureId: String) throws {
    do {
      guard cancellationFence.transition(
        sessionId: sessionId,
        captureId: captureId,
        to: .starting
      ) else { throw CaptureCancellationRequested() }
      try startPreparedOnQueue(sessionId: sessionId, captureId: captureId)
      guard cancellationFence.transition(
        sessionId: sessionId,
        captureId: captureId,
        to: .capturing
      ) else { throw CaptureCancellationRequested() }
    } catch {
      releaseV2OnQueue(sessionId: sessionId, captureId: captureId)
      if let failure = error as? CaptureFailure { throw failure }
      throw CaptureFailure.captureInitializationFailed
    }
  }

  private func releaseV2OnQueue(sessionId: String, captureId: String) {
    if activeSessionId == sessionId, activeCaptureId == captureId {
      stopOnQueue(reason: .requested, emitEvent: true)
      return
    }
    completeV2ReleaseOnQueue(
      sessionId: sessionId,
      captureId: captureId,
      physicalReleaseProven: false,
      reason: .requested,
      emitEvent: true
    )
  }

  private func completeV2ReleaseOnQueue(
    sessionId: String,
    captureId: String,
    physicalReleaseProven: Bool,
    reason: CaptureStopReason,
    emitEvent: Bool
  ) {
    if cancellationFence.phase(sessionId: sessionId, captureId: captureId) == .released { return }
    _ = cancellationFence.requestCancellation(sessionId: sessionId, captureId: captureId)
    let firstTerminal = cancellationFence.markReleased(
      sessionId: sessionId,
      captureId: captureId,
      physicalReleaseProven: physicalReleaseProven
    )
    if emitEvent && firstTerminal {
      emitOnQueue("onCaptureStopped", [
        "sessionId": sessionId,
        "captureId": captureId,
        "reason": reason.rawValue
      ])
    }
  }

  private func throwIfV2Cancelled(sessionId: String, captureId: String?) throws {
    guard let captureId else { return }
    if cancellationFence.isCancellationRequested(sessionId: sessionId, captureId: captureId) {
      throw CaptureCancellationRequested()
    }
  }

  private func installWatchdogOnQueue(
    generation: UInt64,
    durationMs: Int,
    phase: BobLiveAudioWatchdogPhase
  ) {
    cancelWatchdogOnQueue()
    let token = watchdogFence.arm(phase)
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      // `DispatchWorkItem.cancel()` ne garantit pas qu'un callback deja enfile ne s'execute pas.
      // Le jeton rend donc l'ancien callback inoffensif, et la phase interdit au watchdog de
      // preparation d'arreter une capture deja demarree sous la meme generation audio.
      guard generation == self.activeGeneration,
            self.watchdogFence.accepts(
              token: token,
              phase: phase,
              captureRunning: self.captureRunning
            ) else { return }
      self.failOnQueue(
        generation: generation,
        errorCode: "capture_watchdog_expired",
        reason: .watchdogTimeout
      )
    }
    watchdog = work
    captureQueue.asyncAfter(
      deadline: .now() + .milliseconds(durationMs),
      execute: work
    )
  }

  private func cancelWatchdogOnQueue() {
    watchdogFence.cancel()
    watchdog?.cancel()
    watchdog = nil
  }

  private func installHeartbeatWatchdogOnQueue(generation: UInt64) {
    cancelHeartbeatWatchdogOnQueue()
    let timer = DispatchSource.makeTimerSource(queue: captureQueue)
    timer.schedule(
      deadline: .now() + .milliseconds(captureHeartbeatIntervalMs),
      repeating: .milliseconds(captureHeartbeatIntervalMs),
      leeway: .milliseconds(250)
    )
    timer.setEventHandler { [weak self] in
      guard let self,
            generation == self.activeGeneration,
            self.captureRunning,
            self.activeSessionId != nil else { return }

      let audioSession = AVAudioSession.sharedInstance()
      let routeChanged = self.activeRouteSignature != Self.audioRouteSignature(audioSession)
      guard self.ownsAudioSessionConfigurationOnQueue(generation: generation),
            !routeChanged,
            self.engine?.isRunning == true else {
        self.failOnQueue(
          generation: generation,
          errorCode: "capture_interrupted",
          reason: .interruption
        )
        return
      }

      let now = ProcessInfo.processInfo.systemUptime * 1_000
      guard let lastPcmAtMonotonicMs = self.lastPcmAtMonotonicMs,
            now - lastPcmAtMonotonicMs < maximumPcmSilenceMs else {
        self.failOnQueue(
          generation: generation,
          errorCode: "capture_runtime_failed",
          reason: .captureError
        )
        return
      }
    }
    heartbeatWatchdog = timer
    timer.resume()
  }

  private func cancelHeartbeatWatchdogOnQueue() {
    heartbeatWatchdog?.cancel()
    heartbeatWatchdog = nil
  }

  private func cleanupEngineOnQueue() {
    guard let engine else { return }
    let input = engine.inputNode
    if tapInstalled {
      input.removeTap(onBus: 0)
      tapInstalled = false
    }
    engine.stop()
    if voiceProcessingEnabled, input.isVoiceProcessingEnabled {
      try? input.setVoiceProcessingEnabled(false)
    }
    voiceProcessingEnabled = false
    self.engine = nil
  }

  private func restoreAudioSessionOnQueue(generation: UInt64) {
    guard let lease = audioSessionLease, lease.generation == generation else { return }
    let audioSession = AVAudioSession.sharedInstance()
    audioSessionLease = nil

    // Une autre brique audio peut avoir repris la session pendant la capture. Dans ce cas Bob
    // abandonne son lease sans deactivation ni restauration afin de ne jamais l'ecraser.
    let stillOwnsConfiguration = audioSession.category == .playAndRecord
      && audioSession.mode == .voiceChat
      && audioSession.categoryOptions == bobAudioSessionOptions
    guard stillOwnsConfiguration else { return }

    if lease.activationOwned {
      try? audioSession.setActive(false, options: [.notifyOthersOnDeactivation])
    }
    try? audioSession.setCategory(
      lease.snapshot.category,
      mode: lease.snapshot.mode,
      options: lease.snapshot.options
    )
    try? audioSession.setPreferredSampleRate(lease.snapshot.preferredSampleRate)
    try? audioSession.setPreferredIOBufferDuration(lease.snapshot.preferredIOBufferDuration)
  }

  private func ownsAudioSessionConfigurationOnQueue(generation: UInt64) -> Bool {
    guard let lease = audioSessionLease, lease.generation == generation else { return false }
    let audioSession = AVAudioSession.sharedInstance()
    return audioSession.category == .playAndRecord
      && audioSession.mode == .voiceChat
      && audioSession.categoryOptions == bobAudioSessionOptions
  }

  private func installAudioObserversOnQueue() {
    guard notificationObservers.isEmpty else { return }
    let center = NotificationCenter.default
    let interruption = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: rawType) == .began,
            let self else { return }
      self.captureQueue.async {
        guard self.activeSessionId != nil else { return }
        self.failOnQueue(
          generation: self.activeGeneration,
          errorCode: "capture_interrupted",
          reason: .interruption
        )
      }
    }
    let servicesLost = center.addObserver(
      forName: AVAudioSession.mediaServicesWereLostNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard let self else { return }
      self.captureQueue.async {
        guard self.activeSessionId != nil else { return }
        self.failOnQueue(
          generation: self.activeGeneration,
          errorCode: "capture_interrupted",
          reason: .interruption
        )
      }
    }
    let servicesReset = center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard let self else { return }
      self.captureQueue.async {
        guard self.activeSessionId != nil else { return }
        self.failOnQueue(
          generation: self.activeGeneration,
          errorCode: "capture_interrupted",
          reason: .interruption
        )
      }
    }
    let routeChanged = center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard let self else { return }
      self.captureQueue.async {
        guard self.captureRunning,
              let expectedRoute = self.activeRouteSignature,
              expectedRoute != Self.audioRouteSignature(AVAudioSession.sharedInstance()) else {
          return
        }
        self.failOnQueue(
          generation: self.activeGeneration,
          errorCode: "capture_interrupted",
          reason: .interruption
        )
      }
    }
    notificationObservers = [interruption, servicesLost, servicesReset, routeChanged]
  }

  private func removeAudioObserversOnQueue() {
    let center = NotificationCenter.default
    notificationObservers.forEach(center.removeObserver)
    notificationObservers.removeAll(keepingCapacity: false)
  }

  private func emitOnQueue(_ name: String, _ body: [String: Any?]) {
    guard eventsEnabled else { return }
    sendEvent(name, body)
  }

  private static func convert(
    buffer: AVAudioPCMBuffer,
    converter: AVAudioConverter,
    targetFormat: AVAudioFormat
  ) throws -> Data? {
    let ratio = targetFormat.sampleRate / buffer.format.sampleRate
    let capacity = max(1, AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio)) + 1)
    guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
      throw CaptureFailure.captureInitializationFailed
    }
    let inputState = ConversionInputState()
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
      if inputState.supplied {
        inputStatus.pointee = .noDataNow
        return nil
      }
      inputState.supplied = true
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .error || conversionError != nil {
      throw CaptureFailure.captureInitializationFailed
    }
    guard output.frameLength > 0, let samples = output.int16ChannelData?[0] else { return nil }
    return Data(bytes: samples, count: Int(output.frameLength) * MemoryLayout<Int16>.size)
  }

  private static func hasMicrophonePermission(_ audioSession: AVAudioSession) -> Bool {
    if #available(iOS 17.0, *) {
      return AVAudioApplication.shared.recordPermission == .granted
    }
    return audioSession.recordPermission == .granted
  }

  private static func monotonicNanoseconds() -> UInt64 {
    let nanoseconds = ProcessInfo.processInfo.systemUptime * 1_000_000_000
    guard nanoseconds.isFinite, nanoseconds > 0 else { return 0 }
    if nanoseconds >= Double(UInt64.max) { return UInt64.max }
    return UInt64(nanoseconds.rounded(.down))
  }

  private static func monotonicMilliseconds(_ nanoseconds: UInt64) -> Double {
    let wholeMilliseconds = nanoseconds / 1_000_000
    let remainingNanoseconds = nanoseconds % 1_000_000
    return Double(wholeMilliseconds) + Double(remainingNanoseconds) / 1_000_000
  }

  private static func isJavascriptSafeTimestamp(_ nanoseconds: UInt64) -> Bool {
    let wholeMilliseconds = nanoseconds / 1_000_000
    return wholeMilliseconds < javascriptMaximumSafeInteger
      || (wholeMilliseconds == javascriptMaximumSafeInteger
        && nanoseconds.isMultiple(of: 1_000_000))
  }

  private static func audioRouteSignature(_ audioSession: AVAudioSession) -> String {
    let route = audioSession.currentRoute
    let inputs = route.inputs.map { "in:\($0.portType.rawValue):\($0.uid)" }
    let outputs = route.outputs.map { "out:\($0.portType.rawValue):\($0.uid)" }
    return (inputs + outputs).joined(separator: "|")
  }

  private static func isValidSessionId(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil
  }
}
