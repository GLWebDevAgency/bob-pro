export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type DomainError =
  | { code: 'VALIDATION'; field: string; message: string }
  | {
      /** `disbursement_267` (B9) : un débours est HORS base TVA (art. 267, II-2° du CGI) — taux 0 obligatoire. */
      code: 'VAT_RATE_NOT_APPLICABLE';
      rate: number;
      reason: 'franchise_293B' | 'autoliquidation' | 'disbursement_267' | 'unknown';
    }
  | { code: 'INVALID_TRANSITION'; from: string; to: string }
  | { code: 'DOCUMENT_NUMBER_GAP'; expected: string; got: string }
  | {
      /** Garde anti-écrasement : un document déjà rattaché refuse un lien métier DIFFÉRENT. */
      code: 'DOCUMENT_ALREADY_LINKED';
      documentId: string;
      existing: { linkedEntityType: string; linkedEntityId: string };
      requested: { linkedEntityType: string; linkedEntityId: string };
      message: string;
    }
  | { code: 'QUOTE_ALREADY_SIGNED'; quoteId: string }
  | {
      /**
       * A3 — gel légal : la facture FINALE d'un devis B2C signé est bloquée pendant le délai de
       * rétractation de 14 jours (art. L221-18 s. c. conso) tant que le client n'a pas demandé
       * l'exécution anticipée des travaux (art. L221-25). `message` est le texte honnête à
       * afficher tel quel (mobile, vocal) ; les dates permettent tout affichage structuré.
       */
      code: 'RETRACTATION_PERIOD_ACTIVE';
      quoteId: string;
      /** Fin exacte du délai (instant ISO — calcul art. L221-19 / règlement CEE 1182/71). */
      expiresAt: string;
      /** Premier jour calendaire (Europe/Paris) où la facture finale devient possible. */
      availableFrom: string;
      message: string;
    }
  | {
      /**
       * A3/L221-10 — contrat HORS ÉTABLISSEMENT avec un consommateur : AUCUN paiement (acompte
       * compris) ne peut être reçu pendant 7 jours à compter de la conclusion — l'émission de
       * toute pièce exigible est bloquée pendant la fenêtre (sanction : nullité du contrat,
       * art. L242-1 c. conso ; Civ. 1re, 20/12/2023, n° 22-13.014).
       */
      code: 'OFF_PREMISES_PAYMENT_EMBARGO';
      quoteId: string;
      /** Fin exacte de l'interdiction (instant ISO — même computation que L221-19). */
      expiresAt: string;
      /** Premier jour calendaire (Europe/Paris) où la facturation devient possible. */
      availableFrom: string;
      message: string;
      /**
       * L'embargo protège L'ARTISAN (contrat annulable) : un override RESPONSABILISÉ existe —
       * flag explicite `embargoOverride: true` (jamais implicite), confirmation dédiée côté
       * client, événement payment.embargo_overridden journalisé. `true` signale aux clients
       * que l'affordance d'override peut être proposée avec le risque concret (`overrideRisk`).
       */
      overridable?: true;
      /** Reformulation CONCRÈTE du risque (offPremisesEmbargoOverrideRisk) — source unique. */
      overrideRisk?: string;
    }
  | {
      /**
       * A3/L221-21 — le consommateur a exercé sa rétractation (fonctionnalité en ligne) :
       * le contrat ne produit plus aucune pièce de facturation.
       */
      code: 'QUOTE_RETRACTED';
      quoteId: string;
      message: string;
    }
  | {
      /**
       * PR-04 — garde « BC obligatoire » : la fiche client exige un n° de bon de commande
       * (grands comptes/collectivités — une facture sans n° d'engagement est rejetée par
       * l'acheteur, cas RATP CAP). `message` = texte honnête et ACTIONNABLE (CTA « saisir le
       * BC maintenant ») ; `overridable` signale l'affordance d'émission SANS BC, confirmée
       * et JOURNALISÉE (invoice.purchase_order_overridden).
       */
      code: 'PURCHASE_ORDER_REQUIRED';
      invoiceId: string;
      customerId: string;
      customerName: string;
      message: string;
      overridable: true;
    }
  | { code: 'MISSING_SIREN_FOR_EINVOICE'; customerId: string }
  | { code: 'CABINET_MEMBER_ALREADY_EXISTS'; cabinetId: string; userId: string }
  | { code: 'CABINET_LAST_ADMIN_REQUIRED'; cabinetId: string }
  | { code: 'CABINET_INVITATION_EXPIRED'; invitationId: string; expiresAt: string }
  | { code: 'CABINET_INVITATION_ALREADY_USED'; invitationId: string }
  | { code: 'CABINET_INVITATION_EMAIL_MISMATCH'; invitationId: string }
  | {
      code: 'FISCAL_PROFILE_INCONSISTENT';
      rule:
        | 'micro_tax_regime_requires_tns'
        | 'assimile_requires_sasu_or_sas'
        | 'tns_requires_ei_micro_eurl'
        | 'versement_liberatoire_requires_micro'
        | 'micro_legal_form_requires_micro_tax_regime';
      message: string;
    };

export type DomainResult<T> = Result<T, DomainError>;

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
