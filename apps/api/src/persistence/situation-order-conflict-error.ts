/**
 * B2 — sentinelle de violation d'unicité « n° d'ordre de situation déjà pris sur ce devis »,
 * miroir de l'index UNIQUE PARTIEL Postgres
 *   (companyId, parentQuoteId, situationOrder) WHERE parentQuoteId IS NOT NULL
 *   AND situationOrder IS NOT NULL AND kind = 'situation'
 * (cf. migration 20260720030000_situation_order_unique_backstop).
 *
 * Émise par les DEUX adapters de persistence — Prisma (traduction du code P2002) et in-memory
 * (garde fidèle, pour que les tests soient réalistes) — afin que BackendService.generateInvoice
 * la traduise UNE seule fois en conflit métier rejouable (409), JAMAIS en 500 ni en pièce
 * dupliquée. La garde applicative de cumul (GenerateInvoiceFromQuote) reste la première ligne ;
 * cette contrainte est le filet CONCURRENTIEL réel : deux générations simultanées lisent le
 * même engagé, calculent le même n° d'ordre (max + 1, jamais réutilisé) — la base tranche.
 */
export class SituationOrderConflictError extends Error {
  constructor(
    readonly companyId: string,
    readonly parentQuoteId: string,
    readonly situationOrder: number,
  ) {
    super(
      `Situation n° ${situationOrder} déjà créée sur le devis ${parentQuoteId} — ` +
        `génération concurrente détectée (contrainte base), l'appel peut être rejoué.`,
    );
    this.name = 'SituationOrderConflictError';
  }
}
