import {
  VAT_RATES,
  type VatRate,
} from '@bob/core';
import { Prisma } from '@prisma/client';

const VAT_RATE_BY_EXACT_DECIMAL = new Map<string, VatRate>(
  VAT_RATES.map((rate) => [String(rate), rate]),
);

/**
 * Décode un NUMERIC PostgreSQL sans détour par un nombre IEEE-754.
 *
 * Les taux autorisés forment un ensemble fermé du domaine. Le texte décimal exact est donc
 * l'autorité : une valeur voisine telle que 2.1000000000000001 ne doit jamais être arrondie
 * silencieusement vers 2,1.
 */
export function canonicalPrismaVatRate(value: Prisma.Decimal): VatRate | null {
  return VAT_RATE_BY_EXACT_DECIMAL.get(value.toString()) ?? null;
}
