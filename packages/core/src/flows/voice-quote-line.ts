/**
 * Ligne de devis DICTÉE (S2-GUIDÉ) — « ajoute deux heures de main-d'œuvre à 55 euros de
 * l'heure » devient une ligne prête pour la machine devis : catégorie INFÉRÉE (main-d'œuvre /
 * fourniture / déplacement), quantité, prix énoncé, TVA énoncée sinon métier, libellé formaté.
 * CATALOGUE D'ABORD : une prestation enregistrée par l'artisan qui matche l'énoncé fournit
 * libellé/catégorie/prix/TVA (le prix ou la TVA énoncés priment). AMBIGUÏTÉ → question,
 * jamais un choix silencieux ; PRIX MANQUANT hors catalogue → demande, JAMAIS un prix inventé.
 * Pur et testé : la voix n'est qu'un canal, la machine devis reste la seule vérité.
 */
import { type LineCategory } from '../domain/billing/shared/line-item';
import { type VatRate } from '../domain/billing/shared/vat-rate';
import {
  matchSpokenPrestations,
  normalizeVoiceText,
  parseSpokenLaborDuration,
  parseSpokenVatRate,
  type VoicePrestation,
} from './voice-invoice-draft';

export interface ParsedQuoteLine {
  readonly label: string;
  readonly category: LineCategory;
  readonly qty: number;
  /** Prix unitaire HT en centimes — énoncé ou repris du catalogue, jamais inventé. */
  readonly unitPriceHT: number;
  readonly vatRate: VatRate;
  readonly source: 'catalogue' | 'dictee';
}

export type ParseQuoteLineResult =
  | { readonly kind: 'line'; readonly line: ParsedQuoteLine }
  | { readonly kind: 'ambiguous'; readonly options: readonly string[] }
  | { readonly kind: 'missing_price'; readonly label: string; readonly qty: number }
  | { readonly kind: 'none' };

/**
 * Nombres français EN TOUTES LETTRES → chiffres (« cinquante-cinq euros » → « 55 euros ») :
 * la dictée STT rend souvent les nombres en mots. Conversion sur une COPIE réservée à
 * l'extraction quantité/prix/TVA — le libellé et le matching catalogue/client gardent le
 * texte original (« Second Œuvre » ne devient jamais « 2 Œuvre »).
 */
const FR_UNITS: Readonly<Record<string, number>> = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8,
  neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
};
const FR_TENS: Readonly<Record<string, number>> = {
  vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
};

export function frSpokenNumbersToDigits(normalized: string): string {
  const tokens = normalized.trim().split(/\s+/);
  const out: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    const isNumberWord = (w: string | undefined): boolean =>
      w !== undefined && (w in FR_UNITS || w in FR_TENS || w === 'cent' || w === 'cents' || w === 'mille' || w === 'et');
    if (!isNumberWord(token) || token === 'et') {
      out.push(token);
      index += 1;
      continue;
    }
    // Consomme la séquence de mots-nombres contiguë et l'évalue (total/current à la française).
    let total = 0;
    let current = 0;
    let consumed = 0;
    while (index + consumed < tokens.length) {
      const w = tokens[index + consumed]!;
      if (w === 'et') {
        if (!isNumberWord(tokens[index + consumed + 1])) break;
        consumed += 1;
        continue;
      }
      if (w === 'quatre' && (tokens[index + consumed + 1] === 'vingt' || tokens[index + consumed + 1] === 'vingts')) {
        current += 80;
        consumed += 2;
        continue;
      }
      if (w in FR_TENS) {
        current += FR_TENS[w]!;
        consumed += 1;
        continue;
      }
      if (w in FR_UNITS) {
        current += FR_UNITS[w]!;
        consumed += 1;
        continue;
      }
      if (w === 'cent' || w === 'cents') {
        current = (current === 0 ? 1 : current) * 100;
        consumed += 1;
        continue;
      }
      if (w === 'mille') {
        total += (current === 0 ? 1 : current) * 1000;
        current = 0;
        consumed += 1;
        continue;
      }
      break;
    }
    out.push(String(total + current));
    index += consumed;
  }
  return ` ${out.join(' ')} `;
}

const QTY_WORDS: Readonly<Record<string, number>> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
};

const QTY_RE = /(?:^| )(\d{1,3}(?:[.,]5)?|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix) (heures?|h(?= )|jours?|unites?|fois|pieces?)/;
const EXPLICIT_QTY_RE = /quantite (\d{1,3})/;
const MONEY_RE = /(\d(?:[\d ]*\d)?)(?:,(\d{1,2}))?\s*(?:€|euros?\b)/;
const LABOR_RE = /(main d oeuvre|pose|installation|depannage|reparation|heures? de|intervention)/;
const TRAVEL_RE = /(deplacement|kilometr|frais de route)/;
const SUPPLY_RE = /(fourniture|materiel|piece|produit|litres?|chauffe eau|remplacement de)/;

function parseQty(normalized: string): { qty: number; unit: string | null } {
  const explicit = EXPLICIT_QTY_RE.exec(normalized);
  if (explicit?.[1] !== undefined) return { qty: Number(explicit[1]), unit: null };
  const m = QTY_RE.exec(normalized);
  if (!m || m[1] === undefined) return { qty: 1, unit: null };
  const raw = m[1].replace(',', '.');
  const qty = QTY_WORDS[raw] ?? Number(raw);
  return Number.isFinite(qty) && qty > 0 ? { qty, unit: m[2] ?? null } : { qty: 1, unit: null };
}

interface SpokenPrice {
  readonly cents: number;
  /** « à 55 € (de l'heure) » = unitaire ; « pour 110 € (au total|en tout) » = total. */
  readonly scope: 'unit' | 'total';
}

function parseSpokenPrice(normalized: string): SpokenPrice | null {
  const m = MONEY_RE.exec(normalized);
  if (!m || m[1] === undefined) return null;
  const int = Number(m[1].replace(/\s+/g, ''));
  const dec = m[2] !== undefined ? Number(m[2].padEnd(2, '0')) : 0;
  if (!Number.isFinite(int) || int <= 0) return null;
  const before = normalized.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
  const after = normalized.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 16);
  // Le marqueur UNITAIRE explicite (« de l'heure », « par heure », « l'unité ») PRIME sur
  // « pour » : « 2 heures pour 110 € de l'heure » est un prix unitaire.
  const explicitUnit = /^(?:\s*(?:de l ?heure|par heure|l ?unite|la piece|piece))/.test(after);
  const explicitTotal = /(au total|en tout)/.test(after) || /(au total|en tout)/.test(before);
  const forTotal = /\bpour $/.test(before);
  return {
    cents: int * 100 + dec,
    scope: explicitUnit ? 'unit' : explicitTotal || forTotal ? 'total' : 'unit',
  };
}

function inferCategory(normalized: string, unit: string | null): LineCategory {
  if (unit !== null && /^h/.test(unit)) return 'labor';
  if (LABOR_RE.test(normalized)) return 'labor';
  if (TRAVEL_RE.test(normalized)) return 'travel';
  if (SUPPLY_RE.test(normalized)) return 'supply';
  // Article discret (« un chauffe-eau », « trois radiateurs ») sans indice de main-d'œuvre :
  // c'est un BIEN → fourniture. Le reste (« développement de l'app ») est une prestation.
  if (unit !== null && /^(unites?|pieces?)/.test(unit)) return 'supply';
  return 'labor';
}

/** Libellé propre : l'énoncé sans les verbes de commande, quantités, montants et TVA. */
function cleanLabel(utterance: string): string {
  const stripped = utterance
    .replace(/^\s*(ajoute[rz]?|rajoute[rz]?|mets?|met|ajout de|une ligne)\s+/i, '')
    .replace(/\b(\d{1,3}(?:[.,]\d{1,2})?|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+(heures?|h\b|jours?|unités?|unites?|fois|pièces?|pieces?)\s*(de|d['’])?\s*/gi, '')
    .replace(/\bquantit[ée] \d{1,3}\b/gi, '')
    .replace(/\b(?:à|a|pour)?\s*(?:(?:vingt|trente|quarante|cinquante|soixante|cent|cents|mille|et|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize)[\s-]*)+euros?\b(?:\s*(?:au total|en tout|de l['’]heure|par heure))?/gi, '')
    .replace(/\b(?:à|a)?\s*\d[\d ]*(?:,\d{1,2})?\s*(?:€|euros?)\s*(de l['’]heure|par heure|l['’]unité|pièce|piece)?/gi, '')
    .replace(/\btva (?:à |a |de )?\d{1,2}(?:,\d)? ?%?/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
    .trim();
  if (!stripped) return '';
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export interface ParseVoiceQuoteLineOptions {
  readonly prestations?: readonly VoicePrestation[];
  /** Taux métier (TradeConfig) si rien d'énoncé — sinon 20. */
  readonly defaultVatRate?: VatRate;
}

export function parseVoiceQuoteLine(
  utterance: string,
  options: ParseVoiceQuoteLineOptions = {},
): ParseQuoteLineResult {
  const normalized = normalizeVoiceText(utterance);
  if (normalized.trim() === '') return { kind: 'none' };

  // Copie chiffrée pour l'extraction — le texte original reste roi pour libellé/catalogue.
  const digits = frSpokenNumbersToDigits(normalized);
  const { qty, unit } = parseQty(digits);
  const spokenVat = parseSpokenVatRate(digits);
  const priceSpoken = parseSpokenPrice(digits);
  // « 2 heures pour 110 € au total » : le TOTAL se divise EXACTEMENT ou on redemande —
  // un prix unitaire ne s'arrondit jamais en silence (110/2 = 55 ✓ ; 100/3 → question).
  const indivisibleTotal =
    priceSpoken !== null && priceSpoken.scope === 'total' && qty > 1 && priceSpoken.cents % qty !== 0;
  const spokenPrice =
    priceSpoken === null || indivisibleTotal
      ? null
      : priceSpoken.scope === 'unit' || qty <= 1
        ? priceSpoken.cents
        : priceSpoken.cents / qty;

  // 1) CATALOGUE D'ABORD — la vérité de l'artisan prime sur toute inférence.
  const matches = matchSpokenPrestations(normalized, options.prestations ?? []);
  if (indivisibleTotal) {
    // Un total ÉNONCÉ qui ne se divise pas exactement : on clarifie — le prix du catalogue
    // ne remplace JAMAIS un montant dit par l'artisan.
    const label = matches.length === 1 ? matches[0]!.label : cleanLabel(utterance);
    return { kind: 'missing_price', label: label || 'cette prestation', qty };
  }
  if (matches.length > 1) return { kind: 'ambiguous', options: matches.map((p) => p.label) };
  const fromCatalogue = matches[0];
  if (fromCatalogue) {
    return {
      kind: 'line',
      line: {
        label: fromCatalogue.label,
        category: fromCatalogue.category,
        qty,
        unitPriceHT: spokenPrice ?? fromCatalogue.unitPriceHT,
        vatRate: spokenVat ?? fromCatalogue.vatRate,
        source: 'catalogue',
      },
    };
  }

  // 2) Dictée libre — un prix énoncé est OBLIGATOIRE (jamais inventé).
  const category = inferCategory(normalized, unit);
  let label = cleanLabel(utterance);
  if (label === '' && category === 'labor') {
    const duration = parseSpokenLaborDuration(normalized);
    label = duration !== null ? `Main-d’œuvre ${duration}` : 'Main-d’œuvre';
  }
  if (label === '') return { kind: 'none' };
  if (spokenPrice === null) return { kind: 'missing_price', label, qty };

  return {
    kind: 'line',
    line: {
      label,
      category,
      qty,
      unitPriceHT: spokenPrice,
      vatRate: spokenVat ?? options.defaultVatRate ?? 20,
      source: 'dictee',
    },
  };
}
