import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
  }
}

var fence = BobLiveAudioWatchdogFence()

let prepared = fence.arm(.prepared)
expect(fence.accepts(token: prepared, phase: .prepared, captureRunning: false),
       "le watchdog de préparation doit être recevable avant start")
expect(!fence.accepts(token: prepared, phase: .prepared, captureRunning: true),
       "le watchdog de préparation ne doit jamais arrêter une capture démarrée")

let capturing = fence.arm(.capturing)
expect(!fence.accepts(token: prepared, phase: .prepared, captureRunning: false),
       "un watchdog remplacé doit être fencé par son jeton")
expect(fence.accepts(token: capturing, phase: .capturing, captureRunning: true),
       "le watchdog de durée doit rester actif pendant la capture")
expect(!fence.accepts(token: capturing, phase: .capturing, captureRunning: false),
       "le watchdog de durée ne doit pas agir après l'arrêt")

fence.cancel()
expect(!fence.accepts(token: capturing, phase: .capturing, captureRunning: true),
       "cancel doit invalider un callback déjà mis en file")

print("BobLiveAudioWatchdogFence: OK")
