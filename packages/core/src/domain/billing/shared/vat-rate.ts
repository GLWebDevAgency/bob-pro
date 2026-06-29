export type VatRate = 0 | 2.1 | 5.5 | 10 | 20;

export const VAT_RATES: readonly VatRate[] = [0, 2.1, 5.5, 10, 20] as const;

export function isVatRate(n: number): n is VatRate {
  return (VAT_RATES as readonly number[]).includes(n);
}
