package expo.modules.bobliveaudio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BobLiveAudioPhysicalReleaseProofTest {
  private val complete = BobLiveAudioPhysicalReleaseProof.NO_RESOURCES

  @Test
  fun completeProofAllowsTerminality() {
    assertTrue(complete.isComplete)
  }

  @Test
  fun aLiveCaptureThreadKeepsTheGenerationUnreleased() {
    assertFalse(complete.copy(captureThreadTerminated = false).isComplete)
  }

  @Test
  fun recorderStopOrReleaseFailureKeepsTheGenerationUnreleased() {
    assertFalse(complete.copy(recorderStopped = false).isComplete)
    assertFalse(complete.copy(recorderReleased = false).isComplete)
  }

  @Test
  fun focusOrModeFailureKeepsTheGenerationUnreleased() {
    assertFalse(complete.copy(audioFocusAbandoned = false).isComplete)
    assertFalse(complete.copy(audioModeReleased = false).isComplete)
  }
}
