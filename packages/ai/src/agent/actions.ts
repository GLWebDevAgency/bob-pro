import {
  type Result,
  type AppError,
  type Discount,
  type LineInput,
  type ExpenseCategory,
  type FiscalDeadline,
  type SituationAmountInput,
  type SituationProposal,
  type VatPosition,
  type AgedBalance,
  type TrialBalance,
  type IncomeStatement,
  type BalanceSheet,
  type BusinessReview,
  type ClosingReview,
  type SubscriptionStatusView,
  type OwnerPayGuidance,
  type PaymentMethod,
  type FrenchOperationCategory,
} from '@bob/core';
import {
  type ContextEntitySummary,
  type ReadContextEntityInput,
} from './context';

/** Dépense fournisseur encore à payer (BOB-1 — ciblage de payer_depense par nom). */
export interface UnpaidExpense {
  id: string;
  supplierName: string;
  totalTtcCents: number;
  documentDate: string;
}

/** Dépense RÉCENTE du tenant (M3 — ciblage vocal de lier_depense_chantier) : la SEULE matière
 * de résolution par jetons fournisseur/montant/date — jamais un id inventé par le LLM. */
export interface AgentExpense {
  id: string;
  supplierName: string;
  totalTtcCents: number;
  documentDate: string;
  /** Imputation chantier courante — null : dépense hors chantier. */
  chantierId: string | null;
}

/** Outil lier_depense_chantier (M3) : MÊME use case AssignExpenseToChantier (@bob/core) que
 * PUT /expenses/:id/chantier et l'écran Dépenses — anti-IDOR fail-closed (chantier PROUVÉ dans
 * le tenant), idempotent (ré-imputer le même chantier = changed:false, aucune écriture). */
export interface AssignExpenseChantierActionInput {
  expenseId: string;
  /** Chantier cible — ou null EXPLICITE pour délier la dépense (geste légitime). */
  chantierId: string | null;
}

export interface AssignExpenseChantierActionOutput {
  /** Imputation effective après la commande (null = hors chantier). */
  chantierId: string | null;
  /** false = retry idempotent / imputation déjà en place — aucune écriture. */
  changed: boolean;
}

/**
 * Enregistre un règlement fournisseur DEJA effectué. Bob ne déclenche aucun transfert bancaire.
 * Date et moyen sont obligatoires ; la référence et le justificatif restent des preuves optionnelles.
 */
export interface RecordExpensePaymentActionInput {
  expenseId: string;
  paidOn: string;
  method: PaymentMethod;
  reference?: string | null;
  proofDocumentId?: string | null;
}

/** Instantané serveur des notifications non lues. Le cutoff est capturé AVANT le consentement :
 * une notification arrivée pendant la confirmation reste donc non lue. */
export interface NotificationUnreadPreview {
  unreadCount: number;
  throughCreatedAt: string;
}

/** Marquage atomique de toutes les notifications qui existaient au moment du preview. */
export interface NotificationReadThroughInput {
  throughCreatedAt: string;
}

export interface NotificationReadThroughOutput {
  updatedCount: number;
  readAt: string;
}

export interface PayableInvoice {
  id: string;
  number: string;
  remainingCents: number;
  customerName: string;
}

export interface SendableQuote {
  id: string;
  number: string | null;
  customerName: string;
  totalTtcCents: number;
  status: string;
}

export interface IssuableInvoice {
  id: string;
  number: string | null;
  customerName: string;
  totalTtcCents: number;
  status: string;
  /** BT-23 : vrai uniquement quand l'utilisateur doit qualifier l'accessorité des lignes. */
  operationCategoryRequired: boolean;
}

/** Devis SIGNÉ facturable (ASK-2) — matière de generer_facture : le mode (acompte/solde)
 * est une vraie décision de facturation, posée en question structurée quand elle manque. */
export interface InvoiceableQuote {
  id: string;
  number: string | null;
  customerName: string;
  totalTtcCents: number;
  /** Acompte prévu au devis (pourcentage) — null si aucun. */
  depositPct: number | null;
  /** L'acompte a déjà été facturé : la finale devient l'évidence (aucune question). */
  depositInvoiced: boolean;
  /** Faux quand la chaîne acompte → finale n'est pas certifiée pour ce client. */
  depositAvailable?: boolean;
  /** Motif métier réel à restituer ; absent chez les hôtes historiques. */
  depositUnavailableReason?: string | null;
  /** B8 (OPTIONNEL, rétro-compatible) : bon de commande déjà attaché au devis — null si aucun,
   * absent chez un hôte historique. Permet à lier_bon_commande d'annoncer un remplacement. */
  purchaseOrder?: { number: string; receivedAt: string | null; documentId: string | null } | null;
  /** A3 (OPTIONNEL, rétro-compatible) : gel de rétractation B2C ACTIF sur la facture finale —
   * premier jour (YYYY-MM-DD) où elle devient possible ; null/absent = aucun gel. Le flow
   * generer_facture l'annonce HONNÊTEMENT au lieu de proposer une finale vouée au refus. */
  finalBlockedUntil?: string | null;
  /** B5 (OPTIONNEL, rétro-compatible) : retenue de garantie stipulée au devis-chantier (loi
   * n° 71-584 du 16/07/1971, 0 < taux ≤ 5) — null/absent = aucune. Le flow facturer_situation
   * l'ANNONCE honnêtement (net à payer amputé de la retenue), même substance que la mention UI. */
  retenueGarantiePct?: number | null;
  /** Repli acompte pro (OPTIONNEL, rétro-compatible) : une situation VIVANTE existe déjà sur ce
   * devis (brouillons compris, annulées exclues — même règle que hasLivingSituationSibling
   * mobile). `false` STRICT requis pour offrir la chip « Situation n°1 (30 %) » — absent chez un
   * hôte historique = fail-closed, jamais un « n°1 » mensonger. */
  situationInvoiced?: boolean;
}

/** Outil lier_bon_commande (B8) : attache le NUMÉRO d'engagement d'un bon de commande à un
 * devis — MÊME use case AttachPurchaseOrderToQuote (@bob/core) que l'écran devis. L'outil
 * vocal V1 lie le numéro seul : le document scanné se rattache ensuite via le picker manuel
 * (champ documentId de PUT /quotes/:id/purchase-order), jamais deviné à la voix. */
export interface AttachPurchaseOrderActionInput {
  quoteId: string;
  /** Numéro d'engagement, déjà assaini par makePurchaseOrderRef (autorité du domaine). */
  number: string;
}

export interface AttachPurchaseOrderActionOutput {
  quoteId: string;
  /** Numéro du devis (affichage) — null si le devis n'est pas encore numéroté. */
  quoteNumber: string | null;
  /** Révision du devis après mutation (vue rafraîchie côté hôte). */
  revision: number;
  /** Numéro d'engagement effectivement attaché (assaini par le domaine). */
  purchaseOrderNumber: string;
  /** Le devis est signé et encore facturable (ListInvoiceableQuotes) : Bob peut proposer
   * l'enchaînement naturel vers generer_facture — la facture reprendra le numéro (core). */
  invoiceable: boolean;
}

export interface AgentDocument {
  id: string;
  filename: string;
  kind: string;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  createdAt: string;
  // —— Champs OPTIONNELS (rétro-compatibles hôtes existants) — ciblage vocal du coffre ——
  /** Libellé intelligent (renommage humain > suggestion d'analyse > filename) — « le ticket Aldi ». */
  displayName?: string;
  /** Provenance (generated | uploaded | ocr) — seul un scan (ocr) entre dans « À valider ». */
  origin?: string;
  /** Dossier de rangement — null : pas encore rangé (la validation vocale exige un doc rangé). */
  folderId?: string | null;
  /** Confirmation humaine posée (latch) — null : le doc attend encore « c'est bon, je valide ». */
  reviewedAt?: string | null;
}

/** Outil valider_document (parité humain↔Bob) : pose reviewedAt via AcknowledgeDocument @bob/core
 * — même use case que le bouton « Confirmer » de la file « À valider ». Ne déplace ni ne lie rien. */
export interface AcknowledgeDocumentActionInput {
  documentId: string;
}

/** Chantier OUVERT du tenant — cible RÉELLE de classement (jamais un id inventé par le LLM). */
export interface FilingChantier {
  id: string;
  nom: string;
}

/** Dossier du coffre (racine, actif) — cible RÉELLE de classement par nom. */
export interface FilingFolder {
  id: string;
  nom: string;
  /** Clé système (purchases/sales/projects/…) — null : dossier créé par l'artisan. */
  systemKey: string | null;
}

/** Destinations de classement du tenant (outil classer_document) : les SEULES cibles que Bob
 * peut proposer — même autorité que le contexte d'analyse documentaire (anti-hallucination). */
export interface FilingDestinations {
  chantiers: FilingChantier[];
  dossiers: FilingFolder[];
}

/** Destination d'un classement vocal — chantier ouvert (lien métier) OU dossier du coffre. */
export type FileDocumentDestination =
  | { kind: 'chantier'; chantierId: string }
  | { kind: 'folder'; folderId: string };

/** Outil classer_document : MÊME séquence que le geste « Classer là » mobile —
 * MoveDocumentToFolder + ClassifyDocument (chantier) + nom intelligent (règle suggestedRenameFor :
 * jamais par-dessus un renommage humain). L'hôte exécute la séquence via les MÊMES use cases. */
export interface FileDocumentActionInput {
  documentId: string;
  destination: FileDocumentDestination;
}

export interface FileDocumentActionOutput {
  documentId: string;
  folderId: string | null;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  /** Libellé après classement (nom intelligent appliqué, ou libellé humain conservé). */
  displayName: string;
}

/** Outil renommer_document : RenameDocument (@bob/core) — le nom donné devient un renommage
 * HUMAIN prioritaire (les suggestions d'analyse ne l'écraseront plus jamais). */
export interface RenameDocumentActionInput {
  documentId: string;
  displayName: string;
}

export interface RenameDocumentActionOutput {
  documentId: string;
  displayName: string;
}

/** Outil chercher_document : recherche RÉELLE devis & factures (GET /documents/search côté API,
 * pg_trgm) — lecture pure, mêmes résultats que l'écran de recherche. */
export interface SearchDocumentsActionInput {
  query: string;
  scope?: 'quote' | 'invoice' | 'all';
  /** Bornes incluses (YYYY-MM-DD) — dérivées d'un mois dit (« de mars »), jamais devinées. */
  from?: string;
  to?: string;
}

export interface AgentSearchHit {
  source: 'quote' | 'invoice';
  id: string;
  number: string | null;
  customerName: string;
  status: string;
  date: string | null;
  totalTtcCents: number;
  /** Libellé de LIGNE ayant matché (« radiateur ») — null si le match vient du numéro/client. */
  matchedLineLabel: string | null;
}

export interface SearchDocumentsActionOutput {
  hits: AgentSearchHit[];
  totalCount: number;
}

export interface AcknowledgeDocumentActionOutput {
  documentId: string;
  /** Horodatage de validation posé (ou conservé — latch : la première validation fait foi). */
  reviewedAt: string;
}

/** Outil relance_brouillon (parité C15 TODO ① — C25) : cible optionnelle. Sans cible, l'hôte
 * prépare la relance la plus urgente (retard le plus long puis montant — plan @bob/core). */
export interface DraftRelanceActionInput {
  /** Facture précise à relancer (prioritaire sur customerId si les deux sont fournis). */
  invoiceId?: string;
  /** Client à relancer (sa facture échue la plus urgente). */
  customerId?: string;
}

/** Outil envoyer_relance (parité C15 TODO ② — C25) : envoi RÉEL de la relance d'une facture
 * échue (email au client + miroir push), ton choisi par le plan @bob/core côté hôte/serveur.
 * Sortant vers un tiers — TOUJOURS confirmé (plancher), mise en demeure incluse (régime légal
 * selon le type de client : pro L441-10, particulier code civil, acheteur public CCP — P01). */
export interface SendRelanceActionInput {
  invoiceId: string;
}

export interface SendRelanceActionOutput {
  jobId: string;
  /** done | pending | failed (échec = job en retry côté serveur, cause loggée). */
  status: string;
  /** Ton effectivement envoyé (cordial | neutre | ferme | miseendemeure). */
  tone?: string;
}

/** Outil envoyer_facture (PR-01 « Encaisser ») : envoi EMAIL réel d'une facture ÉMISE — même
 * use case SendInvoice (@bob/core) que le bouton mobile. Gardes fail-closed restituées telles
 * quelles (brouillon refusé, destinataire manquant = refus actionnable — jamais contournées). */
export interface SendInvoiceActionInput {
  invoiceId: string;
  /** PR-09 (additif) — destinataire choisi (contact du client) : adresse RÉSOLUE par l'agent
   * contre le carnet réel (« à la compta ») — jamais dictée en aveugle ; absent = repli e-mail
   * de la fiche client (résolution SendInvoice, refus actionnable si aucune adresse). */
  recipientEmail?: string;
}

/** PR-09 — contact joignable d'un client, matière de résolution du destinataire dicté
 * (« envoie la facture à la compta ») : la SEULE liste contre laquelle un rôle/nom dit se
 * résout — jamais une adresse inventée par le LLM. */
export interface InvoiceRecipientContact {
  id: string;
  /** Rôle LIBRE (« Compta », « Valideur BC »…). */
  label: string;
  name: string;
  /** Null = contact sans e-mail (jamais proposé comme destinataire). */
  email: string | null;
}

/** Outil relance_devis (PR-05) : brouillon LISIBLE de la relance d'un devis envoyé resté sans
 * réponse — MÊME palier (quoteRelancePalierOf) et MÊME message (buildQuoteRelance @bob/core)
 * que la carte Aujourd'hui, la fiche devis et le rappel cron. Lecture pure : rien ne part
 * d'ici — le partage/l'envoi reste un geste séparé (envoyer_devis renouvelle le lien). */
export interface DraftQuoteRelanceActionInput {
  quoteId: string;
}

export interface DraftQuoteRelanceActionOutput {
  /** false = hors palier J+15/J+30 (trop tôt, statut, date d'ancrage absente) — subject/body
   * portent alors le message HONNÊTE du service, jamais une relance fabriquée. */
  relanceable: boolean;
  /** Palier atteint (j15 | j30) — null quand relanceable est false. */
  palier: 'j15' | 'j30' | null;
  subject: string;
  body: string;
}

/** Outil marquer_facture_transmise (PR-02) : dates de dépôt/acceptation DÉCLARÉES d'une pièce
 * ÉMISE vers le canal de facturation du client — MÊME use case RecordInvoiceTransmission que
 * PATCH /invoices/:id/transmission et l'écran facture (« envoyée le », dépôt Chorus/portail).
 * Fait déclaré datant un suivi légal : plancher de consentement (registre), jamais un accusé
 * de plateforme inventé. Champ absent = inchangé, null = effacé (contrat du use case). */
export interface RecordInvoiceTransmissionActionInput {
  invoiceId: string;
  depositedAt?: string | null;
  acceptedAt?: string | null;
}

export interface RecordInvoiceTransmissionActionOutput {
  transmission: { depositedAt: string | null; acceptedAt: string | null } | null;
}

/** PR-06 — réglage des relances : cadence personnalisée + interrupteur des relances
 * AUTOMATIQUES (cron). Lecture via cadence_relances ; la bascule (regler_relances_auto) est
 * une mutation CONFIRMÉE (elle conditionne des emails clients récurrents). */
export interface RelanceSettingsView {
  relanceAutoEnabled: boolean;
  /** Cadence personnalisée (J+n après échéance) — null = cadence par défaut (J+3/J+10/J+20/J+30). */
  relancePolicy: {
    cordialAfterDays: number;
    neutreAfterDays: number;
    fermeAfterDays: number;
    miseEnDemeureAfterDays: number;
  } | null;
}

export interface SetRelanceAutoActionInput {
  enabled: boolean;
}

export interface SendInvoiceActionOutput {
  number: string;
  recipient: string;
  /** `sent` = déjà livrée (dédup d'un retry) ; `queued` = job durable, worker à suivre. */
  deliveryStatus: 'queued' | 'sent';
  jobId: string;
}

/** Outil creer_devis (parité C15 TODO ④) — mêmes entrées que le use case CreateQuote de l'UI. */
export interface CreateQuoteActionInput {
  customerId: string;
  lines: LineInput[];
  depositPct?: number;
  /** B3 (additif) — remise globale dictée (« mets 10 % de remise ») : % du HT net de lignes ou
   * montant HT en centimes — MÊME champ que CreateQuote (@bob/core), plafond validé au domaine. */
  globalDiscount?: Discount | null;
  /** PR-08 (additif) — site de rattachement dicté (« chez Carrefour Vitry ») : id RÉSOLU contre
   * la liste réelle du tenant par l'agent (jamais récité) ; l'existence tenant est PROUVÉE par
   * l'hôte (CreateQuote.chantierTargets, anti-IDOR fail-closed du core). */
  chantierId?: string | null;
}

/** Règlement DÉJÀ effectué déclaré à la création (M4 — dépense dictée « j'ai dépensé 89 € chez
 * Leroy Merlin en carte ») : la dépense naît PAYÉE avec sa preuve (RecordExpense.payment @bob/core),
 * au lieu d'un « à payer » absurde qu'il faudrait re-régler. */
export interface RecordExpenseSettlementDeclaration {
  /** DateOnly (YYYY-MM-DD) du règlement réel — jamais devinée. */
  paidOn: string;
  method: PaymentMethod;
  reference?: string | null;
}

/** Outil scan_depense (parité C15 TODO ③) — mêmes entrées que RecordExpense (l'OCR reste côté UI). */
export interface RecordExpenseActionInput {
  supplierName: string;
  totalTtcCents: number;
  category: ExpenseCategory;
  /** DateOnly (YYYY-MM-DD) — défaut : aujourd'hui, résolu par l'hôte (device/serveur). */
  documentDate?: string;
  vatRatePct?: number | null;
  /** M4 (additif) — dépense née imputée : chantier PROUVÉ dans le tenant par l'hôte
   * (RecordExpense.chantierId + deps.chantierTargets, anti-IDOR fail-closed du core). */
  chantierId?: string | null;
  /** M4 (additif) — dépense dictée déjà réglée : naît payée avec sa preuve ; absent → « à payer ». */
  payment?: RecordExpenseSettlementDeclaration | null;
}

/** Outil generer_facture (parité C15 TODO ⑤) — même use case GenerateInvoiceFromQuote que l'UI. */
export interface GenerateInvoiceActionInput {
  quoteId: string;
  /** Choix explicite obligatoire : une relance réseau ne doit jamais changer le type de facture.
   * B2 (additif) — `situation` : situation de travaux d'avancement, portée par l'outil DÉDIÉ
   * facturer_situation (le registre garde generer_facture sur deposit|final). */
  mode: 'deposit' | 'final' | 'situation';
  /** B2 (additif) — REQUIS avec le mode situation (interdit sinon, garde du use case core) :
   * avancement en % du marché ({ percent }) ou montant HT en centimes ({ amountHtCents }) —
   * les situations des marchés privés se stipulent en HT, la TVA en découle par taux. */
  situation?: SituationAmountInput;
  /**
   * Override RESPONSABILISÉ de l'embargo L221-10 (contrat hors établissement B2C) — `true`
   * strict UNIQUEMENT, jamais implicite : Bob reformule d'abord le risque concret (le refus
   * serveur porte `overrideRisk`) et exige la même confirmation explicite que le bouton
   * (safetyFloor du tool). L'événement payment.embargo_overridden est journalisé serveur.
   */
  embargoOverride?: boolean;
}

/** Client FACTURABLE du tenant (B1 — matière de facture_directe) : la SEULE liste contre
 * laquelle un nom dicté (« Mme Girard ») se résout — jamais un id inventé par le LLM. Le
 * type décide des protections légales (b2c : qualification d'urgence A3bis obligatoire). */
export interface BillableCustomer {
  id: string;
  name: string;
  type: 'b2c' | 'b2b' | 'b2g';
}

/** Outil facture_directe (B1) : facture SANS devis signé (brouillon `final` standalone) —
 * MÊME use case ComposeStandaloneInvoice (@bob/core) que POST /invoices et l'écran. Couvre le
 * dépannage urgent facturé sur place (exception au devis, arrêté du 24/01/2017), la régie
 * (TJM × jours) et la facturation syndic/B2B récurrente. L'émission suit ensuite le MÊME
 * chemin IssueInvoice que toute facture — aucun chemin parallèle. */
export interface ComposeStandaloneInvoiceActionInput {
  customerId: string;
  /** Lignes dictées/planifiées (1..100) — TVA de chaque ligne re-jugée par suggestVatRate. */
  lines: LineInput[];
  /** B3 — remise globale dictée (« avec 10 % de remise »). */
  globalDiscount?: Discount | null;
  /** Taux réduits travaux : mêmes booléens d'éligibilité que CreateQuote (jamais déduits). */
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
  /** A3bis — OBLIGATOIRE pour un client b2c : intervention urgente à domicile expressément
   * demandée par le client (art. L221-10, al. 2 c. conso). `true` strict = fait déclaré par
   * l'artisan (confirmé), horodaté serveur par le use case. Absent + b2c → refus fail-closed. */
  urgentOnSiteRepair?: boolean;
  /** PR-08 (additif) — site de rattachement dicté : id RÉSOLU contre la liste réelle du tenant
   * par l'agent (jamais récité) ; existence tenant PROUVÉE par l'hôte (anti-IDOR fail-closed). */
  chantierId?: string | null;
}

export interface ComposeStandaloneInvoiceActionOutput {
  invoiceId: string;
  /** Totaux calculés par le DOMAINE (jamais recalculés côté agent) — la vérité du récap. */
  totalTtcCents: number;
  netToPayCents: number;
}

/** Outil facturer_situation (B2) : situation de travaux d'un devis SIGNÉ — MÊME use case
 * GenerateInvoiceFromQuote (mode 'situation') que l'UI. Le montant est TOUJOURS le choix de
 * l'artisan ({ percent } ou { amountHtCents }) ; l'avancement des tâches du chantier ne fait
 * que PROPOSER (proposeSituationFromChantier — consultatif, jamais imposé). */
export interface GenerateSituationActionInput {
  quoteId: string;
  situation: SituationAmountInput;
  /** Override L221-10 responsabilisé — mêmes règles strictes que generer_facture. */
  embargoOverride?: boolean;
}

/** Proposition d'avancement (lecture PURE) pour un devis signé : dérivée des tâches réelles du
 * chantier via proposeSituationFromChantier (@bob/core). `null` HONNÊTE sans tâches — Bob ne
 * propose rien plutôt que d'inventer un avancement. */
export interface ProposeSituationActionInput {
  quoteId: string;
}

/** Outil definir_conditions_paiement (B4) : « Durand paie à 45 jours fin de mois » — pose les
 * conditions de paiement PROPRES au client (Customer.paymentTerms), MÊME chemin UpdateCustomer
 * (@bob/core) que la fiche client. Elles pilotent l'échéance dérivée à l'émission
 * (IssueInvoice) ; le plafond légal L441-10 (pro : 60 j / 45 j fin de mois) est jugé par le
 * domaine — jamais re-décidé ici. */
export interface SetCustomerPaymentTermsActionInput {
  customerId: string;
  days: number;
  endOfMonth: boolean;
  /** Libellé imprimable (ex. « 45 jours fin de mois ») — validé par PaymentTerms.of (core). */
  label: string;
}

export interface SetCustomerPaymentTermsActionOutput {
  customerId: string;
  customerName: string;
  days: number;
  endOfMonth: boolean;
  label: string;
}

/** Outil programmer_encaissement_embargo — DÉFAUT légal du refus d'encaissement L221-10 :
 * message client programmé au premier jour exigible (outbox serveur planifiée, annulable). */
export interface ScheduleEmbargoPaymentActionInput {
  quoteId: string;
}

export interface ScheduleEmbargoPaymentActionOutput {
  /** Instant (ISO) de la livraison planifiée du message client. */
  scheduledFor: string;
  /** Premier jour calendaire (AAAA-MM-JJ) où le paiement peut être demandé. */
  availableFrom: string;
  jobId: string;
  status: string;
}

/** Outil export_fec (parité C15 TODO ⑥) — mêmes entrées que ExportFec ; l'agent reçoit le RÉSUMÉ,
 * jamais le contenu du fichier (volume + le téléchargement reste un geste UI). */
export interface ExportFecActionInput {
  /** DateOnly (YYYY-MM-DD), période inclusive. */
  from: string;
  to: string;
}

export interface FecExportSummary {
  filename: string;
  entryCount: number;
  rowCount: number;
  warnings: string[];
}

/** Outil creer_client (TODO partagé C12/C40) — création MINIMALE (nom + type) ; l'hôte complète les
 * défauts neutres (adresse vide, score 100, encours 0) via le MÊME use case createCustomer que l'UI. */
export interface CreateCustomerActionInput {
  name: string;
  type: 'b2c' | 'b2b' | 'b2g';
}

/**
 * Surface d'actions de Bob — implémentée par l'app via le BobClient (donc le domaine/use cases).
 * INVARIANT DE PARITÉ : chaque action faisable à la main dans l'UI a ici sa méthode, et les deux
 * passent par le MÊME use case. Bob ne peut donc rien faire que l'utilisateur ne puisse faire, et
 * inversement. Les outils (registry) délèguent à ces méthodes sans logique métier propre.
 */
export interface BobActions {
  // —— Lecture ——
  /** Resume factuel de l'entite actuellement affichee. Le contexte UI n'est qu'un indice :
   * l'hote recharge obligatoirement l'entite tenant-scoped avant de construire ce resume. */
  readContextEntity?(input: ReadContextEntityInput): Promise<Result<ContextEntitySummary, AppError>>;
  computePayout(): Promise<Result<{ payoutCents: number; availableCents: number }, AppError>>;
  /** Phase 1C (SPEC_EXPERT_FISCAL §V2 pt. 1+6) : langage/montant du prélèvement adapté au profil
   * fiscal CONFIRMÉ — MÊME use case pur `deriveOwnerPayGuidance` (@bob/core) que les écrans Argent/
   * Aujourd'hui, pour que la réponse parlée de « combien je peux me verser ? » utilise les mêmes
   * kinds/montants qu'à l'écran (parité). Optionnelle : rétro-compatible — un hôte qui ne
   * l'implémente pas retombe sur `computePayout()` (le langage prudent historique, inchangé). */
  getOwnerPayGuidance?(): Promise<Result<{ guidance: OwnerPayGuidance; payoutCents: number }, AppError>>;
  /** Brouillon de relance — CIBLABLE par facture/client (C25 ①). Défaut sans cible : la plus
   * urgente. Les hôtes historiques sans paramètre restent assignables (TODO Codex apps/api :
   * porter la cible côté serveur — voir rapport C25). */
  draftRelance(input?: DraftRelanceActionInput): Promise<Result<{ subject: string; body: string }, AppError>>;
  listPayableInvoices(): Promise<Result<PayableInvoice[], AppError>>;
  listSendableQuotes(): Promise<Result<SendableQuote[], AppError>>;
  listIssuableInvoices(): Promise<Result<IssuableInvoice[], AppError>>;
  /** Devis signés facturables (ASK-2, optionnelle) — cible de generer_facture ; le handler
   * pose la question acompte/solde quand le devis prévoit un acompte non encore facturé. */
  listInvoiceableQuotes?(): Promise<Result<InvoiceableQuote[], AppError>>;
  /** B1 — clients FACTURABLES du tenant (id + nom + type) : la matière de résolution de
   * facture_directe et definir_conditions_paiement. Lecture pure, jamais un client inventé. */
  listBillableCustomers?(): Promise<Result<BillableCustomer[], AppError>>;
  /** B2 — avancement PROPOSÉ (jamais imposé) d'un devis signé, dérivé des tâches réelles du
   * chantier via proposeSituationFromChantier (@bob/core). `null` honnête sans tâches. */
  proposeSituationAdvancement?(
    input: ProposeSituationActionInput,
  ): Promise<Result<SituationProposal | null, AppError>>;
  listDocuments(): Promise<Result<AgentDocument[], AppError>>;
  // —— Lecture, OPTIONNELLE (C-EXP5b) ——
  /** Échéances fiscales à venir (TVA/URSSAF/IS/CFE/comptes annuels) — MÊME use case
   * deriveFiscalCalendar (@bob/core) que GET /fiscal-calendar et l'écran : l'hôte délègue au
   * BobClient, AUCUNE logique fiscale côté ai/. Optionnelle : rétro-compatible hôtes existants. */
  listFiscalDeadlines?(): Promise<Result<FiscalDeadline[], AppError>>;
  /** État d'abonnement/essai du tenant (pilier 2) — LECTURE SEULE : « où en est mon essai ? »
   * répond depuis GetSubscriptionStatus (@bob/core), la même vérité que l'écran Compte.
   * JAMAIS un acte d'achat vocal (SPEC décision 10) : tout engagement payant se confirme au TAP. */
  getSubscriptionStatus?(): Promise<Result<SubscriptionStatusView, AppError>>;
  // —— Lecture, OPTIONNELLES (BOB-1 — l'expert-comptable de poche) ——
  /** Position de TVA réelle (deriveVatPosition @bob/core : collectée sur ENCAISSEMENTS −
   * déductible mentionnée) — « combien de TVA je dois ? » lit LE chiffre du cashflow. */
  getVatPosition?(): Promise<Result<VatPosition, AppError>>;
  /** Balance âgée clients (deriveAgedBalance @bob/core) — « qui me doit quoi ? ». */
  getAgedBalance?(): Promise<Result<AgedBalance, AppError>>;
  /** Dépenses fournisseurs à payer — la cible de payer_depense (résolution par nom). */
  listUnpaidExpenses?(): Promise<Result<UnpaidExpense[], AppError>>;
  /** M3 — dépenses RÉCENTES du tenant (payées ou à payer), bornées par l'hôte, avec leur
   * imputation chantier courante : la matière du ciblage de lier_depense_chantier. Lecture pure. */
  listRecentExpenses?(): Promise<Result<AgentExpense[], AppError>>;
  /** Preview tenant-scoped du lot non lu. Le cutoff retourné doit être réutilisé tel quel lors
   * de la mutation afin de ne pas absorber les notifications arrivées pendant le consentement. */
  previewUnreadNotifications?(): Promise<Result<NotificationUnreadPreview, AppError>>;
  /** Balance générale + résultat provisoire (deriveTrialBalance @bob/core, CLOTURE-1) —
   * « combien je gagne ? » répond produits − charges du grand-livre réel. */
  getTrialBalance?(): Promise<Result<TrialBalance, AppError>>;
  /** Compte de résultat normé (deriveIncomeStatement @bob/core, CDR-1) — la cascade
   * exploitation/financier/exceptionnel/net enrichit la réponse « combien je gagne ? ». */
  getIncomeStatement?(): Promise<Result<IncomeStatement, AppError>>;
  /** Bilan simplifié actif/passif (deriveBalanceSheet @bob/core, BILAN-1) — « mon bilan ». */
  getBalanceSheet?(): Promise<Result<BalanceSheet, AppError>>;
  /** Revue de pilotage (deriveBusinessReview @bob/core, BA-3) — séries CA facturé/encaissé,
   * comparatifs honnêtes, DSO, top clients, SIG et ratios : « comment va mon activité ? »,
   * « on me paie en combien de temps ? », « mes plus gros clients ? » lisent LA même revue. */
  getBusinessReview?(): Promise<Result<BusinessReview, AppError>>;
  /** Revue de clôture (deriveClosingReview @bob/core, DOSSIER-2) — les diligences de l'EC
   * exécutées par Bob : « mon dossier est-il prêt pour le comptable ? » lit LE même verdict
   * que l'écran Clôture et le dossier envoyé (readyToSign / réserves / anomalies). */
  getClosingReview?(): Promise<Result<ClosingReview, AppError>>;
  // —— Mutation ——
  registerPayment(input: {
    invoiceId: string;
    amountCents: number;
    idempotencyKey?: string | null;
  }): Promise<Result<{ status: string }, AppError>>;
  sendQuote(input: { quoteId: string }): Promise<
    Result<
      { number: string; deliveryStatus?: 'queued' | 'sent' | 'skipped' },
      AppError
    >
  >;
  issueInvoice(input: {
    invoiceId: string;
    /** BT-23 : fait choisi par l'utilisateur lorsque biens et services sont ambigus. */
    operationCategory?: FrenchOperationCategory;
    /** Override RESPONSABILISÉ de l'embargo L221-10 (émission = demande de paiement) — `true`
     * strict après confirmation dédiée (safetyFloor) ; journalisé serveur. Jamais implicite. */
    embargoOverride?: boolean;
    /** PR-04 — override RESPONSABILISÉ de la garde « BC obligatoire » — `true` strict après
     * confirmation explicite (risque de rejet énoncé) ; journalisé serveur. Jamais implicite. */
    purchaseOrderOverride?: boolean;
  }): Promise<Result<{ number: string }, AppError>>;
  // —— Mutation, OPTIONNELLES (parité C15 TODO ③④⑤⑥, C20/C40) ——
  // Optionnelles pour rester rétro-compatibles avec les hôtes existants (apps/api) : le registre
  // n'expose l'outil que si l'hôte fournit l'action — même use case que l'UI, jamais un chemin parallèle.
  createQuote?(input: CreateQuoteActionInput): Promise<Result<{ quoteId: string }, AppError>>;
  recordExpense?(input: RecordExpenseActionInput): Promise<Result<{ id: string }, AppError>>;
  generateInvoice?(input: GenerateInvoiceActionInput): Promise<Result<{ invoiceId: string }, AppError>>;
  /** B1 — « facture 380 € à Mme Girard pour le dépannage » : MÊME use case
   * ComposeStandaloneInvoice (@bob/core) que POST /invoices (parité humain↔Bob). Fail-closed :
   * les gardes du domaine (B6 pro étranger, A3bis urgence b2c) sont restituées, jamais contournées. */
  composeStandaloneInvoice?(
    input: ComposeStandaloneInvoiceActionInput,
  ): Promise<Result<ComposeStandaloneInvoiceActionOutput, AppError>>;
  /** B4 — « Durand paie à 45 jours fin de mois » : MÊME chemin UpdateCustomer (@bob/core) que
   * la fiche client — seules les conditions changent, le reste de la fiche est relu à l'identique. */
  setCustomerPaymentTerms?(
    input: SetCustomerPaymentTermsActionInput,
  ): Promise<Result<SetCustomerPaymentTermsActionOutput, AppError>>;
  /** Embargo L221-10 — DÉFAUT légal du refus d'encaissement, exécutable à la voix (hiérarchie
   * doctrine fondateur : le chemin sûr d'ABORD ; l'override reste le second niveau). MÊME
   * endpoint que le bouton « Programmer l'encaissement » (POST …/embargo-scheduled-payment). */
  scheduleEmbargoPayment?(
    input: ScheduleEmbargoPaymentActionInput,
  ): Promise<Result<ScheduleEmbargoPaymentActionOutput, AppError>>;
  exportFec?(input: ExportFecActionInput): Promise<Result<FecExportSummary, AppError>>;
  createCustomer?(input: CreateCustomerActionInput): Promise<Result<{ id: string }, AppError>>;
  /** Envoi réel de relance (C25 ②) — même endpoint que le bouton « Relancer » de l'écran
   * Notifications (client.sendRelance). Sortant : plancher de confirmation dans le registre. */
  sendRelance?(input: SendRelanceActionInput): Promise<Result<SendRelanceActionOutput, AppError>>;
  /** PR-01 « Encaisser » — « envoie la facture » : MÊME endpoint POST /invoices/:id/send que le
   * bouton (SendInvoice @bob/core — pièce émise uniquement, lien public + PDF archivé joint,
   * expéditeur perçu = la société). Sortant vers un tiers : confirmation du registre. */
  sendInvoice?(input: SendInvoiceActionInput): Promise<Result<SendInvoiceActionOutput, AppError>>;
  /** PR-09 — contacts joignables du CLIENT d'une facture (résolution du destinataire dicté) :
   * MÊME lecture ListCustomerContacts que la fiche client — lecture pure, capacité optionnelle. */
  listInvoiceRecipientContacts?(input: {
    invoiceId: string;
  }): Promise<Result<InvoiceRecipientContact[], AppError>>;
  /** PR-05 — « relance le devis Durand » : brouillon LISIBLE au MÊME palier (quoteRelancePalierOf)
   * et avec le MÊME message (buildQuoteRelance @bob/core) que la carte Aujourd'hui/fiche devis.
   * Lecture pure — rien ne part ; hors palier = réponse honnête (relanceable:false). */
  draftQuoteRelance?(
    input: DraftQuoteRelanceActionInput,
  ): Promise<Result<DraftQuoteRelanceActionOutput, AppError>>;
  /** PR-02 — « j'ai déposé la facture sur Chorus hier » : MÊME use case RecordInvoiceTransmission
   * que PATCH /invoices/:id/transmission (pièce émise, acceptation ⊇ dépôt — invariants du
   * domaine, refus restitués verbatim). Fait déclaré, jamais un accusé de plateforme inventé. */
  recordInvoiceTransmission?(
    input: RecordInvoiceTransmissionActionInput,
  ): Promise<Result<RecordInvoiceTransmissionActionOutput, AppError>>;
  /** PR-06 — lecture de la cadence de relances et de l'interrupteur automatique : MÊME source
   * CompanyBillingSettings que l'écran Réglages facturation (une seule vérité écran/voix/cron). */
  getRelanceSettings?(): Promise<Result<RelanceSettingsView, AppError>>;
  /** PR-06 — bascule des relances AUTOMATIQUES : MÊME chemin UpdateCompanyBillingSettings que
   * l'écran (révision courante résolue par l'hôte — le geste vocal n'a pas de vue optimiste). */
  setRelanceAutoEnabled?(
    input: SetRelanceAutoActionInput,
  ): Promise<Result<RelanceSettingsView, AppError>>;
  /** Preuve d'un règlement fournisseur déjà exécuté — écriture comptable : palier accounting. */
  recordExpensePayment?(input: RecordExpensePaymentActionInput): Promise<
    Result<{ status: string; alreadyRecorded: boolean; paymentEntryId: string }, AppError>
  >;
  /** M3 — « mets la dépense Aldi sur le chantier Durand » : MÊME use case AssignExpenseToChantier
   * (@bob/core) que PUT /expenses/:id/chantier et l'écran Dépenses (parité humain↔Bob). Tenant
   * scoping strict + anti-IDOR fail-closed côté core ; idempotent (changed:false sans écriture). */
  assignExpenseChantier?(
    input: AssignExpenseChantierActionInput,
  ): Promise<Result<AssignExpenseChantierActionOutput, AppError>>;
  /**
   * Compatibilité de compilation pendant la migration des hôtes. Le registre ne l'expose plus :
   * cette action sans date/moyen ne doit jamais être appelée.
   */
  payExpense?(input: { expenseId: string }): Promise<Result<{ status: string }, AppError>>;
  /** Même commande atomique que « Tout marquer comme lu » dans l'écran Notifications. */
  markNotificationsReadThrough?(
    input: NotificationReadThroughInput,
  ): Promise<Result<NotificationReadThroughOutput, AppError>>;
  /** « C'est bon, valide le ticket » — MÊME use case AcknowledgeDocument (@bob/core) que le
   * bouton « Confirmer » de la file « À valider » (parité humain↔Bob). L'hôte résout la
   * révision courante côté serveur ; le latch garantit l'idempotence (jamais réécrit). */
  acknowledgeDocument?(
    input: AcknowledgeDocumentActionInput,
  ): Promise<Result<AcknowledgeDocumentActionOutput, AppError>>;
  /** Destinations de classement RÉELLES du tenant (chantiers ouverts + dossiers racine actifs)
   * — lecture pure, la SEULE autorité de résolution de classer_document (jamais d'id inventé). */
  listFilingDestinations?(): Promise<Result<FilingDestinations, AppError>>;
  /** « Range le ticket Aldi dans le chantier Durand » — MÊME séquence que le geste « Classer
   * là » mobile : MoveDocumentToFolder + ClassifyDocument (chantier) + nom intelligent
   * (suggestedRenameFor : un renommage humain n'est JAMAIS écrasé). L'hôte résout les révisions. */
  fileDocument?(input: FileDocumentActionInput): Promise<Result<FileDocumentActionOutput, AppError>>;
  /** « Renomme-le facture matériaux salle de bain » — MÊME use case RenameDocument que l'écran
   * détail : le nom dicté devient un renommage humain PRIORITAIRE sur toute suggestion. */
  renameDocument?(input: RenameDocumentActionInput): Promise<Result<RenameDocumentActionOutput, AppError>>;
  /** « Retrouve la facture du radiateur de mars » — MÊME recherche que GET /documents/search
   * (devis & factures, ranking serveur). Lecture pure, résultats réels uniquement. */
  searchDocuments?(input: SearchDocumentsActionInput): Promise<Result<SearchDocumentsActionOutput, AppError>>;
  /** B8 — « la RATP m'a envoyé un bon de commande n° 4500123 » : MÊME use case
   * AttachPurchaseOrderToQuote que PUT /quotes/:id/purchase-order (parité humain↔Bob).
   * L'hôte résout la révision courante (le geste vocal n'a pas de vue optimiste) ; le numéro
   * sera repris automatiquement sur la facture dérivée (Invoice.fromSignedQuote, core). */
  attachPurchaseOrderToQuote?(
    input: AttachPurchaseOrderActionInput,
  ): Promise<Result<AttachPurchaseOrderActionOutput, AppError>>;
}
