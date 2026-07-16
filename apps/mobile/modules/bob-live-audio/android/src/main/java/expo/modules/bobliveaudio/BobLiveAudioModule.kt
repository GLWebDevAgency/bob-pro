package expo.modules.bobliveaudio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.UUID
import kotlin.math.max

private const val TARGET_SAMPLE_RATE_HZ = 16_000
private const val TARGET_CHANNELS = 1
private const val TARGET_FRAME_DURATION_MS = 40
private const val TARGET_FRAME_DURATION_NANOS = 40_000_000L
private const val TARGET_FRAME_BYTES = 1_280 // 16 kHz * 40 ms * Int16 mono
private const val CAPTURE_BUFFER_FRAMES = 8
private const val MAX_IN_FLIGHT_FRAMES = 16L
private const val DEFAULT_MAX_CAPTURE_DURATION_MS = 900_000
private const val MAXIMUM_MAX_CAPTURE_DURATION_MS = 900_000
private const val MINIMUM_MAX_CAPTURE_DURATION_MS = 1_000
private const val STOP_JOIN_TIMEOUT_MS = 750L
/** Une génération préparée ne peut jamais conserver focus/mode/recorder si JS disparaît. */
private const val PREPARED_START_TIMEOUT_MS = 10_000L
private const val CAPTURE_HEARTBEAT_INTERVAL_MS = 2_000L
private const val MAXIMUM_PCM_SILENCE_MS = 5_000L
private val SESSION_ID = Regex("^[A-Za-z0-9-]{1,64}$")

private enum class CaptureStopReason(val wireValue: String) {
  REQUESTED("requested"),
  BACKGROUND("background"),
  CONTEXT_DESTROYED("context_destroyed"),
  CAPTURE_ERROR("capture_error"),
  BACKPRESSURE("backpressure"),
  WATCHDOG_TIMEOUT("watchdog_timeout"),
  INTERRUPTION("interruption"),
}

private enum class ProcessingStatus(val wireValue: String) {
  ENABLED("enabled"),
  UNAVAILABLE("unavailable"),
}

private class BobLiveAudioException(code: String) : CodedException(
  "ERR_BOB_LIVE_AUDIO",
  code,
  null,
)

private data class CaptureCapabilities(
  val sessionId: String,
  val captureId: String,
  val maxCaptureDurationMs: Int,
  val acousticEchoCancellation: ProcessingStatus,
  val noiseSuppression: ProcessingStatus,
  val automaticGainControl: ProcessingStatus,
  val vadConfig: BobLiveVadConfig,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "sessionId" to sessionId,
    "captureId" to captureId,
    "encoding" to "pcm_s16le",
    "sampleRateHz" to TARGET_SAMPLE_RATE_HZ,
    "channels" to TARGET_CHANNELS,
    "frameDurationMs" to TARGET_FRAME_DURATION_MS,
    "maxInFlightFrames" to MAX_IN_FLIGHT_FRAMES.toInt(),
    "maxCaptureDurationMs" to maxCaptureDurationMs,
    "acousticEchoCancellation" to acousticEchoCancellation.wireValue,
    "noiseSuppression" to noiseSuppression.wireValue,
    "automaticGainControl" to automaticGainControl.wireValue,
    "vadConfigVersion" to vadConfig.version,
    "vadEventOrdering" to "pcm_before_vad",
    "vadAnalysisWindowMs" to vadConfig.analysisWindowMs,
    "vadPreRollMs" to vadConfig.preRollMs,
    "vadSpeechStartMs" to vadConfig.speechStartWindowCount * vadConfig.analysisWindowMs,
    "vadSpeechEndMs" to vadConfig.speechEndWindowCount * vadConfig.analysisWindowMs,
    "vadMaximumUtteranceMs" to vadConfig.maxUtteranceMs,
    // Reste faux jusqu'a certification de la matrice appareil/route audio.
    "fullDuplexCertified" to false,
  )
}

private data class AudioModeLease(
  val generation: Long,
  val previousMode: Int,
)

private data class AudioFocusLease(
  val listener: AudioManager.OnAudioFocusChangeListener,
  val request: AudioFocusRequest?,
  val lost: AtomicBoolean,
)

private data class CaptureState(
  val sessionId: String,
  val generation: Long,
  val recorder: AudioRecord,
  val effects: List<AudioEffect>,
  val audioManager: AudioManager,
  val audioModeLease: AudioModeLease,
  val audioFocusLease: AudioFocusLease,
  val capabilities: CaptureCapabilities,
  /** Thread-confined to the capture loop; generation is identical to this state. */
  val vad: BobLiveVad,
  @Volatile var started: Boolean = false,
  @Volatile var stopping: Boolean = false,
  @Volatile var thread: Thread? = null,
  @Volatile var watchdog: ScheduledFuture<*>? = null,
  @Volatile var heartbeatWatchdog: ScheduledFuture<*>? = null,
  @Volatile var lastPcmAtMonotonicMs: Long? = null,
  var nextSequence: Long = 0,
  var lastAcknowledgedSequence: Long = -1,
)

private class NamedDaemonThreadFactory(private val name: String) : ThreadFactory {
  override fun newThread(task: Runnable): Thread = Thread(task, name).apply {
    isDaemon = true
  }
}

class BobLiveAudioModule : Module() {
  private val stateLock = Any()
  private val acceptsEvents = AtomicBoolean(true)
  private val acceptsStarts = AtomicBoolean(true)
  private val destroyed = AtomicBoolean(false)
  private val controlExecutor: ExecutorService = Executors.newSingleThreadExecutor(
    NamedDaemonThreadFactory("BobLiveAudioControl"),
  )
  private val watchdogExecutor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(
    NamedDaemonThreadFactory("BobLiveAudioWatchdog"),
  )

  private var activeCapture: CaptureState? = null
  private var generation = 0L
  private var audioModeOwnerGeneration: Long? = null

  override fun definition() = ModuleDefinition {
    Name("BobLiveAudio")

    Events("onPcmChunk", "onVadEvent", "onCaptureError", "onCaptureStopped")

    AsyncFunction("prepareAsync") { sessionId: String, requestedMaxCaptureDurationMs: Int? ->
      runOnControl {
        prepareCaptureOnControl(sessionId, requestedMaxCaptureDurationMs).toMap()
      }
    }

    AsyncFunction("startPreparedAsync") { sessionId: String, captureId: String ->
      runOnControl {
        startPreparedCaptureOnControl(sessionId, captureId)
      }
    }

    AsyncFunction("acknowledgePcmAsync") {
      sessionId: String, captureId: String, throughSequence: Long ->
      runOnControl {
        acknowledgeOnControl(sessionId, captureId, throughSequence)
      }
    }

    AsyncFunction("stopAsync") { sessionId: String, captureId: String ->
      runOnControl {
        stopCaptureOnControl(
          requestedSessionId = sessionId,
          requestedCaptureId = captureId,
          expectedGeneration = null,
          reason = CaptureStopReason.REQUESTED,
          emitEvent = true,
        )
      }
    }

    OnActivityEntersForeground {
      if (!destroyed.get()) acceptsStarts.set(true)
    }

    OnActivityEntersBackground {
      acceptsStarts.set(false)
      scheduleLifecycleStop(CaptureStopReason.BACKGROUND, emitEvent = true)
    }

    OnActivityDestroys {
      acceptsStarts.set(false)
      scheduleLifecycleStop(CaptureStopReason.CONTEXT_DESTROYED, emitEvent = false)
    }

    OnDestroy {
      destroyed.set(true)
      acceptsStarts.set(false)
      acceptsEvents.set(false)
      scheduleLifecycleStop(CaptureStopReason.CONTEXT_DESTROYED, emitEvent = false)
      watchdogExecutor.shutdownNow()
      controlExecutor.shutdown()
    }
  }

  @SuppressLint("MissingPermission")
  private fun prepareCaptureOnControl(
    sessionId: String,
    requestedMaxCaptureDurationMs: Int?,
  ): CaptureCapabilities {
    if (!SESSION_ID.matches(sessionId) || destroyed.get() || !acceptsStarts.get()) {
      throw BobLiveAudioException("capture_initialization_failed")
    }
    val maxCaptureDurationMs = requestedMaxCaptureDurationMs ?: DEFAULT_MAX_CAPTURE_DURATION_MS
    if (maxCaptureDurationMs !in MINIMUM_MAX_CAPTURE_DURATION_MS..MAXIMUM_MAX_CAPTURE_DURATION_MS) {
      throw BobLiveAudioException("capture_initialization_failed")
    }

    val existingCapture = synchronized(stateLock) { activeCapture }
    if (existingCapture != null) {
      if (existingCapture.sessionId != sessionId || existingCapture.stopping) {
        throw BobLiveAudioException("capture_busy")
      }
      if (existingCapture.capabilities.maxCaptureDurationMs != maxCaptureDurationMs) {
        throw BobLiveAudioException("capture_protocol_failed")
      }
      if (existingCapture.audioFocusLease.lost.get()) {
        failCaptureOnControl(
          existingCapture,
          "capture_interrupted",
          CaptureStopReason.INTERRUPTION,
        )
        throw BobLiveAudioException("capture_initialization_failed")
      }
      return existingCapture.capabilities
    }

    val context = appContext.reactContext
      ?: throw BobLiveAudioException("capture_initialization_failed")
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      throw BobLiveAudioException("microphone_permission_denied")
    }
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: throw BobLiveAudioException("capture_initialization_failed")

    val captureGeneration = synchronized(stateLock) {
      generation = nextGeneration(generation)
      generation
    }
    var modeLease: AudioModeLease? = null
    var focusLease: AudioFocusLease? = null
    var recorder: AudioRecord? = null
    val effects = mutableListOf<AudioEffect>()
    var installedState: CaptureState? = null

    try {
      modeLease = acquireAudioModeOnControl(audioManager, captureGeneration)
      focusLease = acquireAudioFocus(audioManager, captureGeneration)

      val minBufferBytes = AudioRecord.getMinBufferSize(
        TARGET_SAMPLE_RATE_HZ,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
      if (minBufferBytes <= 0) throw BobLiveAudioException("capture_initialization_failed")

      val audioFormat = AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(TARGET_SAMPLE_RATE_HZ)
        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
        .build()
      val initializedRecorder = createAudioRecorder(
        audioFormat,
        max(minBufferBytes, TARGET_FRAME_BYTES * CAPTURE_BUFFER_FRAMES),
      )
      recorder = initializedRecorder

      val aec = createEffect(
        available = AcousticEchoCanceler.isAvailable(),
        create = { AcousticEchoCanceler.create(initializedRecorder.audioSessionId) },
      )
      aec.effect?.let(effects::add)
      val noiseSuppressor = createEffect(
        available = NoiseSuppressor.isAvailable(),
        create = { NoiseSuppressor.create(initializedRecorder.audioSessionId) },
      )
      noiseSuppressor.effect?.let(effects::add)
      val gainControl = createEffect(
        available = AutomaticGainControl.isAvailable(),
        create = { AutomaticGainControl.create(initializedRecorder.audioSessionId) },
      )
      gainControl.effect?.let(effects::add)

      val vad = BobLiveVad(initialGeneration = captureGeneration)
      val capabilities = CaptureCapabilities(
        sessionId = sessionId,
        captureId = UUID.randomUUID().toString(),
        maxCaptureDurationMs = maxCaptureDurationMs,
        acousticEchoCancellation = aec.status,
        noiseSuppression = noiseSuppressor.status,
        automaticGainControl = gainControl.status,
        vadConfig = vad.config,
      )
      val state = CaptureState(
        sessionId = sessionId,
        generation = captureGeneration,
        recorder = initializedRecorder,
        effects = effects.toList(),
        audioManager = audioManager,
        audioModeLease = modeLease
          ?: throw BobLiveAudioException("capture_initialization_failed"),
        audioFocusLease = focusLease
          ?: throw BobLiveAudioException("capture_initialization_failed"),
        capabilities = capabilities,
        vad = vad,
      )

      synchronized(stateLock) {
        if (
          generation != captureGeneration
          || activeCapture != null
          || destroyed.get()
          || !acceptsStarts.get()
          || state.audioFocusLease.lost.get()
        ) {
          throw BobLiveAudioException("capture_initialization_failed")
        }
        activeCapture = state
      }
      installedState = state

      // `prepareAsync` précède volontairement l'installation des listeners JS. Un gel ou un
      // crash entre prepare et start ne doit donc jamais garder le focus et le recorder ouverts.
      state.watchdog = schedulePreparedStartTimeout(state)

      // La perte de focus peut arriver entre requestAudioFocus() et l'installation
      // generationnelle. Le listener pose le bit atomique; ce second fence ferme la course.
      if (state.audioFocusLease.lost.get() || destroyed.get() || !acceptsStarts.get()) {
        throw BobLiveAudioException("capture_initialization_failed")
      }
      return capabilities
    } catch (error: SecurityException) {
      clearFailedInstall(installedState)
      releasePartiallyConstructedOnControl(
        recorder,
        effects,
        audioManager,
        modeLease,
        focusLease,
        captureGeneration,
      )
      throw BobLiveAudioException("microphone_permission_denied")
    } catch (error: BobLiveAudioException) {
      clearFailedInstall(installedState)
      releasePartiallyConstructedOnControl(
        recorder,
        effects,
        audioManager,
        modeLease,
        focusLease,
        captureGeneration,
      )
      throw error
    } catch (_: Exception) {
      clearFailedInstall(installedState)
      releasePartiallyConstructedOnControl(
        recorder,
        effects,
        audioManager,
        modeLease,
        focusLease,
        captureGeneration,
      )
      throw BobLiveAudioException("capture_initialization_failed")
    }
  }

  @SuppressLint("MissingPermission")
  private fun startPreparedCaptureOnControl(sessionId: String, captureId: String) {
    if (!SESSION_ID.matches(sessionId) || !SESSION_ID.matches(captureId)) {
      throw BobLiveAudioException("capture_protocol_failed")
    }
    val state = synchronized(stateLock) {
      activeCapture?.takeIf {
        it.sessionId == sessionId
          && it.capabilities.captureId == captureId
          && !it.stopping
          && generation == it.generation
      }
    } ?: throw BobLiveAudioException("capture_protocol_failed")

    if (destroyed.get() || !acceptsStarts.get()) {
      stopCaptureOnControl(
        requestedSessionId = sessionId,
        requestedCaptureId = captureId,
        expectedGeneration = state.generation,
        reason = if (destroyed.get()) {
          CaptureStopReason.CONTEXT_DESTROYED
        } else {
          CaptureStopReason.BACKGROUND
        },
        emitEvent = acceptsEvents.get() && !destroyed.get(),
      )
      throw BobLiveAudioException("capture_initialization_failed")
    }
    if (state.audioFocusLease.lost.get()) {
      failCaptureOnControl(state, "capture_interrupted", CaptureStopReason.INTERRUPTION)
      throw BobLiveAudioException("capture_initialization_failed")
    }
    if (state.started) return

    try {
      state.watchdog?.cancel(false)
      state.watchdog = null
      state.recorder.startRecording()
      if (state.recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        throw BobLiveAudioException("capture_initialization_failed")
      }

      val captureThread = Thread(
        { captureLoop(state) },
        "BobLiveAudioCapture-${state.generation}",
      ).apply {
        isDaemon = true
      }
      state.thread = captureThread

      synchronized(stateLock) {
        if (
          activeCapture !== state
          || state.stopping
          || generation != state.generation
          || destroyed.get()
          || !acceptsStarts.get()
        ) {
          throw BobLiveAudioException("capture_initialization_failed")
        }
        state.started = true
        state.lastPcmAtMonotonicMs = SystemClock.elapsedRealtime()
      }

      // Une perte juste avant started=true n'est volontairement pas emise par le
      // listener (la capture n'avait pas commence). Ce fence la transforme en arret
      // autoritatif maintenant que les listeners JS sont installes.
      if (state.audioFocusLease.lost.get()) {
        failCaptureOnControl(state, "capture_interrupted", CaptureStopReason.INTERRUPTION)
        throw BobLiveAudioException("capture_initialization_failed")
      }

      state.watchdog = watchdogExecutor.schedule(
        {
          scheduleCaptureFailure(
            state,
            "capture_watchdog_expired",
            CaptureStopReason.WATCHDOG_TIMEOUT,
          )
        },
        state.capabilities.maxCaptureDurationMs.toLong(),
        TimeUnit.MILLISECONDS,
      )
      state.heartbeatWatchdog = scheduleCaptureHeartbeat(state)
      captureThread.start()
    } catch (_: BobLiveAudioException) {
      failCaptureOnControl(state, "capture_initialization_failed", CaptureStopReason.CAPTURE_ERROR)
      throw BobLiveAudioException("capture_initialization_failed")
    } catch (_: Exception) {
      failCaptureOnControl(state, "capture_initialization_failed", CaptureStopReason.CAPTURE_ERROR)
      throw BobLiveAudioException("capture_initialization_failed")
    }
  }

  private fun captureLoop(state: CaptureState) {
    try {
      Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
      val readBuffer = ByteArray(TARGET_FRAME_BYTES)
      val frame = ByteArray(TARGET_FRAME_BYTES)
      var frameOffset = 0
      var nextFrameStartedAtNanos = SystemClock.elapsedRealtimeNanos()

      while (isCurrent(state)) {
        val bytesRead = state.recorder.read(
          readBuffer,
          0,
          readBuffer.size,
          AudioRecord.READ_BLOCKING,
        )
        if (!isCurrent(state)) return
        if (bytesRead < 0 || bytesRead % Short.SIZE_BYTES != 0) {
          scheduleCaptureFailure(state, "capture_runtime_failed", CaptureStopReason.CAPTURE_ERROR)
          return
        }
        if (bytesRead == 0) continue
        state.lastPcmAtMonotonicMs = SystemClock.elapsedRealtime()

        var sourceOffset = 0
        while (sourceOffset < bytesRead && isCurrent(state)) {
          val copyBytes = minOf(TARGET_FRAME_BYTES - frameOffset, bytesRead - sourceOffset)
          System.arraycopy(readBuffer, sourceOffset, frame, frameOffset, copyBytes)
          sourceOffset += copyBytes
          frameOffset += copyBytes
          if (frameOffset == TARGET_FRAME_BYTES) {
            val sequence = reserveNextSequence(state)
            if (sequence == null) {
              scheduleCaptureFailure(
                state,
                "capture_backpressure_exhausted",
                CaptureStopReason.BACKPRESSURE,
              )
              return
            }
            // Decide and validate without publishing. A rejected active VAD frame must never
            // leave an orphan PCM chunk in the JS ring.
            val vadEvent = try {
              state.vad.processPcm16Le(
                frameGeneration = state.generation,
                pcm = frame,
                frameStartedAtNanos = nextFrameStartedAtNanos,
                playbackActive = false,
              )
            } catch (_: Exception) {
              scheduleCaptureFailure(
                state,
                "capture_protocol_failed",
                CaptureStopReason.CAPTURE_ERROR,
              )
              return
            }
            if (!isCurrent(state)) return
            if (vadEvent === BobLiveVadEvent.IgnoredStaleGeneration) {
              // Impossible for the still-current CaptureState: fail closed on a broken fence.
              scheduleCaptureFailure(
                state,
                "capture_protocol_failed",
                CaptureStopReason.CAPTURE_ERROR,
              )
              return
            }
            val frameStartedAtMonotonicMs = nextFrameStartedAtNanos / 1_000_000L
            if (
              !BobLiveVadBridgeContract.isSafeJsInteger(sequence) ||
              !BobLiveVadBridgeContract.isSafeJsInteger(frameStartedAtMonotonicMs)
            ) {
              scheduleCaptureFailure(
                state,
                "capture_protocol_failed",
                CaptureStopReason.CAPTURE_ERROR,
              )
              return
            }
            val vadPayload = when (vadEvent) {
              BobLiveVadEvent.None -> null
              BobLiveVadEvent.IgnoredStaleGeneration -> null // handled above
              is BobLiveVadEvent.SpeechStarted,
              is BobLiveVadEvent.SpeechEnded -> vadEventPayloadOrNull(state, vadEvent)
                ?: run {
                  scheduleCaptureFailure(
                    state,
                    "capture_protocol_failed",
                    CaptureStopReason.CAPTURE_ERROR,
                  )
                  return
                }
            }
            // Bridge call order is authoritative for the JS pre-roll ring: PCM, then VAD.
            emitPcmChunk(state, sequence, frame, frameStartedAtMonotonicMs)
            if (!isCurrent(state)) return
            if (vadPayload != null) emitVadEvent(state, vadPayload)
            if (nextFrameStartedAtNanos > Long.MAX_VALUE - TARGET_FRAME_DURATION_NANOS) {
              scheduleCaptureFailure(
                state,
                "capture_protocol_failed",
                CaptureStopReason.CAPTURE_ERROR,
              )
              return
            }
            nextFrameStartedAtNanos += TARGET_FRAME_DURATION_NANOS
            frameOffset = 0
          }
        }
      }
    } catch (_: Exception) {
      if (!state.stopping) {
        scheduleCaptureFailure(state, "capture_runtime_failed", CaptureStopReason.CAPTURE_ERROR)
      }
    }
  }

  private fun reserveNextSequence(state: CaptureState): Long? = synchronized(stateLock) {
    if (
      activeCapture !== state
      || !state.started
      || state.stopping
      || generation != state.generation
    ) return@synchronized null
    val outstandingAfterEmission = state.nextSequence - state.lastAcknowledgedSequence
    if (outstandingAfterEmission > MAX_IN_FLIGHT_FRAMES) return@synchronized null
    state.nextSequence.also { state.nextSequence = nextSequence(state.nextSequence) }
  }

  private fun emitPcmChunk(
    state: CaptureState,
    sequence: Long,
    pcm: ByteArray,
    frameStartedAtMonotonicMs: Long,
  ) {
    if (!isCurrent(state)) return
    safeSendEvent(
      "onPcmChunk",
      mapOf(
        "sessionId" to state.sessionId,
        "captureId" to state.capabilities.captureId,
        "sequence" to sequence,
        "capturedAtMonotonicMs" to frameStartedAtMonotonicMs,
        "pcmBase64" to Base64.encodeToString(pcm, Base64.NO_WRAP),
      ),
    )
  }

  private fun emitVadEvent(state: CaptureState, payload: Map<String, Any?>) {
    if (!isCurrent(state)) return
    safeSendEvent("onVadEvent", payload)
  }

  private fun vadEventPayloadOrNull(
    state: CaptureState,
    event: BobLiveVadEvent,
  ): Map<String, Any?>? {
    val kind = when (event) {
      is BobLiveVadEvent.SpeechStarted -> BOB_LIVE_VAD_SPEECH_STARTED
      is BobLiveVadEvent.SpeechEnded -> BOB_LIVE_VAD_SPEECH_ENDED
      BobLiveVadEvent.None,
      BobLiveVadEvent.IgnoredStaleGeneration -> return null
    }
    if (!BobLiveVadBridgeContract.isValid(event, kind, state.generation, state.vad.config)) {
      return null
    }

    return when (event) {
      is BobLiveVadEvent.SpeechStarted -> vadEventPayload(
        state = state,
        kind = kind,
        configVersion = event.configVersion,
        utteranceIndex = event.utteranceIndex,
        detectedAtNanos = event.detectedAtNanos,
        preRollMs = event.preRollMs,
        startedAtNanos = event.startedAtNanos,
        endedAtNanos = null,
        forcedEnd = false,
        energyDbfs = event.energyDbfs,
        noiseFloorDbfs = event.noiseFloorDbfs,
      )
      is BobLiveVadEvent.SpeechEnded -> vadEventPayload(
        state = state,
        kind = kind,
        configVersion = event.configVersion,
        utteranceIndex = event.utteranceIndex,
        detectedAtNanos = event.detectedAtNanos,
        preRollMs = event.preRollMs,
        startedAtNanos = event.startedAtNanos,
        endedAtNanos = event.endedAtNanos,
        forcedEnd = event.forcedEnd,
        energyDbfs = event.energyDbfs,
        noiseFloorDbfs = event.noiseFloorDbfs,
      )
      BobLiveVadEvent.None,
      BobLiveVadEvent.IgnoredStaleGeneration -> null
    }
  }

  private fun vadEventPayload(
    state: CaptureState,
    kind: String,
    configVersion: String,
    utteranceIndex: Long,
    detectedAtNanos: Long,
    preRollMs: Int,
    startedAtNanos: Long,
    endedAtNanos: Long?,
    forcedEnd: Boolean,
    energyDbfs: Double,
    noiseFloorDbfs: Double,
  ): Map<String, Any?> = mapOf(
    "sessionId" to state.sessionId,
    "captureId" to state.capabilities.captureId,
    "kind" to kind,
    "configVersion" to configVersion,
    "utteranceIndex" to utteranceIndex,
    "detectedAtMonotonicMs" to detectedAtNanos / 1_000_000L,
    "preRollMs" to preRollMs,
    "startedAtMonotonicMs" to startedAtNanos / 1_000_000L,
    "endedAtMonotonicMs" to endedAtNanos?.div(1_000_000L),
    "forcedEnd" to forcedEnd,
    "energyDbfs" to energyDbfs,
    "noiseFloorDbfs" to noiseFloorDbfs,
  )

  private fun acknowledgeOnControl(
    sessionId: String,
    captureId: String,
    throughSequence: Long,
  ) {
    if (!SESSION_ID.matches(sessionId) || !SESSION_ID.matches(captureId) || throughSequence < 0) {
      throw BobLiveAudioException("capture_protocol_failed")
    }
    val state = synchronized(stateLock) { activeCapture } ?: return
    if (state.sessionId != sessionId || state.capabilities.captureId != captureId) {
      // ACK retarde d'une ancienne session: ne jamais fermer la capture courante.
      throw BobLiveAudioException("capture_protocol_failed")
    }

    val invalidFutureAck = synchronized(stateLock) {
      if (activeCapture !== state || state.stopping || generation != state.generation) return@synchronized false
      if (throughSequence <= state.lastAcknowledgedSequence) return@synchronized false
      if (throughSequence >= state.nextSequence) return@synchronized true
      state.lastAcknowledgedSequence = throughSequence
      false
    }
    if (invalidFutureAck) {
      failCaptureOnControl(state, "capture_protocol_failed", CaptureStopReason.CAPTURE_ERROR)
      throw BobLiveAudioException("capture_protocol_failed")
    }
  }

  private fun schedulePreparedStartTimeout(state: CaptureState): ScheduledFuture<*> =
    watchdogExecutor.schedule(
      {
        if (!controlExecutor.isShutdown) {
          try {
            controlExecutor.execute {
              val stillPrepared = synchronized(stateLock) {
                activeCapture === state
                  && !state.started
                  && !state.stopping
                  && generation == state.generation
              }
              if (stillPrepared) {
                failCaptureOnControl(
                  state,
                  "capture_watchdog_expired",
                  CaptureStopReason.WATCHDOG_TIMEOUT,
                )
              }
            }
          } catch (_: RejectedExecutionException) {
            // OnDestroy a deja queue le nettoyage autoritatif avant shutdown().
          }
        }
      },
      minOf(state.capabilities.maxCaptureDurationMs.toLong(), PREPARED_START_TIMEOUT_MS),
      TimeUnit.MILLISECONDS,
    )

  private fun scheduleCaptureHeartbeat(state: CaptureState): ScheduledFuture<*> =
    watchdogExecutor.scheduleAtFixedRate(
      {
        if (state.started && !state.stopping && acceptsStarts.get() && !destroyed.get()) {
          val recorderRunning = try {
            state.recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING
          } catch (_: RuntimeException) {
            false
          }
          val ownsCommunicationMode = try {
            state.audioManager.mode == AudioManager.MODE_IN_COMMUNICATION
          } catch (_: RuntimeException) {
            false
          }
          val interrupted = state.audioFocusLease.lost.get()
            || !ownsCommunicationMode
            || !recorderRunning
          if (interrupted) {
            scheduleCaptureFailure(
              state,
              "capture_interrupted",
              CaptureStopReason.INTERRUPTION,
            )
          } else {
            val lastPcmAt = state.lastPcmAtMonotonicMs
            if (
              lastPcmAt == null
              || SystemClock.elapsedRealtime() - lastPcmAt >= MAXIMUM_PCM_SILENCE_MS
            ) {
              scheduleCaptureFailure(
                state,
                "capture_runtime_failed",
                CaptureStopReason.CAPTURE_ERROR,
              )
            }
          }
        }
      },
      CAPTURE_HEARTBEAT_INTERVAL_MS,
      CAPTURE_HEARTBEAT_INTERVAL_MS,
      TimeUnit.MILLISECONDS,
    )

  private fun scheduleCaptureFailure(
    state: CaptureState,
    errorCode: String,
    reason: CaptureStopReason,
  ) {
    if (state.stopping || !acceptsStarts.get() || destroyed.get() || controlExecutor.isShutdown) return
    try {
      controlExecutor.execute {
        failCaptureOnControl(state, errorCode, reason)
      }
    } catch (_: RejectedExecutionException) {
      // OnDestroy a deja queue le nettoyage autoritatif avant shutdown().
    }
  }

  private fun failCaptureOnControl(
    state: CaptureState,
    errorCode: String,
    reason: CaptureStopReason,
  ) {
    val claimed = synchronized(stateLock) {
      if (activeCapture !== state || state.stopping || generation != state.generation) {
        false
      } else {
        state.stopping = true
        activeCapture = null
        generation = nextGeneration(generation)
        true
      }
    }
    if (!claimed) return

    safeSendEvent(
      "onCaptureError",
      mapOf(
        "sessionId" to state.sessionId,
        "captureId" to state.capabilities.captureId,
        "code" to errorCode,
      ),
    )
    releaseCaptureOnControl(state, joinThread = state.thread !== Thread.currentThread())
    safeSendEvent(
      "onCaptureStopped",
      mapOf(
        "sessionId" to state.sessionId,
        "captureId" to state.capabilities.captureId,
        "reason" to reason.wireValue,
      ),
    )
  }

  private fun stopCaptureOnControl(
    requestedSessionId: String?,
    requestedCaptureId: String?,
    expectedGeneration: Long?,
    reason: CaptureStopReason,
    emitEvent: Boolean,
  ) {
    val state = synchronized(stateLock) {
      val active = activeCapture ?: return
      if (requestedSessionId != null && active.sessionId != requestedSessionId) return
      if (requestedCaptureId != null && active.capabilities.captureId != requestedCaptureId) return
      if (expectedGeneration != null && active.generation != expectedGeneration) return
      active.stopping = true
      activeCapture = null
      generation = nextGeneration(generation)
      active
    }
    releaseCaptureOnControl(state, joinThread = true)
    if (emitEvent) {
      safeSendEvent(
        "onCaptureStopped",
        mapOf(
          "sessionId" to state.sessionId,
          "captureId" to state.capabilities.captureId,
          "reason" to reason.wireValue,
        ),
      )
    }
  }

  private fun scheduleLifecycleStop(reason: CaptureStopReason, emitEvent: Boolean) {
    if (controlExecutor.isShutdown) return
    try {
      controlExecutor.execute {
        stopCaptureOnControl(
          requestedSessionId = null,
          requestedCaptureId = null,
          expectedGeneration = null,
          reason = reason,
          emitEvent = emitEvent,
        )
      }
    } catch (_: RejectedExecutionException) {
      // L'executor peut se fermer entre le test et execute().
    }
  }

  private fun releaseCaptureOnControl(state: CaptureState, joinThread: Boolean) {
    state.watchdog?.cancel(false)
    state.watchdog = null
    state.heartbeatWatchdog?.cancel(false)
    state.heartbeatWatchdog = null
    state.lastPcmAtMonotonicMs = null
    state.started = false
    try {
      if (state.recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) state.recorder.stop()
    } catch (_: IllegalStateException) {
      // La generation est invalidee; le nettoyage doit continuer.
    }

    val thread = state.thread
    if (joinThread && thread != null && thread !== Thread.currentThread()) {
      try {
        thread.join(STOP_JOIN_TIMEOUT_MS)
        if (thread.isAlive) thread.interrupt()
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    state.thread = null

    state.effects.forEach(::releaseEffect)
    try {
      state.recorder.release()
    } catch (_: RuntimeException) {
      // DEAD_OBJECT ou service audio deja detruit.
    } finally {
      abandonAudioFocus(state.audioManager, state.audioFocusLease)
      restoreAudioModeOnControl(state.audioManager, state.audioModeLease)
    }
  }

  private fun releasePartiallyConstructedOnControl(
    recorder: AudioRecord?,
    effects: List<AudioEffect>,
    audioManager: AudioManager,
    modeLease: AudioModeLease?,
    focusLease: AudioFocusLease?,
    captureGeneration: Long,
  ) {
    effects.forEach(::releaseEffect)
    if (recorder != null) {
      try {
        if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
      } catch (_: IllegalStateException) {
        // Recorder partiellement initialise.
      }
      try {
        recorder.release()
      } catch (_: RuntimeException) {
        // Recorder partiellement initialise.
      }
    }
    if (focusLease != null) abandonAudioFocus(audioManager, focusLease)
    if (modeLease != null) restoreAudioModeOnControl(audioManager, modeLease)
    synchronized(stateLock) {
      if (generation == captureGeneration) generation = nextGeneration(generation)
    }
  }

  private fun acquireAudioModeOnControl(
    audioManager: AudioManager,
    captureGeneration: Long,
  ): AudioModeLease {
    if (audioModeOwnerGeneration != null) throw BobLiveAudioException("capture_busy")
    val lease = AudioModeLease(captureGeneration, audioManager.mode)
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    audioModeOwnerGeneration = captureGeneration
    return lease
  }

  private fun restoreAudioModeOnControl(audioManager: AudioManager, lease: AudioModeLease) {
    if (audioModeOwnerGeneration != lease.generation) return
    audioModeOwnerGeneration = null
    try {
      // Une autre brique peut avoir repris le mode entre-temps; ne jamais l'ecraser.
      if (audioManager.mode == AudioManager.MODE_IN_COMMUNICATION) {
        audioManager.mode = lease.previousMode
      }
    } catch (_: RuntimeException) {
      // AudioService peut disparaitre pendant l'extinction du processus.
    }
  }

  @Suppress("DEPRECATION")
  private fun acquireAudioFocus(
    audioManager: AudioManager,
    captureGeneration: Long,
  ): AudioFocusLease {
    val lost = AtomicBoolean(false)
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      if (
        change == AudioManager.AUDIOFOCUS_LOSS
        || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
        || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
      ) {
        lost.set(true)
        val state = synchronized(stateLock) {
          activeCapture?.takeIf { it.generation == captureGeneration }
        }
        if (state?.started == true && acceptsStarts.get() && !destroyed.get()) {
          scheduleCaptureFailure(state, "capture_interrupted", CaptureStopReason.INTERRUPTION)
        }
      }
    }

    val request: AudioFocusRequest?
    val result: Int
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(attributes)
        .setAcceptsDelayedFocusGain(false)
        .setOnAudioFocusChangeListener(listener)
        .build()
      result = audioManager.requestAudioFocus(request)
    } else {
      request = null
      result = audioManager.requestAudioFocus(
        listener,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
      )
    }
    if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      throw BobLiveAudioException("capture_initialization_failed")
    }
    return AudioFocusLease(listener, request, lost)
  }

  @Suppress("DEPRECATION")
  private fun abandonAudioFocus(audioManager: AudioManager, lease: AudioFocusLease) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && lease.request != null) {
        audioManager.abandonAudioFocusRequest(lease.request)
      } else {
        audioManager.abandonAudioFocus(lease.listener)
      }
    } catch (_: RuntimeException) {
      // AudioService peut etre deja detruit.
    }
  }

  @SuppressLint("MissingPermission")
  private fun createAudioRecorder(audioFormat: AudioFormat, bufferBytes: Int): AudioRecord {
    for (source in intArrayOf(MediaRecorder.AudioSource.VOICE_COMMUNICATION, MediaRecorder.AudioSource.MIC)) {
      val candidate = try {
        AudioRecord.Builder()
          .setAudioSource(source)
          .setAudioFormat(audioFormat)
          .setBufferSizeInBytes(bufferBytes)
          .build()
      } catch (error: SecurityException) {
        throw error
      } catch (_: RuntimeException) {
        null
      }
      if (candidate?.state == AudioRecord.STATE_INITIALIZED) return candidate
      try {
        candidate?.release()
      } catch (_: RuntimeException) {
        // Continuer vers MIC.
      }
    }
    throw BobLiveAudioException("capture_initialization_failed")
  }

  private fun clearFailedInstall(state: CaptureState?) {
    if (state == null) return
    synchronized(stateLock) {
      if (activeCapture !== state) return
      state.stopping = true
      activeCapture = null
      generation = nextGeneration(generation)
    }
    state.watchdog?.cancel(false)
    state.watchdog = null
    state.heartbeatWatchdog?.cancel(false)
    state.heartbeatWatchdog = null
    state.lastPcmAtMonotonicMs = null
  }

  private fun releaseEffect(effect: AudioEffect) {
    try {
      effect.enabled = false
    } catch (_: RuntimeException) {
      // L'effet peut avoir perdu son controle.
    }
    try {
      effect.release()
    } catch (_: RuntimeException) {
      // La session audio peut deja etre detruite.
    }
  }

  private data class EffectResult(
    val effect: AudioEffect?,
    val status: ProcessingStatus,
  )

  private fun createEffect(available: Boolean, create: () -> AudioEffect?): EffectResult {
    if (!available) return EffectResult(null, ProcessingStatus.UNAVAILABLE)
    return try {
      val effect = create() ?: return EffectResult(null, ProcessingStatus.UNAVAILABLE)
      try {
        effect.enabled = true
        EffectResult(
          effect,
          if (effect.enabled) ProcessingStatus.ENABLED else ProcessingStatus.UNAVAILABLE,
        )
      } catch (_: RuntimeException) {
        releaseEffect(effect)
        EffectResult(null, ProcessingStatus.UNAVAILABLE)
      }
    } catch (_: RuntimeException) {
      EffectResult(null, ProcessingStatus.UNAVAILABLE)
    }
  }

  private fun isCurrent(state: CaptureState): Boolean = synchronized(stateLock) {
    activeCapture === state
      && state.started
      && !state.stopping
      && acceptsStarts.get()
      && !destroyed.get()
      && generation == state.generation
  }

  private fun safeSendEvent(name: String, body: Map<String, Any?>) {
    if (!acceptsEvents.get()) return
    try {
      sendEvent(name, body)
    } catch (_: IllegalArgumentException) {
      // Le runtime JS peut disparaitre entre le fence et l'emission.
    } catch (_: IllegalStateException) {
      // Idem lors d'un fast refresh/destroy de l'AppContext.
    }
  }

  private fun <T> runOnControl(block: () -> T): T {
    if (controlExecutor.isShutdown) throw BobLiveAudioException("capture_initialization_failed")
    val future = try {
      controlExecutor.submit<T> { block() }
    } catch (_: RejectedExecutionException) {
      throw BobLiveAudioException("capture_initialization_failed")
    }
    return try {
      future.get()
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      throw BobLiveAudioException("capture_initialization_failed")
    } catch (error: ExecutionException) {
      throw (error.cause as? BobLiveAudioException
        ?: BobLiveAudioException("capture_initialization_failed"))
    }
  }

  private fun nextGeneration(current: Long): Long = if (current == Long.MAX_VALUE) 1L else current + 1L

  private fun nextSequence(current: Long): Long {
    if (current == Long.MAX_VALUE) throw BobLiveAudioException("capture_protocol_failed")
    return current + 1L
  }
}
