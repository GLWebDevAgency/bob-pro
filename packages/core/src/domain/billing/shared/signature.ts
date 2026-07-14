import { type Instant } from '../../../shared-kernel/time';

/** Comment le devis a réellement été signé — jamais inféré, toujours porté par l'appelant. */
export type SignatureMethod = 'onsite_draw' | 'remote_link';

/**
 * Preuve d'intégrité du tracé RÉELLEMENT reçu par le serveur. Absente tant qu'aucun tracé n'a
 * été transmis (ex. lien distant sans capture aujourd'hui) : une preuve absente est honnête,
 * une preuve fabriquée ne l'est pas (P0 R4 — le pad ne signait pas ce qu'il affichait : le
 * serveur inventait `method: 'draw'` sans avoir reçu ni tracé ni consentement).
 * V1 : seuls le hash et l'horodatage sont persistés — l'image elle-même n'est pas archivée
 * (archivage du tracé = évolution de domaine suivante, hors périmètre de ce correctif).
 */
export interface SignatureProof {
  method: SignatureMethod;
  /** SHA-256 (hex) du tracé transmis, calculé côté serveur — jamais fourni par le client. */
  sha256: string;
  capturedAt: Instant;
}

export interface Signature {
  signerName: string;
  signedAt: Instant;
  /**
   * `legacy_declared` : signature enregistrée AVANT ce correctif (nom + date seulement) — la
   * méthode réelle est inconnue et n'est JAMAIS réinventée à la réhydratation (P0 R4 : l'ancien
   * mapper fabriquait `draw` pour toutes les lignes historiques).
   */
  method: SignatureMethod | 'legacy_declared';
  accepted: true;
  /** Présent uniquement quand un tracé a réellement été reçu et haché. */
  proof?: SignatureProof;
}
