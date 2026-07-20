enum BobLiveAudioWatchdogPhase: Equatable {
  case prepared
  case capturing
}

/// Petit automate pur qui rend les timers audio annulés réellement inoffensifs.
///
/// `DispatchWorkItem.cancel()` est coopératif : un callback déjà mis en file peut encore entrer.
/// Le jeton monotone et la phase attendue empêchent alors un ancien watchdog de préparation de
/// fermer une capture active, ou un watchdog de capture d'agir après l'arrêt.
struct BobLiveAudioWatchdogFence {
  private(set) var token: UInt64 = 0
  private(set) var phase: BobLiveAudioWatchdogPhase?

  mutating func arm(_ phase: BobLiveAudioWatchdogPhase) -> UInt64 {
    token &+= 1
    self.phase = phase
    return token
  }

  mutating func cancel() {
    token &+= 1
    phase = nil
  }

  func accepts(
    token candidateToken: UInt64,
    phase candidatePhase: BobLiveAudioWatchdogPhase,
    captureRunning: Bool
  ) -> Bool {
    guard candidateToken == token, candidatePhase == phase else { return false }
    switch candidatePhase {
    case .prepared:
      return !captureRunning
    case .capturing:
      return captureRunning
    }
  }
}
