const MAX_QUOTE_QTY = 1_000_000;
const MAX_QUOTE_HT_CENTS = 1_500_000_000;

function normalizedDecimal(input: string): string {
  return input.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
}

/** Quantité métier : strictement positive, au plus trois décimales et bornée. */
export function parseQuoteLineQuantity(input: string): number | null {
  const normalized = normalizedDecimal(input);
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_QUOTE_QTY) return null;
  return Math.round(value * 1_000) === value * 1_000 ? value : null;
}

/** Prix saisi en euros, converti sans flottant résiduel en centimes. Le prix gratuit (0 €) est valide. */
export function parseQuoteLineEuroCents(input: string): number | null {
  const normalized = normalizedDecimal(input);
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [euros = '', decimals = ''] = normalized.split('.');
  const cents = Number(euros) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_QUOTE_HT_CENTS) return null;
  return cents;
}

export function isValidQuoteLineLabel(input: string): boolean {
  const hasControlCharacter = [...input].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  return input.trim().length > 0 && input.length <= 500 && !hasControlCharacter;
}
