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

function parseUnitPriceCents(normalized: string): number | null {
  const m = MONEY_RE.exec(normalized);
  if (!m || m[1] === undefined) return null;
  const int = Number(m[1].replace(/\s+/g, ''));
  const dec = m[2] !== undefined ? Number(m[2].padEnd(2, '0')) : 0;
  return Number.isFinite(int) && int > 0 ? int * 100 + dec : null;
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

  const { qty, unit } = parseQty(normalized);
  const spokenVat = parseSpokenVatRate(normalized);
  const spokenPrice = parseUnitPriceCents(normalized);

  // 1) CATALOGUE D'ABORD — la vérité de l'artisan prime sur toute inférence.
  const matches = matchSpokenPrestations(normalized, options.prestations ?? []);
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
