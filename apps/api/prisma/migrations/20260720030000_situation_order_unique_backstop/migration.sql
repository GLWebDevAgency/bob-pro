-- B2 — BACKSTOP D'INTÉGRITÉ des situations de travaux (garde de cumul « acompte + situations
-- ≤ marché », annoncée INVIOLABLE). La garde applicative de GenerateInvoiceFromQuote est un
-- read-then-write sans verrou : deux générations CONCURRENTES (double-tap, retry réseau,
-- action vocale + UI) lisaient le même engagé, passaient chacune la garde et créaient DEUX
-- « Situation n°N » sur le même devis — duplicata du n° d'ordre imprimé sur les PDF (décompte
-- BTP incohérent) et cumul au-delà du marché signé (TVA exigible sur chaque pièce émise,
-- art. 283 du CGI).
--
-- Cet index UNIQUE PARTIEL fait échouer la seconde insertion : le domaine alloue désormais le
-- n° d'ordre en max + 1 TOUT statut (un n° n'est JAMAIS réutilisé, pièces annulées comprises),
-- donc deux générations concurrentes calculent le MÊME n° et la base tranche — l'API traduit
-- l'échec en conflit rejouable (409), jamais en pièce dupliquée. Les avoirs (kind
-- 'credit_note') reflètent le n° d'ordre de leur source : ils sont EXCLUS de l'index (le
-- miroir exact est déjà imposé par le trigger de traçabilité).
--
-- Migration STRICTEMENT ADDITIVE : index seul, aucune ligne modifiée.
CREATE UNIQUE INDEX "uniq_invoice_parent_quote_situation_order"
  ON "invoices"("companyId", "parentQuoteId", "situationOrder")
  WHERE "parentQuoteId" IS NOT NULL
    AND "situationOrder" IS NOT NULL
    AND kind = 'situation';
