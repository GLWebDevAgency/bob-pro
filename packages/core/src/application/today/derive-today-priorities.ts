import { type DateOnly } from '../../shared-kernel/time';
import { type Totals } from '../../domain/billing/shared/totals';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus, type QuoteStatus } from '../../domain/billing/shared/state-machines';
import { type ComplianceItem } from '../../domain/compliance/diagnostic';

/**
 * Use case pur « priorités du jour » (claim C10, amendement A1-C10).
 * Entrée = données RÉELLES projetées (factures/devis/clients tels que servis par l'api-client),
 * sortie = TodayPriority[] triées, prêtes pour l'UI. Aucune I/O, aucun repli fixtures :
 * l'absence de données produit simplement zéro priorité (l'état vide est un état de premier rang).
 */

// ── Entrées (projections minimales, structurellement compatibles avec les vues api-client) ──

export interface TodayInvoiceData {
  id: string;
  customerId: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string | null;
  parentQuoteId: string | null;
  totals: Totals;
  dueAt: DateOnly | null;
  paid: number; // centimes encaissés cumulés
  /**
   * PR-02 — livraison EMAIL constatée par l'outbox (premier job `invoice-delivery` réussi).
   * Trois valeurs, trois sens DISTINCTS (même doctrine fail-closed que TodayCustomerData.email) :
   * · un instant ISO → la pièce est PARTIE (preuve serveur) ;
   * · `null` → aucune livraison constatée (l'appelant l'AFFIRME) ;
   * · `undefined` → information non transportée : on n'affirme JAMAIS qu'une pièce n'est pas
   *   partie depuis une projection qui ne porte simplement pas le fait.
   */
  emailDeliveredAt?: string | null;
  /**
   * PR-02 — suivi DÉCLARÉ de transmission (dépôt Chorus/portail, ou « envoyée le » déclaré).
   * `undefined` = information non transportée (fail-closed) ; `null` = jamais suivi.
   */
  transmission?: { depositedAt: DateOnly | null; acceptedAt: DateOnly | null } | null;
}

export interface TodayQuoteData {
  id: string;
  customerId: string;
  status: QuoteStatus;
  number: string | null;
  totals: Totals;
  /**
   * PR-05 — date d'établissement RÉELLE (ancre des paliers de relance J+15/J+30).
   * `undefined` = information non transportée, `null` = devis legacy sans date : dans les DEUX
   * cas le devis est EXCLU des relances (fail-closed — on n'invente jamais une date d'ancrage).
   */
  issuedAt?: DateOnly | null;
  /**
   * PR-05 — bon de commande du devis (alerte « signé sans BC »). `undefined` = information non
   * transportée (fail-closed : jamais d'alerte), `null` = aucun BC saisi.
   */
  purchaseOrder?: { number: string } | null;
}

export interface TodayCustomerData {
  id: string;
  name: string;
  /**
   * Adresse e-mail persistée du client. Trois valeurs, trois sens DISTINCTS :
   * · une adresse → le client est joignable par e-mail ;
   * · `null` (ou vide) → renseigné ABSENT : le client n'a pas d'e-mail (fiche téléphone seul) ;
   * · `undefined` → l'appelant ne fournit pas le champ, donc l'information est INCONNUE.
   * Fail-closed : seul `null`/vide déclenche « devis à transmettre » — on n'affirme jamais
   * qu'une adresse manque à partir d'une projection qui ne la transporte simplement pas.
   */
  email?: string | null;
  /** PR-05 — type du client (b2c/b2b/b2g) : signal de l'alerte « signé sans BC » (b2g).
   *  Optionnel additif : absent = inconnu, jamais un type inventé. */
  type?: 'b2c' | 'b2b' | 'b2g';
  /** PR-05 — canal de facturation déclaré : chorus/portail = BC attendu (grands comptes).
   *  Optionnel additif ; absent ou null = email (aucun signal). */
  billingChannel?: { type: 'email' | 'chorus' | 'portail' } | null;
}

/**
 * Signal conformité de l'entreprise, fourni par la composition (diagnostic réel).
 * Optionnel : sans signal, on N'INVENTE PAS de priorité conformité.
 */
export interface TodayCompanyData {
  /** Réception des factures électroniques (échéance 2026-09-01) déjà configurée ? */
  einvoiceReceptionConfigured: boolean;
}

export interface DeriveTodayPrioritiesInput {
  invoices: readonly TodayInvoiceData[];
  quotes: readonly TodayQuoteData[];
  customers: readonly TodayCustomerData[];
  company?: TodayCompanyData;
  today: DateOnly;
}

// ── Sortie (union discriminée consommée par l'écran Aujourd'hui) ──

export interface RelancePriority {
  kind: 'relance';
  id: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  docNumber: string | null;
  /** Reste à encaisser en centimes — plafonné à netToPay (jamais ttc) : netToPay − paid. */
  amountCents: number;
  daysLate: number;
}

export interface FactureFinalePriority {
  kind: 'facture_finale';
  id: string;
  quoteId: string;
  customerId: string;
  customerName: string;
  /** Numéro du devis signé (référence visible côté UI). */
  docNumber: string | null;
  /** Restant à facturer en centimes = ttc du devis − netToPay (acompte net) de la facture d'acompte payée. */
  amountCents: number;
}

/**
 * Devis envoyé que PERSONNE n'a reçu (cas terrain fondateur 2026-07-20) : l'artisan a demandé
 * l'envoi du lien par e-mail pour un client dont seul le téléphone est connu. Le serveur répond
 * `deliveryStatus: 'skipped'` et n'envoie rien — c'est correct —, mais le devis passe quand même
 * `sent` : le numéro légal est alloué et la date d'établissement figée (art. A1). On N'INVENTE
 * donc AUCUN statut « en attente d'envoi » dans le domaine ; la priorité se DÉRIVE de l'état
 * réel, et elle s'éteint d'elle-même dès que le devis quitte `sent` (vu/signé/refusé/expiré).
 */
export interface DevisATransmettrePriority {
  kind: 'devis_a_transmettre';
  id: string;
  quoteId: string;
  customerId: string;
  customerName: string;
  /** Numéro du devis déjà alloué (référence visible côté UI et dans le message partagé). */
  docNumber: string | null;
  /** Montant TTC du devis — ce qui reste en jeu tant que le client ne l'a pas sous les yeux. */
  amountCents: number;
}

/**
 * PR-02 « Encaisser » — facture ÉMISE que RIEN ne prouve transmise : aucun job `invoice-delivery`
 * réussi ET aucun dépôt déclaré. Le cas Fly Services (2 % encaissé : des factures jamais
 * envoyées). État 100 % DÉRIVÉ — aucun statut inventé : la carte s'éteint d'elle-même dès
 * qu'un envoi réussit (outbox) OU qu'un dépôt est déclaré (« envoyée le » / Chorus / portail),
 * et disparaît quand la pièce quitte `issued` (payée, en retard → la relance prend le relais).
 * Fail-closed : les DEUX faits (`emailDeliveredAt`, `transmission`) doivent être TRANSPORTÉS
 * (≠ undefined) — jamais d'alerte depuis une projection muette.
 */
export interface FactureATransmettrePriority {
  kind: 'facture_a_transmettre';
  id: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  /** Numéro légal de la pièce émise (référence visible côté UI). */
  docNumber: string | null;
  /** Reste à encaisser en centimes (netToPay − paid) — ce qui dort tant que rien n'est parti. */
  amountCents: number;
}

/** PR-05 — paliers de relance devis (ancrés sur `issuedAt` réel, jamais une date inventée). */
export const QUOTE_RELANCE_STEPS = { j15: 15, j30: 30 } as const;
export type QuoteRelancePalier = keyof typeof QUOTE_RELANCE_STEPS;

/**
 * PR-05 — devis envoyé/vu SANS réponse depuis J+15 (puis J+30) : relance MANUELLE pré-rédigée
 * en un tap (jamais envoyée seule). Extinction par l'état réel : signé/refusé/expiré sort du
 * périmètre tout seul (aucun statut inventé). Devis legacy sans `issuedAt` EXCLUS (fail-closed).
 */
export interface DevisARelancerPriority {
  kind: 'devis_a_relancer';
  id: string;
  quoteId: string;
  customerId: string;
  customerName: string;
  docNumber: string | null;
  /** Montant TTC du devis — l'enjeu qui dort sans réponse. */
  amountCents: number;
  /** Jours calendaires depuis l'établissement (issuedAt réel). */
  daysSinceIssued: number;
  /** Palier atteint (le plus avancé) — pilote la dédup des notifications par palier. */
  palier: QuoteRelancePalier;
}

/**
 * PR-05 — devis SIGNÉ sans n° de bon de commande alors que le contexte l'exige (client public
 * b2g, ou canal de facturation chorus/portail) : sans BC, la facture dérivée sera rejetée
 * (cas RATP CAP). Signal RÉEL uniquement — jamais une règle spécifique client.
 */
export interface BcManquantPriority {
  kind: 'bc_manquant';
  id: string;
  quoteId: string;
  customerId: string;
  customerName: string;
  docNumber: string | null;
  amountCents: number;
}

export interface ConformitePriority {
  kind: 'conformite';
  id: string;
}

export type TodayPriority =
  | RelancePriority
  | FactureATransmettrePriority
  | FactureFinalePriority
  | BcManquantPriority
  | DevisATransmettrePriority
  | DevisARelancerPriority
  | ConformitePriority;

// ── Règles métier ──

/** Statuts encore encaissables : une facture payée/annulée/brouillon ne se relance pas. */
const COLLECTIBLE: ReadonlySet<InvoiceStatus> = new Set(['issued', 'partially_paid', 'late']);

const MS_PER_DAY = 86_400_000;

/** Jours calendaires entiers entre deux DateOnly (UTC, sans dépendance). */
function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY);
}

function customerIndex(
  customers: readonly TodayCustomerData[],
): ReadonlyMap<string, TodayCustomerData> {
  return new Map(customers.map((c) => [c.id, c]));
}

/**
 * Vrai UNIQUEMENT quand l'appelant AFFIRME l'absence d'adresse (`null` ou chaîne blanche).
 * Un champ non fourni (`undefined`) reste inconnu et ne produit jamais d'affirmation.
 */
function isEmailKnownMissing(customer: TodayCustomerData): boolean {
  if (customer.email === undefined) return false;
  return customer.email === null || customer.email.trim() === '';
}

/**
 * Facture en retard : statut encaissable, reste dû strictement positif, et échéance dépassée
 * (statut `late` posé par le backend, ou dueAt < today). Les avoirs sont hors périmètre relance.
 */
function overdueRemainingCents(invoice: TodayInvoiceData, today: DateOnly): number | null {
  if (invoice.kind === 'credit_note') return null;
  if (!COLLECTIBLE.has(invoice.status)) return null;
  const remaining = invoice.totals.netToPay - invoice.paid;
  if (remaining <= 0) return null;
  const overdue = invoice.status === 'late' || (invoice.dueAt !== null && invoice.dueAt < today);
  return overdue ? remaining : null;
}

function deriveRelances(
  input: DeriveTodayPrioritiesInput,
  customers: ReadonlyMap<string, TodayCustomerData>,
): RelancePriority[] {
  const relances: RelancePriority[] = [];
  for (const invoice of input.invoices) {
    const remaining = overdueRemainingCents(invoice, input.today);
    if (remaining === null) continue;
    const customerName = customers.get(invoice.customerId)?.name;
    // Une pièce orpheline est une incohérence de référentiel, pas un client sans nom. Elle ne
    // devient jamais une priorité actionnable tant que la relation autoritative n'est pas réparée.
    if (customerName === undefined) continue;
    relances.push({
      kind: 'relance',
      id: `relance-${invoice.id}`,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      customerName,
      docNumber: invoice.number,
      amountCents: remaining,
      daysLate: invoice.dueAt !== null ? Math.max(0, daysBetween(invoice.dueAt, input.today)) : 0,
    });
  }
  // Tri : retard le plus long d'abord, puis montant le plus élevé (contrat C10 v1.1).
  return relances.sort((a, b) => b.daysLate - a.daysLate || b.amountCents - a.amountCents);
}

function deriveFacturesFinales(
  input: DeriveTodayPrioritiesInput,
  customers: ReadonlyMap<string, TodayCustomerData>,
): FactureFinalePriority[] {
  const childrenByQuote = new Map<string, TodayInvoiceData[]>();
  for (const invoice of input.invoices) {
    if (invoice.parentQuoteId === null) continue;
    const children = childrenByQuote.get(invoice.parentQuoteId);
    if (children) children.push(invoice);
    else childrenByQuote.set(invoice.parentQuoteId, [invoice]);
  }

  const finales: FactureFinalePriority[] = [];
  for (const quote of input.quotes) {
    if (quote.status !== 'signed') continue;
    const customerName = customers.get(quote.customerId)?.name;
    if (customerName === undefined) continue;
    const children = childrenByQuote.get(quote.id) ?? [];
    // Il faut un acompte ENCAISSÉ (payé), et aucune facture finale déjà engagée (même en brouillon).
    const depositPaid = children.find((i) => i.kind === 'deposit' && i.status === 'paid');
    if (!depositPaid) continue;
    if (children.some((i) => i.kind === 'final' && i.status !== 'cancelled')) continue;
    // Restant = ttc du devis − acompte net (netToPay de la facture d'acompte) — cohérent billing-nettopay.
    const remaining = quote.totals.ttc - depositPaid.totals.netToPay;
    if (remaining <= 0) continue;
    finales.push({
      kind: 'facture_finale',
      id: `facture-finale-${quote.id}`,
      quoteId: quote.id,
      customerId: quote.customerId,
      customerName,
      docNumber: quote.number,
      amountCents: remaining,
    });
  }
  return finales.sort((a, b) => b.amountCents - a.amountCents);
}

/**
 * Devis `sent` dont le client n'a AUCUNE adresse e-mail connue : le lien n'est parti nulle part.
 * Aucune autre condition n'est nécessaire — `sent` est le seul statut où le devis est vivant et
 * pas encore ouvert. `viewed`/`signed`/`refused`/`expired` prouvent que la pièce est arrivée (ou
 * qu'elle est close) : la carte disparaît alors toute seule, sans état supplémentaire à tracer.
 */
function deriveDevisATransmettre(
  input: DeriveTodayPrioritiesInput,
  customers: ReadonlyMap<string, TodayCustomerData>,
): DevisATransmettrePriority[] {
  const aTransmettre: DevisATransmettrePriority[] = [];
  for (const quote of input.quotes) {
    if (quote.status !== 'sent') continue;
    const customer = customers.get(quote.customerId);
    // Devis orphelin : incohérence de référentiel, jamais une priorité actionnable.
    if (customer === undefined) continue;
    if (!isEmailKnownMissing(customer)) continue;
    aTransmettre.push({
      kind: 'devis_a_transmettre',
      id: `devis-a-transmettre-${quote.id}`,
      quoteId: quote.id,
      customerId: quote.customerId,
      customerName: customer.name,
      docNumber: quote.number,
      amountCents: quote.totals.ttc,
    });
  }
  // Le plus gros enjeu d'abord — même convention que les factures finales.
  return aTransmettre.sort((a, b) => b.amountCents - a.amountCents);
}

/**
 * Vrai UNIQUEMENT quand la pièce est émise ET que les deux faits de transmission sont TRANSPORTÉS
 * et négatifs : aucun envoi e-mail constaté, aucun dépôt déclaré. Exporté : la liste ventes
 * (badge ambre) et Pilotage (« émises sans envoi constaté ») dérivent du MÊME prédicat.
 */
export function isIssuedNeverTransmitted(
  invoice: Pick<TodayInvoiceData, 'kind' | 'status' | 'emailDeliveredAt' | 'transmission'>,
): boolean {
  if (invoice.kind === 'credit_note') return false;
  if (invoice.status !== 'issued') return false;
  // Fail-closed : un fait absent (undefined) n'autorise aucune affirmation.
  if (invoice.emailDeliveredAt === undefined || invoice.transmission === undefined) return false;
  if (invoice.emailDeliveredAt !== null) return false;
  return invoice.transmission?.depositedAt == null;
}

function deriveFacturesATransmettre(
  input: DeriveTodayPrioritiesInput,
  customers: ReadonlyMap<string, TodayCustomerData>,
): FactureATransmettrePriority[] {
  const aTransmettre: FactureATransmettrePriority[] = [];
  for (const invoice of input.invoices) {
    if (!isIssuedNeverTransmitted(invoice)) continue;
    const remaining = invoice.totals.netToPay - invoice.paid;
    if (remaining <= 0) continue;
    const customerName = customers.get(invoice.customerId)?.name;
    // Pièce orpheline : incohérence de référentiel, jamais une priorité actionnable.
    if (customerName === undefined) continue;
    aTransmettre.push({
      kind: 'facture_a_transmettre',
      id: `facture-a-transmettre-${invoice.id}`,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      customerName,
      docNumber: invoice.number,
      amountCents: remaining,
    });
  }
  // Le plus gros enjeu d'abord — même convention que les factures finales.
  return aTransmettre.sort((a, b) => b.amountCents - a.amountCents);
}

/**
 * PR-05 — palier de relance atteint par un devis, depuis sa date d'établissement RÉELLE.
 * Fonction PURE exportée : le cron (notifications dédupliquées par palier) et la carte
 * Aujourd'hui dérivent du MÊME calcul. null = aucun palier atteint OU date d'ancrage absente
 * (fail-closed) OU statut hors périmètre (extinction par l'état réel).
 */
export function quoteRelancePalierOf(
  quote: Pick<TodayQuoteData, 'status' | 'issuedAt'>,
  today: DateOnly,
): { palier: QuoteRelancePalier; daysSinceIssued: number } | null {
  if (quote.status !== 'sent' && quote.status !== 'viewed') return null;
  // Fail-closed : jamais de date d'ancrage inventée (devis legacy sans issuedAt exclus).
  if (quote.issuedAt === undefined || quote.issuedAt === null) return null;
  const daysSinceIssued = daysBetween(quote.issuedAt, today);
  if (daysSinceIssued >= QUOTE_RELANCE_STEPS.j30) return { palier: 'j30', daysSinceIssued };
  if (daysSinceIssued >= QUOTE_RELANCE_STEPS.j15) return { palier: 'j15', daysSinceIssued };
  return null;
}

function deriveDevisARelancer(
  input: DeriveTodayPrioritiesInput,
  customers: ReadonlyMap<string, TodayCustomerData>,
): DevisARelancerPriority[] {
  const aRelancer: DevisARelancerPriority[] = [];
  for (const quote of input.quotes) {
    const reached = quoteRelancePalierOf(quote, input.today);
    if (reached === null) continue;
    const customer = customers.get(quote.customerId);
    if (customer === undefined) continue;
    aRelancer.push({
      kind: 'devis_a_relancer',
      id: `devis-a-relancer-${quote.id}`,
      quoteId: quote.id,
      customerId: quote.customerId,
      customerName: customer.name,
      docNumber: quote.number,
      amountCents: quote.totals.ttc,
      daysSinceIssued: reached.daysSinceIssued,
      palier: reached.palier,
    });
  }
  // L'attente la plus longue d'abord, puis le plus gros enjeu.
  return aRelancer.sort((a, b) => b.daysSinceIssued - a.daysSinceIssued || b.amountCents - a.amountCents);
}

/**
 * PR-05 — signal RÉEL de l'exigence de BC : client public (b2g) ou canal de dépôt
 * (chorus/portail). Fail-closed : type et canal absents = aucun signal, jamais d'alerte.
 */
function purchaseOrderExpected(customer: TodayCustomerData): boolean {
  if (customer.type === 'b2g') return true;
  const channel = customer.billingChannel?.type;
  return channel === 'chorus' || channel === 'portail';
}

function deriveBcManquants(
  input: DeriveTodayPrioritiesInput,
  customers: ReadonlyMap<string, TodayCustomerData>,
): BcManquantPriority[] {
  const manquants: BcManquantPriority[] = [];
  for (const quote of input.quotes) {
    if (quote.status !== 'signed') continue;
    // Fail-closed : BC non transporté (undefined) = on n'affirme JAMAIS qu'il manque.
    if (quote.purchaseOrder === undefined || quote.purchaseOrder !== null) continue;
    const customer = customers.get(quote.customerId);
    if (customer === undefined) continue;
    if (!purchaseOrderExpected(customer)) continue;
    manquants.push({
      kind: 'bc_manquant',
      id: `bc-manquant-${quote.id}`,
      quoteId: quote.id,
      customerId: quote.customerId,
      customerName: customer.name,
      docNumber: quote.number,
      amountCents: quote.totals.ttc,
    });
  }
  return manquants.sort((a, b) => b.amountCents - a.amountCents);
}

function deriveConformite(input: DeriveTodayPrioritiesInput): ConformitePriority[] {
  // Une seule priorité conformité au maximum, et uniquement sur signal réel (jamais par défaut).
  if (input.company === undefined || input.company.einvoiceReceptionConfigured) return [];
  return [{ kind: 'conformite', id: 'conformite-einvoice-2026' }];
}

/**
 * Dérive les priorités du briefing « Aujourd'hui » :
 * 1. relances — factures échues non payées (retard desc, puis montant desc) ;
 * 2. factures à transmettre — pièces ÉMISES sans aucun envoi constaté ni dépôt déclaré (PR-02) ;
 * 3. factures finales — devis signés dont l'acompte est encaissé mais sans facture finale ;
 * 4. BC manquants — devis SIGNÉS sans n° de commande alors que le contexte l'exige (PR-05) ;
 * 5. devis à transmettre — devis `sent` que le client n'a pas pu recevoir, faute d'e-mail ;
 * 6. devis à relancer — sans réponse depuis J+15/J+30 sur date d'établissement réelle (PR-05) ;
 * 7. conformité — préparation facturation électronique 2026 non configurée (1 max).
 * Tri global : l'argent déjà dû d'abord (et une pièce jamais partie EST de l'argent dû qui ne
 * rentrera jamais seul), l'argent à facturer ensuite, puis les devis restés dans le vide, et
 * enfin l'information de conformité. Le cap d'affichage est géré par l'UI.
 */
export function deriveTodayPriorities(input: DeriveTodayPrioritiesInput): TodayPriority[] {
  const customers = customerIndex(input.customers);
  return [
    ...deriveRelances(input, customers),
    ...deriveFacturesATransmettre(input, customers),
    ...deriveFacturesFinales(input, customers),
    // PR-05 : un devis signé SANS BC exigé bloque la facturation — juste après « à facturer ».
    ...deriveBcManquants(input, customers),
    ...deriveDevisATransmettre(input, customers),
    // PR-05 : devis sans réponse J+15/J+30 — relance manuelle pré-rédigée.
    ...deriveDevisARelancer(input, customers),
    ...deriveConformite(input),
  ];
}

/**
 * Projette le diagnostic conformité réel vers le signal attendu par deriveTodayPriorities.
 * Item `einvoice-reception` à `todo` → non configuré ; item absent (pays non couvert) → rien à préparer.
 */
export function todayCompanyFromDiagnostic(diagnostic: {
  items: readonly Pick<ComplianceItem, 'id' | 'status'>[];
}): TodayCompanyData {
  const reception = diagnostic.items.find((item) => item.id === 'einvoice-reception');
  return { einvoiceReceptionConfigured: reception === undefined || reception.status !== 'todo' };
}
