import { type Instant } from '../../../shared-kernel/time';
import { type CustomerType } from '../../customer/customer';

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

/**
 * A3 — demande EXPRESSE d'exécution anticipée des travaux avant la fin du délai de rétractation
 * (art. L221-25 du code de la consommation), cochée par le CLIENT au moment de signer et
 * horodatée serveur. Présente uniquement pour un client consommateur (b2c) qui l'a réellement
 * demandée — jamais fabriquée, jamais déduite (un droit qui n'existe pas ne se renonce pas).
 */
export interface EarlyExecutionRequest {
  requestedAt: Instant;
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
  /** A3 — présent uniquement si le client a demandé l'exécution anticipée en signant (L221-25). */
  earlyExecution?: EarlyExecutionRequest;
  /**
   * A3 — qualité du client FIGÉE à la CONCLUSION du contrat (SignQuote la lit dans la même
   * transaction que la signature) : la qualité de consommateur s'apprécie au jour de la
   * conclusion (art. liminaire et L221-1 c. conso) — une édition ultérieure de la fiche client
   * (b2c↔b2b) ne peut ni lever ni créer rétroactivement le droit de rétractation ou
   * l'interdiction de paiement L221-10. Absente = signature antérieure au figeage : les gardes
   * retombent honnêtement sur le type courant de la fiche (jamais un backfill inventé).
   */
  customerType?: CustomerType;
}
