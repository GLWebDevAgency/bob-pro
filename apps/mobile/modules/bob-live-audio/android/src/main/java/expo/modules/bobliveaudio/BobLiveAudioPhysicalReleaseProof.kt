package expo.modules.bobliveaudio

/**
 * Preuve conservatrice de libération d'une génération audio Android.
 *
 * Un appel sans exception n'est pris en compte que par l'adaptateur qui a aussi vérifié l'état
 * observable correspondant. La terminalité v2 n'est publiable que si chaque propriétaire natif a
 * été rendu et si le thread de lecture ne peut plus toucher `AudioRecord`.
 */
internal data class BobLiveAudioPhysicalReleaseProof(
  val captureThreadTerminated: Boolean,
  val recorderStopped: Boolean,
  val recorderReleased: Boolean,
  val audioFocusAbandoned: Boolean,
  val audioModeReleased: Boolean,
) {
  val isComplete: Boolean
    get() = captureThreadTerminated
      && recorderStopped
      && recorderReleased
      && audioFocusAbandoned
      && audioModeReleased

  companion object {
    val NO_RESOURCES = BobLiveAudioPhysicalReleaseProof(
      captureThreadTerminated = true,
      recorderStopped = true,
      recorderReleased = true,
      audioFocusAbandoned = true,
      audioModeReleased = true,
    )
  }
}
