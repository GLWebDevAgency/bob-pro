/** Parse un montant EUR saisi en français sans passer par un flottant. */
export function parseEuroAmountToCents(raw: string): number | null {
  const normalized = raw
    .trim()
    .replace(/[\s\u00a0\u202f]/gu, '')
    .replace(/€$/u, '');
  if (!/^-?\d+(?:[,.]\d{1,2})?$/u.test(normalized)) return null;

  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [eurosRaw = '', decimalsRaw = ''] = unsigned.replace(',', '.').split('.');
  try {
    const cents = BigInt(eurosRaw) * 100n + BigInt(decimalsRaw.padEnd(2, '0'));
    const signed = negative ? -cents : cents;
    if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
      return null;
    }
    return Number(signed);
  } catch {
    return null;
  }
}

export function formatCentsForEuroInput(cents: number | null): string {
  if (cents === null || !Number.isSafeInteger(cents)) return '';
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const euros = Math.floor(absolute / 100);
  const decimals = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${euros},${decimals}`;
}
