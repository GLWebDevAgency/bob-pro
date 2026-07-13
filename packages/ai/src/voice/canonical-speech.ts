/**
 * Contrat isomorphe de parole canonique.
 *
 * Ce module ne décide pas comment une phrase est synthétisée. Il qualifie le texte AVANT
 * qu'un hôte choisisse son canal audio : seules quelques phrases statiques, comparées octet
 * pour octet, sont `fixed_safe`. Toute autre parole est `dynamic_sensitive`, même si aucun
 * fait connu n'y est détecté. Une absence de fait n'est donc jamais une preuve d'innocuité.
 *
 * Le digest cryptographique est volontairement absent de ce package framework-free. L'hôte
 * serveur doit sérialiser l'enveloppe puis calculer/sign-er son digest dans son adaptateur
 * cryptographique ; le client ne constitue jamais une autorité de digest.
 */

export const CANONICAL_SPEECH_VERSION = 1 as const;

/**
 * Phrases sans donnée métier pouvant utiliser un artefact audio pré-calculé.
 *
 * Ne pas ajouter ici de confirmation (« fait », « payé », « envoyé ») : même sans montant,
 * elle attesterait une mutation métier. L'égalité est intentionnellement stricte ; une espace,
 * une apostrophe différente ou un caractère de contrôle ferme le chemin sûr.
 */
export const FIXED_SAFE_SPEECH = Object.freeze({
  listening: 'Je t’écoute.',
  checking: 'Je vérifie.',
} as const);

export type FixedSafeSpeechId = keyof typeof FIXED_SAFE_SPEECH;
export type CanonicalSpeechClassification = 'fixed_safe' | 'dynamic_sensitive';

export const CANONICAL_SPEECH_FACT_KINDS = [
  'number',
  'amount',
  'percentage',
  'date',
  'document_reference',
  'siren',
  'siret',
  'vat_number',
  'iban',
  'email',
  'phone',
  'business_status',
] as const;

export type CanonicalSpeechFactKind = (typeof CANONICAL_SPEECH_FACT_KINDS)[number];

/** Un fait minimal et normalisé. La source complète reste `canonicalText`, sans duplication PII. */
export interface CanonicalSpeechFact {
  readonly kind: CanonicalSpeechFactKind;
  readonly normalized: string;
}

export interface CanonicalSpeechEnvelope {
  readonly version: typeof CANONICAL_SPEECH_VERSION;
  /** Texte exact demandé par le cerveau ; il est conservé pour l'audit et la synthèse. */
  readonly text: string;
  /** Forme déterministe assainie, destinée à l'extraction et au calcul de digest par l'hôte. */
  readonly canonicalText: string;
  readonly classification: CanonicalSpeechClassification;
  readonly fixedPhraseId?: FixedSafeSpeechId;
  readonly facts: readonly CanonicalSpeechFact[];
}

const FIXED_SAFE_ENTRIES = Object.entries(FIXED_SAFE_SPEECH) as readonly (readonly [FixedSafeSpeechId, string])[];

/** Les contrôles/formats ne doivent ni survivre à l'audit, ni recoller deux mots. */
function canonicalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function searchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function normalizedDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function normalizeInteger(value: string): string {
  const stripped = value.replace(/^0+(?=\d)/, '');
  return stripped === '' ? '0' : stripped;
}

/**
 * Normalise un nombre sans conversion IEEE-754 afin de ne jamais perdre de chiffres.
 * La dernière virgule/point est décimale quand elle est suivie de 1 ou 2 chiffres ; sinon
 * les séparateurs sont des groupements de milliers (convention des sorties Bob en euros).
 */
function normalizeDecimal(value: string): string | null {
  let compact = value.replace(/[\s\u00a0\u202f']/gu, '');
  const sign = compact.startsWith('-') ? '-' : '';
  compact = compact.replace(/^[+-]/, '');
  if (!/^\d[\d.,]*$/u.test(compact)) return null;

  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  const separatorIndex = Math.max(lastComma, lastDot);
  let integer = compact;
  let fraction = '';
  if (separatorIndex >= 0) {
    const candidateFraction = compact.slice(separatorIndex + 1);
    if (/^\d{1,2}$/u.test(candidateFraction)) {
      integer = compact.slice(0, separatorIndex);
      fraction = candidateFraction;
    }
  }
  integer = normalizeInteger(integer.replace(/[.,]/gu, ''));
  if (!/^\d+$/u.test(integer)) return null;
  const normalizedFraction = fraction.replace(/0+$/u, '');
  const normalized = normalizedFraction === '' ? integer : `${integer}.${normalizedFraction}`;
  return normalized === '0' ? '0' : `${sign}${normalized}`;
}

function normalizePercentage(value: string): string | null {
  const normalized = normalizeDecimal(value.replace(/%/gu, ''));
  return normalized === null ? null : `${normalized}%`;
}

function validIsoDate(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  if (day > (days[month - 1] ?? 0)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  janvier: 1,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
});

const STATUS_PATTERNS: readonly {
  readonly normalized: string;
  readonly pattern: RegExp;
}[] = [
  { normalized: 'partially_paid', pattern: /\bpartiellement\s+(?:paye|payee|payes|payees)\b/gu },
  { normalized: 'pending', pattern: /\ben\s+attente\b/gu },
  { normalized: 'late', pattern: /\ben\s+retard\b/gu },
  { normalized: 'to_pay', pattern: /\ba\s+payer\b/gu },
  { normalized: 'in_progress', pattern: /\ben\s+cours\b/gu },
  { normalized: 'paid', pattern: /\b(?:paye|payee|payes|payees|encaisse|encaissee|encaisses|encaissees|regle|reglee|regles|reglees)\b/gu },
  { normalized: 'unpaid', pattern: /\b(?:impaye|impayee|impayes|impayees)\b/gu },
  { normalized: 'overdue', pattern: /\b(?:echu|echue|echus|echues)\b/gu },
  { normalized: 'draft', pattern: /\bbrouillon\b/gu },
  { normalized: 'issued', pattern: /\b(?:emis|emise|emises)\b/gu },
  { normalized: 'sent', pattern: /\b(?:envoye|envoyee|envoyes|envoyees)\b/gu },
  { normalized: 'viewed', pattern: /\b(?:consulte|consultee|consultes|consultees)\b/gu },
  { normalized: 'signed', pattern: /\b(?:signe|signee|signes|signees)\b/gu },
  { normalized: 'refused', pattern: /\b(?:refuse|refusee|refuses|refusees)\b/gu },
  { normalized: 'expired', pattern: /\b(?:expire|expiree|expires|expirees)\b/gu },
  { normalized: 'cancelled', pattern: /\b(?:annule|annulee|annules|annulees)\b/gu },
  { normalized: 'archived', pattern: /\b(?:archive|archivee|archives|archivees)\b/gu },
  { normalized: 'active', pattern: /\b(?:actif|active|actifs|actives)\b/gu },
  { normalized: 'deleted', pattern: /\b(?:supprime|supprimee|supprimes|supprimees)\b/gu },
  { normalized: 'closed', pattern: /\b(?:cloture|cloturee|clotures|cloturees)\b/gu },
  { normalized: 'validated', pattern: /\b(?:valide|validee|valides|validees)\b/gu },
  { normalized: 'posted', pattern: /\b(?:comptabilise|comptabilisee|comptabilises|comptabilisees)\b/gu },
];

const IBAN_LENGTH_BY_COUNTRY: Readonly<Record<string, number>> = Object.freeze({
  AT: 20,
  BE: 16,
  CH: 21,
  DE: 22,
  ES: 24,
  FR: 27,
  GB: 22,
  IE: 22,
  IT: 27,
  LU: 20,
  NL: 18,
  PT: 25,
});

function hasValidIbanChecksum(candidate: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(candidate)) return false;
  const rearranged = candidate.slice(4) + candidate.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const encoded = /\d/u.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of encoded) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function extractIbans(text: string): string[] {
  const upper = text.toUpperCase();
  const values: string[] = [];
  const starts = upper.matchAll(/\b[A-Z]{2}\s*\d{2}/gu);
  for (const match of starts) {
    if (match.index === undefined) continue;
    const tail = /^[A-Z]{2}\s*\d{2}(?:[\s-]*[A-Z0-9]){11,40}/u.exec(upper.slice(match.index))?.[0];
    if (!tail) continue;
    const compact = tail.replace(/[^A-Z0-9]/gu, '');
    const country = compact.slice(0, 2);
    const expectedLength = IBAN_LENGTH_BY_COUNTRY[country];
    const lengths = expectedLength === undefined
      ? Array.from({ length: 20 }, (_, index) => index + 15)
      : [expectedLength];
    for (const length of lengths) {
      const candidate = compact.slice(0, length);
      if (candidate.length === length && hasValidIbanChecksum(candidate)) {
        values.push(candidate);
        break;
      }
    }
  }
  return values;
}

function addFact(
  facts: Map<string, CanonicalSpeechFact>,
  kind: CanonicalSpeechFactKind,
  normalized: string | null | undefined,
): void {
  if (!normalized) return;
  const key = `${kind}\u0000${normalized}`;
  if (!facts.has(key)) facts.set(key, Object.freeze({ kind, normalized }));
}

/** Extraction déterministe : elle enrichit l'audit, mais ne pilote jamais le classement sûr. */
export function extractCanonicalSpeechFacts(text: string): readonly CanonicalSpeechFact[] {
  const canonicalText = canonicalizeText(text);
  const facts = new Map<string, CanonicalSpeechFact>();

  for (const match of canonicalText.matchAll(/(?:€|EUR)\s*([+-]?\d(?:[\d\s\u00a0\u202f'.,]*\d)?)/giu)) {
    const normalized = match[1] === undefined ? null : normalizeDecimal(match[1]);
    addFact(facts, 'amount', normalized === null ? null : `EUR:${normalized}`);
  }
  for (const match of canonicalText.matchAll(/([+-]?\d(?:[\d\s\u00a0\u202f'.,]*\d)?)\s*(?:€|EUR\b|euros?\b)/giu)) {
    const normalized = match[1] === undefined ? null : normalizeDecimal(match[1]);
    addFact(facts, 'amount', normalized === null ? null : `EUR:${normalized}`);
  }
  for (const match of canonicalText.matchAll(/([+-]?\d+(?:[.,]\d+)?)\s*%/gu)) {
    addFact(facts, 'percentage', match[1] === undefined ? null : normalizePercentage(match[1]));
  }

  for (const match of canonicalText.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/gu)) {
    addFact(facts, 'date', validIsoDate(Number(match[1]), Number(match[2]), Number(match[3])));
  }
  for (const match of canonicalText.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/gu)) {
    addFact(facts, 'date', validIsoDate(Number(match[3]), Number(match[2]), Number(match[1])));
  }
  const searchable = searchText(canonicalText);
  for (const match of searchable.matchAll(/\b(\d{1,2})(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})\b/gu)) {
    const month = match[2] === undefined ? undefined : MONTHS[match[2]];
    addFact(facts, 'date', month === undefined ? null : validIsoDate(Number(match[3]), month, Number(match[1])));
  }

  for (const match of canonicalText.matchAll(/\b(?:FAC(?:TURE)?|DEV(?:IS)?|AV(?:OIR)?|[DFA])[-\s]?\d{4}[-/]\d{2,}\b/giu)) {
    addFact(facts, 'document_reference', match[0].replace(/\s/gu, '').replace(/\//gu, '-').toUpperCase());
  }
  for (const match of canonicalText.matchAll(/\b(?:facture|devis|avoir|ticket|document|pi[eè]ce|bon(?:\s+de\s+commande)?)\s*(?:n(?:°|o)?\s*)?[:#-]?\s*((?:[A-Z]{1,5}[-\s]?)?\d{4}[-/]\d{2,})\b/giu)) {
    addFact(facts, 'document_reference', match[1]?.replace(/\s/gu, '').replace(/\//gu, '-').toUpperCase());
  }

  for (const match of canonicalText.matchAll(/\bSIRET\s*:?[\s-]*((?:\d[\s.-]*){14})\b/giu)) {
    const value = match[1] === undefined ? '' : normalizedDigits(match[1]);
    addFact(facts, 'siret', value.length === 14 ? value : null);
  }
  for (const match of canonicalText.matchAll(/\bSIREN\s*:?[\s-]*((?:\d[\s.-]*){9})\b/giu)) {
    const value = match[1] === undefined ? '' : normalizedDigits(match[1]);
    addFact(facts, 'siren', value.length === 9 ? value : null);
  }
  for (const match of canonicalText.matchAll(/\b(?:TVA(?:\s+intracommunautaire)?\s*:?[\s-]*)?(FR[\s.-]*[A-Z0-9]{2}(?:[\s.-]*\d){9})\b/giu)) {
    const value = match[1]?.replace(/[^A-Z0-9]/giu, '').toUpperCase();
    addFact(facts, 'vat_number', value?.length === 13 ? value : null);
  }
  for (const iban of extractIbans(canonicalText)) addFact(facts, 'iban', iban);

  for (const match of canonicalText.matchAll(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/giu)) {
    addFact(facts, 'email', match[0].toLowerCase());
  }
  for (const match of canonicalText.matchAll(/(?:\+33|0033|0)[\s().-]*[1-9](?:[\s().-]*\d{2}){4}\b/gu)) {
    const digits = normalizedDigits(match[0]);
    const normalized = match[0].trimStart().startsWith('+33') || match[0].trimStart().startsWith('0033')
      ? `+33${digits.slice(-9)}`
      : `+33${digits.slice(1)}`;
    addFact(facts, 'phone', normalized.length === 12 ? normalized : null);
  }

  const occupiedStatusRanges: { start: number; end: number }[] = [];
  for (const status of STATUS_PATTERNS) {
    for (const match of searchable.matchAll(status.pattern)) {
      if (match.index === undefined) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (occupiedStatusRanges.some((range) => start < range.end && end > range.start)) continue;
      occupiedStatusRanges.push({ start, end });
      addFact(facts, 'business_status', status.normalized);
    }
  }

  // Tous les lexèmes numériques sont conservés en plus des faits spécialisés. Cette redondance
  // permet à l'auditeur acoustique de détecter un chiffre inventé, y compris dans un identifiant.
  for (const match of canonicalText.matchAll(/[+-]?\d+(?:[\s\u00a0\u202f'.,]\d+)*/gu)) {
    addFact(facts, 'number', normalizeDecimal(match[0]));
  }

  return Object.freeze([...facts.values()]);
}

export function isFixedSafeSpeech(text: string): text is (typeof FIXED_SAFE_SPEECH)[FixedSafeSpeechId] {
  return FIXED_SAFE_ENTRIES.some(([, phrase]) => text === phrase);
}

export function createCanonicalSpeechEnvelope(text: string): CanonicalSpeechEnvelope {
  const fixedEntry = FIXED_SAFE_ENTRIES.find(([, phrase]) => text === phrase);
  const canonicalText = canonicalizeText(text);
  const facts = extractCanonicalSpeechFacts(canonicalText);
  return Object.freeze({
    version: CANONICAL_SPEECH_VERSION,
    text,
    canonicalText,
    classification: fixedEntry === undefined ? 'dynamic_sensitive' : 'fixed_safe',
    ...(fixedEntry === undefined ? {} : { fixedPhraseId: fixedEntry[0] }),
    facts,
  });
}
