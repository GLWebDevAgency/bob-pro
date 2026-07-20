-- B9 — Recherche intelligente Devis & Factures (« retrouve-moi les devis de Mairie de Sèvres du
-- mois dernier »). Migration purement ADDITIVE : deux extensions, une fonction, une colonne
-- (defaultée, donc NOT NULL sans backfill manuel), et des index. Aucune contrainte / colonne /
-- table existante n'est modifiée ou supprimée.
--
-- Ces index GIN sont des index D'EXPRESSION (accents/casse pliés — voir immutable_unaccent plus
-- bas) : le DSL Prisma (@@index) ne sait représenter que des index sur colonne brute, PAS sur une
-- expression. Ils sont donc VOLONTAIREMENT ABSENTS de schema.prisma (voir les commentaires sur
-- Customer/Quote/Invoice/LineItem qui pointent ici). Vérifié empiriquement (2026-07-17,
-- `prisma migrate dev --create-only` après application) : Prisma les ignore silencieusement, ne
-- les recrée ni ne les supprime — aucun risque de drift à corriger involontairement.

-- pg_trgm : seule façon d'indexer une recherche "floue"/"contient" (fautes de frappe, sous-
-- chaînes) sur du texte libre — un LIKE '%...%' ou ILIKE classique ne peut PAS utiliser de B-Tree
-- et force un scan complet. Nécessaire pour le nom client, le numéro de pièce et les libellés de
-- ligne, et pour tenir la cible <50ms de l'autocomplétion (GET /documents/suggest).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent : la similarité trigram brute est TROP SENSIBLE aux accents pour l'usage réel — mesuré
-- en base : similarity('Mairie de Sèvres', 'sevres') = 0.2 (sous le seuil pg_trgm par défaut de
-- 0.3, donc AUCUN résultat pour la requête même du cahier des charges), alors qu'une fois les deux
-- côtés passés par immutable_unaccent+lower, word_similarity('sevres', 'mairie de sevres') = 1.0.
-- Sans unaccent, l'exemple fondateur ("Mairie de Sèvres" tapé "sevres") ne fonctionne PAS.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() natif est marqué STABLE (dépend d'une config de recherche pouvant changer) — un
-- index D'EXPRESSION exige IMMUTABLE. Enveloppe standard (recette officielle PostgreSQL) qui fige
-- la config 'unaccent' : sans elle, `CREATE INDEX ... (unaccent(name) ...)` échoue au DDL.
CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text AS $$
  SELECT public.unaccent('public.unaccent', $1)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

-- Un devis n'a pas de date métier propre (contrairement à Invoice.issuedAt, posée à l'émission) :
-- aucune colonne createdAt n'existait sur quotes. On l'ajoute comme date de référence pour le tri
-- et les plages "ce mois-ci / mois dernier / 2 derniers mois". DEFAULT CURRENT_TIMESTAMP rend la
-- colonne NOT NULL sans backfill applicatif ; les devis déjà en base reçoivent la date de cette
-- migration (aucune date de création plus fidèle n'a jamais été persistée).
ALTER TABLE "quotes" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Plages de dates : les chips "ce mois-ci / mois dernier / 2 derniers mois" filtrent TOUJOURS par
-- tenant puis trient par date desc — un index composite (companyId, date DESC) sert directement
-- ce pattern (borne + tri) sans tri en mémoire côté Postgres. issuedAt est NULL en brouillon —
-- hors périmètre "recherche par période" par construction (une pièce non émise n'a pas encore de
-- date métier), Postgres exclut nativement les NULL d'un index B-Tree DESC utilisé en borne.
CREATE INDEX "quotes_company_created_idx" ON "quotes"("companyId", "createdAt" DESC);
CREATE INDEX "invoices_company_issued_idx" ON "invoices"("companyId", "issuedAt" DESC);

-- Nom client : LA cible de recherche la plus fréquente ("retrouve les devis de Mairie de
-- Sèvres"). Le nom n'est jamais dénormalisé sur quotes/invoices (schéma réel) → un seul index
-- trigram ici sert à la fois le filtre "q=" (join quotes/invoices → customers, FK déjà indexée)
-- et les suggestions d'autocomplétion typées "customer". immutable_unaccent(lower(...)) des DEUX
-- côtés (index + requête, cf. sales-document-search.repository.ts) : lecture insensible aux
-- accents/casse, condition pour que l'index GIN accélère réellement l'opérateur <% (word
-- similarity) utilisé par la recherche.
CREATE INDEX "customers_name_trgm_idx" ON "customers" USING GIN (immutable_unaccent(lower("name")) gin_trgm_ops);

-- Numéro de pièce : recherche "contient" (taper "014" doit retrouver "DEV-2026-014"). Le B-Tree
-- unique existant (companyId, number) ne sert que l'égalité/le préfixe, pas la sous-chaîne — d'où
-- un index trigram dédié, séparé, sur chacune des deux tables.
CREATE INDEX "quotes_number_trgm_idx" ON "quotes" USING GIN (immutable_unaccent(lower("number")) gin_trgm_ops);
CREATE INDEX "invoices_number_trgm_idx" ON "invoices" USING GIN (immutable_unaccent(lower("number")) gin_trgm_ops);

-- Libellés de ligne ("prestation/libellé" du cahier des charges) : retrouver une pièce par le
-- contenu d'une ligne ("peinture façade") sans scanner toute line_items.
CREATE INDEX "line_items_label_trgm_idx" ON "line_items" USING GIN (immutable_unaccent(lower("label")) gin_trgm_ops);
