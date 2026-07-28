import { isValidDateOnly } from '@bob/core';

/**
 * PR-12c [parité vocale §2.7] — lecture en UNE passe des faits d'une consigne de CONTRAT
 * dictée dans le désordre : « fais-moi le contrat fontaines RATP, 3 fontaines, 1 200 € par an,
 * ça démarre au 1er octobre, 2 passages ». Module PUR (zéro I/O, zéro état) : la résolution du
 * client, du site et des équipements contre les données RÉELLES reste à l'agent — ici on ne lit
 * que ce qui a été DIT, et un fait illisible reste `null` (jamais deviné).
 */

const FRENCH_MONTHS: readonly string[] = [
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
];

const MONTH_ALTERNATION = FRENCH_MONTHS.join('|');

/** Espaces de MILLIERS réellement produits par un clavier/une dictée FR (fine, insécable). */
const THOUSAND_GAP = '[\\s\\u00a0\\u202f]';

/**
 * Montant en euros dit — le séparateur de MILLIERS est LU (« 1 200 € » vaut 1 200 €, jamais
 * 200 € : la troncature silencieuse ferait naître un contrat à un sixième de son prix).
 * Décimales optionnelles (« 1 200,50 € »). Retourne des centimes ; null si rien de lisible.
 */
export function extractSpokenEuroCents(text: string): number | null {
  const match = new RegExp(
    `(\\d{1,3}(?:${THOUSAND_GAP}\\d{3})+|\\d+)(?:[.,](\\d{1,2}))?\\s*(?:€|euros?\\b|eur\\b)`,
    'i',
  ).exec(text);
  if (match?.[1] === undefined) return null;
  const units = Number(match[1].replace(new RegExp(THOUSAND_GAP, 'g'), ''));
  const decimals = match[2] === undefined ? 0 : Number(match[2].padEnd(2, '0'));
  const cents = Math.round(units * 100) + decimals;
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

function validated(candidate: string): string | null {
  return isValidDateOnly(candidate) ? candidate : null;
}

/**
 * Date de DÉMARRAGE dite (« ça démarre au 1er octobre », « à partir du 01/10/2026 »,
 * « 2026-10-01 »). Sans année dite, l'année retenue est la PROCHAINE occurrence ≥ `today`
 * (une couverture démarre, elle ne rétroagit pas) ; la date complète est RÉCITÉE à la
 * confirmation groupée — jamais une année supposée en silence. `today` absent ⇒ une date sans
 * année reste illisible (null) plutôt qu'inventée.
 */
export function extractSpokenStartDate(text: string, today: string | null): string | null {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(normalized);
  if (iso) return validated(`${iso[1]}-${iso[2]}-${iso[3]}`);
  const slash = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(normalized);
  if (slash) return validated(`${slash[3]}-${pad2(Number(slash[2]))}-${pad2(Number(slash[1]))}`);
  const spokenWithYear = new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${MONTH_ALTERNATION})\\s+(\\d{4})\\b`).exec(
    normalized,
  );
  if (spokenWithYear) {
    const monthIndex = FRENCH_MONTHS.indexOf(spokenWithYear[2]!);
    return validated(
      `${spokenWithYear[3]}-${pad2(monthIndex + 1)}-${pad2(Number(spokenWithYear[1]))}`,
    );
  }
  const spoken = new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${MONTH_ALTERNATION})\\b`).exec(normalized);
  if (spoken === null || today === null || !isValidDateOnly(today)) return null;
  const monthIndex = FRENCH_MONTHS.indexOf(spoken[2]!);
  const day = pad2(Number(spoken[1]));
  const thisYear = validated(`${today.slice(0, 4)}-${pad2(monthIndex + 1)}-${day}`);
  if (thisYear !== null && thisYear >= today) return thisYear;
  return validated(`${Number(today.slice(0, 4)) + 1}-${pad2(monthIndex + 1)}-${day}`);
}

/** Caractères de CONTRÔLE interdits par le domaine (motif de résiliation, `\p{Cc}`) —
 * neutralisés avant de porter la phrase du pro en trace : jamais un refus technique sur un
 * artefact de dictée. */
export function sanitizeSpokenNote(text: string): string {
  return text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
}

export interface SpokenContractFacts {
  /** Libellé LIBRE du contrat (« Fontaines RATP ») — jamais un lexique métier codé. */
  label: string | null;
  /** Montant ANNUEL HT dit, en centimes (« 1 200 € par an ») — la ligne unique du contrat. */
  annualAmountCents: number | null;
  /** Périodicité dite (« 2 passages », « 2 visites par an ») — jamais un défaut inventé ici. */
  visitsPerYear: number | null;
  /** Reconduction tacite REFUSÉE explicitement (« sans reconduction tacite ») ; null = non dit. */
  tacitRenewal: boolean | null;
  /** Démarrage dit → date anniversaire du contrat. */
  startDate: string | null;
  /** Nombre d'équipements ANNONCÉ (« ils ont 3 machines ») — sert à DIRE honnêtement l'écart
   * avec ce que le parc réel porte, jamais à inventer un équipement. */
  equipmentCount: number | null;
}

/** Mots de GESTE d'une consigne de contrat — retirés du libellé lu (« fais-moi le contrat
 * fontaines RATP » a pour libellé « fontaines RATP », jamais « fais-moi le contrat… »). */
const LABEL_LEADING = /^(?:de\s+maintenance\s+)?(?:pour\s+)?(?:le\s+|la\s+|les\s+|l\W\s*|un\s+|une\s+|du\s+|des\s+|de\s+|d\W\s*)*/i;

/**
 * Libellé dit : le segment qui SUIT le mot « contrat », borné à la première ponctuation forte.
 * La forme canonique des followUps guillemette le libellé — elle est lue en priorité, ce qui
 * fait CONVERGER les tours suivants (le libellé ne se reconstruit jamais deux fois autrement).
 */
export function extractSpokenContractLabel(message: string): string | null {
  const quoted = /contrats?\s+«\s*([^»]{2,80})\s*»/i.exec(message);
  const raw =
    quoted?.[1] ??
    /contrats?\s+([^,;.!?()«»]{2,80})/i.exec(message)?.[1] ??
    null;
  if (raw === null) return null;
  const stripped = raw
    .replace(LABEL_LEADING, '')
    // Faits déjà lus ailleurs : ils ne polluent jamais le libellé.
    .replace(new RegExp(`\\d[\\d${THOUSAND_GAP}.,]*\\s*(?:€|euros?|eur)\\b.*$`, 'i'), '')
    .replace(/\b(?:a\s+partir\s+du?|des\s+le|ca\s+demarre|demarre|demarrage)\b.*$/i, '')
    .replace(/\b\d{1,2}\s*(?:visites?|passages?)\b.*$/i, '')
    .replace(/\bpour\s+le\s+client\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-–—:,;]+$/, '')
    .trim();
  if (stripped.length < 2) return null;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Lecture en UNE passe de tous les faits énoncés (aucune question tant qu'il ne manque rien). */
export function extractSpokenContractFacts(
  message: string,
  today: string | null,
): SpokenContractFacts {
  const normalized = message
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  const visits = /\b(\d{1,2})\s*(?:visites?|passages?|interventions?)\b/.exec(normalized);
  const visitsPerYear =
    visits?.[1] !== undefined && Number(visits[1]) >= 0 && Number(visits[1]) <= 52
      ? Number(visits[1])
      : null;
  // Équipements ANNONCÉS : le nom de la machine est LIBRE (« 3 machines », « 3 fontaines »,
  // « 2 ascenseurs ») — aucun lexique matériel codé. Les unités de la consigne (passages,
  // euros, durées) sont exclues : elles ne comptent jamais des équipements.
  const equipments =
    /\b(\d{1,3})\s+(?!visites?|passages?|interventions?|euros?|eur\b|ans?\b|annees?|mois\b|jours?|semaines?|fois\b|heures?)([\p{L}]{4,})/u.exec(
      normalized,
    );
  const tacitRefused = /\bsans\s+(?:reconduction|renouvellement)\s+tacite\b|\bnon\s+tacite\b|\bpas\s+de\s+(?:reconduction|renouvellement)\s+tacite\b/.test(
    normalized,
  );
  return {
    label: extractSpokenContractLabel(message),
    annualAmountCents: extractSpokenEuroCents(message),
    visitsPerYear,
    tacitRenewal: tacitRefused ? false : null,
    startDate: extractSpokenStartDate(message, today),
    equipmentCount:
      equipments?.[1] !== undefined && Number(equipments[1]) > 0 ? Number(equipments[1]) : null,
  };
}

/**
 * Motif de RÉSILIATION dit — trace légale de la décision (le domaine l'exige). Un motif
 * explicite (« motif : … », « parce que … ») prime ; sinon la PHRASE DITE fait la trace : ce
 * que le pro a énoncé EST la décision, jamais un motif inventé à sa place.
 */
export function extractSpokenTerminationNote(message: string): string | null {
  const explicit =
    /\bmotifs?\s*:\s*([^.;!?]{2,200})/i.exec(message)?.[1] ??
    /\b(?:parce\s+qu(?:e|’|')\s*|car\s+|raisons?\s*:\s*)([^.;!?]{2,200})/i.exec(message)?.[1] ??
    null;
  const note = sanitizeSpokenNote(explicit ?? message).slice(0, 200).trim();
  return note.length >= 2 ? note : null;
}
