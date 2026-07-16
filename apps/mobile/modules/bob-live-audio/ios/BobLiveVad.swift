import Foundation

/// Wire-level timing profile shared by `prepareAsync`, emitted VAD events and the JS decoder.
/// A timing change is a new profile version; reusing this identifier with different values would
/// make an OTA bundle and an installed native binary silently disagree.
enum BobLiveVadProfileV1 {
  static let version = "bob-live-vad-foundation-1"
  static let sampleRateHz = 16_000
  static let channels = 1
  static let analysisWindowMs = 20
  static let preRollMs = 240
  static let speechStartMs = 60
  static let speechEndMs = 700
  static let maximumUtteranceMs = 30_000
  static let speechStartWindows = speechStartMs / analysisWindowMs
  static let speechEndWindows = speechEndMs / analysisWindowMs
}

/// Versioned, deterministic configuration for the local Bob Live VAD.
///
/// The default values are conservative engineering defaults, not production acoustic tuning.
/// They must be certified and, when necessary, revised against the real device/route/noise
/// corpus before `fullDuplexCertified` can become true.
struct BobLiveVadConfiguration: Equatable {
  static let deterministicV1 = BobLiveVadConfiguration(
    uncheckedVersion: BobLiveVadProfileV1.version,
    sampleRateHz: BobLiveVadProfileV1.sampleRateHz,
    channels: BobLiveVadProfileV1.channels,
    analysisWindowMs: BobLiveVadProfileV1.analysisWindowMs,
    preRollMs: BobLiveVadProfileV1.preRollMs,
    speechStartWindows: BobLiveVadProfileV1.speechStartWindows,
    speechEndWindows: BobLiveVadProfileV1.speechEndWindows,
    maximumUtteranceMs: BobLiveVadProfileV1.maximumUtteranceMs,
    initialNoiseFloorDbfs: -60,
    minimumNoiseFloorDbfs: -72,
    maximumNoiseFloorDbfs: -30,
    minimumOnsetDbfs: -42,
    minimumSustainDbfs: -48,
    onsetAboveNoiseDb: 10,
    sustainAboveNoiseDb: 6,
    playbackOnsetMarginDb: 6,
    noiseRiseAlpha: 0.02,
    noiseFallAlpha: 0.10,
    maximumNoiseRisePerWindowDb: 1,
    maximumNoiseFallPerWindowDb: 3
  )

  let version: String
  let sampleRateHz: Int
  let channels: Int
  let analysisWindowMs: Int
  let preRollMs: Int
  let speechStartWindows: Int
  let speechEndWindows: Int
  let maximumUtteranceMs: Int
  let initialNoiseFloorDbfs: Double
  let minimumNoiseFloorDbfs: Double
  let maximumNoiseFloorDbfs: Double
  let minimumOnsetDbfs: Double
  let minimumSustainDbfs: Double
  let onsetAboveNoiseDb: Double
  let sustainAboveNoiseDb: Double
  let playbackOnsetMarginDb: Double
  let noiseRiseAlpha: Double
  let noiseFallAlpha: Double
  let maximumNoiseRisePerWindowDb: Double
  let maximumNoiseFallPerWindowDb: Double

  /// Builds an injectable configuration only after validating every real-time invariant.
  init(
    version: String,
    sampleRateHz: Int,
    channels: Int,
    analysisWindowMs: Int,
    preRollMs: Int,
    speechStartWindows: Int,
    speechEndWindows: Int,
    maximumUtteranceMs: Int,
    initialNoiseFloorDbfs: Double,
    minimumNoiseFloorDbfs: Double,
    maximumNoiseFloorDbfs: Double,
    minimumOnsetDbfs: Double,
    minimumSustainDbfs: Double,
    onsetAboveNoiseDb: Double,
    sustainAboveNoiseDb: Double,
    playbackOnsetMarginDb: Double,
    noiseRiseAlpha: Double,
    noiseFallAlpha: Double,
    maximumNoiseRisePerWindowDb: Double,
    maximumNoiseFallPerWindowDb: Double
  ) throws {
    self.init(
      uncheckedVersion: version,
      sampleRateHz: sampleRateHz,
      channels: channels,
      analysisWindowMs: analysisWindowMs,
      preRollMs: preRollMs,
      speechStartWindows: speechStartWindows,
      speechEndWindows: speechEndWindows,
      maximumUtteranceMs: maximumUtteranceMs,
      initialNoiseFloorDbfs: initialNoiseFloorDbfs,
      minimumNoiseFloorDbfs: minimumNoiseFloorDbfs,
      maximumNoiseFloorDbfs: maximumNoiseFloorDbfs,
      minimumOnsetDbfs: minimumOnsetDbfs,
      minimumSustainDbfs: minimumSustainDbfs,
      onsetAboveNoiseDb: onsetAboveNoiseDb,
      sustainAboveNoiseDb: sustainAboveNoiseDb,
      playbackOnsetMarginDb: playbackOnsetMarginDb,
      noiseRiseAlpha: noiseRiseAlpha,
      noiseFallAlpha: noiseFallAlpha,
      maximumNoiseRisePerWindowDb: maximumNoiseRisePerWindowDb,
      maximumNoiseFallPerWindowDb: maximumNoiseFallPerWindowDb
    )
    try validate()
  }

  private init(
    uncheckedVersion version: String,
    sampleRateHz: Int,
    channels: Int,
    analysisWindowMs: Int,
    preRollMs: Int,
    speechStartWindows: Int,
    speechEndWindows: Int,
    maximumUtteranceMs: Int,
    initialNoiseFloorDbfs: Double,
    minimumNoiseFloorDbfs: Double,
    maximumNoiseFloorDbfs: Double,
    minimumOnsetDbfs: Double,
    minimumSustainDbfs: Double,
    onsetAboveNoiseDb: Double,
    sustainAboveNoiseDb: Double,
    playbackOnsetMarginDb: Double,
    noiseRiseAlpha: Double,
    noiseFallAlpha: Double,
    maximumNoiseRisePerWindowDb: Double,
    maximumNoiseFallPerWindowDb: Double
  ) {
    self.version = version
    self.sampleRateHz = sampleRateHz
    self.channels = channels
    self.analysisWindowMs = analysisWindowMs
    self.preRollMs = preRollMs
    self.speechStartWindows = speechStartWindows
    self.speechEndWindows = speechEndWindows
    self.maximumUtteranceMs = maximumUtteranceMs
    self.initialNoiseFloorDbfs = initialNoiseFloorDbfs
    self.minimumNoiseFloorDbfs = minimumNoiseFloorDbfs
    self.maximumNoiseFloorDbfs = maximumNoiseFloorDbfs
    self.minimumOnsetDbfs = minimumOnsetDbfs
    self.minimumSustainDbfs = minimumSustainDbfs
    self.onsetAboveNoiseDb = onsetAboveNoiseDb
    self.sustainAboveNoiseDb = sustainAboveNoiseDb
    self.playbackOnsetMarginDb = playbackOnsetMarginDb
    self.noiseRiseAlpha = noiseRiseAlpha
    self.noiseFallAlpha = noiseFallAlpha
    self.maximumNoiseRisePerWindowDb = maximumNoiseRisePerWindowDb
    self.maximumNoiseFallPerWindowDb = maximumNoiseFallPerWindowDb
  }

  private func validate() throws {
    guard !version.isEmpty,
          version.utf8.count <= 64,
          version.unicodeScalars.allSatisfy({ scalar in
            switch scalar.value {
            case 45, 46, 48...57, 65...90, 95, 97...122:
              return true
            default:
              return false
            }
          }) else {
      throw BobLiveVadConfigurationError.invalidVersion
    }
    guard version == BobLiveVadProfileV1.version else {
      throw BobLiveVadConfigurationError.unsupportedProfile
    }
    guard sampleRateHz == BobLiveVadProfileV1.sampleRateHz else {
      throw BobLiveVadConfigurationError.unsupportedSampleRate
    }
    guard channels == BobLiveVadProfileV1.channels else {
      throw BobLiveVadConfigurationError.unsupportedChannelCount
    }
    guard analysisWindowMs == BobLiveVadProfileV1.analysisWindowMs else {
      throw BobLiveVadConfigurationError.unsupportedAnalysisWindow
    }
    guard preRollMs == BobLiveVadProfileV1.preRollMs else {
      throw BobLiveVadConfigurationError.invalidPreRoll
    }
    guard speechStartWindows == BobLiveVadProfileV1.speechStartWindows,
          speechEndWindows == BobLiveVadProfileV1.speechEndWindows else {
      throw BobLiveVadConfigurationError.invalidHysteresis
    }
    guard maximumUtteranceMs == BobLiveVadProfileV1.maximumUtteranceMs else {
      throw BobLiveVadConfigurationError.invalidMaximumUtterance
    }

    let dbValues = [
      initialNoiseFloorDbfs,
      minimumNoiseFloorDbfs,
      maximumNoiseFloorDbfs,
      minimumOnsetDbfs,
      minimumSustainDbfs,
      onsetAboveNoiseDb,
      sustainAboveNoiseDb,
      playbackOnsetMarginDb,
      maximumNoiseRisePerWindowDb,
      maximumNoiseFallPerWindowDb,
    ]
    guard dbValues.allSatisfy(\.isFinite),
          minimumNoiseFloorDbfs >= -120,
          minimumNoiseFloorDbfs < maximumNoiseFloorDbfs,
          maximumNoiseFloorDbfs <= -1,
          (minimumNoiseFloorDbfs...maximumNoiseFloorDbfs).contains(initialNoiseFloorDbfs),
          minimumSustainDbfs >= -120,
          minimumSustainDbfs < minimumOnsetDbfs,
          minimumOnsetDbfs <= 0,
          onsetAboveNoiseDb >= 0,
          onsetAboveNoiseDb <= 40,
          sustainAboveNoiseDb >= 0,
          sustainAboveNoiseDb <= 40,
          onsetAboveNoiseDb > sustainAboveNoiseDb,
          playbackOnsetMarginDb >= 0,
          playbackOnsetMarginDb <= 40,
          maximumNoiseRisePerWindowDb > 0,
          maximumNoiseRisePerWindowDb <= 30,
          maximumNoiseFallPerWindowDb > 0,
          maximumNoiseFallPerWindowDb <= 30 else {
      throw BobLiveVadConfigurationError.invalidDecibelRange
    }
    guard noiseRiseAlpha.isFinite,
          noiseFallAlpha.isFinite,
          noiseRiseAlpha >= 0,
          noiseRiseAlpha <= 1,
          noiseFallAlpha >= 0,
          noiseFallAlpha <= 1 else {
      throw BobLiveVadConfigurationError.invalidNoiseAdaptation
    }
  }
}

enum BobLiveVadConfigurationError: Error, Equatable {
  case invalidVersion
  case unsupportedProfile
  case unsupportedSampleRate
  case unsupportedChannelCount
  case unsupportedAnalysisWindow
  case invalidPreRoll
  case invalidHysteresis
  case invalidMaximumUtterance
  case invalidDecibelRange
  case invalidNoiseAdaptation
}

/// Opaque generation returned by `reset()`. A callback from an older capture can never mutate
/// the new detector because callers must present the exact active token to `process`.
struct BobLiveVadGeneration: Equatable, Hashable {
  let rawValue: UInt64
}

enum BobLiveVadInputDisposition: Equatable {
  case accepted
  case acceptedAfterGap
  case ignoredInactiveGeneration
  case rejectedUnsupportedFrameSize
  case rejectedNonMonotonicTimestamp
  case rejectedTimestampOverflow
}

enum BobLiveVadEventKind: Equatable {
  case speechStarted
  case speechEnded
}

/// Timestamped metadata only. The audio pre-roll remains owned by the native ring buffer that
/// will consume this foundation; this pure detector never allocates or retains utterance audio.
struct BobLiveVadEvent: Equatable {
  let kind: BobLiveVadEventKind
  let configurationVersion: String
  let generation: BobLiveVadGeneration
  let utteranceIndex: UInt64
  let detectedAtNanoseconds: UInt64
  let preRollStartAtNanoseconds: UInt64
  let preRollMs: Int
  let startedAtNanoseconds: UInt64
  let endedAtNanoseconds: UInt64?
  let forcedEnd: Bool
  let energyDbfs: Double
  let noiseFloorDbfs: Double
}

/// Pure fail-closed validation immediately before a VAD transition crosses the Expo bridge.
/// The detector and this validator deliberately share the immutable negotiated configuration;
/// accepting a looser timeline here would make native and OTA contracts diverge silently.
enum BobLiveVadBridgeContract {
  static let javascriptMaximumSafeInteger: UInt64 = 9_007_199_254_740_991

  static func isValid(
    _ event: BobLiveVadEvent,
    expectedGeneration: BobLiveVadGeneration,
    configuration: BobLiveVadConfiguration
  ) -> Bool {
    guard event.configurationVersion == configuration.version,
          configuration.version == BobLiveVadProfileV1.version,
          event.generation == expectedGeneration,
          event.utteranceIndex > 0,
          event.utteranceIndex <= javascriptMaximumSafeInteger,
          event.preRollMs >= 0,
          event.preRollMs <= configuration.preRollMs,
          event.preRollMs.isMultiple(of: configuration.analysisWindowMs),
          event.preRollStartAtNanoseconds <= event.startedAtNanoseconds,
          event.startedAtNanoseconds <= event.detectedAtNanoseconds,
          isJavascriptSafeTimestamp(event.startedAtNanoseconds),
          isJavascriptSafeTimestamp(event.detectedAtNanoseconds),
          event.startedAtNanoseconds - event.preRollStartAtNanoseconds
            == UInt64(event.preRollMs) * nanosecondsPerMillisecond,
          event.energyDbfs.isFinite,
          (-120.0...0.0).contains(event.energyDbfs),
          event.noiseFloorDbfs.isFinite,
          (configuration.minimumNoiseFloorDbfs...configuration.maximumNoiseFloorDbfs)
            .contains(event.noiseFloorDbfs) else {
      return false
    }

    let speechStartNanoseconds = UInt64(
      configuration.speechStartWindows * configuration.analysisWindowMs
    ) * nanosecondsPerMillisecond
    let speechEndNanoseconds = UInt64(
      configuration.speechEndWindows * configuration.analysisWindowMs
    ) * nanosecondsPerMillisecond
    let maximumUtteranceNanoseconds = UInt64(configuration.maximumUtteranceMs)
      * nanosecondsPerMillisecond
    let analysisWindowNanoseconds = UInt64(configuration.analysisWindowMs)
      * nanosecondsPerMillisecond

    switch event.kind {
    case .speechStarted:
      return event.endedAtNanoseconds == nil
        && !event.forcedEnd
        && event.detectedAtNanoseconds - event.startedAtNanoseconds
          == speechStartNanoseconds

    case .speechEnded:
      guard let endedAtNanoseconds = event.endedAtNanoseconds,
            endedAtNanoseconds >= event.startedAtNanoseconds,
            endedAtNanoseconds <= event.detectedAtNanoseconds,
            isJavascriptSafeTimestamp(endedAtNanoseconds) else {
        return false
      }
      let utteranceDurationNanoseconds = endedAtNanoseconds
        - event.startedAtNanoseconds
      if event.forcedEnd {
        return utteranceDurationNanoseconds == maximumUtteranceNanoseconds
          && event.detectedAtNanoseconds == endedAtNanoseconds
      }
      return utteranceDurationNanoseconds >= speechStartNanoseconds
        && utteranceDurationNanoseconds.isMultiple(of: analysisWindowNanoseconds)
        && event.detectedAtNanoseconds - event.startedAtNanoseconds
          < maximumUtteranceNanoseconds
        && event.detectedAtNanoseconds - endedAtNanoseconds == speechEndNanoseconds
    }
  }

  private static let nanosecondsPerMillisecond: UInt64 = 1_000_000

  private static func isJavascriptSafeTimestamp(_ nanoseconds: UInt64) -> Bool {
    let wholeMilliseconds = nanoseconds / nanosecondsPerMillisecond
    return wholeMilliseconds < javascriptMaximumSafeInteger
      || (wholeMilliseconds == javascriptMaximumSafeInteger
        && nanoseconds.isMultiple(of: nanosecondsPerMillisecond))
  }
}

/// Fixed-capacity event batch. A supported input contains at most two 20 ms analysis windows, so
/// two slots cover every possible transition without allocating an Array in the audio hot path.
struct BobLiveVadEventBatch: Equatable {
  fileprivate(set) var first: BobLiveVadEvent?
  fileprivate(set) var second: BobLiveVadEvent?

  var count: Int {
    if second != nil { return 2 }
    if first != nil { return 1 }
    return 0
  }

  fileprivate mutating func append(_ event: BobLiveVadEvent) {
    if first == nil {
      first = event
    } else if second == nil {
      second = event
    }
  }
}

struct BobLiveVadProcessResult: Equatable {
  let disposition: BobLiveVadInputDisposition
  let analysisWindowsProcessed: Int
  let bufferedSamples: Int
  let lastEnergyDbfs: Double?
  let noiseFloorDbfs: Double
  let events: BobLiveVadEventBatch
}

/// Alignment-independent PCM16 little-endian decoder.
///
/// `Data` exposes raw bytes but does not contractually guarantee `Int16` alignment. The caller
/// owns and reuses the destination storage, so this helper performs no allocation in the hot path.
enum BobLivePcm16LittleEndian {
  static func decode(
    _ bytes: UnsafeRawBufferPointer,
    into samples: UnsafeMutableBufferPointer<Int16>
  ) -> Bool {
    let (requiredByteCount, byteCountOverflow) = samples.count
      .multipliedReportingOverflow(by: MemoryLayout<Int16>.size)
    guard !byteCountOverflow, bytes.count == requiredByteCount else { return false }
    for sampleIndex in 0..<samples.count {
      let byteIndex = sampleIndex * MemoryLayout<Int16>.size
      let bits = UInt16(bytes[byteIndex]) | (UInt16(bytes[byteIndex + 1]) << 8)
      samples[sampleIndex] = Int16(bitPattern: bits)
    }
    return true
  }
}

/// Pure PCM16 mono 16 kHz energy VAD with deterministic hysteresis.
///
/// Calls must be serialized by the native audio queue. Accepted input sizes are 10, 20 and 40 ms
/// (160/320/640 samples); all decisions are made on 20 ms windows so callback chunking cannot
/// change the transition semantics.
struct BobLiveVad {
  private enum Phase {
    case idle
    case speaking
    case forcedCooldown
  }

  private static let pcmFullScale = 32_768.0
  private static let minimumMeasuredDbfs = -120.0
  private static let nanosecondsPerMillisecond: UInt64 = 1_000_000

  let configuration: BobLiveVadConfiguration

  private let analysisSamples: Int
  private let sampleDurationNanoseconds: UInt64
  private var partialWindow: [Int16]
  private var partialSampleCount = 0
  private var partialStartedAtNanoseconds: UInt64?
  private var partialIncludesPlayback = false

  private var generationCounter: UInt64 = 0
  private var activeGeneration: BobLiveVadGeneration?
  private var phase: Phase = .idle
  private var noiseFloorDbfs: Double
  private var consecutiveOnsetWindows = 0
  private var onsetStartedAtNanoseconds: UInt64?
  private var consecutiveBelowSustainWindows = 0
  private var continuousAudioStartedAtNanoseconds: UInt64?
  private var lastInputEndedAtNanoseconds: UInt64?

  private var utteranceCounter: UInt64 = 0
  private var activeUtteranceIndex: UInt64?
  private var speechStartedAtNanoseconds: UInt64?
  private var speechPreRollStartedAtNanoseconds: UInt64?
  private var speechPreRollMs = 0
  private var trailingSilenceStartedAtNanoseconds: UInt64?

  init(configuration: BobLiveVadConfiguration = .deterministicV1) {
    self.configuration = configuration
    analysisSamples = configuration.sampleRateHz * configuration.analysisWindowMs / 1_000
    sampleDurationNanoseconds = 1_000_000_000 / UInt64(configuration.sampleRateHz)
    partialWindow = [Int16](repeating: 0, count: analysisSamples)
    noiseFloorDbfs = configuration.initialNoiseFloorDbfs
  }

  /// Invalidates the previous token, clears all temporal evidence and returns a fresh generation.
  /// Returns nil only after the UInt64 generation space is exhausted, failing closed forever.
  mutating func reset() -> BobLiveVadGeneration? {
    clearTemporalState(resetNoiseFloor: true)
    guard generationCounter < UInt64.max else {
      activeGeneration = nil
      return nil
    }
    generationCounter += 1
    let generation = BobLiveVadGeneration(rawValue: generationCounter)
    activeGeneration = generation
    return generation
  }

  /// Idempotently invalidates only the active generation. A stale stop cannot cancel its successor.
  @discardableResult
  mutating func invalidate(generation: BobLiveVadGeneration) -> Bool {
    guard generation == activeGeneration else { return false }
    activeGeneration = nil
    clearTemporalState(resetNoiseFloor: true)
    return true
  }

  mutating func process(
    pcm16 samples: UnsafeBufferPointer<Int16>,
    capturedAtNanoseconds: UInt64,
    generation: BobLiveVadGeneration,
    playbackActive: Bool
  ) -> BobLiveVadProcessResult {
    guard generation == activeGeneration else {
      return result(disposition: .ignoredInactiveGeneration)
    }
    guard samples.count == analysisSamples / 2
            || samples.count == analysisSamples
            || samples.count == analysisSamples * 2 else {
      return result(disposition: .rejectedUnsupportedFrameSize)
    }

    let (inputDurationNanoseconds, durationOverflow) = UInt64(samples.count)
      .multipliedReportingOverflow(by: sampleDurationNanoseconds)
    guard !durationOverflow else {
      return result(disposition: .rejectedTimestampOverflow)
    }
    let (inputEndedAtNanoseconds, timestampOverflow) = capturedAtNanoseconds
      .addingReportingOverflow(inputDurationNanoseconds)
    guard !timestampOverflow else {
      return result(disposition: .rejectedTimestampOverflow)
    }
    if let lastInputEndedAtNanoseconds,
       capturedAtNanoseconds < lastInputEndedAtNanoseconds {
      return result(disposition: .rejectedNonMonotonicTimestamp)
    }

    let hasGap = lastInputEndedAtNanoseconds.map {
      capturedAtNanoseconds > $0
    } ?? false
    if continuousAudioStartedAtNanoseconds == nil || hasGap {
      continuousAudioStartedAtNanoseconds = capturedAtNanoseconds
    }
    if hasGap {
      discardPartialWindow()
      resetConsecutiveEvidenceForGap()
    }
    lastInputEndedAtNanoseconds = inputEndedAtNanoseconds

    var events = BobLiveVadEventBatch()
    var analysisWindowsProcessed = 0
    var lastEnergyDbfs: Double?
    var sourceIndex = 0

    if partialSampleCount > 0 {
      let required = analysisSamples - partialSampleCount
      let copied = min(required, samples.count)
      if copied > 0 {
        for index in 0..<copied {
          partialWindow[partialSampleCount + index] = samples[index]
        }
        partialSampleCount += copied
        partialIncludesPlayback = partialIncludesPlayback || playbackActive
        sourceIndex += copied
      }
      if partialSampleCount == analysisSamples,
         let windowStartedAtNanoseconds = partialStartedAtNanoseconds {
        let energyDbfs = partialWindow.withUnsafeBufferPointer {
          Self.measureDbfsRemovingDc($0)
        }
        processAnalysisWindow(
          energyDbfs: energyDbfs,
          startedAtNanoseconds: windowStartedAtNanoseconds,
          playbackActive: partialIncludesPlayback,
          generation: generation,
          events: &events
        )
        analysisWindowsProcessed += 1
        lastEnergyDbfs = energyDbfs
        discardPartialWindow()
      }
    }

    while samples.count - sourceIndex >= analysisSamples {
      let window = UnsafeBufferPointer(rebasing: samples[sourceIndex..<(sourceIndex + analysisSamples)])
      let offsetNanoseconds = UInt64(sourceIndex) * sampleDurationNanoseconds
      let windowStartedAtNanoseconds = capturedAtNanoseconds + offsetNanoseconds
      let energyDbfs = Self.measureDbfsRemovingDc(window)
      processAnalysisWindow(
        energyDbfs: energyDbfs,
        startedAtNanoseconds: windowStartedAtNanoseconds,
        playbackActive: playbackActive,
        generation: generation,
        events: &events
      )
      analysisWindowsProcessed += 1
      lastEnergyDbfs = energyDbfs
      sourceIndex += analysisSamples
    }

    let remaining = samples.count - sourceIndex
    if remaining > 0 {
      partialStartedAtNanoseconds = capturedAtNanoseconds
        + UInt64(sourceIndex) * sampleDurationNanoseconds
      partialIncludesPlayback = playbackActive
      for index in 0..<remaining {
        partialWindow[index] = samples[sourceIndex + index]
      }
      partialSampleCount = remaining
    }

    return BobLiveVadProcessResult(
      disposition: hasGap ? .acceptedAfterGap : .accepted,
      analysisWindowsProcessed: analysisWindowsProcessed,
      bufferedSamples: partialSampleCount,
      lastEnergyDbfs: lastEnergyDbfs,
      noiseFloorDbfs: noiseFloorDbfs,
      events: events
    )
  }

  private mutating func processAnalysisWindow(
    energyDbfs: Double,
    startedAtNanoseconds: UInt64,
    playbackActive: Bool,
    generation: BobLiveVadGeneration,
    events: inout BobLiveVadEventBatch
  ) {
    let windowDurationNanoseconds = UInt64(configuration.analysisWindowMs)
      * Self.nanosecondsPerMillisecond
    let windowEndedAtNanoseconds = startedAtNanoseconds + windowDurationNanoseconds
    let onsetThresholdDbfs = min(0, max(
      configuration.minimumOnsetDbfs,
      noiseFloorDbfs + configuration.onsetAboveNoiseDb
    ) + (playbackActive ? configuration.playbackOnsetMarginDb : 0))
    let sustainThresholdDbfs = min(0, max(
      configuration.minimumSustainDbfs,
      noiseFloorDbfs + configuration.sustainAboveNoiseDb
    ))

    switch phase {
    case .idle:
      if energyDbfs >= onsetThresholdDbfs {
        if consecutiveOnsetWindows == 0 {
          onsetStartedAtNanoseconds = startedAtNanoseconds
        }
        consecutiveOnsetWindows += 1
        if consecutiveOnsetWindows >= configuration.speechStartWindows,
           let startedAtNanoseconds = onsetStartedAtNanoseconds {
          beginSpeech(
            startedAtNanoseconds: startedAtNanoseconds,
            detectedAtNanoseconds: windowEndedAtNanoseconds,
            energyDbfs: energyDbfs,
            generation: generation,
            events: &events
          )
        }
      } else {
        consecutiveOnsetWindows = 0
        onsetStartedAtNanoseconds = nil
        // The band between sustain and onset is suspicious energy. Do not teach it to the
        // environment model, especially while playback echo may be present.
        if energyDbfs < sustainThresholdDbfs {
          adaptNoiseFloor(towards: energyDbfs)
        }
      }

    case .speaking:
      guard let speechStartedAtNanoseconds else {
        phase = .idle
        return
      }
      let maximumDurationNanoseconds = UInt64(configuration.maximumUtteranceMs)
        * Self.nanosecondsPerMillisecond
      let maximumEnd = speechStartedAtNanoseconds.addingReportingOverflow(
        maximumDurationNanoseconds
      )
      let forcedEndAtNanoseconds = maximumEnd.overflow ? UInt64.max : maximumEnd.partialValue
      if windowEndedAtNanoseconds >= forcedEndAtNanoseconds {
        endSpeech(
          endedAtNanoseconds: forcedEndAtNanoseconds,
          detectedAtNanoseconds: windowEndedAtNanoseconds,
          forced: true,
          energyDbfs: energyDbfs,
          generation: generation,
          events: &events
        )
        phase = .forcedCooldown
        consecutiveBelowSustainWindows = 0
      } else if energyDbfs < sustainThresholdDbfs {
        if consecutiveBelowSustainWindows == 0 {
          trailingSilenceStartedAtNanoseconds = startedAtNanoseconds
        }
        consecutiveBelowSustainWindows += 1
        if consecutiveBelowSustainWindows >= configuration.speechEndWindows {
          endSpeech(
            endedAtNanoseconds: trailingSilenceStartedAtNanoseconds
              ?? startedAtNanoseconds,
            detectedAtNanoseconds: windowEndedAtNanoseconds,
            forced: false,
            energyDbfs: energyDbfs,
            generation: generation,
            events: &events
          )
          phase = .idle
          adaptNoiseFloor(towards: energyDbfs)
        }
      } else {
        consecutiveBelowSustainWindows = 0
        trailingSilenceStartedAtNanoseconds = nil
      }

    case .forcedCooldown:
      if energyDbfs < sustainThresholdDbfs {
        consecutiveBelowSustainWindows += 1
        if consecutiveBelowSustainWindows >= configuration.speechEndWindows {
          phase = .idle
          consecutiveBelowSustainWindows = 0
          adaptNoiseFloor(towards: energyDbfs)
        }
      } else {
        consecutiveBelowSustainWindows = 0
      }
    }
  }

  private mutating func beginSpeech(
    startedAtNanoseconds: UInt64,
    detectedAtNanoseconds: UInt64,
    energyDbfs: Double,
    generation: BobLiveVadGeneration,
    events: inout BobLiveVadEventBatch
  ) {
    phase = .speaking
    consecutiveOnsetWindows = 0
    onsetStartedAtNanoseconds = nil
    consecutiveBelowSustainWindows = 0
    trailingSilenceStartedAtNanoseconds = nil
    utteranceCounter &+= 1
    activeUtteranceIndex = utteranceCounter
    speechStartedAtNanoseconds = startedAtNanoseconds

    let requestedPreRollNanoseconds = UInt64(configuration.preRollMs)
      * Self.nanosecondsPerMillisecond
    let earliestPreRoll = startedAtNanoseconds >= requestedPreRollNanoseconds
      ? startedAtNanoseconds - requestedPreRollNanoseconds
      : 0
    let availableAudioStart = continuousAudioStartedAtNanoseconds ?? startedAtNanoseconds
    let preRollStart = max(earliestPreRoll, availableAudioStart)
    let actualPreRollMs = Int(
      (startedAtNanoseconds - preRollStart) / Self.nanosecondsPerMillisecond
    )
    speechPreRollStartedAtNanoseconds = preRollStart
    speechPreRollMs = actualPreRollMs

    events.append(BobLiveVadEvent(
      kind: .speechStarted,
      configurationVersion: configuration.version,
      generation: generation,
      utteranceIndex: utteranceCounter,
      detectedAtNanoseconds: detectedAtNanoseconds,
      preRollStartAtNanoseconds: preRollStart,
      preRollMs: actualPreRollMs,
      startedAtNanoseconds: startedAtNanoseconds,
      endedAtNanoseconds: nil,
      forcedEnd: false,
      energyDbfs: energyDbfs,
      noiseFloorDbfs: noiseFloorDbfs
    ))
  }

  private mutating func endSpeech(
    endedAtNanoseconds: UInt64,
    detectedAtNanoseconds: UInt64,
    forced: Bool,
    energyDbfs: Double,
    generation: BobLiveVadGeneration,
    events: inout BobLiveVadEventBatch
  ) {
    guard let utteranceIndex = activeUtteranceIndex,
          let startedAtNanoseconds = speechStartedAtNanoseconds,
          let preRollStartAtNanoseconds = speechPreRollStartedAtNanoseconds else { return }
    events.append(BobLiveVadEvent(
      kind: .speechEnded,
      configurationVersion: configuration.version,
      generation: generation,
      utteranceIndex: utteranceIndex,
      detectedAtNanoseconds: detectedAtNanoseconds,
      preRollStartAtNanoseconds: preRollStartAtNanoseconds,
      preRollMs: speechPreRollMs,
      startedAtNanoseconds: startedAtNanoseconds,
      endedAtNanoseconds: endedAtNanoseconds,
      forcedEnd: forced,
      energyDbfs: energyDbfs,
      noiseFloorDbfs: noiseFloorDbfs
    ))
    activeUtteranceIndex = nil
    speechStartedAtNanoseconds = nil
    speechPreRollStartedAtNanoseconds = nil
    speechPreRollMs = 0
    consecutiveOnsetWindows = 0
    onsetStartedAtNanoseconds = nil
    consecutiveBelowSustainWindows = 0
    trailingSilenceStartedAtNanoseconds = nil
  }

  private mutating func adaptNoiseFloor(towards measuredDbfs: Double) {
    let target = min(
      configuration.maximumNoiseFloorDbfs,
      max(configuration.minimumNoiseFloorDbfs, measuredDbfs)
    )
    let rising = target > noiseFloorDbfs
    let alpha = rising ? configuration.noiseRiseAlpha : configuration.noiseFallAlpha
    let rawDelta = (target - noiseFloorDbfs) * alpha
    let boundedDelta = rising
      ? min(rawDelta, configuration.maximumNoiseRisePerWindowDb)
      : max(rawDelta, -configuration.maximumNoiseFallPerWindowDb)
    noiseFloorDbfs = min(
      configuration.maximumNoiseFloorDbfs,
      max(configuration.minimumNoiseFloorDbfs, noiseFloorDbfs + boundedDelta)
    )
  }

  private mutating func resetConsecutiveEvidenceForGap() {
    consecutiveOnsetWindows = 0
    onsetStartedAtNanoseconds = nil
    consecutiveBelowSustainWindows = 0
    trailingSilenceStartedAtNanoseconds = nil
  }

  private mutating func discardPartialWindow() {
    partialSampleCount = 0
    partialStartedAtNanoseconds = nil
    partialIncludesPlayback = false
  }

  private mutating func clearTemporalState(resetNoiseFloor: Bool) {
    phase = .idle
    discardPartialWindow()
    consecutiveOnsetWindows = 0
    onsetStartedAtNanoseconds = nil
    consecutiveBelowSustainWindows = 0
    continuousAudioStartedAtNanoseconds = nil
    lastInputEndedAtNanoseconds = nil
    utteranceCounter = 0
    activeUtteranceIndex = nil
    speechStartedAtNanoseconds = nil
    speechPreRollStartedAtNanoseconds = nil
    speechPreRollMs = 0
    trailingSilenceStartedAtNanoseconds = nil
    if resetNoiseFloor {
      noiseFloorDbfs = configuration.initialNoiseFloorDbfs
    }
  }

  private func result(disposition: BobLiveVadInputDisposition) -> BobLiveVadProcessResult {
    BobLiveVadProcessResult(
      disposition: disposition,
      analysisWindowsProcessed: 0,
      bufferedSamples: partialSampleCount,
      lastEnergyDbfs: nil,
      noiseFloorDbfs: noiseFloorDbfs,
      events: BobLiveVadEventBatch()
    )
  }

  /// Computes AC RMS (DC removed) in one pass using E[x²] - E[x]².
  private static func measureDbfsRemovingDc(_ samples: UnsafeBufferPointer<Int16>) -> Double {
    guard !samples.isEmpty else { return minimumMeasuredDbfs }
    var sum: Int64 = 0
    var sumOfSquares: Int64 = 0
    for sample in samples {
      let value = Int64(sample)
      sum += value
      sumOfSquares += value * value
    }
    let count = Double(samples.count)
    let mean = Double(sum) / count
    let variance = max(0, Double(sumOfSquares) / count - mean * mean)
    let rms = sqrt(variance)
    guard rms > 0 else { return minimumMeasuredDbfs }
    return max(minimumMeasuredDbfs, 20 * log10(rms / pcmFullScale))
  }
}
