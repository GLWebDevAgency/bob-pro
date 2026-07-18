import Foundation

enum BobLiveAudioCancellationPhase: Equatable {
  case preparing
  case prepared
  case starting
  case capturing
  case cancelling
  case released
}

/// Fence de cycle de vie indépendant de la file AVFoundation.
///
/// `requestCancellation` ne touche jamais `captureQueue`: il doit rester appelable même si une
/// primitive audio système ne rend pas la main. La libération physique reste prouvée séparément
/// par `markReleased`, après le nettoyage de la génération concernée.
final class BobLiveAudioCancellationFence: @unchecked Sendable {
  private struct Key: Hashable {
    let sessionId: String
    let captureId: String
  }

  private struct Entry {
    var phase: BobLiveAudioCancellationPhase
    var cancellationRequested: Bool
    var resourcesMayBeAllocated: Bool
    let ordinal: UInt64
  }

  private let lock = NSLock()
  private let maximumEntries: Int
  private let maximumSeenKeys: Int
  private var entries: [Key: Entry] = [:]
  /// Tombstones de processus: l'éviction du journal court ne rend jamais un id réutilisable.
  private var seenKeys: Set<Key> = []
  private var nextOrdinal: UInt64 = 0

  init(maximumEntries: Int = 32, maximumSeenKeys: Int = 4_096) {
    self.maximumEntries = max(1, maximumEntries)
    self.maximumSeenKeys = max(maximumEntries, maximumSeenKeys)
  }

  /// Enregistre une intention avant que la tâche de préparation entre sur `captureQueue`.
  /// Retourne `false` uniquement si la clé est retraitée ou si le registre borné est saturé.
  func beginPrepare(sessionId: String, captureId: String) -> Bool {
    withLock {
      let key = Key(sessionId: sessionId, captureId: captureId)
      // `captureId` est un nonce de génération à usage unique. Une nouvelle tentative doit créer
      // un nouvel identifiant afin qu'un terminal retardé ne ferme jamais la capture suivante.
      guard !seenKeys.contains(key), seenKeys.count < maximumSeenKeys else { return false }
      guard makeRoomForEntry() else { return false }
      entries[key] = Entry(
        phase: .preparing,
        cancellationRequested: false,
        resourcesMayBeAllocated: false,
        ordinal: allocateOrdinal()
      )
      seenKeys.insert(key)
      return true
    }
  }

  func markResourcesMayBeAllocated(sessionId: String, captureId: String) -> Bool {
    withLock {
      let key = Key(sessionId: sessionId, captureId: captureId)
      guard var entry = entries[key],
            entry.phase == .preparing,
            !entry.cancellationRequested else { return false }
      entry.resourcesMayBeAllocated = true
      entries[key] = entry
      return true
    }
  }

  /// Pose un tombstone synchroniquement, y compris si `beginPrepare` n'a pas encore été exécuté.
  /// `true` atteste uniquement le fence mémoire, jamais la libération de l'audio.
  func requestCancellation(sessionId: String, captureId: String) -> Bool {
    withLock {
      let key = Key(sessionId: sessionId, captureId: captureId)
      if var entry = entries[key] {
        if entry.phase == .released { return true }
        entry.cancellationRequested = true
        entry.phase = .cancelling
        entries[key] = entry
        return true
      }
      guard !seenKeys.contains(key), seenKeys.count < maximumSeenKeys else { return false }
      guard makeRoomForEntry() else { return false }
      entries[key] = Entry(
        phase: .cancelling,
        cancellationRequested: true,
        resourcesMayBeAllocated: false,
        ordinal: allocateOrdinal()
      )
      seenKeys.insert(key)
      return true
    }
  }

  func isCancellationRequested(sessionId: String, captureId: String) -> Bool {
    withLock {
      entries[Key(sessionId: sessionId, captureId: captureId)]?.cancellationRequested == true
    }
  }

  /// Une transition n'est acceptée que pour la même génération non annulée et non terminale.
  func transition(
    sessionId: String,
    captureId: String,
    to phase: BobLiveAudioCancellationPhase
  ) -> Bool {
    withLock {
      let key = Key(sessionId: sessionId, captureId: captureId)
      guard var entry = entries[key],
            entry.phase != .released,
            !entry.cancellationRequested,
            Self.isAllowedTransition(from: entry.phase, to: phase) else { return false }
      entry.phase = phase
      entries[key] = entry
      return true
    }
  }

  /// Retourne `true` une seule fois, après annulation et preuve physique si une ressource a pu être
  /// allouée. Un cancel antérieur à l'allocation peut terminer sans preuve artificielle.
  func markReleased(
    sessionId: String,
    captureId: String,
    physicalReleaseProven: Bool
  ) -> Bool {
    withLock {
      let key = Key(sessionId: sessionId, captureId: captureId)
      guard var entry = entries[key],
            entry.phase == .cancelling,
            !entry.resourcesMayBeAllocated || physicalReleaseProven else { return false }
      entry.phase = .released
      entry.cancellationRequested = true
      entries[key] = entry
      return true
    }
  }

  func resourcesMayBeAllocated(sessionId: String, captureId: String) -> Bool {
    withLock {
      entries[Key(sessionId: sessionId, captureId: captureId)]?.resourcesMayBeAllocated == true
    }
  }

  func contains(sessionId: String, captureId: String) -> Bool {
    withLock { entries[Key(sessionId: sessionId, captureId: captureId)] != nil }
  }

  func phase(
    sessionId: String,
    captureId: String
  ) -> BobLiveAudioCancellationPhase? {
    withLock { entries[Key(sessionId: sessionId, captureId: captureId)]?.phase }
  }

  private func withLock<T>(_ operation: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return operation()
  }

  private func allocateOrdinal() -> UInt64 {
    nextOrdinal = nextOrdinal == UInt64.max ? 1 : nextOrdinal + 1
    return nextOrdinal
  }

  private func makeRoomForEntry() -> Bool {
    if entries.count < maximumEntries { return true }
    guard let retired = entries
      .filter({ $0.value.phase == .released })
      .min(by: { $0.value.ordinal < $1.value.ordinal })?.key else { return false }
    entries.removeValue(forKey: retired)
    return true
  }

  private static func isAllowedTransition(
    from: BobLiveAudioCancellationPhase,
    to: BobLiveAudioCancellationPhase
  ) -> Bool {
    switch (from, to) {
    case (.preparing, .prepared), (.prepared, .starting), (.starting, .capturing):
      return true
    default:
      return false
    }
  }
}
