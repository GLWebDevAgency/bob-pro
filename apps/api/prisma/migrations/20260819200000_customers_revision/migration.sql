-- Jarvis U1-e §2 — RÉVISION DE LA FICHE CLIENT (expand additif, compatible N-1).
--
-- POURQUOI : la garde §9.1 (« la cible mutée entre présentation et confirmation invalide la
-- proposition ») exige de comparer un ENTIER relu à un entier scellé. `customers` n'en portait
-- aucun — ni `revision`, ni `version`, ni `updatedAt` — contrairement à la table sœur
-- `customer_contacts` (`revision Int @default(1)`, migration 20260727110000), dont ce fichier
-- reprend exactement le patron. Sans cette colonne, aucune dérive n'est détectable et la garde
-- reste une promesse creuse.
--
-- COMPATIBLE N-1 : le writer N-1 ne connaît pas la colonne et ne l'écrit jamais — le DEFAULT
-- suffit, aucun backfill, aucune écriture existante n'est modifiée. Les lignes historiques
-- naissent donc à la révision 1, ce qui est exactement la vérité qu'on peut affirmer : « cette
-- fiche n'a pas bougé depuis que Bob sait compter ». Pendant un déploiement roulant, les deux
-- révisions applicatives cohabitent sans se gêner : N-1 écrit sans la colonne, N l'incrémente
-- dans le use case canonique d'édition (`UpdateCustomer` -> `customers.save`). L'ORDRE reste
-- celui de release.sh — `prisma migrate deploy` AVANT le déploiement du code, jamais l'inverse.
--
-- Pas de rewrite : PostgreSQL >= 11 ajoute une colonne NOT NULL à DEFAULT constant sans
-- réécrire la table.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Le deployeur n'est ni superuser ni proprietaire des tables protegees (Supabase, et le harnais
-- de certification local qui reproduit cette contrainte) : ALTER TABLE exige le PROPRIETAIRE.
-- Meme preambule que les migrations recentes qui alterent une table existante — assumer le role,
-- ou echouer en le NOMMANT, jamais un ALTER refuse a mi-parcours.
DO $bob_customers_revision_owner$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'customers'
     AND relation.relkind IN ('r', 'p');

  IF schema_owner_oid IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42P01',
      MESSAGE = 'CUSTOMERS_REVISION_TABLE_MISSING';
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'CUSTOMERS_REVISION_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'CUSTOMERS_REVISION_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_customers_revision_owner$;

ALTER TABLE public.customers
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

-- Bornes du domaine (`isRevision` de customer-contact-v1 : entier sûr, >= 1, <= int4 max) —
-- la base refuse ce que le domaine refuserait, jamais l'inverse. Posée NOT VALID puis validée
-- IMMÉDIATEMENT : la colonne vient de naître, toutes ses valeurs valent 1, la validation ne
-- peut pas échouer et ne laisse aucune dette de contrainte non validée derrière elle.
ALTER TABLE public.customers
  ADD CONSTRAINT customers_revision_range_check
    CHECK ("revision" BETWEEN 1 AND 2147483647) NOT VALID;

ALTER TABLE public.customers
  VALIDATE CONSTRAINT customers_revision_range_check;

COMMIT;
