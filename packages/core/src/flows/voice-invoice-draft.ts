import { type LineInput, type LineCategory } from '../domain/billing/shared/line-item';
import { type VatRate, isVatRate } from '../domain/billing/shared/vat-rate';
import { type PaymentMethod } from '../domain/payment/payment';
import { type VoiceInvoiceDraft } from './voice-invoice';

/**
 * Dérivation PURE du brouillon « Facture à la voix » (C20) depuis un transcript FR :
 * client reconnu parmi les clients RÉELS, lignes chiffrées, TVA et moyen d'encaissement.
 * Règle d'or (DA §4) : on ne fabrique JAMAIS un montant — chaque centime vient d'un montant
 * énoncé. Convention (proto §voice) : un montant de ligne énoncé est HT ; « total X € TTC »
 * (ou un montant unique sans catégorie) est TTC et borne le document ; le reliquat HT devient
 * la ligne de main-d'œuvre/prestation. Zéro montant exploitable -> lines vide (voiceCaptured
 * refusera : l'état « rien compris » est un état de premier rang).
 */

export interface VoiceCustomerRef {
  readonly id: string;
  readonly name: string;
}

export interface DeriveVoiceInvoiceDraftInput {
  transcript: string;
  customers: readonly VoiceCustomerRef[];
  /** Taux métier (TradeConfig.defaultVatRate) si le transcript ne précise rien — sinon 20. */
  defaultVatRate?: number;
}

export interface VoiceInvoiceDerivation {
  draft: VoiceInvoiceDraft;
  /** Moyen d'encaissement entendu (« par carte », « en espèces ») — défaut virement. */
  paymentMethod: PaymentMethod;
  vatRate: VatRate;
}

/** minuscules + sans accents (œ -> oe) + ponctuation -> espaces, encadré d'espaces (mots entiers). */
function normalize(input: string): string {
  const flat = input
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/œ/gi, 'oe')
    .toLowerCase()
    .replace(/[^a-z0-9,€%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${flat} `;
}

/** Civilités et formes juridiques : jamais discriminantes pour reconnaître un client. */
const NAME_STOPWORDS = new Set([
  'mme', 'madame', 'monsieur', 'mlle', 'mademoiselle', 'docteur',
  'sarl', 'sas', 'sasu', 'sci', 'eurl', 'ste', 'societe', 'entreprise', 'ets',
]);

/** Reconnaît le client dont un mot du nom (≥ 3 lettres, hors civilités) est énoncé. */
function matchCustomer(normalized: string, customers: readonly VoiceCustomerRef[]): string | null {
  // La normalisation garde , € % pour les montants — ici on ne compare que des MOTS entiers.
  const words = ` ${normalized.replace(/[,€%]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  let best: { id: string; len: number } | null = null;
  for (const customer of customers) {
    const nameWords = normalize(customer.name)
      .split(' ')
      .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
    for (const word of nameWords) {
      if (words.includes(` ${word} `) && (best === null || word.length > best.len)) {
        best = { id: customer.id, len: word.length };
      }
    }
  }
  return best?.id ?? null;
}

type AmountKind = 'total' | 'supply' | 'travel' | 'labor' | 'other';

interface SpokenAmount {
  cents: number;
  kind: AmountKind;
}

const MONEY_RE = /(\d(?:[\d ]*\d)?)(?:,(\d{1,2}))?\s*(?:€|euros?\b)/g;

function classifyAmount(before: string, after: string): AmountKind {
  if (/(total|au total|en tout)/.test(before) || /^\s*ttc\b/.test(after)) return 'total';
  if (/(materiel|fourniture|piece)/.test(before)) return 'supply';
  if (/(deplacement|forfait)/.test(before)) return 'travel';
  if (/(main d oeuvre|main-d oeuvre|pose|heure)/.test(before)) return 'labor';
  return 'other';
}

function parseAmounts(normalized: string): SpokenAmount[] {
  const found: SpokenAmount[] = [];
  for (const m of normalized.matchAll(MONEY_RE)) {
    const int = Number((m[1] ?? '').replace(/\s+/g, ''));
    const dec = m[2] !== undefined ? Number(m[2].padEnd(2, '0')) : 0;
    if (!Number.isFinite(int) || int <= 0) continue;
    const before = normalized.slice(Math.max(0, (m.index ?? 0) - 32), m.index ?? 0);
    const after = normalized.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 8);
    found.push({ cents: int * 100 + dec, kind: classifyAmount(before, after) });
  }
  return found;
}

/** « TVA 10 » / « TVA à 5,5 % » énoncée -> taux légal, sinon null. */
function parseVatRate(normalized: string): VatRate | null {
  const m = /tva (?:a |de )?(\d{1,2}(?:,\d)?) ?%?/.exec(normalized);
  if (!m || m[1] === undefined) return null;
  const rate = Number(m[1].replace(',', '.'));
  return isVatRate(rate) ? rate : null;
}

function parsePaymentMethod(normalized: string): PaymentMethod {
  if (/( carte | cb )/.test(normalized)) return 'card';
  if (/( especes | liquide | cash )/.test(normalized)) return 'cash';
  return 'transfer';
}

/** Durée de main-d'œuvre énoncée (« 1h30 », « 2 heures ») — pour le libellé, jamais un prix. */
function parseLaborDuration(normalized: string): string | null {
  const m = /(\d{1,2}) ?h(?:eures?)? ?(\d{1,2})?/.exec(normalized);
  if (!m || m[1] === undefined) return null;
  return m[2] !== undefined ? `${m[1]}h${m[2].padStart(2, '0')}` : `${m[1]} h`;
}

const KIND_LINE: Partial<Record<AmountKind, { label: string; category: LineCategory }>> = {
  supply: { label: 'Fournitures / matériel', category: 'supply' },
  travel: { label: 'Déplacement', category: 'travel' },
  labor: { label: 'Main-d’œuvre', category: 'labor' },
  other: { label: 'Prestation', category: 'labor' },
};

export function deriveVoiceInvoiceDraft(input: DeriveVoiceInvoiceDraftInput): VoiceInvoiceDerivation {
  const transcript = input.transcript.trim();
  const normalized = normalize(transcript);
  const vatRate: VatRate =
    parseVatRate(normalized) ?? (input.defaultVatRate !== undefined && isVatRate(input.defaultVatRate) ? input.defaultVatRate : 20);
  const laborDuration = parseLaborDuration(normalized);
  const laborLabel = laborDuration !== null ? `Main-d’œuvre · ${laborDuration}` : 'Main-d’œuvre';

  const amounts = parseAmounts(normalized);
  let totalTtc = amounts.filter((a) => a.kind === 'total').at(-1)?.cents ?? null;
  let itemized = amounts.filter((a) => a.kind !== 'total');
  // « Facture de 300 € pour… » : un montant unique sans catégorie = le total TTC énoncé.
  if (totalTtc === null && itemized.length === 1 && itemized[0]?.kind === 'other') {
    totalTtc = itemized[0].cents;
    itemized = [];
  }

  const lines: LineInput[] = itemized.map((a) => {
    const spec = KIND_LINE[a.kind] ?? { label: 'Prestation', category: 'labor' as LineCategory };
    return {
      label: a.kind === 'labor' ? laborLabel : spec.label,
      category: spec.category,
      qty: 1,
      unitPriceHT: a.cents,
      vatRate,
    };
  });

  if (totalTtc !== null) {
    const totalHt = Math.round(totalTtc / (1 + vatRate / 100));
    const rest = totalHt - lines.reduce((sum, l) => sum + Math.round(l.qty * l.unitPriceHT), 0);
    // Le reliquat HT (couvert par le total énoncé) = main-d'œuvre/prestation — jamais inventé au-delà.
    if (rest > 0) {
      const hasLaborLine = lines.some((l) => l.category === 'labor');
      lines.push({
        label: hasLaborLine ? 'Prestation' : laborLabel,
        category: 'labor',
        qty: 1,
        unitPriceHT: rest,
        vatRate,
      });
    }
  }

  return {
    draft: {
      transcript: transcript.length > 0 ? transcript : null,
      customerId: matchCustomer(normalized, input.customers),
      lines,
    },
    paymentMethod: parsePaymentMethod(normalized),
    vatRate,
  };
}
