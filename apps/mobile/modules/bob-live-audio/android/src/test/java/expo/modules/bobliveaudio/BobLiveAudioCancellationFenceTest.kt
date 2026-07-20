package expo.modules.bobliveaudio

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BobLiveAudioCancellationFenceTest {
  private val sessionId = "018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a21"
  private val captureId = "018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a22"

  @Test
  fun cancelBeforePrepareIsTerminalAndIdempotent() {
    val fence = BobLiveAudioCancellationFence()

    assertTrue(fence.requestCancellation(sessionId, captureId))
    assertFalse(fence.beginPrepare(sessionId, captureId))
    assertEquals(BobLiveAudioCancellationPhase.CANCELLING, fence.phase(sessionId, captureId))
    assertTrue(fence.markReleased(sessionId, captureId, physicalReleaseProven = false))
    assertFalse(fence.markReleased(sessionId, captureId, physicalReleaseProven = true))
    assertTrue(fence.requestCancellation(sessionId, captureId))
  }

  @Test
  fun cancelDoesNotWaitForTheBlockedAudioExecutor() {
    val fence = BobLiveAudioCancellationFence()
    assertTrue(fence.beginPrepare(sessionId, captureId))
    assertTrue(fence.markResourcesMayBeAllocated(sessionId, captureId))
    val entered = CountDownLatch(1)
    val unblock = CountDownLatch(1)
    val finished = CountDownLatch(1)
    val executor = Executors.newSingleThreadExecutor()
    try {
      executor.execute {
        entered.countDown()
        unblock.await(5, TimeUnit.SECONDS)
        assertTrue(fence.isCancellationRequested(sessionId, captureId))
        assertTrue(fence.markReleased(sessionId, captureId, physicalReleaseProven = true))
        finished.countDown()
      }

      assertTrue(entered.await(1, TimeUnit.SECONDS))
      assertTrue(fence.requestCancellation(sessionId, captureId))
      assertTrue(fence.isCancellationRequested(sessionId, captureId))
      unblock.countDown()
      assertTrue(finished.await(1, TimeUnit.SECONDS))
    } finally {
      executor.shutdownNow()
    }
  }

  @Test
  fun cancellationIsGenerationBoundAndTheRegistryIsBounded() {
    val fence = BobLiveAudioCancellationFence(maximumEntries = 2)
    val capture2 = "018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a23"
    val capture3 = "018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a24"

    assertTrue(fence.beginPrepare(sessionId, captureId))
    assertTrue(fence.beginPrepare(sessionId, capture2))
    assertTrue(fence.requestCancellation(sessionId, captureId))
    assertFalse(fence.isCancellationRequested(sessionId, capture2))
    assertFalse(fence.beginPrepare(sessionId, capture3))
    assertTrue(fence.markReleased(sessionId, captureId, physicalReleaseProven = false))
    assertTrue(fence.beginPrepare(sessionId, capture3))
    assertFalse(fence.beginPrepare(sessionId, captureId))
  }

  @Test
  fun transitionsAreStrictAndCaptureIdsAreOneShot() {
    val fence = BobLiveAudioCancellationFence()

    assertTrue(fence.beginPrepare(sessionId, captureId))
    assertFalse(fence.beginPrepare(sessionId, captureId))
    assertFalse(fence.transition(sessionId, captureId, BobLiveAudioCancellationPhase.CAPTURING))
    assertTrue(fence.transition(sessionId, captureId, BobLiveAudioCancellationPhase.PREPARED))
    assertFalse(fence.transition(sessionId, captureId, BobLiveAudioCancellationPhase.PREPARED))
    assertTrue(fence.transition(sessionId, captureId, BobLiveAudioCancellationPhase.STARTING))
    assertTrue(fence.transition(sessionId, captureId, BobLiveAudioCancellationPhase.CAPTURING))
    assertFalse(fence.markReleased(sessionId, captureId, physicalReleaseProven = true))
    assertTrue(fence.requestCancellation(sessionId, captureId))
    assertTrue(fence.markReleased(sessionId, captureId, physicalReleaseProven = true))
  }

  @Test
  fun allocatedResourcesRequireCompletePhysicalProof() {
    val fence = BobLiveAudioCancellationFence()
    assertTrue(fence.beginPrepare(sessionId, captureId))
    assertTrue(fence.markResourcesMayBeAllocated(sessionId, captureId))
    assertTrue(fence.requestCancellation(sessionId, captureId))

    assertFalse(fence.markReleased(sessionId, captureId, physicalReleaseProven = false))
    assertEquals(BobLiveAudioCancellationPhase.CANCELLING, fence.phase(sessionId, captureId))
    assertTrue(fence.markReleased(sessionId, captureId, physicalReleaseProven = true))
  }
}
