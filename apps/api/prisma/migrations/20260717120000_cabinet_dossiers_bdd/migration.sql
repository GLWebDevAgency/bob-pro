CREATE TABLE "cabinet_dossiers" (
  "id" TEXT NOT NULL,
  "cabinetId" TEXT NOT NULL,
  "siren" VARCHAR(9) NOT NULL,
  "clientName" VARCHAR(200) NOT NULL,
  "sourceFileName" VARCHAR(255) NOT NULL,
  "entryCount" INTEGER NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "periodFrom" DATE NOT NULL,
  "periodTo" DATE NOT NULL,
  "turnoverCents" BIGINT NOT NULL,
  "resultCents" BIGINT NOT NULL,
  "totalDebitCents" BIGINT NOT NULL,
  "totalCreditCents" BIGINT NOT NULL,
  "trialBalanceBalanced" BOOLEAN NOT NULL,
  "balanceSheetBalanced" BOOLEAN NOT NULL,
  "statementsConsistent" BOOLEAN NOT NULL,
  "balanceSheetDifferenceCents" BIGINT NOT NULL,
  "analysis" JSONB NOT NULL,
  "analysisSha256" CHAR(64) NOT NULL,
  "review" JSONB,
  "fiscal" JSONB NOT NULL,
  "lastImportedAt" TIMESTAMPTZ(3) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cabinet_dossiers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cabinet_dossiers_identity_check" CHECK (
    "siren" ~ '^[0-9]{9}$'
    AND char_length(btrim("clientName")) BETWEEN 2 AND 200
    AND char_length(btrim("sourceFileName")) BETWEEN 1 AND 255
    AND position('/' in "sourceFileName") = 0
    AND position(chr(92) in "sourceFileName") = 0
  ),
  CONSTRAINT "cabinet_dossiers_counts_check" CHECK (
    "entryCount" >= 1 AND "rowCount" >= "entryCount"
  ),
  CONSTRAINT "cabinet_dossiers_period_check" CHECK ("periodFrom" <= "periodTo"),
  CONSTRAINT "cabinet_dossiers_money_check" CHECK (
    "totalDebitCents" >= 0 AND "totalCreditCents" >= 0
    AND "trialBalanceBalanced" = ("totalDebitCents" = "totalCreditCents")
    AND "balanceSheetBalanced" = ("balanceSheetDifferenceCents" = 0)
  ),
  CONSTRAINT "cabinet_dossiers_analysis_check" CHECK (
    jsonb_typeof("analysis") = 'object'
    AND "analysisSha256" ~ '^[0-9a-f]{64}$'
    AND ("review" IS NULL OR jsonb_typeof("review") = 'object')
    AND jsonb_typeof("fiscal") = 'object'
  ),
  CONSTRAINT "cabinet_dossiers_revision_check" CHECK ("revision" >= 1)
);

CREATE UNIQUE INDEX "cabinet_dossiers_cabinetId_siren_key"
  ON "cabinet_dossiers"("cabinetId", "siren");
CREATE INDEX "cabinet_dossiers_cabinetId_updatedAt_id_idx"
  ON "cabinet_dossiers"("cabinetId", "updatedAt" DESC, "id" DESC);

ALTER TABLE "cabinet_dossiers"
  ADD CONSTRAINT "cabinet_dossiers_cabinetId_fkey"
  FOREIGN KEY ("cabinetId") REFERENCES "cabinets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION cabinet_guard_dossier_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW."cabinetId" <> OLD."cabinetId"
     OR NEW.siren <> OLD.siren
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'immutable cabinet dossier fields cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'cabinet dossier revision must increment by one' USING ERRCODE = '23514';
  END IF;
  IF NEW."lastImportedAt" < OLD."lastImportedAt" THEN
    RAISE EXCEPTION 'cabinet dossier import time cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinet_dossiers_guard_update
BEFORE UPDATE ON "cabinet_dossiers"
FOR EACH ROW EXECUTE FUNCTION cabinet_guard_dossier_update();

-- La migration laisse volontairement la table sans policy jusqu'à l'application de rls.sql.
-- ENABLE + FORCE rendent cet intervalle de rolling deploy strictement inaccessible au rôle runtime.
ALTER TABLE "cabinet_dossiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cabinet_dossiers" FORCE ROW LEVEL SECURITY;
