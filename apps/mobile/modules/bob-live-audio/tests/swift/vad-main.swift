import Foundation

private let nanosecondsPerMillisecond: UInt64 = 1_000_000

private func ms(_ value: Int) -> UInt64 {
  UInt64(value) * nanosecondsPerMillisecond
}

private func fail(_ message: String, file: StaticString = #filePath, line: UInt = #line) -> Never {
  FileHandle.standardError.write(Data("FAILED \(file):\(line): \(message)\n".utf8))
  exit(1)
}

private func expect(
  _ condition: @autoclosure () -> Bool,
  _ message: String,
  file: StaticString = #filePath,
  line: UInt = #line
) {
  guard condition() else { fail(message, file: file, line: line) }
}

private func expectClose(
  _ actual: Double,
  _ expected: Double,
  tolerance: Double = 0.000_001,
  _ message: String,
  file: StaticString = #filePath,
  line: UInt = #line
) {
  guard abs(actual - expected) <= tolerance else {
    fail("\(message): expected \(expected), got \(actual)", file: file, line: line)
  }
}

private func expectConfigurationError(
  _ expected: BobLiveVadConfigurationError,
  file: StaticString = #filePath,
  line: UInt = #line,
  _ operation: () throws -> Void
) {
  do {
    try operation()
    fail("expected configuration error \(expected)", file: file, line: line)
  } catch let error as BobLiveVadConfigurationError {
    expect(error == expected, "unexpected configuration error \(error)", file: file, line: line)
  } catch {
    fail("unexpected error \(error)", file: file, line: line)
  }
}

private func makeConfiguration(
  version: String = "bob-live-vad-foundation-1",
  sampleRateHz: Int = 16_000,
  channels: Int = 1,
  analysisWindowMs: Int = 20,
  preRollMs: Int = 240,
  speechStartWindows: Int = 3,
  speechEndWindows: Int = 35,
  maximumUtteranceMs: Int = 30_000,
  initialNoiseFloorDbfs: Double = -60,
  minimumNoiseFloorDbfs: Double = -72,
  maximumNoiseFloorDbfs: Double = -30,
  minimumOnsetDbfs: Double = -42,
  minimumSustainDbfs: Double = -48,
  onsetAboveNoiseDb: Double = 10,
  sustainAboveNoiseDb: Double = 6,
  playbackOnsetMarginDb: Double = 6,
  noiseRiseAlpha: Double = 0.02,
  noiseFallAlpha: Double = 0.10,
  maximumNoiseRisePerWindowDb: Double = 1,
  maximumNoiseFallPerWindowDb: Double = 3
) throws -> BobLiveVadConfiguration {
  try BobLiveVadConfiguration(
    version: version,
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
}

private func signal(durationMs: Int, rmsDbfs: Double) -> [Int16] {
  let sampleCount = durationMs * 16
  let amplitude = min(
    32_767,
    max(0, Int((32_768 * pow(10, rmsDbfs / 20)).rounded()))
  )
  return (0..<sampleCount).map { index in
    Int16(index.isMultiple(of: 2) ? amplitude : -amplitude)
  }
}

private func silence(durationMs: Int = 20) -> [Int16] {
  [Int16](repeating: 0, count: durationMs * 16)
}

private func constantDc(durationMs: Int = 20, value: Int16) -> [Int16] {
  [Int16](repeating: value, count: durationMs * 16)
}

private struct VadClock {
  var vad: BobLiveVad
  let generation: BobLiveVadGeneration
  var nowNanoseconds: UInt64 = 0

  init(configuration: BobLiveVadConfiguration = .deterministicV1) {
    var vad = BobLiveVad(configuration: configuration)
    guard let generation = vad.reset() else { fail("generation allocation failed") }
    self.vad = vad
    self.generation = generation
  }

  mutating func push(
    _ samples: [Int16],
    durationMs: Int,
    playbackActive: Bool = false
  ) -> BobLiveVadProcessResult {
    let result = samples.withUnsafeBufferPointer {
      vad.process(
        pcm16: $0,
        capturedAtNanoseconds: nowNanoseconds,
        generation: generation,
        playbackActive: playbackActive
      )
    }
    nowNanoseconds += ms(durationMs)
    return result
  }

  mutating func quiet(durationMs: Int = 20) -> BobLiveVadProcessResult {
    push(silence(durationMs: durationMs), durationMs: durationMs)
  }

  mutating func tone(
    _ rmsDbfs: Double,
    durationMs: Int = 20,
    playbackActive: Bool = false
  ) -> BobLiveVadProcessResult {
    push(
      signal(durationMs: durationMs, rmsDbfs: rmsDbfs),
      durationMs: durationMs,
      playbackActive: playbackActive
    )
  }
}

private func onlyEvent(
  _ result: BobLiveVadProcessResult,
  file: StaticString = #filePath,
  line: UInt = #line
) -> BobLiveVadEvent? {
  expect(result.events.second == nil, "a supported frame emitted more than one event", file: file, line: line)
  return result.events.first
}

private func copying(
  _ event: BobLiveVadEvent,
  generation: BobLiveVadGeneration? = nil,
  detectedAtNanoseconds: UInt64? = nil,
  preRollStartAtNanoseconds: UInt64? = nil,
  preRollMs: Int? = nil,
  startedAtNanoseconds: UInt64? = nil,
  endedAtNanoseconds: UInt64? = nil,
  forcedEnd: Bool? = nil
) -> BobLiveVadEvent {
  BobLiveVadEvent(
    kind: event.kind,
    configurationVersion: event.configurationVersion,
    generation: generation ?? event.generation,
    utteranceIndex: event.utteranceIndex,
    detectedAtNanoseconds: detectedAtNanoseconds ?? event.detectedAtNanoseconds,
    preRollStartAtNanoseconds: preRollStartAtNanoseconds
      ?? event.preRollStartAtNanoseconds,
    preRollMs: preRollMs ?? event.preRollMs,
    startedAtNanoseconds: startedAtNanoseconds ?? event.startedAtNanoseconds,
    endedAtNanoseconds: endedAtNanoseconds ?? event.endedAtNanoseconds,
    forcedEnd: forcedEnd ?? event.forcedEnd,
    energyDbfs: event.energyDbfs,
    noiseFloorDbfs: event.noiseFloorDbfs
  )
}

private func testDefaultsAndValidation() {
  let config = BobLiveVadConfiguration.deterministicV1
  expect(config.version == BobLiveVadProfileV1.version, "wire profile version")
  expect(
    config.sampleRateHz == BobLiveVadProfileV1.sampleRateHz
      && config.channels == BobLiveVadProfileV1.channels,
    "PCM16 mono 16 kHz"
  )
  expect(config.analysisWindowMs == BobLiveVadProfileV1.analysisWindowMs, "20 ms analysis")
  expect(config.preRollMs == BobLiveVadProfileV1.preRollMs, "240 ms pre-roll")
  expect(
    config.speechStartWindows * config.analysisWindowMs == BobLiveVadProfileV1.speechStartMs,
    "60 ms onset hysteresis"
  )
  expect(
    config.speechEndWindows * config.analysisWindowMs == BobLiveVadProfileV1.speechEndMs,
    "700 ms endpoint hangover"
  )
  expect(
    config.maximumUtteranceMs == BobLiveVadProfileV1.maximumUtteranceMs,
    "30 s maximum utterance"
  )
  expect(config.initialNoiseFloorDbfs == -60, "initial noise floor")
  expect(config.minimumNoiseFloorDbfs == -72, "minimum noise floor")
  expect(config.maximumNoiseFloorDbfs == -30, "maximum noise floor")
  expect(config.minimumOnsetDbfs == -42, "absolute onset")
  expect(config.minimumSustainDbfs == -48, "absolute sustain")
  expect(config.onsetAboveNoiseDb == 10 && config.sustainAboveNoiseDb == 6, "noise margins")
  expect(config.playbackOnsetMarginDb == 6, "playback margin")
  expect(config.noiseRiseAlpha == 0.02 && config.noiseFallAlpha == 0.10, "adaptation alphas")
  expect(config.maximumNoiseRisePerWindowDb == 1, "noise rise cap")
  expect(config.maximumNoiseFallPerWindowDb == 3, "noise fall cap")

  expectConfigurationError(.invalidVersion) {
    _ = try makeConfiguration(version: "unsafe profile!")
  }
  expectConfigurationError(.unsupportedProfile) {
    _ = try makeConfiguration(version: "bob-live-vad-foundation-2")
  }
  expectConfigurationError(.unsupportedSampleRate) {
    _ = try makeConfiguration(sampleRateHz: 48_000)
  }
  expectConfigurationError(.unsupportedChannelCount) {
    _ = try makeConfiguration(channels: 2)
  }
  expectConfigurationError(.invalidPreRoll) {
    _ = try makeConfiguration(preRollMs: 220)
  }
  expectConfigurationError(.invalidHysteresis) {
    _ = try makeConfiguration(speechStartWindows: 4)
  }
  expectConfigurationError(.invalidHysteresis) {
    _ = try makeConfiguration(speechEndWindows: 34)
  }
  expectConfigurationError(.invalidMaximumUtterance) {
    _ = try makeConfiguration(maximumUtteranceMs: 29_980)
  }
  expectConfigurationError(.invalidDecibelRange) {
    _ = try makeConfiguration(minimumOnsetDbfs: -50, minimumSustainDbfs: -48)
  }
  expectConfigurationError(.invalidNoiseAdaptation) {
    _ = try makeConfiguration(noiseRiseAlpha: .nan)
  }
}

private func testAlignmentIndependentLittleEndianDecoding() {
  // The leading byte deliberately shifts the PCM view away from an Int16-aligned address.
  let storage: [UInt8] = [
    0xAA,
    0x00, 0x00, // 0
    0x01, 0x00, // 1
    0xFF, 0xFF, // -1
    0x00, 0x80, // Int16.min
    0xFF, 0x7F, // Int16.max
    0xBB,
  ]
  var decoded = [Int16](repeating: 7, count: 5)
  let accepted = storage.withUnsafeBytes { rawBytes in
    let unalignedPcm = UnsafeRawBufferPointer(rebasing: rawBytes[1..<11])
    return decoded.withUnsafeMutableBufferPointer {
      BobLivePcm16LittleEndian.decode(unalignedPcm, into: $0)
    }
  }
  expect(accepted, "unaligned PCM16LE bytes must decode")
  expect(decoded == [0, 1, -1, Int16.min, Int16.max], "explicit little-endian values")

  let beforeInvalidDecode = decoded
  let rejected = storage.withUnsafeBytes { rawBytes in
    let invalidLength = UnsafeRawBufferPointer(rebasing: rawBytes[1..<10])
    return decoded.withUnsafeMutableBufferPointer {
      BobLivePcm16LittleEndian.decode(invalidLength, into: $0)
    }
  }
  expect(!rejected, "odd or mismatched byte length must fail closed")
  expect(decoded == beforeInvalidDecode, "rejected decode must not partially mutate scratch")
}

private func testFrameDurationsAndDcRemoval() {
  var clock = VadClock()
  let firstHalf = clock.quiet(durationMs: 10)
  expect(firstHalf.disposition == .accepted, "10 ms first half accepted")
  expect(firstHalf.analysisWindowsProcessed == 0 && firstHalf.bufferedSamples == 160,
         "10 ms must buffer half an analysis window")
  let secondHalf = clock.quiet(durationMs: 10)
  expect(secondHalf.analysisWindowsProcessed == 1 && secondHalf.bufferedSamples == 0,
         "two 10 ms calls must make one analysis window")
  expect(clock.quiet(durationMs: 20).analysisWindowsProcessed == 1, "20 ms frame")
  expect(clock.quiet(durationMs: 40).analysisWindowsProcessed == 2, "40 ms frame")

  let invalid = signal(durationMs: 30, rmsDbfs: -20)
  let invalidResult = clock.push(invalid, durationMs: 30)
  expect(invalidResult.disposition == .rejectedUnsupportedFrameSize, "reject 30 ms input")

  let dc = constantDc(value: 12_000)
  let dcResult = dc.withUnsafeBufferPointer {
    clock.vad.process(
      pcm16: $0,
      capturedAtNanoseconds: clock.nowNanoseconds,
      generation: clock.generation,
      playbackActive: false
    )
  }
  expectClose(dcResult.lastEnergyDbfs ?? 0, -120, "DC must be removed before RMS")
  expect(dcResult.events.count == 0, "constant DC must never be speech")
}

private func testAdaptiveFloorIsBoundedAndSuspiciousEnergyDoesNotTrainIt() throws {
  var clock = VadClock()
  var last = clock.quiet()
  for _ in 1..<200 { last = clock.quiet() }
  expectClose(last.noiseFloorDbfs, -72, "silence must converge to lower floor")

  // -45 dBFS is between default sustain (-48) and onset (-42): suspicious but not onset.
  let beforeSuspicious = last.noiseFloorDbfs
  for _ in 0..<200 { last = clock.tone(-45) }
  expectClose(last.noiseFloorDbfs, beforeSuspicious,
              "suspicious energy must not train the idle estimator")

  let bounded = try makeConfiguration(
    minimumOnsetDbfs: -5,
    minimumSustainDbfs: -10,
    onsetAboveNoiseDb: 30,
    sustainAboveNoiseDb: 20
  )
  var boundedClock = VadClock(configuration: bounded)
  var high = boundedClock.tone(-20)
  for _ in 1..<1_000 { high = boundedClock.tone(-20) }
  expectClose(high.noiseFloorDbfs, -30, "noise floor upper clamp")
  var low = boundedClock.quiet()
  for _ in 1..<200 { low = boundedClock.quiet() }
  expectClose(low.noiseFloorDbfs, -72, "noise floor lower clamp")

  let capped = try makeConfiguration(
    minimumOnsetDbfs: -5,
    minimumSustainDbfs: -10,
    onsetAboveNoiseDb: 30,
    sustainAboveNoiseDb: 20,
    noiseRiseAlpha: 1,
    noiseFallAlpha: 1
  )
  var cappedClock = VadClock(configuration: capped)
  let oneRise = cappedClock.tone(-20)
  expectClose(oneRise.noiseFloorDbfs, -59, "upward adaptation is capped at +1 dB/window")
  let oneFall = cappedClock.quiet()
  expectClose(oneFall.noiseFloorDbfs, -62, "downward adaptation is capped at -3 dB/window")
}

private func testExactSpeechTransitionsAndPreRoll() {
  var clock = VadClock()
  for _ in 0..<12 { expect(onlyEvent(clock.quiet()) == nil, "pre-roll silence") }
  expect(onlyEvent(clock.tone(-24)) == nil, "onset window one")
  expect(onlyEvent(clock.tone(-24)) == nil, "onset window two")
  guard let started = onlyEvent(clock.tone(-24)) else { fail("missing speech start") }
  expect(started.kind == .speechStarted, "speech start kind")
  expect(started.configurationVersion == "bob-live-vad-foundation-1", "event profile")
  expect(started.generation == clock.generation, "event generation")
  expect(started.startedAtNanoseconds == ms(240), "start is first onset window")
  expect(started.detectedAtNanoseconds == ms(300), "start detected after exactly 60 ms")
  expect(started.preRollStartAtNanoseconds == 0, "pre-roll start")
  expect(started.preRollMs == 240, "available pre-roll")
  expect(started.endedAtNanoseconds == nil && !started.forcedEnd, "start metadata")

  for _ in 0..<5 { expect(onlyEvent(clock.tone(-30)) == nil, "sustained speech") }
  let acousticEndpoint = clock.nowNanoseconds
  for _ in 0..<34 { expect(onlyEvent(clock.quiet()) == nil, "endpoint hangover") }
  guard let ended = onlyEvent(clock.quiet()) else { fail("missing natural speech end") }
  expect(ended.kind == .speechEnded, "speech end kind")
  expect(ended.startedAtNanoseconds == started.startedAtNanoseconds, "correlated start")
  expect(ended.endedAtNanoseconds == acousticEndpoint,
         "natural endpoint excludes the 700 ms trailing silence")
  expect(
    (acousticEndpoint - started.startedAtNanoseconds).isMultiple(
      of: ms(BobLiveVadProfileV1.analysisWindowMs)
    ),
    "natural endpoint remains aligned to the negotiated analysis window"
  )
  expect(ended.detectedAtNanoseconds == acousticEndpoint + ms(700),
         "natural endpoint detected after exactly 35 windows")
  expect(!ended.forcedEnd, "natural endpoint is not forced")
  expect(ended.preRollMs == 240, "end carries start pre-roll")
}

private func testCallbackChunkingHasIdenticalTransitions() {
  var clock = VadClock()
  for _ in 0..<24 { expect(onlyEvent(clock.quiet(durationMs: 10)) == nil, "10 ms silence") }
  expect(onlyEvent(clock.tone(-25, durationMs: 40)) == nil,
         "40 ms contains only two onset windows")
  guard let started = onlyEvent(clock.tone(-25, durationMs: 20)) else {
    fail("missing chunk-independent start")
  }
  expect(started.startedAtNanoseconds == ms(240), "chunk-independent start timestamp")
  expect(started.detectedAtNanoseconds == ms(300), "chunk-independent detection timestamp")
}

private func testPlaybackResidualAndBargeIn() {
  var withoutPlayback = VadClock()
  expect(onlyEvent(withoutPlayback.tone(-39)) == nil, "residual onset one")
  expect(onlyEvent(withoutPlayback.tone(-39)) == nil, "residual onset two")
  expect(onlyEvent(withoutPlayback.tone(-39))?.kind == .speechStarted,
         "-39 dBFS crosses non-playback onset")

  var playback = VadClock()
  var floor = -60.0
  for _ in 0..<20 {
    let result = playback.tone(-39, playbackActive: true)
    expect(onlyEvent(result) == nil, "playback residual must not trigger speech")
    floor = result.noiseFloorDbfs
  }
  expectClose(floor, -60, "playback residual in suspicious band must not train noise")

  // Playback state on either 10 ms half must protect the complete 20 ms analysis window.
  for _ in 0..<3 {
    expect(onlyEvent(playback.tone(-39, durationMs: 10, playbackActive: true)) == nil,
           "playback half-window")
    expect(onlyEvent(playback.tone(-39, durationMs: 10, playbackActive: false)) == nil,
           "merged playback window")
  }

  expect(onlyEvent(playback.tone(-25, playbackActive: true)) == nil, "barge-in onset one")
  expect(onlyEvent(playback.tone(-25, playbackActive: true)) == nil, "barge-in onset two")
  guard let bargeIn = onlyEvent(playback.tone(-25, playbackActive: true)) else {
    fail("close speech must cross the playback-adjusted onset")
  }
  expect(bargeIn.kind == .speechStarted, "barge-in speech start")
}

private func testForcedEndAndRearm() {
  var clock = VadClock()
  expect(onlyEvent(clock.tone(-24)) == nil, "max onset one")
  expect(onlyEvent(clock.tone(-24)) == nil, "max onset two")
  guard let started = onlyEvent(clock.tone(-24)) else { fail("missing max start") }
  expect(started.preRollMs == 0, "a capture without history reports zero available pre-roll")
  expect(
    started.detectedAtNanoseconds - started.startedAtNanoseconds
      == ms(BobLiveVadProfileV1.speechStartMs),
    "forced-case start still uses exact onset hysteresis"
  )

  for _ in 0..<1_496 {
    expect(onlyEvent(clock.tone(-24)) == nil, "must remain below 30 s maximum")
  }
  guard let ended = onlyEvent(clock.tone(-24)) else { fail("missing forced maximum end") }
  expect(ended.kind == .speechEnded && ended.forcedEnd, "forced terminal event")
  expect(ended.startedAtNanoseconds == started.startedAtNanoseconds, "forced correlation")
  expect(ended.endedAtNanoseconds == started.startedAtNanoseconds + ms(30_000),
         "forced endpoint exactly at 30 s")
  expect(ended.detectedAtNanoseconds == ended.endedAtNanoseconds,
         "aligned 20 ms maximum has no detection delay")

  for _ in 0..<10 {
    expect(onlyEvent(clock.tone(-24)) == nil, "continuous speech cannot restart after cap")
  }
  for _ in 0..<35 { expect(onlyEvent(clock.quiet()) == nil, "cooldown silence") }
  expect(onlyEvent(clock.tone(-24)) == nil, "rearm onset one")
  expect(onlyEvent(clock.tone(-24)) == nil, "rearm onset two")
  expect(onlyEvent(clock.tone(-24))?.kind == .speechStarted, "rearm after silence")
}

private func testBridgeContractRejectsImpossibleTimelines() {
  let configuration = BobLiveVadConfiguration.deterministicV1
  var clock = VadClock(configuration: configuration)
  for _ in 0..<12 { _ = clock.quiet() }
  _ = clock.tone(-24)
  _ = clock.tone(-24)
  guard let started = onlyEvent(clock.tone(-24)) else { fail("missing bridge start") }

  expect(
    BobLiveVadBridgeContract.isValid(
      started,
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "generated start must cross the bridge"
  )
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(started, detectedAtNanoseconds: started.detectedAtNanoseconds - ms(20)),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "start detection cannot precede the exact onset hysteresis"
  )
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(started, detectedAtNanoseconds: started.detectedAtNanoseconds + ms(20)),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "start detection cannot exceed the exact onset hysteresis"
  )
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(started, preRollMs: 230),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "pre-roll must remain aligned to the 20 ms analysis window"
  )
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(
        started,
        preRollStartAtNanoseconds: started.preRollStartAtNanoseconds + ms(20)
      ),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "pre-roll timestamp and advertised duration must correlate exactly"
  )
  expect(
    !BobLiveVadBridgeContract.isValid(
      started,
      expectedGeneration: BobLiveVadGeneration(rawValue: clock.generation.rawValue + 1),
      configuration: configuration
    ),
    "stale VAD generation cannot cross the bridge"
  )

  for _ in 0..<5 { _ = clock.tone(-30) }
  for _ in 0..<34 { _ = clock.quiet() }
  guard let ended = onlyEvent(clock.quiet()) else { fail("missing bridge end") }
  expect(
    BobLiveVadBridgeContract.isValid(
      ended,
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "generated natural end must cross the bridge"
  )
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(ended, detectedAtNanoseconds: ended.detectedAtNanoseconds - ms(20)),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "natural end cannot shorten endpoint hysteresis"
  )
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(ended, detectedAtNanoseconds: ended.detectedAtNanoseconds + ms(20)),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "natural end cannot lengthen endpoint hysteresis"
  )
  guard let acousticEndpoint = ended.endedAtNanoseconds else { fail("missing acoustic end") }
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(
        ended,
        detectedAtNanoseconds: ended.detectedAtNanoseconds + ms(1),
        endedAtNanoseconds: acousticEndpoint + ms(1)
      ),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "natural duration must remain aligned to the analysis window"
  )

  let latestNaturalEndpoint = started.startedAtNanoseconds + ms(29_300)
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(
        ended,
        detectedAtNanoseconds: latestNaturalEndpoint + ms(700),
        endedAtNanoseconds: latestNaturalEndpoint
      ),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "natural endpoint cannot reach the forced 30 s boundary"
  )

  let forcedEndpoint = started.startedAtNanoseconds + ms(30_000)
  let forced = copying(
    ended,
    detectedAtNanoseconds: forcedEndpoint,
    endedAtNanoseconds: forcedEndpoint,
    forcedEnd: true
  )
  expect(
    BobLiveVadBridgeContract.isValid(
      forced,
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "forced endpoint is exact at 30 s"
  )
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(forced, detectedAtNanoseconds: forcedEndpoint + ms(20)),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "forced endpoint has no detection delay"
  )
  expect(
    !BobLiveVadBridgeContract.isValid(
      copying(
        forced,
        detectedAtNanoseconds: forcedEndpoint - ms(20),
        endedAtNanoseconds: forcedEndpoint - ms(20)
      ),
      expectedGeneration: clock.generation,
      configuration: configuration
    ),
    "forced endpoint cannot occur before 30 s"
  )
}

private func testGenerationAndTimestampFences() {
  var vad = BobLiveVad()
  guard let first = vad.reset() else { fail("first generation") }
  let half = signal(durationMs: 10, rmsDbfs: -24)
  let firstResult = half.withUnsafeBufferPointer {
    vad.process(
      pcm16: $0,
      capturedAtNanoseconds: 0,
      generation: first,
      playbackActive: false
    )
  }
  expect(firstResult.bufferedSamples == 160, "first half buffered")

  let gapResult = half.withUnsafeBufferPointer {
    vad.process(
      pcm16: $0,
      capturedAtNanoseconds: ms(20),
      generation: first,
      playbackActive: false
    )
  }
  expect(gapResult.disposition == .acceptedAfterGap, "timestamp gap is explicit")
  expect(gapResult.analysisWindowsProcessed == 0 && gapResult.bufferedSamples == 160,
         "gap must discard rather than merge partial windows")

  let contiguousResult = half.withUnsafeBufferPointer {
    vad.process(
      pcm16: $0,
      capturedAtNanoseconds: ms(30),
      generation: first,
      playbackActive: false
    )
  }
  expect(contiguousResult.analysisWindowsProcessed == 1, "contiguous half completes window")

  let full = signal(durationMs: 20, rmsDbfs: -24)
  let overlap = full.withUnsafeBufferPointer {
    vad.process(
      pcm16: $0,
      capturedAtNanoseconds: ms(35),
      generation: first,
      playbackActive: false
    )
  }
  expect(overlap.disposition == .rejectedNonMonotonicTimestamp, "overlap rejected")

  guard let second = vad.reset() else { fail("second generation") }
  let invalidSize = [Int16](repeating: 1, count: 1)
  let stale = invalidSize.withUnsafeBufferPointer {
    vad.process(
      pcm16: $0,
      capturedAtNanoseconds: UInt64.max,
      generation: first,
      playbackActive: false
    )
  }
  expect(stale.disposition == .ignoredInactiveGeneration,
         "generation fence runs before payload or timestamp inspection")
  expect(!vad.invalidate(generation: first), "stale invalidation cannot cancel successor")

  let accepted = full.withUnsafeBufferPointer {
    vad.process(
      pcm16: $0,
      capturedAtNanoseconds: 0,
      generation: second,
      playbackActive: false
    )
  }
  expect(accepted.disposition == .accepted, "reset clears timestamp history")

  guard let third = vad.reset() else { fail("third generation") }
  let overflow = full.withUnsafeBufferPointer {
    vad.process(
      pcm16: $0,
      capturedAtNanoseconds: UInt64.max - ms(10),
      generation: third,
      playbackActive: false
    )
  }
  expect(overflow.disposition == .rejectedTimestampOverflow, "timestamp overflow rejected")
  let afterOverflow = full.withUnsafeBufferPointer {
    vad.process(
      pcm16: $0,
      capturedAtNanoseconds: 0,
      generation: third,
      playbackActive: false
    )
  }
  expect(afterOverflow.disposition == .accepted, "overflow rejection must not mutate clock state")
  expect(!vad.invalidate(generation: second), "older generation cannot invalidate successor")
  expect(vad.invalidate(generation: third), "active generation invalidates")
  let afterStop = full.withUnsafeBufferPointer {
    vad.process(
      pcm16: $0,
      capturedAtNanoseconds: ms(20),
      generation: third,
      playbackActive: false
    )
  }
  expect(afterStop.disposition == .ignoredInactiveGeneration, "stopped callbacks ignored")
}

@main
private enum BobLiveVadStandaloneTests {
  static func main() throws {
    testDefaultsAndValidation()
    testAlignmentIndependentLittleEndianDecoding()
    testFrameDurationsAndDcRemoval()
    try testAdaptiveFloorIsBoundedAndSuspiciousEnergyDoesNotTrainIt()
    testExactSpeechTransitionsAndPreRoll()
    testCallbackChunkingHasIdenticalTransitions()
    testPlaybackResidualAndBargeIn()
    testForcedEndAndRearm()
    testBridgeContractRejectsImpossibleTimelines()
    testGenerationAndTimestampFences()
    print("BobLiveVad: OK (10 deterministic suites)")
  }
}
