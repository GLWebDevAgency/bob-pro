import { type Instant, type DateOnly, parisDateOnly, addDays } from '../../shared-kernel/time';
import { type Signature } from '../billing/shared/signature';
import { type CustomerType } from '../customer/customer';

/**
 * A3 — Droit de rétractation de 14 jours du consommateur (art. L221-18 s. du code de la
 * consommation) pour les contrats conclus À DISTANCE ou HORS ÉTABLISSEMENT (art. L221-1).
 *
 * Périmètre produit (vérifié par l'audit AUDIT_INDISPENSABLES_V1 §A3) : l'app ne connaît que
 * deux canaux de signature (sign-quote.ts) —
 *  • `remote_link`  : lien public envoyé au client → contrat À DISTANCE (art. L221-1, I-1°) ;
 *  • `onsite_draw`  : signature sur le téléphone de l'artisan, chez le client → contrat HORS
 *    ÉTABLISSEMENT (art. L221-1, I-2° : conclu « dans un lieu qui n'est pas celui où le
 *    professionnel exerce son activité en permanence », le domicile du client en est le cas
 *    type). Le canal « en boutique/établissement du professionnel » n'existe pas dans l'app.
 * DONC : tout devis B2C signé via l'app est PRÉSUMÉ soumis au droit de rétractation. Une
 * signature `legacy_declared` (méthode réelle inconnue, jamais réinventée) est passée par l'un
 * de ces deux canaux : même présomption, fail-closed.
 *
 * Sanctions en cas de manquement (pourquoi ce module est non négociable) : information non
 * fournie → délai porté à 12 mois (art. L221-20) ; exécution avant la fin du délai sans
 * demande expresse du client → le professionnel ne peut exiger aucun paiement pour le service
 * exécuté (art. L221-25, a contrario ; jurisprudence constante sur les travaux non payables).
 */

/** Durée légale du délai de rétractation (art. L221-18 du code de la consommation). */
export const RETRACTATION_DELAY_DAYS = 14;

/**
 * Renonciation au gel : demande EXPRESSE d'exécution anticipée des travaux avant la fin du
 * délai (art. L221-25 c. conso — le consommateur qui demande l'exécution avant la fin du délai
 * doit payer le prix correspondant au service fourni jusqu'à sa rétractation).
 */
export interface RetractationWaiver {
  /** Toujours `true` quand la renonciation existe — la case cochée est un fait, jamais déduit. */
  requestedEarlyExecution: true;
  /** Horodatage de la demande (porté par la signature — Signature.earlyExecution.requestedAt). */
  at: Instant;
}

/** Contexte de rétractation d'un devis SIGNÉ (le contrat est conclu à la signature). */
export interface Retractation {
  /** true = client consommateur (b2c) signé via l'app : présomption distance/hors établissement. */
  applicable: boolean;
  /** Demande d'exécution anticipée tracée à la signature — null si non demandée. */
  waived: RetractationWaiver | null;
  /**
   * Fin du délai de rétractation — instant précis calculé selon l'art. L221-19 c. conso
   * (renvoi au règlement CEE n° 1182/71) : null quand le droit n'est pas applicable.
   */
  expiresAt: Instant | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendrier légal français (computation du délai, art. L221-19 c. conso)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dimanche de Pâques (calendrier grégorien) — algorithme de Meeus/Butcher, déterministe,
 * nécessaire aux trois jours fériés mobiles (lundi de Pâques, Ascension, lundi de Pentecôte).
 */
function easterSunday(year: number): DateOnly {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Jours fériés légaux NATIONAUX (art. L3133-1 du code du travail) : 1er janvier, lundi de
 * Pâques, 1er mai, 8 mai, Ascension (Pâques + 39 j), lundi de Pentecôte (Pâques + 50 j),
 * 14 juillet, Assomption (15 août), Toussaint (1er novembre), 11 novembre, Noël (25 décembre).
 * Liste nationale uniquement — les fériés locaux (Alsace-Moselle, outre-mer) ne sont pas
 * modélisés : ils ne feraient qu'ALLONGER le délai, la base nationale est le régime commun.
 */
export function isFrenchPublicHoliday(date: DateOnly): boolean {
  const year = Number(date.slice(0, 4));
  const monthDay = date.slice(5);
  if (['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25'].includes(monthDay))
    return true;
  const easter = easterSunday(year);
  return (
    date === addDays(easter, 1) || // lundi de Pâques
    date === addDays(easter, 39) || // Ascension (jeudi)
    date === addDays(easter, 50) // lundi de Pentecôte
  );
}

/** Samedi/dimanche d'une DateOnly (calcul UTC pur : une DateOnly n'a pas de fuseau). */
function isWeekend(date: DateOnly): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Instant UTC du DÉBUT du jour calendaire Europe/Paris donné (00:00 heure de Paris).
 * DST-safe : Paris vaut UTC+1 (hiver) ou UTC+2 (été) ; les bascules ont lieu à 02h/03h,
 * jamais autour de minuit — exactement UN des deux candidats retombe sur la bonne date à
 * Paris. L'offset +2 est testé en premier : en été, le candidat +1 afficherait la bonne date
 * mais 01h00 (faux) alors que le candidat +2 échoue proprement le test de date en hiver.
 */
function parisStartOfDayInstant(date: DateOnly): Instant {
  const utcMidnight = Date.parse(`${date}T00:00:00.000Z`);
  for (const offsetHours of [2, 1]) {
    const candidate = new Date(utcMidnight - offsetHours * 3_600_000);
    if (parisDateOnly(candidate) === date) return candidate.toISOString();
  }
  /* v8 ignore next 2 — inatteignable : Paris est toujours UTC+1 ou UTC+2. */
  return new Date(utcMidnight).toISOString();
}

/**
 * Fin d'un délai légal de N jours courant à compter d'une conclusion de contrat — computation
 * de l'art. L221-19 c. conso, qui renvoie EXPRESSÉMENT au règlement CEE n° 1182/71 du
 * 3 juin 1971 :
 *  1° le jour de la conclusion du contrat n'est PAS compté dans le délai ;
 *  2° le délai prend fin à l'expiration de la DERNIÈRE HEURE du dernier jour ;
 *  3° s'il expire un samedi, un dimanche ou un jour férié ou chômé, il est prorogé jusqu'au
 *     premier JOUR OUVRABLE suivant (règlement 1182/71, art. 2 §2 : les samedis, dimanches et
 *     jours fériés ne sont pas des jours ouvrables — d'où la boucle qui saute les trois).
 * Le calendrier de référence est le jour métier Europe/Paris (le contrat est conclu en France).
 * Retour : l'instant PRÉCIS où le délai expire (minuit de Paris à la fin du dernier jour).
 * Partagée entre le délai de rétractation (14 j, L221-18) et l'interdiction de paiement hors
 * établissement (7 j, L221-10) : pour cette dernière, appliquer la même computation est la
 * lecture PRUDENTE — elle ne peut qu'ALLONGER la fenêtre d'interdiction, jamais la raccourcir.
 */
function legalDelayExpiresAt(signedAt: Instant, days: number): Instant {
  const conclusionDay = parisDateOnly(signedAt);
  let lastDay = addDays(conclusionDay, days);
  while (isWeekend(lastDay) || isFrenchPublicHoliday(lastDay)) lastDay = addDays(lastDay, 1);
  // « expiration de la dernière heure du dernier jour » = minuit de Paris au début du jour suivant.
  return parisStartOfDayInstant(addDays(lastDay, 1));
}

/** Fin du délai de rétractation de 14 jours (art. L221-18/L221-19 c. conso) — le gel est actif
 *  strictement AVANT cet instant. */
export function retractationExpiresAt(signedAt: Instant): Instant {
  return legalDelayExpiresAt(signedAt, RETRACTATION_DELAY_DAYS);
}

export interface DeriveRetractationInput {
  /** Type COURANT du client (fiche) — fallback pour les signatures antérieures au figeage. */
  customerType: CustomerType;
  signature: Signature | null;
}

/**
 * Contexte de rétractation d'un devis — null tant que le devis n'est pas signé (aucun contrat,
 * aucun délai). Professionnels (b2b/b2g) : droit inapplicable (le régime des art. L221-18 s.
 * protège le CONSOMMATEUR, art. liminaire c. conso), jamais de gel.
 * La qualité du client est lue en PRIORITÉ depuis la signature (Signature.customerType, figée à
 * la CONCLUSION du contrat) : la qualité de consommateur s'apprécie au jour de la conclusion —
 * une édition ultérieure de la fiche client (b2c→b2b ou l'inverse) ne peut ni lever ni créer
 * rétroactivement le droit de rétractation. Fallback honnête : signatures antérieures au
 * figeage → type courant de la fiche (comportement historique, jamais un backfill inventé).
 */
export function deriveRetractation(input: DeriveRetractationInput): Retractation | null {
  if (input.signature === null) return null;
  const concludedWith = input.signature.customerType ?? input.customerType;
  const applicable = concludedWith === 'b2c';
  if (!applicable) return { applicable: false, waived: null, expiresAt: null };
  const early = input.signature.earlyExecution;
  return {
    applicable: true,
    waived: early ? { requestedEarlyExecution: true, at: early.requestedAt } : null,
    expiresAt: retractationExpiresAt(input.signature.signedAt),
  };
}

export type RetractationFreeze =
  | { active: false }
  | {
      active: true;
      /** Fin exacte du délai (instant, calcul L221-19). */
      expiresAt: Instant;
      /** Premier jour calendaire (Paris) où la facture finale redevient possible. */
      availableFrom: DateOnly;
    };

/**
 * A3 — GEL du passage devis signé → FACTURE FINALE : actif pour un devis B2C signé, sans
 * demande d'exécution anticipée, tant que le délai de rétractation court. Prudence assumée :
 * facturer (et exiger le paiement de) la totalité des travaux pendant le délai supposerait
 * leur exécution — non payable sans demande expresse (art. L221-25). L'ACOMPTE n'est pas gelé
 * (voir GenerateInvoiceFromQuote pour la nuance L221-10 laissée à l'arbitrage juridique).
 */
export function retractationFreeze(
  retractation: Retractation | null,
  now: Instant,
): RetractationFreeze {
  if (retractation === null || !retractation.applicable || retractation.waived !== null)
    return { active: false };
  const expiresAt = retractation.expiresAt;
  if (expiresAt === null || now >= expiresAt) return { active: false };
  return { active: true, expiresAt, availableFrom: parisDateOnly(expiresAt) };
}

/** « 2026-08-04 » → « 04/08/2026 » (affichage FR des messages de gel). */
export function formatDateOnlyFr(date: DateOnly): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

/**
 * Message HONNÊTE du gel — source unique pour l'API, le mobile et le flow vocal : il explique
 * POURQUOI (délai légal), JUSQU'À QUAND (date de déblocage) et CE QUI RESTE POSSIBLE (acompte).
 */
export function retractationFreezeMessage(availableFrom: DateOnly): string {
  return (
    `Client particulier : le délai légal de rétractation de 14 jours court encore ` +
    `(art. L221-18 du code de la consommation). La facture finale sera possible à partir du ` +
    `${formatDateOnlyFr(availableFrom)}. L'acompte prévu au devis reste facturable, et le devis ` +
    `reste pleinement valable — c'est une protection légale du client, pas un refus.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Interdiction de paiement pendant 7 jours — contrat HORS ÉTABLISSEMENT (art. L221-10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Durée de l'interdiction de percevoir un paiement après la conclusion d'un contrat HORS
 * ÉTABLISSEMENT (art. L221-10 c. conso : « Le professionnel ne peut recevoir aucun paiement
 * ou aucune contrepartie, sous quelque forme que ce soit, de la part du consommateur avant
 * l'expiration d'un délai de sept jours à compter de la conclusion du contrat hors
 * établissement »). Sanction : NULLITÉ du contrat (art. L242-1 c. conso ; Civ. 1re,
 * 20 déc. 2023, n° 22-13.014) + sanctions pénales du démarchage.
 */
export const OFF_PREMISES_PAYMENT_EMBARGO_DAYS = 7;

export type OffPremisesPaymentEmbargo =
  | { active: false }
  | {
      active: true;
      /** Fin exacte de l'interdiction (computation légale, cf. legalDelayExpiresAt). */
      expiresAt: Instant;
      /** Premier jour calendaire (Paris) où un paiement peut être demandé/reçu. */
      availableFrom: DateOnly;
    };

export interface OffPremisesPaymentEmbargoInput {
  /** Type COURANT du client (fiche) — fallback pour les signatures antérieures au figeage. */
  customerType: CustomerType;
  signature: Signature | null;
}

/**
 * A3/L221-10 — interdiction de PERCEVOIR tout paiement (acompte compris) pendant 7 jours après
 * la conclusion d'un contrat HORS ÉTABLISSEMENT avec un consommateur. Périmètre produit :
 *  • `onsite_draw` (signature chez le client) = contrat hors établissement (art. L221-1, I-2°)
 *    → interdiction ACTIVE pendant 7 jours ;
 *  • `remote_link` = contrat À DISTANCE : l'art. L221-10 ne vise QUE le contrat hors
 *    établissement — aucune interdiction (l'app n'invente pas une interdiction que la loi ne
 *    généralise pas) ;
 *  • `legacy_declared` (méthode réelle inconnue, jamais réinventée) → fail-closed : présomption
 *    hors établissement, interdiction active.
 * L'exception des travaux d'entretien/réparation URGENTS expressément sollicités (art. L221-10)
 * n'est PAS modélisée : fail-closed, aucun contournement tant que le fait n'est pas tracé.
 * La demande d'exécution anticipée (L221-25) est SANS EFFET ici : elle autorise l'exécution,
 * jamais la perception d'un paiement avant l'expiration du délai de sept jours.
 * Émettre une facture, c'est demander un paiement : le blocage porte donc sur l'émission des
 * pièces exigibles (acompte, situation, finale) — lecture prudente, jamais permissive.
 */
export function offPremisesPaymentEmbargo(
  input: OffPremisesPaymentEmbargoInput,
  now: Instant,
): OffPremisesPaymentEmbargo {
  const signature = input.signature;
  if (signature === null) return { active: false };
  const concludedWith = signature.customerType ?? input.customerType;
  if (concludedWith !== 'b2c') return { active: false };
  if (signature.method === 'remote_link') return { active: false };
  const expiresAt = legalDelayExpiresAt(signature.signedAt, OFF_PREMISES_PAYMENT_EMBARGO_DAYS);
  if (now >= expiresAt) return { active: false };
  return { active: true, expiresAt, availableFrom: parisDateOnly(expiresAt) };
}

/** Message HONNÊTE de l'interdiction L221-10 — source unique API/mobile/vocal. */
export function offPremisesPaymentEmbargoMessage(availableFrom: DateOnly): string {
  return (
    `Client particulier signé à domicile (contrat hors établissement) : la loi interdit de ` +
    `recevoir tout paiement, acompte compris, pendant 7 jours après la signature ` +
    `(art. L221-10 du code de la consommation — le contrat serait annulable). La facturation ` +
    `sera possible à partir du ${formatDateOnlyFr(availableFrom)}. Le devis signé reste ` +
    `pleinement valable.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Textes réglementaires — information précontractuelle + formulaire détachable
// ─────────────────────────────────────────────────────────────────────────────

/** Identité du professionnel insérée dans les textes réglementaires (jamais inventée). */
export interface RetractationProfessional {
  name: string;
  /** Adresse géographique sur une ligne (ex. « 12 rue des Fleurs, 92310 Sèvres »). */
  addressLine: string;
  /** Adresse électronique — insérée uniquement quand elle est CONNUE (jamais fabriquée). */
  email?: string | null;
  /** Numéro de téléphone — inséré uniquement quand il est CONNU. */
  phone?: string | null;
}

/**
 * Coordonnées du professionnel pour les emplacements « [insérer …] » des modèles types.
 * L'instruction (2) de l'avis type en vigueur (annexe à l'art. R221-3 c. conso, rédaction décret
 * n° 2022-424 du 25 mars 2022, transposition « Omnibus ») impose d'insérer « votre nom, votre
 * adresse géographique, votre numéro de téléphone et votre adresse électronique » — SANS la
 * réserve « lorsqu'ils sont disponibles » (disparue en 2022 avec le télécopieur). Téléphone ou
 * courriel absents du profil : insérés dès qu'ils existent, JAMAIS fabriqués — l'incomplétude
 * est signalée par retractationContactGaps (l'avis incomplet perd la présomption R221-3 et
 * expose au délai porté à 12 mois, art. L221-20).
 */
function professionalContact(pro: RetractationProfessional): string {
  const parts = [pro.name, pro.addressLine];
  if (pro.phone) parts.push(`tél. : ${pro.phone}`);
  if (pro.email) parts.push(`courriel : ${pro.email}`);
  return parts.join(', ');
}

/**
 * Données de contact MANQUANTES au regard des modèles types EN VIGUEUR :
 *  • avis d'information (annexe R221-3, instruction (2), décret n° 2022-424) : nom, adresse
 *    géographique, numéro de téléphone ET adresse électronique — tous requis ;
 *  • formulaire de rétractation (annexe R221-1, décret n° 2022-424) : nom, adresse géographique
 *    ET adresse électronique (le téléphone n'y figure pas).
 * Sert au signalement de conformité (réglages entreprise / nudge) — les textes eux-mêmes
 * n'impriment que le connu, jamais l'inventé.
 */
export function retractationContactGaps(pro: RetractationProfessional): {
  /** Champs manquants pour l'avis R221-3 (téléphone + courriel requis). */
  noticeMissing: ('phone' | 'email')[];
  /** Champs manquants pour le formulaire R221-1 (courriel requis). */
  formMissing: 'email'[];
} {
  const noticeMissing: ('phone' | 'email')[] = [];
  if (!pro.phone) noticeMissing.push('phone');
  if (!pro.email) noticeMissing.push('email');
  return { noticeMissing, formMissing: pro.email ? [] : ['email'] };
}

/**
 * A3 — options du bloc d'information : emplacement de la fonctionnalité de rétractation en
 * ligne (art. L221-21 dernier al. c. conso, ordonnance n° 2026-2 du 5 janvier 2026 ; modalités
 * art. D221-5, décret n° 2026-3 du 5 janvier 2026 — en vigueur depuis le 19 juin 2026).
 */
export interface RetractationNoticeOptions {
  /**
   * URL de la fonctionnalité « Renoncer au contrat ici » (quand elle existe déjà) OU explication
   * appropriée de l'endroit où elle sera disponible (instruction (3) de l'avis type, annexe
   * R221-3 version décret 2026-3 : « insérer l'adresse internet ou une autre explication
   * appropriée » ; information due au titre du 7° de l'art. L221-5). Null/absent = contrat non
   * concerné (hors interface en ligne) : ligne OMISE.
   */
  onlineFunctionLocation?: string | null;
}

/**
 * Bloc d'INFORMATION sur le droit de rétractation — reprise de l'avis d'information type
 * (annexe à l'article R. 221-3 du code de la consommation, rédaction issue du décret
 * n° 2022-424 du 25 mars 2022 puis du décret n° 2026-3 du 5 janvier 2026), complété
 * conformément à ses instructions pour un contrat de PRESTATION DE SERVICES (travaux) : le
 * délai court à compter du jour de la CONCLUSION du contrat (art. L221-18, 1°). Fournir cet
 * avis correctement rempli vaut respect de l'obligation d'information (art. R221-3). Texte
 * réglementaire : ne pas reformuler — seuls les emplacements [à insérer] sont complétés avec
 * des données réelles.
 */
export function retractationNoticeLines(
  pro: RetractationProfessional,
  options?: RetractationNoticeOptions,
): string[] {
  const location = options?.onlineFunctionLocation ?? null;
  return [
    'Droit de rétractation',
    'Vous avez le droit de vous rétracter du présent contrat sans donner de motif dans un délai de quatorze jours.',
    'Le délai de rétractation expire quatorze jours après le jour de la conclusion du contrat.',
    `Pour exercer le droit de rétractation, vous devez nous notifier (${professionalContact(pro)}) votre décision de rétractation du présent contrat au moyen d'une déclaration dénuée d'ambiguïté (par exemple, lettre envoyée par la poste ou courrier électronique). Vous pouvez utiliser le modèle de formulaire de rétractation mais ce n'est pas obligatoire.`,
    // A3 — contrat conclu au moyen d'une interface en ligne : existence et emplacement de la
    // fonctionnalité de rétractation (art. L221-5, 7° et L221-21 dernier al. c. conso ;
    // instruction (3) de l'avis type, annexe R221-3 version décret n° 2026-3), avec l'accusé
    // de réception sur support durable prévu à l'art. D221-5.
    ...(location
      ? [
          `Vous pouvez également vous rétracter en ligne, au moyen de la fonctionnalité « ${RETRACTATION_WITHDRAW_FUNCTION_LABEL} » disponible pendant toute la durée du délai de rétractation : ${location}. Si vous utilisez cette possibilité, nous vous enverrons sans tarder un accusé de réception de votre rétractation sur un support durable.`,
        ]
      : []),
    "Pour que le délai de rétractation soit respecté, il suffit que vous transmettiez votre communication relative à l'exercice du droit de rétractation avant l'expiration du délai de rétractation.",
    'Effets de rétractation',
    'En cas de rétractation de votre part du présent contrat, nous vous rembourserons tous les paiements reçus de vous sans retard excessif et, en tout état de cause, au plus tard quatorze jours à compter du jour où nous sommes informés de votre décision de rétractation du présent contrat. Nous procéderons au remboursement en utilisant le même moyen de paiement que celui que vous aurez utilisé pour la transaction initiale, sauf si vous convenez expressément d’un moyen différent ; en tout état de cause, ce remboursement n’occasionnera pas de frais pour vous.',
    "Si vous avez demandé de commencer la prestation de services pendant le délai de rétractation, vous devrez nous payer un montant proportionnel à ce qui vous a été fourni jusqu'au moment où vous nous avez informés de votre rétractation du présent contrat, par rapport à l'ensemble des prestations prévues par le contrat.",
  ];
}

/**
 * FORMULAIRE DÉTACHABLE de rétractation — modèle type de l'annexe à l'article R. 221-1 du code
 * de la consommation (obligatoirement joint au contrat, art. L221-5 et L221-9 : le contrat
 * « est accompagné du formulaire type de rétractation mentionné au 2° de l'article L221-5 »).
 * TEXTE EXACT du modèle réglementaire EN VIGUEUR (rédaction du décret n° 2022-424 du
 * 25 mars 2022, transposition « Omnibus ») : l'emplacement à compléter est « [insérer le nom,
 * l'adresse géographique et l'adresse électronique du professionnel] » — l'adresse électronique
 * est REQUISE sans condition (le télécopieur et la réserve « lorsqu'ils sont disponibles » ont
 * disparu en 2022). Courriel absent du profil : inséré dès qu'il existe, JAMAIS fabriqué —
 * l'incomplétude est signalée par retractationContactGaps (formulaire non conforme au modèle =
 * information non fournie, délai porté à 12 mois, art. L221-20 ; amende administrative,
 * art. L242-10). Le reste est à remplir par le client.
 */
export function retractationFormLines(pro: RetractationProfessional): string[] {
  const contact = [pro.name, pro.addressLine, ...(pro.email ? [pro.email] : [])].join(', ');
  return [
    'Formulaire de rétractation',
    '(Veuillez compléter et renvoyer le présent formulaire uniquement si vous souhaitez vous rétracter du contrat.)',
    `À l'attention de ${contact} :`,
    'Je/Nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat portant sur la vente du bien (*)/pour la prestation de services (*) ci-dessous :',
    'Commandé le (*)/reçu le (*) :',
    'Nom du (des) consommateur(s) :',
    'Adresse du (des) consommateur(s) :',
    'Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) :',
    'Date :',
    '(*) Rayez la mention inutile.',
  ];
}

/**
 * Libellé EXACT de la case « exécution anticipée » affichée au client AVANT signature (page
 * sign-web) — demande expresse au sens de l'art. L221-25, al. 1 c. conso (rédaction issue de
 * l'ordonnance n° 2021-1734 du 22 décembre 2021), qui impose de recueillir DEUX choses :
 *  1° la demande expresse d'exécution avant la fin du délai (avec l'obligation de payer le
 *     prix correspondant au service fourni jusqu'à la rétractation, art. L221-25, al. 2) ;
 *  2° la RECONNAISSANCE par le consommateur « qu'après que le professionnel aura entièrement
 *     exécuté le contrat, il ne disposera plus du droit de rétractation » — sans elle,
 *     l'exception de l'art. L221-28, 1° ne joue pas (le droit survivrait à l'exécution
 *     complète) et le dernier alinéa de l'art. L221-25 expose à la gratuité totale (« aucune
 *     somme n'est due » si la demande n'a pas été recueillie selon le premier alinéa).
 * Source unique : le serveur sert ce texte, la page ne le réécrit jamais.
 */
export const RETRACTATION_EARLY_EXECUTION_LABEL =
  "Je demande expressément l'exécution immédiate des travaux avant la fin du délai de " +
  'rétractation de 14 jours. Si je me rétracte ensuite, je devrai payer le montant ' +
  "correspondant aux travaux déjà exécutés (art. L221-25 du code de la consommation), et je " +
  "reconnais qu'après que l'entreprise aura entièrement exécuté les travaux, je ne disposerai " +
  'plus du droit de rétractation (art. L221-28, 1° du même code).';

// ─────────────────────────────────────────────────────────────────────────────
// Fonctionnalité de rétractation EN LIGNE (art. L221-21 dernier al. et D221-5 c. conso)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A3 — fonctionnalité de rétractation en ligne, OBLIGATOIRE depuis le 19 juin 2026 pour tout
 * contrat conclu À DISTANCE au moyen d'une interface en ligne (art. L221-21 dernier al.
 * c. conso, créé par l'ordonnance n° 2026-2 du 5 janvier 2026 transposant la directive (UE)
 * 2023/2673 ; modalités : art. D221-5, décret n° 2026-3 du 5 janvier 2026) :
 *  • identifiée par les mots « renoncer au contrat ici » ou une formule analogue dénuée
 *    d'ambiguïté, visible, directement et facilement accessible, disponible pendant TOUTE la
 *    durée du délai de rétractation, sans frais ;
 *  • la déclaration en ligne permet au consommateur de fournir/confirmer son nom, les détails
 *    du contrat et le moyen électronique de réception de l'accusé ;
 *  • soumission via une fonctionnalité de confirmation identifiée par « confirmer la
 *    rétractation » ou une formule analogue ;
 *  • le professionnel envoie ensuite, dans un délai raisonnable, un ACCUSÉ DE RÉCEPTION sur
 *    support durable mentionnant le contenu de la déclaration et la date/heure de son envoi.
 * Périmètre produit : offert à TOUT devis B2C signé via l'app — le flux `remote_link` y est
 * strictement tenu (contrat à distance via interface en ligne) ; l'offrir aussi au flux
 * `onsite_draw`/`legacy_declared` est un SURCROÎT de droit, jamais une violation (fail-closed).
 * Sanction du manquement : amende administrative 15 000 € / 75 000 € (art. L242-13 c. conso).
 */
export const RETRACTATION_WITHDRAW_FUNCTION_LABEL = 'Renoncer au contrat ici';

/** Libellé de la fonctionnalité de CONFIRMATION (art. D221-5 : « confirmer la rétractation »). */
export const RETRACTATION_CONFIRM_FUNCTION_LABEL = 'Confirmer la rétractation';

export type OnlineRetractationAvailability =
  | { available: false; reason: 'not_applicable' | 'expired' | 'already_retracted' }
  | { available: true; expiresAt: Instant };

/**
 * Disponibilité de la fonctionnalité en ligne : pendant TOUTE la durée du délai (D221-5), que
 * l'exécution anticipée ait été demandée ou non — la demande L221-25 ne fait pas perdre le
 * droit (seule l'exécution COMPLÈTE le fait, L221-28, 1°) : la fonctionnalité reste offerte.
 */
export function onlineRetractationAvailability(
  retractation: Retractation | null,
  alreadyRetracted: boolean,
  now: Instant,
): OnlineRetractationAvailability {
  if (alreadyRetracted) return { available: false, reason: 'already_retracted' };
  if (retractation === null || !retractation.applicable || retractation.expiresAt === null)
    return { available: false, reason: 'not_applicable' };
  if (now >= retractation.expiresAt) return { available: false, reason: 'expired' };
  return { available: true, expiresAt: retractation.expiresAt };
}

/** « 2026-07-19T14:03:00Z » → « 19/07/2026 à 16:03 (heure de Paris) » — accusé D221-5. */
export function formatInstantFrParis(at: Instant): string {
  const date = new Date(at);
  const fmt = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${fmt.format(date).replace(/,?\s+/, ' à ')} (heure de Paris)`;
}

export interface RetractationDeclarationInput {
  /** Nom fourni/confirmé par le consommateur dans la déclaration (D221-5). */
  declarantName: string;
  /** Détails du contrat : numéro du devis signé. */
  quoteNumber: string;
  companyName: string;
  /** Moyen électronique choisi pour recevoir l'accusé (adresse électronique). */
  acknowledgmentEmail: string;
  /** Horodatage SERVEUR de l'envoi de la déclaration. */
  sentAt: Instant;
}

/**
 * Contenu de la DÉCLARATION de rétractation en ligne (D221-5, II) — reprend la substance du
 * modèle de l'annexe R221-1 (déclaration dénuée d'ambiguïté), complétée des faits réels.
 */
export function retractationDeclarationLines(input: RetractationDeclarationInput): string[] {
  return [
    `À l'attention de ${input.companyName} :`,
    `Je vous notifie par la présente ma rétractation du contrat portant sur la prestation de services objet du devis n° ${input.quoteNumber}.`,
    `Nom du consommateur : ${input.declarantName}`,
    `Accusé de réception demandé par courrier électronique à : ${input.acknowledgmentEmail}`,
    `Déclaration envoyée le ${formatInstantFrParis(input.sentAt)}.`,
  ];
}

/**
 * ACCUSÉ DE RÉCEPTION de la rétractation, sur support durable (art. D221-5, IV : il mentionne
 * le contenu de la déclaration ainsi que la date et l'heure de son envoi).
 */
export function retractationAcknowledgmentLines(input: RetractationDeclarationInput): string[] {
  return [
    'Accusé de réception de votre rétractation',
    `${input.companyName} accuse réception de votre déclaration de rétractation, envoyée le ${formatInstantFrParis(input.sentAt)}, dont le contenu suit :`,
    ...retractationDeclarationLines(input),
    'Votre rétractation a bien été enregistrée. Les paiements éventuellement reçus vous seront remboursés dans les conditions rappelées par l’avis d’information sur le droit de rétractation (au plus tard quatorze jours après réception de la présente déclaration, art. L221-24 du code de la consommation).',
  ];
}
