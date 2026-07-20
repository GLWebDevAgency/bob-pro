package expo.modules.bobliveaudio

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

private val BOB_LIVE_VAD_CONFIG_VERSION = Regex("^[A-Za-z0-9._-]{1,64}$")
internal const val BOB_LIVE_VAD_SPEECH_STARTED = "speech_started"
internal const val BOB_LIVE_VAD_SPEECH_ENDED = "speech_ended"

/** Immutable wire timing for the native-binary/OTA contract advertised by prepareAsync. */
internal object BobLiveVadProfileV1 {
  const val VERSION = "bob-live-vad-foundation-1"
  const val SAMPLE_RATE_HZ = 16_000
  const val CHANNELS = 1
  const val ANALYSIS_WINDOW_MS = 20
  const val PRE_ROLL_MS = 240
  const val SPEECH_START_MS = 60
  const val SPEECH_END_MS = 700
  const val MAXIMUM_UTTERANCE_MS = 30_000
  const val SPEECH_START_WINDOW_COUNT = SPEECH_START_MS / ANALYSIS_WINDOW_MS
  const val SPEECH_END_WINDOW_COUNT = SPEECH_END_MS / ANALYSIS_WINDOW_MS
}

/**
 * Versioned parameters for the deterministic Bob Live VAD foundation.
 *
 * Acoustic thresholds remain injectable for deterministic tests and future calibration. Wire
 * timing is immutable for this version: changing it requires a new profile identifier and an
 * explicit native-binary/OTA rollout, never silent reuse of `foundation-1`.
 */
internal data class BobLiveVadConfig(
  val version: String = BobLiveVadProfileV1.VERSION,
  val sampleRateHz: Int = BobLiveVadProfileV1.SAMPLE_RATE_HZ,
  val channels: Int = BobLiveVadProfileV1.CHANNELS,
  val analysisWindowMs: Int = BobLiveVadProfileV1.ANALYSIS_WINDOW_MS,
  val preRollMs: Int = BobLiveVadProfileV1.PRE_ROLL_MS,
  val speechStartWindowCount: Int = BobLiveVadProfileV1.SPEECH_START_WINDOW_COUNT,
  val speechEndWindowCount: Int = BobLiveVadProfileV1.SPEECH_END_WINDOW_COUNT,
  val maxUtteranceMs: Int = BobLiveVadProfileV1.MAXIMUM_UTTERANCE_MS,
  val initialNoiseFloorDbfs: Double = -60.0,
  val minimumNoiseFloorDbfs: Double = -72.0,
  val maximumNoiseFloorDbfs: Double = -30.0,
  val onsetAbsoluteDbfs: Double = -42.0,
  val onsetNoiseMarginDb: Double = 10.0,
  val sustainAbsoluteDbfs: Double = -48.0,
  val sustainNoiseMarginDb: Double = 6.0,
  val playbackOnsetMarginDb: Double = 6.0,
  val noiseRiseAlpha: Double = 0.02,
  val noiseFallAlpha: Double = 0.10,
  val maximumNoiseRiseDbPerWindow: Double = 1.0,
  val maximumNoiseFallDbPerWindow: Double = 3.0,
) {
  val analysisWindowSamples: Int = sampleRateHz * analysisWindowMs / 1_000
  val speechStartMs: Int = speechStartWindowCount * analysisWindowMs
  val speechEndSilenceMs: Int = speechEndWindowCount * analysisWindowMs

  init {
    require(version.matches(BOB_LIVE_VAD_CONFIG_VERSION)) {
      "version must be a bounded wire-safe identifier"
    }
    require(version == BobLiveVadProfileV1.VERSION) {
      "unsupported VAD wire profile"
    }
    require(sampleRateHz == BobLiveVadProfileV1.SAMPLE_RATE_HZ) {
      "Bob Live VAD requires PCM16 mono 16 kHz"
    }
    require(channels == BobLiveVadProfileV1.CHANNELS) {
      "Bob Live VAD requires PCM16 mono 16 kHz"
    }
    require(analysisWindowMs == BobLiveVadProfileV1.ANALYSIS_WINDOW_MS) {
      "the negotiated analysis contract uses 20 ms windows"
    }
    require(sampleRateHz * analysisWindowMs % 1_000 == 0)
    require(analysisWindowSamples > 0)
    require(preRollMs == BobLiveVadProfileV1.PRE_ROLL_MS) {
      "pre-roll differs from the negotiated profile"
    }
    require(speechStartWindowCount == BobLiveVadProfileV1.SPEECH_START_WINDOW_COUNT) {
      "speech-start hysteresis differs from the negotiated profile"
    }
    require(speechEndWindowCount == BobLiveVadProfileV1.SPEECH_END_WINDOW_COUNT) {
      "speech-end hysteresis differs from the negotiated profile"
    }
    require(maxUtteranceMs == BobLiveVadProfileV1.MAXIMUM_UTTERANCE_MS) {
      "maximum utterance differs from the negotiated profile"
    }
    require(minimumNoiseFloorDbfs.isFinite())
    require(initialNoiseFloorDbfs.isFinite())
    require(maximumNoiseFloorDbfs.isFinite())
    require(minimumNoiseFloorDbfs in -120.0..-1.0)
    require(maximumNoiseFloorDbfs in minimumNoiseFloorDbfs..-1.0)
    require(initialNoiseFloorDbfs in minimumNoiseFloorDbfs..maximumNoiseFloorDbfs)
    require(onsetAbsoluteDbfs in -120.0..0.0)
    require(sustainAbsoluteDbfs in -120.0..0.0)
    require(onsetAbsoluteDbfs > sustainAbsoluteDbfs) { "onset must be stricter than sustain" }
    require(onsetNoiseMarginDb in 0.0..40.0)
    require(sustainNoiseMarginDb in 0.0..40.0)
    require(onsetNoiseMarginDb > sustainNoiseMarginDb) {
      "onset noise margin must be stricter than sustain"
    }
    require(playbackOnsetMarginDb in 0.0..40.0)
    require(noiseRiseAlpha in 0.0..1.0)
    require(noiseFallAlpha in 0.0..1.0)
    require(maximumNoiseRiseDbPerWindow in 0.01..30.0)
    require(maximumNoiseFallDbPerWindow in 0.01..30.0)
  }
}

/**
 * Events allocate only on actual utterance transitions. [None] and
 * [IgnoredStaleGeneration] are singleton hot-path results.
 */
internal sealed interface BobLiveVadEvent {
  data object None : BobLiveVadEvent

  /** A late PCM frame from a fenced capture generation was ignored without touching state. */
  data object IgnoredStaleGeneration : BobLiveVadEvent

  data class SpeechStarted(
    val configVersion: String,
    val generation: Long,
    val utteranceIndex: Long,
    val preRollMs: Int,
    /** Timestamp of the first onset window, not the later detection timestamp. */
    val startedAtNanos: Long,
    val detectedAtNanos: Long,
    val energyDbfs: Double,
    val noiseFloorDbfs: Double,
    val onsetThresholdDbfs: Double,
  ) : BobLiveVadEvent

  data class SpeechEnded(
    val configVersion: String,
    val generation: Long,
    val utteranceIndex: Long,
    val preRollMs: Int,
    val startedAtNanos: Long,
    /** Estimated acoustic endpoint. For natural endings this excludes trailing endpoint silence. */
    val endedAtNanos: Long,
    val detectedAtNanos: Long,
    val forcedEnd: Boolean,
    val energyDbfs: Double,
    val noiseFloorDbfs: Double,
  ) : BobLiveVadEvent
}

internal data class BobLiveVadSnapshot(
  val configVersion: String,
  val generation: Long,
  val speechActive: Boolean,
  val awaitingSilenceAfterForcedEnd: Boolean,
  val noiseFloorDbfs: Double,
  val lastRmsDbfs: Double,
  val onsetWindowCount: Int,
  val silenceWindowCount: Int,
)

/** Pure fail-closed validation performed immediately before crossing the Expo/JS bridge. */
internal object BobLiveVadBridgeContract {
  const val JS_NUMBER_MAX_SAFE_INTEGER = 9_007_199_254_740_991L

  fun isSafeJsInteger(value: Long): Boolean = value in 0L..JS_NUMBER_MAX_SAFE_INTEGER

  fun isValid(
    event: BobLiveVadEvent,
    kind: String,
    expectedGeneration: Long,
    config: BobLiveVadConfig,
  ): Boolean {
    val commonValid = when (event) {
      BobLiveVadEvent.None,
      BobLiveVadEvent.IgnoredStaleGeneration -> false
      is BobLiveVadEvent.SpeechStarted -> commonEventFieldsAreValid(
        configVersion = event.configVersion,
        generation = event.generation,
        utteranceIndex = event.utteranceIndex,
        preRollMs = event.preRollMs,
        startedAtNanos = event.startedAtNanos,
        endedAtNanos = null,
        detectedAtNanos = event.detectedAtNanos,
        energyDbfs = event.energyDbfs,
        noiseFloorDbfs = event.noiseFloorDbfs,
        expectedGeneration = expectedGeneration,
        config = config,
      )
      is BobLiveVadEvent.SpeechEnded -> commonEventFieldsAreValid(
        configVersion = event.configVersion,
        generation = event.generation,
        utteranceIndex = event.utteranceIndex,
        preRollMs = event.preRollMs,
        startedAtNanos = event.startedAtNanos,
        endedAtNanos = event.endedAtNanos,
        detectedAtNanos = event.detectedAtNanos,
        energyDbfs = event.energyDbfs,
        noiseFloorDbfs = event.noiseFloorDbfs,
        expectedGeneration = expectedGeneration,
        config = config,
      )
    }
    if (!commonValid) return false

    return when (event) {
      is BobLiveVadEvent.SpeechStarted -> kind == BOB_LIVE_VAD_SPEECH_STARTED &&
        event.detectedAtNanos - event.startedAtNanos ==
        config.speechStartMs * NANOS_PER_MILLISECOND &&
        event.onsetThresholdDbfs.isFinite() &&
        event.onsetThresholdDbfs in MINIMUM_BRIDGE_DBFS..0.0
      is BobLiveVadEvent.SpeechEnded -> {
        if (kind != BOB_LIVE_VAD_SPEECH_ENDED) return false
        val durationNanos = event.endedAtNanos - event.startedAtNanos
        if (event.forcedEnd) {
          durationNanos == config.maxUtteranceMs * NANOS_PER_MILLISECOND &&
            event.detectedAtNanos == event.endedAtNanos
        } else {
          durationNanos >= config.speechStartMs * NANOS_PER_MILLISECOND &&
            durationNanos % (config.analysisWindowMs * NANOS_PER_MILLISECOND) == 0L &&
            event.detectedAtNanos - event.startedAtNanos <
            config.maxUtteranceMs * NANOS_PER_MILLISECOND &&
            event.detectedAtNanos - event.endedAtNanos ==
            config.speechEndSilenceMs * NANOS_PER_MILLISECOND
        }
      }
      BobLiveVadEvent.None,
      BobLiveVadEvent.IgnoredStaleGeneration -> false
    }
  }

  private fun commonEventFieldsAreValid(
    configVersion: String,
    generation: Long,
    utteranceIndex: Long,
    preRollMs: Int,
    startedAtNanos: Long,
    endedAtNanos: Long?,
    detectedAtNanos: Long,
    energyDbfs: Double,
    noiseFloorDbfs: Double,
    expectedGeneration: Long,
    config: BobLiveVadConfig,
  ): Boolean {
    if (
      configVersion != config.version ||
      !configVersion.matches(BOB_LIVE_VAD_CONFIG_VERSION) ||
      generation != expectedGeneration ||
      !isSafeJsInteger(utteranceIndex) ||
      utteranceIndex == 0L ||
      preRollMs !in 0..config.preRollMs ||
      preRollMs % config.analysisWindowMs != 0 ||
      startedAtNanos < 0L ||
      detectedAtNanos < startedAtNanos ||
      !isSafeMonotonicNanosForJs(startedAtNanos) ||
      !isSafeMonotonicNanosForJs(detectedAtNanos) ||
      !energyDbfs.isFinite() ||
      energyDbfs !in MINIMUM_BRIDGE_DBFS..0.0 ||
      !noiseFloorDbfs.isFinite() ||
      noiseFloorDbfs !in config.minimumNoiseFloorDbfs..config.maximumNoiseFloorDbfs
    ) return false

    if (endedAtNanos != null) {
      if (
        endedAtNanos < startedAtNanos ||
        endedAtNanos > detectedAtNanos ||
        !isSafeMonotonicNanosForJs(endedAtNanos)
      ) return false
    }
    return true
  }

  private fun isSafeMonotonicNanosForJs(value: Long): Boolean =
    value >= 0L && isSafeJsInteger(value / NANOS_PER_MILLISECOND)

  private const val NANOS_PER_MILLISECOND = 1_000_000L
  private const val MINIMUM_BRIDGE_DBFS = -120.0
}

/**
 * Allocation-bounded PCM16LE voice activity detector.
 *
 * The instance is intentionally thread-confined to the native audio engine. Every PCM call is
 * fenced by a capture generation and carries a timestamp for the first sample from a monotonic
 * clock. Input frames may be 10, 20, or 40 ms; analysis always runs on reused 20 ms storage.
 * Pre-roll is metadata only: the native/JS transport ring remains the sole owner of PCM history.
 */
internal class BobLiveVad(
  val config: BobLiveVadConfig = BobLiveVadConfig(),
  initialGeneration: Long = 1L,
) {
  private val analysisSamples = ShortArray(config.analysisWindowSamples)
  private val analysisWindowNanos = config.analysisWindowMs * NANOS_PER_MILLISECOND
  private val maxUtteranceNanos = config.maxUtteranceMs * NANOS_PER_MILLISECOND

  var generation: Long = initialGeneration
    private set

  private var analysisSampleCount = 0
  private var analysisWindowStartedAtNanos = 0L
  private var analysisIncludesPlayback = false
  private var lastInputEndedAtNanos: Long? = null
  private var continuousSegmentStartedAtNanos: Long? = null

  private var noiseFloorDbfs = config.initialNoiseFloorDbfs
  private var lastRmsDbfs = MINIMUM_MEASURED_DBFS
  private var onsetWindowCount = 0
  private var silenceWindowCount = 0
  private var candidateStartedAtNanos: Long? = null
  private var candidatePreRollMs = 0

  private var speechActive = false
  private var speechStartedAtNanos: Long? = null
  private var speechPreRollMs = 0
  private var trailingSilenceStartedAtNanos: Long? = null
  private var awaitingSilenceAfterForcedEnd = false
  private var utteranceCounter = 0L
  private var activeUtteranceIndex: Long? = null

  init {
    require(initialGeneration >= 0L) { "generation must be non-negative" }
  }

  /**
   * Advances the generation fence and resets all acoustic history.
   *
   * Duplicate or stale resets are ignored: a late lifecycle callback cannot clear a newer capture.
   */
  fun reset(nextGeneration: Long): Boolean {
    require(nextGeneration >= 0L) { "generation must be non-negative" }
    if (nextGeneration <= generation) return false
    generation = nextGeneration
    clearAcousticState()
    return true
  }

  /**
   * Processes exactly one PCM16 little-endian mono frame.
   *
   * Generation mismatch is checked before the payload, so a late/freed capture buffer is never
   * inspected. Current-generation timestamps must be non-overlapping and monotonic.
   */
  fun processPcm16Le(
    frameGeneration: Long,
    pcm: ByteArray,
    offset: Int = 0,
    length: Int = pcm.size - offset,
    frameStartedAtNanos: Long,
    playbackActive: Boolean,
  ): BobLiveVadEvent {
    if (frameGeneration != generation) return BobLiveVadEvent.IgnoredStaleGeneration

    require(offset >= 0 && length >= 0 && offset <= pcm.size - length) {
      "invalid PCM frame bounds"
    }
    val durationMs = durationMsForPcm16ByteLength(length)
    require(frameStartedAtNanos >= 0L) { "timestamp must come from a monotonic clock" }
    val durationNanos = durationMs * NANOS_PER_MILLISECOND
    require(frameStartedAtNanos <= Long.MAX_VALUE - durationNanos) { "timestamp overflow" }
    val frameEndedAtNanos = frameStartedAtNanos + durationNanos

    val previousEnd = lastInputEndedAtNanos
    require(previousEnd == null || frameStartedAtNanos >= previousEnd) {
      "PCM timestamps must be monotonic and non-overlapping"
    }
    if (previousEnd == null) {
      continuousSegmentStartedAtNanos = frameStartedAtNanos
    } else if (frameStartedAtNanos != previousEnd) {
      // Never merge two 10 ms halves across an unknown capture gap.
      discardPartialAnalysisWindow()
      continuousSegmentStartedAtNanos = frameStartedAtNanos
      onsetWindowCount = 0
      candidateStartedAtNanos = null
      candidatePreRollMs = 0
      silenceWindowCount = 0
      trailingSilenceStartedAtNanos = null
    }

    var firstEvent: BobLiveVadEvent = BobLiveVadEvent.None
    val sourceSampleCount = length / BYTES_PER_PCM16_SAMPLE
    var sourceSampleIndex = 0
    var byteIndex = offset
    while (sourceSampleIndex < sourceSampleCount) {
      if (analysisSampleCount == 0) {
        val sampleOffsetNanos = sourceSampleIndex * NANOS_PER_SAMPLE_16_KHZ
        analysisWindowStartedAtNanos = frameStartedAtNanos + sampleOffsetNanos
      }
      val low = pcm[byteIndex].toInt() and 0xff
      val high = pcm[byteIndex + 1].toInt()
      analysisSamples[analysisSampleCount] = ((high shl 8) or low).toShort()
      analysisSampleCount += 1
      analysisIncludesPlayback = analysisIncludesPlayback || playbackActive
      sourceSampleIndex += 1
      byteIndex += BYTES_PER_PCM16_SAMPLE

      if (analysisSampleCount == analysisSamples.size) {
        val event = analyseCompletedWindow(
          windowStartedAtNanos = analysisWindowStartedAtNanos,
          playbackActive = analysisIncludesPlayback,
        )
        if (event !== BobLiveVadEvent.None) {
          check(firstEvent === BobLiveVadEvent.None) {
            "validated VAD parameters permit at most one transition per input frame"
          }
          firstEvent = event
        }
        analysisSampleCount = 0
        analysisIncludesPlayback = false
      }
    }

    lastInputEndedAtNanos = frameEndedAtNanos
    return firstEvent
  }

  fun snapshot(): BobLiveVadSnapshot = BobLiveVadSnapshot(
    configVersion = config.version,
    generation = generation,
    speechActive = speechActive,
    awaitingSilenceAfterForcedEnd = awaitingSilenceAfterForcedEnd,
    noiseFloorDbfs = noiseFloorDbfs,
    lastRmsDbfs = lastRmsDbfs,
    onsetWindowCount = onsetWindowCount,
    silenceWindowCount = silenceWindowCount,
  )

  private fun analyseCompletedWindow(
    windowStartedAtNanos: Long,
    playbackActive: Boolean,
  ): BobLiveVadEvent {
    val windowEndedAtNanos = windowStartedAtNanos + analysisWindowNanos
    val rmsDbfs = dcRemovedRmsDbfs()
    lastRmsDbfs = rmsDbfs

    val onsetThresholdDbfs = (
      max(config.onsetAbsoluteDbfs, noiseFloorDbfs + config.onsetNoiseMarginDb) +
        if (playbackActive) config.playbackOnsetMarginDb else 0.0
      ).coerceAtMost(0.0)
    val sustainThresholdDbfs = max(
      config.sustainAbsoluteDbfs,
      noiseFloorDbfs + config.sustainNoiseMarginDb,
    ).coerceAtMost(0.0)
    val isOnset = rmsDbfs >= onsetThresholdDbfs
    val isSustainedSpeech = rmsDbfs >= sustainThresholdDbfs

    if (speechActive) {
      val startedAtNanos = checkNotNull(speechStartedAtNanos)
      if (windowEndedAtNanos - startedAtNanos >= maxUtteranceNanos) {
        val forcedEndpoint = startedAtNanos + maxUtteranceNanos
        val event = endSpeech(
          endedAtNanos = forcedEndpoint,
          detectedAtNanos = windowEndedAtNanos,
          forcedEnd = true,
          energyDbfs = rmsDbfs,
        )
        awaitingSilenceAfterForcedEnd = true
        return event
      }

      if (isSustainedSpeech) {
        silenceWindowCount = 0
        trailingSilenceStartedAtNanos = null
        return BobLiveVadEvent.None
      }

      if (silenceWindowCount == 0) trailingSilenceStartedAtNanos = windowStartedAtNanos
      silenceWindowCount += 1
      if (silenceWindowCount < config.speechEndWindowCount) return BobLiveVadEvent.None

      val acousticEndpoint = checkNotNull(trailingSilenceStartedAtNanos)
      val event = endSpeech(
        endedAtNanos = acousticEndpoint,
        detectedAtNanos = windowEndedAtNanos,
        forcedEnd = false,
        energyDbfs = rmsDbfs,
      )
      adaptNoiseFloor(rmsDbfs)
      return event
    }

    if (awaitingSilenceAfterForcedEnd) {
      if (isSustainedSpeech) {
        silenceWindowCount = 0
        return BobLiveVadEvent.None
      }
      silenceWindowCount += 1
      if (silenceWindowCount >= config.speechEndWindowCount) {
        awaitingSilenceAfterForcedEnd = false
        silenceWindowCount = 0
        adaptNoiseFloor(rmsDbfs)
      }
      return BobLiveVadEvent.None
    }

    if (isOnset) {
      if (onsetWindowCount == 0) {
        candidateStartedAtNanos = windowStartedAtNanos
        val segmentStart = continuousSegmentStartedAtNanos ?: windowStartedAtNanos
        val availablePreRollNanos = (windowStartedAtNanos - segmentStart).coerceAtLeast(0L)
        candidatePreRollMs = minOf(
          config.preRollMs,
          (availablePreRollNanos / NANOS_PER_MILLISECOND).toInt(),
        )
      }
      onsetWindowCount += 1
      if (onsetWindowCount < config.speechStartWindowCount) return BobLiveVadEvent.None

      val startedAtNanos = checkNotNull(candidateStartedAtNanos)
      if (utteranceCounter == Long.MAX_VALUE) {
        throw IllegalStateException("utterance index exhausted")
      }
      utteranceCounter += 1L
      activeUtteranceIndex = utteranceCounter
      speechActive = true
      speechStartedAtNanos = startedAtNanos
      speechPreRollMs = candidatePreRollMs
      onsetWindowCount = 0
      candidateStartedAtNanos = null
      candidatePreRollMs = 0
      silenceWindowCount = 0
      trailingSilenceStartedAtNanos = null
      return BobLiveVadEvent.SpeechStarted(
        configVersion = config.version,
        generation = generation,
        utteranceIndex = utteranceCounter,
        preRollMs = speechPreRollMs,
        startedAtNanos = startedAtNanos,
        detectedAtNanos = windowEndedAtNanos,
        energyDbfs = rmsDbfs,
        noiseFloorDbfs = noiseFloorDbfs,
        onsetThresholdDbfs = onsetThresholdDbfs,
      )
    }

    // Suspected onset frames never train the estimator, even when the final candidate fails.
    onsetWindowCount = 0
    candidateStartedAtNanos = null
    candidatePreRollMs = 0
    // The sustain-to-onset band is possible weak speech or residual echo. Teaching it to the
    // environment model would lift the floor until that same speaker became undetectable.
    if (!isSustainedSpeech) adaptNoiseFloor(rmsDbfs)
    return BobLiveVadEvent.None
  }

  private fun endSpeech(
    endedAtNanos: Long,
    detectedAtNanos: Long,
    forcedEnd: Boolean,
    energyDbfs: Double,
  ): BobLiveVadEvent.SpeechEnded {
    val startedAtNanos = checkNotNull(speechStartedAtNanos)
    val utteranceIndex = checkNotNull(activeUtteranceIndex)
    val event = BobLiveVadEvent.SpeechEnded(
      configVersion = config.version,
      generation = generation,
      utteranceIndex = utteranceIndex,
      preRollMs = speechPreRollMs,
      startedAtNanos = startedAtNanos,
      endedAtNanos = endedAtNanos,
      detectedAtNanos = detectedAtNanos,
      forcedEnd = forcedEnd,
      energyDbfs = energyDbfs,
      noiseFloorDbfs = noiseFloorDbfs,
    )
    speechActive = false
    speechStartedAtNanos = null
    activeUtteranceIndex = null
    speechPreRollMs = 0
    onsetWindowCount = 0
    candidateStartedAtNanos = null
    candidatePreRollMs = 0
    silenceWindowCount = 0
    trailingSilenceStartedAtNanos = null
    return event
  }

  private fun dcRemovedRmsDbfs(): Double {
    var sum = 0L
    var sumOfSquares = 0L
    for (sample in analysisSamples) {
      val value = sample.toLong()
      sum += value
      sumOfSquares += value * value
    }
    val count = analysisSamples.size.toDouble()
    val mean = sum / count
    val variance = (sumOfSquares / count - mean * mean).coerceAtLeast(0.0)
    val rms = sqrt(variance)
    if (rms <= 0.0) return MINIMUM_MEASURED_DBFS
    return max(MINIMUM_MEASURED_DBFS, 20.0 * log10(rms / PCM16_FULL_SCALE))
  }

  private fun adaptNoiseFloor(measuredDbfs: Double) {
    val target = measuredDbfs.coerceIn(
      config.minimumNoiseFloorDbfs,
      config.maximumNoiseFloorDbfs,
    )
    val delta = target - noiseFloorDbfs
    val boundedDelta = if (delta >= 0.0) {
      (delta * config.noiseRiseAlpha).coerceAtMost(config.maximumNoiseRiseDbPerWindow)
    } else {
      (delta * config.noiseFallAlpha).coerceAtLeast(-config.maximumNoiseFallDbPerWindow)
    }
    noiseFloorDbfs = (noiseFloorDbfs + boundedDelta).coerceIn(
      config.minimumNoiseFloorDbfs,
      config.maximumNoiseFloorDbfs,
    )
  }

  private fun durationMsForPcm16ByteLength(length: Int): Int = when (length) {
    PCM16_BYTES_10_MS -> 10
    PCM16_BYTES_20_MS -> 20
    PCM16_BYTES_40_MS -> 40
    else -> throw IllegalArgumentException("PCM frame must contain exactly 10, 20, or 40 ms")
  }

  private fun discardPartialAnalysisWindow() {
    analysisSampleCount = 0
    analysisIncludesPlayback = false
  }

  private fun clearAcousticState() {
    discardPartialAnalysisWindow()
    analysisWindowStartedAtNanos = 0L
    lastInputEndedAtNanos = null
    continuousSegmentStartedAtNanos = null
    noiseFloorDbfs = config.initialNoiseFloorDbfs
    lastRmsDbfs = MINIMUM_MEASURED_DBFS
    onsetWindowCount = 0
    silenceWindowCount = 0
    candidateStartedAtNanos = null
    candidatePreRollMs = 0
    speechActive = false
    speechStartedAtNanos = null
    speechPreRollMs = 0
    trailingSilenceStartedAtNanos = null
    awaitingSilenceAfterForcedEnd = false
    utteranceCounter = 0L
    activeUtteranceIndex = null
  }

  private companion object {
    const val BYTES_PER_PCM16_SAMPLE = 2
    const val NANOS_PER_MILLISECOND = 1_000_000L
    const val NANOS_PER_SAMPLE_16_KHZ = 62_500L
    const val PCM16_FULL_SCALE = 32_768.0
    const val MINIMUM_MEASURED_DBFS = -120.0
    const val PCM16_BYTES_10_MS = 320
    const val PCM16_BYTES_20_MS = 640
    const val PCM16_BYTES_40_MS = 1_280
  }
}
