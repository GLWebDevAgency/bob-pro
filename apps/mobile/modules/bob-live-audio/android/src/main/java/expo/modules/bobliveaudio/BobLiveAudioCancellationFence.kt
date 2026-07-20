package expo.modules.bobliveaudio

internal enum class BobLiveAudioCancellationPhase {
  PREPARING,
  PREPARED,
  STARTING,
  CAPTURING,
  CANCELLING,
  RELEASED,
}

/**
 * Fence mémoire indépendant du single-thread executor audio.
 *
 * Une demande d'annulation doit rester immédiate même si AudioRecord ou AudioManager bloque le
 * worker de contrôle. Elle ne constitue jamais, à elle seule, une preuve de libération physique.
 */
internal class BobLiveAudioCancellationFence(
  maximumEntries: Int = 32,
  maximumSeenKeys: Int = 4_096,
) {
  private data class Key(val sessionId: String, val captureId: String)
  private data class Entry(
    var phase: BobLiveAudioCancellationPhase,
    var cancellationRequested: Boolean,
    var resourcesMayBeAllocated: Boolean,
    val ordinal: Long,
  )

  private val lock = Any()
  private val maximumEntries = maximumEntries.coerceAtLeast(1)
  private val maximumSeenKeys = maximumSeenKeys.coerceAtLeast(maximumEntries)
  private val entries = mutableMapOf<Key, Entry>()
  /** Tombstones de processus: une clé évincée du journal court ne redevient jamais valide. */
  private val seenKeys = mutableSetOf<Key>()
  private var nextOrdinal = 0L

  fun beginPrepare(sessionId: String, captureId: String): Boolean = synchronized(lock) {
    val key = Key(sessionId, captureId)
    // A capture id is a one-shot generation nonce. Retrying must allocate a new id; otherwise a
    // delayed terminal event could release the lease of a later physical capture.
    if (key in seenKeys || seenKeys.size >= maximumSeenKeys) return@synchronized false
    if (!makeRoomForEntry()) return@synchronized false
    entries[key] = Entry(
      BobLiveAudioCancellationPhase.PREPARING,
      cancellationRequested = false,
      resourcesMayBeAllocated = false,
      ordinal = allocateOrdinal(),
    )
    seenKeys.add(key)
    true
  }

  fun markResourcesMayBeAllocated(sessionId: String, captureId: String): Boolean = synchronized(lock) {
    val entry = entries[Key(sessionId, captureId)] ?: return@synchronized false
    if (
      entry.phase != BobLiveAudioCancellationPhase.PREPARING
      || entry.cancellationRequested
    ) return@synchronized false
    entry.resourcesMayBeAllocated = true
    true
  }

  /** `true` atteste seulement l'écriture du tombstone, pas la fermeture de l'audio. */
  fun requestCancellation(sessionId: String, captureId: String): Boolean = synchronized(lock) {
    val key = Key(sessionId, captureId)
    val existing = entries[key]
    if (existing != null) {
      if (existing.phase == BobLiveAudioCancellationPhase.RELEASED) return@synchronized true
      existing.cancellationRequested = true
      existing.phase = BobLiveAudioCancellationPhase.CANCELLING
      return@synchronized true
    }
    if (key in seenKeys || seenKeys.size >= maximumSeenKeys) return@synchronized false
    if (!makeRoomForEntry()) return@synchronized false
    entries[key] = Entry(
      BobLiveAudioCancellationPhase.CANCELLING,
      cancellationRequested = true,
      resourcesMayBeAllocated = false,
      ordinal = allocateOrdinal(),
    )
    seenKeys.add(key)
    true
  }

  fun isCancellationRequested(sessionId: String, captureId: String): Boolean = synchronized(lock) {
    entries[Key(sessionId, captureId)]?.cancellationRequested == true
  }

  fun transition(
    sessionId: String,
    captureId: String,
    phase: BobLiveAudioCancellationPhase,
  ): Boolean = synchronized(lock) {
    val entry = entries[Key(sessionId, captureId)] ?: return@synchronized false
    if (
      entry.phase == BobLiveAudioCancellationPhase.RELEASED
      || entry.cancellationRequested
      || !isAllowedTransition(entry.phase, phase)
    ) {
      return@synchronized false
    }
    entry.phase = phase
    true
  }

  /**
   * Retourne vrai une seule fois, uniquement après l'arc `cancelling -> released`.
   *
   * Une génération qui a pu allouer une ressource native exige une preuve physique complète.
   * Un cancel arrivé avant toute allocation peut terminer sans preuve artificielle.
   */
  fun markReleased(
    sessionId: String,
    captureId: String,
    physicalReleaseProven: Boolean,
  ): Boolean = synchronized(lock) {
    val entry = entries[Key(sessionId, captureId)] ?: return@synchronized false
    if (
      entry.phase != BobLiveAudioCancellationPhase.CANCELLING
      || (entry.resourcesMayBeAllocated && !physicalReleaseProven)
    ) return@synchronized false
    entry.phase = BobLiveAudioCancellationPhase.RELEASED
    entry.cancellationRequested = true
    true
  }

  fun resourcesMayBeAllocated(sessionId: String, captureId: String): Boolean = synchronized(lock) {
    entries[Key(sessionId, captureId)]?.resourcesMayBeAllocated == true
  }

  fun contains(sessionId: String, captureId: String): Boolean = synchronized(lock) {
    entries.containsKey(Key(sessionId, captureId))
  }

  fun phase(sessionId: String, captureId: String): BobLiveAudioCancellationPhase? =
    synchronized(lock) { entries[Key(sessionId, captureId)]?.phase }

  private fun allocateOrdinal(): Long {
    nextOrdinal = if (nextOrdinal == Long.MAX_VALUE) 1L else nextOrdinal + 1L
    return nextOrdinal
  }

  private fun makeRoomForEntry(): Boolean {
    if (entries.size < maximumEntries) return true
    val retired = entries
      .filterValues { it.phase == BobLiveAudioCancellationPhase.RELEASED }
      .minByOrNull { it.value.ordinal }
      ?.key
      ?: return false
    entries.remove(retired)
    return true
  }

  private fun isAllowedTransition(
    from: BobLiveAudioCancellationPhase,
    to: BobLiveAudioCancellationPhase,
  ): Boolean = when (from) {
    BobLiveAudioCancellationPhase.PREPARING -> to == BobLiveAudioCancellationPhase.PREPARED
    BobLiveAudioCancellationPhase.PREPARED -> to == BobLiveAudioCancellationPhase.STARTING
    BobLiveAudioCancellationPhase.STARTING -> to == BobLiveAudioCancellationPhase.CAPTURING
    BobLiveAudioCancellationPhase.CAPTURING,
    BobLiveAudioCancellationPhase.CANCELLING,
    BobLiveAudioCancellationPhase.RELEASED -> false
  }
}
