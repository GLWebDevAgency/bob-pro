import Foundation

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

private let sessionId = "018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a21"
private let captureId = "018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a22"

private func testCancelBeforePrepare() {
  let fence = BobLiveAudioCancellationFence()
  expect(fence.requestCancellation(sessionId: sessionId, captureId: captureId), "cancel fence")
  expect(!fence.beginPrepare(sessionId: sessionId, captureId: captureId), "cancel beats prepare")
  expect(
    fence.phase(sessionId: sessionId, captureId: captureId) == .cancelling,
    "cancelling phase"
  )
  expect(
    fence.markReleased(
      sessionId: sessionId,
      captureId: captureId,
      physicalReleaseProven: false
    ),
    "first release proof"
  )
  expect(
    !fence.markReleased(
      sessionId: sessionId,
      captureId: captureId,
      physicalReleaseProven: true
    ),
    "terminal exactly once"
  )
  expect(fence.requestCancellation(sessionId: sessionId, captureId: captureId), "idempotent cancel")
}

private func testCancelDoesNotWaitForAudioQueue() {
  let fence = BobLiveAudioCancellationFence()
  expect(fence.beginPrepare(sessionId: sessionId, captureId: captureId), "begin prepare")
  expect(
    fence.markResourcesMayBeAllocated(sessionId: sessionId, captureId: captureId),
    "resources may be allocated"
  )

  let entered = DispatchSemaphore(value: 0)
  let unblock = DispatchSemaphore(value: 0)
  let finished = DispatchSemaphore(value: 0)
  DispatchQueue(label: "bob-live-test-audio").async {
    entered.signal()
    _ = unblock.wait(timeout: .now() + 5)
    expect(
      fence.isCancellationRequested(sessionId: sessionId, captureId: captureId),
      "worker observes tombstone"
    )
    expect(
      fence.markReleased(
        sessionId: sessionId,
        captureId: captureId,
        physicalReleaseProven: true
      ),
      "worker releases once"
    )
    finished.signal()
  }

  expect(entered.wait(timeout: .now() + 1) == .success, "worker entered blocking stage")
  expect(fence.requestCancellation(sessionId: sessionId, captureId: captureId), "cancel returns")
  expect(
    fence.isCancellationRequested(sessionId: sessionId, captureId: captureId),
    "tombstone visible while audio queue blocked"
  )
  unblock.signal()
  expect(finished.wait(timeout: .now() + 1) == .success, "worker terminal")
}

private func testGenerationIsolationAndBound() {
  let fence = BobLiveAudioCancellationFence(maximumEntries: 2)
  let capture2 = "018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a23"
  let capture3 = "018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a24"
  expect(fence.beginPrepare(sessionId: sessionId, captureId: captureId), "generation one")
  expect(fence.beginPrepare(sessionId: sessionId, captureId: capture2), "generation two")
  expect(fence.requestCancellation(sessionId: sessionId, captureId: captureId), "cancel generation one")
  expect(
    !fence.isCancellationRequested(sessionId: sessionId, captureId: capture2),
    "generation two remains live"
  )
  expect(!fence.beginPrepare(sessionId: sessionId, captureId: capture3), "no unbounded tombstones")
  expect(
    fence.markReleased(
      sessionId: sessionId,
      captureId: captureId,
      physicalReleaseProven: false
    ),
    "retire generation one"
  )
  expect(fence.beginPrepare(sessionId: sessionId, captureId: capture3), "retired slot is reusable")
  expect(
    !fence.beginPrepare(sessionId: sessionId, captureId: captureId),
    "retired generation identity remains one-shot"
  )
}

private func testStrictTransitionsAndPhysicalProof() {
  let fence = BobLiveAudioCancellationFence()
  expect(fence.beginPrepare(sessionId: sessionId, captureId: captureId), "one-shot begin")
  expect(!fence.beginPrepare(sessionId: sessionId, captureId: captureId), "id cannot be reused")
  expect(
    !fence.transition(sessionId: sessionId, captureId: captureId, to: .capturing),
    "preparing cannot jump to capturing"
  )
  expect(
    fence.markResourcesMayBeAllocated(sessionId: sessionId, captureId: captureId),
    "resource acquisition fenced"
  )
  expect(
    fence.transition(sessionId: sessionId, captureId: captureId, to: .prepared),
    "prepare arc"
  )
  expect(
    fence.transition(sessionId: sessionId, captureId: captureId, to: .starting),
    "start arc"
  )
  expect(
    fence.transition(sessionId: sessionId, captureId: captureId, to: .capturing),
    "capture arc"
  )
  expect(
    !fence.markReleased(
      sessionId: sessionId,
      captureId: captureId,
      physicalReleaseProven: true
    ),
    "release requires cancelling arc"
  )
  expect(fence.requestCancellation(sessionId: sessionId, captureId: captureId), "cancel arc")
  expect(
    !fence.markReleased(
      sessionId: sessionId,
      captureId: captureId,
      physicalReleaseProven: false
    ),
    "allocated resources reject an incomplete physical proof"
  )
  expect(
    fence.markReleased(
      sessionId: sessionId,
      captureId: captureId,
      physicalReleaseProven: true
    ),
    "complete physical proof releases"
  )
}

@main
private enum BobLiveAudioCancellationFenceStandaloneTests {
  static func main() {
    testCancelBeforePrepare()
    testCancelDoesNotWaitForAudioQueue()
    testGenerationIsolationAndBound()
    testStrictTransitionsAndPhysicalProof()
    print("BobLiveAudioCancellationFence: OK (4 deterministic suites)")
  }
}
