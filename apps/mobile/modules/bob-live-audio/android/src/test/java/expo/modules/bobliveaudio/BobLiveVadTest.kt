package expo.modules.bobliveaudio

import kotlin.math.PI
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BobLiveVadTest {
  @Test
  fun `defaults are the versioned cross-platform foundation and reject unsafe profiles`() {
    val config = BobLiveVadConfig()

    assertEquals(BobLiveVadProfileV1.VERSION, config.version)
    assertEquals(BobLiveVadProfileV1.SAMPLE_RATE_HZ, config.sampleRateHz)
    assertEquals(BobLiveVadProfileV1.ANALYSIS_WINDOW_MS, config.analysisWindowMs)
    assertEquals(BobLiveVadProfileV1.PRE_ROLL_MS, config.preRollMs)
    assertEquals(BobLiveVadProfileV1.SPEECH_START_WINDOW_COUNT, config.speechStartWindowCount)
    assertEquals(BobLiveVadProfileV1.SPEECH_START_MS, config.speechStartMs)
    assertEquals(BobLiveVadProfileV1.SPEECH_END_WINDOW_COUNT, config.speechEndWindowCount)
    assertEquals(BobLiveVadProfileV1.SPEECH_END_MS, config.speechEndSilenceMs)
    assertEquals(BobLiveVadProfileV1.MAXIMUM_UTTERANCE_MS, config.maxUtteranceMs)
    assertEquals(-60.0, config.initialNoiseFloorDbfs, 0.0)
    assertEquals(-72.0, config.minimumNoiseFloorDbfs, 0.0)
    assertEquals(-30.0, config.maximumNoiseFloorDbfs, 0.0)
    assertEquals(-42.0, config.onsetAbsoluteDbfs, 0.0)
    assertEquals(-48.0, config.sustainAbsoluteDbfs, 0.0)
    assertEquals(6.0, config.playbackOnsetMarginDb, 0.0)

    assertThrows(IllegalArgumentException::class.java) {
      BobLiveVadConfig(sampleRateHz = 48_000)
    }
    assertThrows(IllegalArgumentException::class.java) {
      BobLiveVadConfig(version = "bob-live-vad-foundation-2")
    }
    assertThrows(IllegalArgumentException::class.java) {
      BobLiveVadConfig(analysisWindowMs = 40)
    }
    assertThrows(IllegalArgumentException::class.java) {
      BobLiveVadConfig(preRollMs = 220)
    }
    assertThrows(IllegalArgumentException::class.java) {
      BobLiveVadConfig(speechStartWindowCount = 4)
    }
    assertThrows(IllegalArgumentException::class.java) {
      BobLiveVadConfig(speechEndWindowCount = 34)
    }
    assertThrows(IllegalArgumentException::class.java) {
      BobLiveVadConfig(maxUtteranceMs = 29_980)
    }
    assertThrows(IllegalArgumentException::class.java) {
      BobLiveVadConfig(onsetAbsoluteDbfs = -50.0, sustainAbsoluteDbfs = -48.0)
    }
    assertThrows(IllegalArgumentException::class.java) {
      BobLiveVadConfig(initialNoiseFloorDbfs = -20.0)
    }
  }

  @Test
  fun `silence ambient noise and DC do not start speech and the adaptive floor stays bounded`() {
    val vad = BobLiveVad(initialGeneration = 7)
    val clock = PcmClock(vad, generation = 7)

    repeat(50) {
      assertSame(BobLiveVadEvent.None, clock.silence())
    }
    repeat(20) {
      assertSame(BobLiveVadEvent.None, clock.constantDc(12_000))
    }
    repeat(200) {
      assertSame(BobLiveVadEvent.None, clock.noise(-55.0))
    }

    val snapshot = vad.snapshot()
    assertFalse(snapshot.speechActive)
    assertTrue(snapshot.noiseFloorDbfs in -72.0..-30.0)

    val boundedConfig = BobLiveVadConfig(
      onsetAbsoluteDbfs = -5.0,
      onsetNoiseMarginDb = 30.0,
      sustainAbsoluteDbfs = -10.0,
      sustainNoiseMarginDb = 20.0,
    )
    val boundedVad = BobLiveVad(boundedConfig, initialGeneration = 1)
    val boundedClock = PcmClock(boundedVad, generation = 1)
    repeat(1_000) { assertSame(BobLiveVadEvent.None, boundedClock.noise(-20.0)) }
    assertEquals(-30.0, boundedVad.snapshot().noiseFloorDbfs, 0.000_001)
    repeat(200) { assertSame(BobLiveVadEvent.None, boundedClock.silence()) }
    assertEquals(-72.0, boundedVad.snapshot().noiseFloorDbfs, 0.000_001)
  }

  @Test
  fun `speech start carries bounded pre-roll and natural end excludes endpoint silence`() {
    val vad = BobLiveVad(initialGeneration = 11)
    val clock = PcmClock(vad, generation = 11)

    repeat(12) { assertSame(BobLiveVadEvent.None, clock.silence()) }
    assertSame(BobLiveVadEvent.None, clock.speech(-24.0))
    assertSame(BobLiveVadEvent.None, clock.speech(-24.0))
    val started = clock.speech(-24.0)

    assertTrue(started is BobLiveVadEvent.SpeechStarted)
    started as BobLiveVadEvent.SpeechStarted
    assertEquals(240, started.preRollMs)
    assertEquals(ms(240), started.startedAtNanos)
    assertEquals(ms(300), started.detectedAtNanos)
    assertEquals(11, started.generation)
    assertEquals(1, started.utteranceIndex)

    repeat(5) { assertSame(BobLiveVadEvent.None, clock.speech(-30.0)) }
    val acousticEnd = clock.nowNanos
    repeat(34) { assertSame(BobLiveVadEvent.None, clock.silence()) }
    val ended = clock.silence()

    assertTrue(ended is BobLiveVadEvent.SpeechEnded)
    ended as BobLiveVadEvent.SpeechEnded
    assertFalse(ended.forcedEnd)
    assertEquals(started.startedAtNanos, ended.startedAtNanos)
    assertEquals(started.utteranceIndex, ended.utteranceIndex)
    assertEquals(240, ended.preRollMs)
    assertEquals(acousticEnd, ended.endedAtNanos)
    assertEquals(acousticEnd + ms(700), ended.detectedAtNanos)
    assertFalse(vad.snapshot().speechActive)
  }

  @Test
  fun `onset and sustain thresholds provide deterministic hysteresis`() {
    val vad = BobLiveVad(initialGeneration = 1)
    val clock = PcmClock(vad, generation = 1)
    val initialFloor = vad.snapshot().noiseFloorDbfs

    assertSame(BobLiveVadEvent.None, clock.speech(-30.0))
    assertSame(BobLiveVadEvent.None, clock.speech(-30.0))
    // Below onset: the incomplete two-window candidate must be forgotten.
    assertSame(BobLiveVadEvent.None, clock.speech(-45.0))
    assertEquals(
      initialFloor,
      vad.snapshot().noiseFloorDbfs,
      0.0,
    )
    assertSame(BobLiveVadEvent.None, clock.speech(-30.0))
    assertSame(BobLiveVadEvent.None, clock.speech(-30.0))
    assertTrue(clock.speech(-30.0) is BobLiveVadEvent.SpeechStarted)

    // -45 dBFS is below onset (-42) but above sustain (-48), so it must not endpoint.
    repeat(100) { assertSame(BobLiveVadEvent.None, clock.speech(-45.0)) }
    assertTrue(vad.snapshot().speechActive)
    repeat(34) { assertSame(BobLiveVadEvent.None, clock.silence()) }
    val ended = clock.silence()
    assertTrue(ended is BobLiveVadEvent.SpeechEnded && !ended.forcedEnd)
  }

  @Test
  fun `ten twenty and forty millisecond PCM frames share exact twenty millisecond analysis`() {
    val vad = BobLiveVad(initialGeneration = 1)
    val clock = PcmClock(vad, generation = 1)

    repeat(24) { assertSame(BobLiveVadEvent.None, clock.silence(durationMs = 10)) }
    assertSame(BobLiveVadEvent.None, clock.speech(-25.0, durationMs = 40))
    val started = clock.speech(-25.0, durationMs = 20)
    assertTrue(started is BobLiveVadEvent.SpeechStarted)
    started as BobLiveVadEvent.SpeechStarted
    assertEquals(ms(240), started.startedAtNanos)
    assertEquals(ms(300), started.detectedAtNanos)

    val invalid = sinePcm16Le(durationMs = 30, rmsDbfs = -20.0)
    assertThrows(IllegalArgumentException::class.java) {
      vad.processPcm16Le(
        frameGeneration = 1,
        pcm = invalid,
        frameStartedAtNanos = clock.nowNanos,
        playbackActive = false,
      )
    }
  }

  @Test
  fun `playback onset margin rejects echo-like residual but still detects close speech`() {
    val withoutPlaybackVad = BobLiveVad(initialGeneration = 1)
    val withoutPlayback = PcmClock(withoutPlaybackVad, generation = 1)
    repeat(2) { assertSame(BobLiveVadEvent.None, withoutPlayback.speech(-39.0)) }
    assertTrue(withoutPlayback.speech(-39.0) is BobLiveVadEvent.SpeechStarted)

    val playbackVad = BobLiveVad(initialGeneration = 1)
    val playback = PcmClock(playbackVad, generation = 1)
    repeat(20) {
      assertSame(
        BobLiveVadEvent.None,
        playback.speech(-39.0, playbackActive = true),
      )
    }
    assertFalse(playbackVad.snapshot().speechActive)
    assertEquals(-60.0, playbackVad.snapshot().noiseFloorDbfs, 0.0)

    repeat(2) {
      assertSame(
        BobLiveVadEvent.None,
        playback.speech(-25.0, playbackActive = true),
      )
    }
    val bargeIn = playback.speech(-25.0, playbackActive = true)
    assertTrue(bargeIn is BobLiveVadEvent.SpeechStarted)
  }

  @Test
  fun `max utterance forces one terminal event and requires silence before another onset`() {
    val vad = BobLiveVad(initialGeneration = 3)
    val clock = PcmClock(vad, generation = 3)

    repeat(2) { assertSame(BobLiveVadEvent.None, clock.speech(-24.0)) }
    val started = clock.speech(-24.0) as BobLiveVadEvent.SpeechStarted
    var forcedEnd: BobLiveVadEvent.SpeechEnded? = null
    repeat(1_497) {
      val event = clock.speech(-24.0)
      if (event is BobLiveVadEvent.SpeechEnded) forcedEnd = event
    }

    val ended = requireNotNull(forcedEnd)
    assertTrue(ended.forcedEnd)
    assertEquals(started.startedAtNanos + ms(30_000), ended.endedAtNanos)
    assertEquals(ended.endedAtNanos, ended.detectedAtNanos)
    assertTrue(vad.snapshot().awaitingSilenceAfterForcedEnd)

    repeat(10) { assertSame(BobLiveVadEvent.None, clock.speech(-24.0)) }
    assertFalse(vad.snapshot().speechActive)
    repeat(35) { assertSame(BobLiveVadEvent.None, clock.silence()) }
    assertFalse(vad.snapshot().awaitingSilenceAfterForcedEnd)
    repeat(2) { assertSame(BobLiveVadEvent.None, clock.speech(-24.0)) }
    assertTrue(clock.speech(-24.0) is BobLiveVadEvent.SpeechStarted)
  }

  @Test
  fun `generation fence ignores stale buffers before inspection and stale resets preserve state`() {
    val vad = BobLiveVad(initialGeneration = 41)
    val firstClock = PcmClock(vad, generation = 41)
    repeat(2) { assertSame(BobLiveVadEvent.None, firstClock.speech(-24.0)) }

    assertTrue(vad.reset(42))
    val ignored = vad.processPcm16Le(
      frameGeneration = 41,
      pcm = byteArrayOf(1),
      offset = 99,
      length = -8,
      frameStartedAtNanos = -1,
      playbackActive = false,
    )
    assertSame(BobLiveVadEvent.IgnoredStaleGeneration, ignored)
    assertFalse(vad.reset(41))
    assertFalse(vad.reset(42))

    val secondClock = PcmClock(vad, generation = 42)
    repeat(2) { assertSame(BobLiveVadEvent.None, secondClock.speech(-24.0)) }
    assertTrue(secondClock.speech(-24.0) is BobLiveVadEvent.SpeechStarted)
    assertFalse(vad.reset(42))
    assertTrue(vad.snapshot().speechActive)
  }

  @Test
  fun `bridge contract rejects unrepresentable or internally inconsistent VAD metadata`() {
    val config = BobLiveVadConfig()
    val vad = BobLiveVad(config, initialGeneration = 5)
    val clock = PcmClock(vad, generation = 5)
    repeat(2) { assertSame(BobLiveVadEvent.None, clock.speech(-24.0)) }
    val started = clock.speech(-24.0) as BobLiveVadEvent.SpeechStarted

    assertTrue(
      BobLiveVadBridgeContract.isValid(
        started,
        BOB_LIVE_VAD_SPEECH_STARTED,
        5,
        config,
      ),
    )
    assertFalse(BobLiveVadBridgeContract.isValid(started, "speechEnded", 5, config))
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        started.copy(generation = 4),
        BOB_LIVE_VAD_SPEECH_STARTED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        started.copy(utteranceIndex = BobLiveVadBridgeContract.JS_NUMBER_MAX_SAFE_INTEGER + 1),
        BOB_LIVE_VAD_SPEECH_STARTED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        started.copy(energyDbfs = Double.NaN),
        BOB_LIVE_VAD_SPEECH_STARTED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        started.copy(detectedAtNanos = started.startedAtNanos - 1),
        BOB_LIVE_VAD_SPEECH_STARTED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        started.copy(detectedAtNanos = started.detectedAtNanos - ms(20)),
        BOB_LIVE_VAD_SPEECH_STARTED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        started.copy(detectedAtNanos = started.detectedAtNanos + ms(20)),
        BOB_LIVE_VAD_SPEECH_STARTED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        started.copy(preRollMs = 230),
        BOB_LIVE_VAD_SPEECH_STARTED,
        5,
        config,
      ),
    )
    assertFalse(BobLiveVadBridgeContract.isSafeJsInteger(-1))
    assertTrue(
      BobLiveVadBridgeContract.isSafeJsInteger(
        BobLiveVadBridgeContract.JS_NUMBER_MAX_SAFE_INTEGER,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isSafeJsInteger(
        BobLiveVadBridgeContract.JS_NUMBER_MAX_SAFE_INTEGER + 1,
      ),
    )

    repeat(34) { assertSame(BobLiveVadEvent.None, clock.silence()) }
    val ended = clock.silence() as BobLiveVadEvent.SpeechEnded
    assertTrue(
      BobLiveVadBridgeContract.isValid(
        ended,
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        ended.copy(forcedEnd = true),
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        ended.copy(endedAtNanos = ended.startedAtNanos - 1),
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        ended.copy(detectedAtNanos = ended.detectedAtNanos - ms(20)),
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        ended.copy(detectedAtNanos = ended.detectedAtNanos + ms(20)),
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        ended.copy(
          endedAtNanos = ended.endedAtNanos + ms(1),
          detectedAtNanos = ended.detectedAtNanos + ms(1),
        ),
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )
    val latestNaturalEndpoint = ended.startedAtNanos + ms(29_300)
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        ended.copy(
          endedAtNanos = latestNaturalEndpoint,
          detectedAtNanos = latestNaturalEndpoint + ms(700),
        ),
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )

    val forcedEndpoint = ended.startedAtNanos + ms(30_000)
    val forced = ended.copy(
      endedAtNanos = forcedEndpoint,
      detectedAtNanos = forcedEndpoint,
      forcedEnd = true,
    )
    assertTrue(
      BobLiveVadBridgeContract.isValid(
        forced,
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        forced.copy(detectedAtNanos = forcedEndpoint + ms(20)),
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )
    assertFalse(
      BobLiveVadBridgeContract.isValid(
        forced.copy(
          endedAtNanos = forcedEndpoint - ms(20),
          detectedAtNanos = forcedEndpoint - ms(20),
        ),
        BOB_LIVE_VAD_SPEECH_ENDED,
        5,
        config,
      ),
    )
  }

  @Test
  fun `timestamps are monotonic non-overlapping and gaps never join partial windows`() {
    val vad = BobLiveVad(initialGeneration = 1)
    val tenMsSpeech = sinePcm16Le(durationMs = 10, rmsDbfs = -24.0)

    assertSame(
      BobLiveVadEvent.None,
      vad.processPcm16Le(1, tenMsSpeech, frameStartedAtNanos = 0, playbackActive = false),
    )
    // A 10 ms gap discards the partial analysis window instead of joining disjoint samples.
    assertSame(
      BobLiveVadEvent.None,
      vad.processPcm16Le(1, tenMsSpeech, frameStartedAtNanos = ms(20), playbackActive = false),
    )
    assertSame(
      BobLiveVadEvent.None,
      vad.processPcm16Le(1, tenMsSpeech, frameStartedAtNanos = ms(30), playbackActive = false),
    )
    val frame20 = sinePcm16Le(durationMs = 20, rmsDbfs = -24.0)
    assertSame(
      BobLiveVadEvent.None,
      vad.processPcm16Le(1, frame20, frameStartedAtNanos = ms(40), playbackActive = false),
    )
    val started = vad.processPcm16Le(
      1,
      frame20,
      frameStartedAtNanos = ms(60),
      playbackActive = false,
    )
    assertTrue(started is BobLiveVadEvent.SpeechStarted)

    assertThrows(IllegalArgumentException::class.java) {
      vad.processPcm16Le(
        1,
        frame20,
        frameStartedAtNanos = ms(70),
        playbackActive = false,
      )
    }
  }

  private class PcmClock(
    private val vad: BobLiveVad,
    private val generation: Long,
  ) {
    var nowNanos: Long = 0L
      private set

    private var noiseSeed = 0x5EED1234

    fun silence(durationMs: Int = 20): BobLiveVadEvent = push(
      pcm = ByteArray(durationMs * PCM16_BYTES_PER_MILLISECOND),
      durationMs = durationMs,
      playbackActive = false,
    )

    fun constantDc(value: Int, durationMs: Int = 20): BobLiveVadEvent = push(
      pcm = constantPcm16Le(durationMs, value),
      durationMs = durationMs,
      playbackActive = false,
    )

    fun noise(rmsDbfs: Double, durationMs: Int = 20): BobLiveVadEvent {
      val generated = noisePcm16Le(durationMs, rmsDbfs, noiseSeed)
      noiseSeed = generated.second
      return push(generated.first, durationMs, playbackActive = false)
    }

    fun speech(
      rmsDbfs: Double,
      durationMs: Int = 20,
      playbackActive: Boolean = false,
    ): BobLiveVadEvent = push(
      pcm = sinePcm16Le(durationMs, rmsDbfs),
      durationMs = durationMs,
      playbackActive = playbackActive,
    )

    private fun push(
      pcm: ByteArray,
      durationMs: Int,
      playbackActive: Boolean,
    ): BobLiveVadEvent {
      val event = vad.processPcm16Le(
        frameGeneration = generation,
        pcm = pcm,
        frameStartedAtNanos = nowNanos,
        playbackActive = playbackActive,
      )
      nowNanos += ms(durationMs)
      return event
    }
  }

  private companion object {
    const val PCM16_BYTES_PER_MILLISECOND = 32

    fun ms(value: Int): Long = value * 1_000_000L

    fun sinePcm16Le(durationMs: Int, rmsDbfs: Double): ByteArray {
      val sampleCount = durationMs * 16
      val targetRms = 32_768.0 * 10.0.pow(rmsDbfs / 20.0)
      val peak = (targetRms * sqrt(2.0)).coerceAtMost(32_767.0)
      return pcm16Le(sampleCount) { index ->
        (peak * sin(2.0 * PI * 400.0 * index / 16_000.0)).roundToInt()
      }
    }

    fun constantPcm16Le(durationMs: Int, value: Int): ByteArray = pcm16Le(durationMs * 16) {
      value.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
    }

    fun noisePcm16Le(
      durationMs: Int,
      rmsDbfs: Double,
      initialSeed: Int,
    ): Pair<ByteArray, Int> {
      val targetRms = 32_768.0 * 10.0.pow(rmsDbfs / 20.0)
      val peak = (targetRms * sqrt(3.0)).coerceAtMost(32_767.0)
      var seed = initialSeed
      val bytes = pcm16Le(durationMs * 16) {
        seed = seed xor (seed shl 13)
        seed = seed xor (seed ushr 17)
        seed = seed xor (seed shl 5)
        val unit = ((seed ushr 1).toDouble() / Int.MAX_VALUE.toDouble()) * 2.0 - 1.0
        (unit * peak).roundToInt()
      }
      return bytes to seed
    }

    fun pcm16Le(sampleCount: Int, sampleAt: (Int) -> Int): ByteArray {
      val bytes = ByteArray(sampleCount * 2)
      repeat(sampleCount) { index ->
        val sample = sampleAt(index).coerceIn(
          Short.MIN_VALUE.toInt(),
          Short.MAX_VALUE.toInt(),
        )
        bytes[index * 2] = (sample and 0xff).toByte()
        bytes[index * 2 + 1] = (sample shr 8).toByte()
      }
      return bytes
    }
  }
}
