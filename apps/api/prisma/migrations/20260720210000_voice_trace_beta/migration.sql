-- TRAÇAGE DU COMPORTEMENT VOCAL — une ligne par TOUR de conversation vocale.
--
-- Demande fondateur du 20/07/2026 : « les logs lorsque je teste en vocal. On doit avoir
-- exactement tout ce qui se passe et pouvoir comprendre et reproduire les erreurs […] Ce n'est
-- pas forcément des erreurs qui doivent sortir, mais le comportement, la réponse, comment Bob
-- réagit à mes demandes. » Le seul traçage vocal existant se limitait au MODÈLE et au NOMBRE de
-- caractères (backend.service.ts, `voice.transcribe` / `voice.synthesize`) : ni le texte
-- prononcé, ni l'intention, ni l'outil, ni le résultat, ni la réponse, ni les latences.
--
-- EXPAND-ONLY : création pure, aucune table ni colonne existante n'est touchée.
--
-- SOUVERAINETÉ. `transcript` et `reply` sont les données les plus sensibles de l'app (noms de
-- clients, montants, SIRET). Elles restent dans NOTRE base : ce sont exactement celles que
-- `packages/core/src/observability/telemetry-scrubbing.ts` interdit d'envoyer à un tiers pour
-- motif RGPD. Ajouter un observateur externe créerait un sous-traitant pour ces données.
--
-- RÉTENTION 30 JOURS. Debug de bêta-test, pas archive légale : aucune obligation de
-- conservation. `retentionExpiresAt` est matérialisé EN COLONNE pour qu'une purge s'exécute
-- sans rejouer la politique, et purgé par tenant par VoiceTracePurgeService.
CREATE TABLE "voice_traces" (
  "id"                 TEXT        NOT NULL,
  "companyId"          TEXT        NOT NULL,
  "sessionId"          TEXT        NOT NULL,
  "turnIndex"          INTEGER     NOT NULL,
  "userId"             TEXT,
  "correlationId"      TEXT        NOT NULL,
  "planCorrelationId"  TEXT,
  "startedAt"          TIMESTAMPTZ(6) NOT NULL,
  "transcript"         TEXT,
  "sttModel"           TEXT,
  "intent"             TEXT,
  "tool"               TEXT,
  "toolArgs"           JSONB,
  "autonomy"           TEXT,
  "llmModel"           TEXT,
  "outcome"            TEXT        NOT NULL,
  "level"              TEXT        NOT NULL,
  "reason"             TEXT,
  "reply"              TEXT,
  "ttsModel"           TEXT,
  "transcriptionMs"    INTEGER,
  "planificationMs"    INTEGER,
  "executionMs"        INTEGER,
  "syntheseMs"         INTEGER,
  "updatedAt"          TIMESTAMPTZ(6) NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "voice_traces_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "voice_traces"
  ADD CONSTRAINT "voice_traces_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Le tour est l'unité : deux écritures du même tour (transcription puis planification) doivent
-- se rejoindre sur la MÊME ligne, jamais en créer une seconde.
CREATE UNIQUE INDEX "voice_trace_turn" ON "voice_traces" ("companyId", "sessionId", "turnIndex");

-- Lecture chronologique d'une session (script de diagnostic).
CREATE INDEX "voice_traces_tenant_time_idx" ON "voice_traces" ("companyId", "startedAt");
-- « Montre-moi les anomalies du jour » sans scanner tout le stock.
CREATE INDEX "voice_traces_level_idx" ON "voice_traces" ("companyId", "level", "startedAt");
-- Purge : le balayage de rétention doit rester un index scan borné.
CREATE INDEX "voice_traces_retention_idx" ON "voice_traces" ("companyId", "retentionExpiresAt");

-- Les valeurs autorisées sont VERROUILLÉES en base plutôt qu'en enum Postgres : une trace de
-- debug doit rester expand-only (ajouter une issue demain = un CHECK remplacé, pas un ALTER TYPE
-- bloquant). Une valeur hors liste est un bug d'écriture, pas une donnée à accepter.
ALTER TABLE "voice_traces"
  ADD CONSTRAINT "voice_traces_outcome_known"
  CHECK ("outcome" IN ('heard', 'success', 'refused', 'error'));

ALTER TABLE "voice_traces"
  ADD CONSTRAINT "voice_traces_level_known"
  CHECK ("level" IN ('info', 'warn', 'error'));

-- Un refus métier ou une anomalie SANS raison serait une trace muette : exactement ce que ce
-- chantier corrige. Le contrat est posé en base, pas seulement dans l'application.
ALTER TABLE "voice_traces"
  ADD CONSTRAINT "voice_traces_failure_states_carry_reason"
  CHECK ("outcome" IN ('heard', 'success') OR "reason" IS NOT NULL);

-- Latences : une étape non franchie reste NULL (jamais 0, qui mentirait sur une mesure).
ALTER TABLE "voice_traces"
  ADD CONSTRAINT "voice_traces_latencies_non_negative"
  CHECK (
    COALESCE("transcriptionMs", 0) >= 0
    AND COALESCE("planificationMs", 0) >= 0
    AND COALESCE("executionMs", 0) >= 0
    AND COALESCE("syntheseMs", 0) >= 0
  );

ALTER TABLE "voice_traces"
  ADD CONSTRAINT "voice_traces_turn_index_positive" CHECK ("turnIndex" >= 1);

-- La rétention est un INVARIANT de la table, pas une intention : une ligne sans échéance
-- postérieure à son début échapperait à la purge et deviendrait un stock permanent de
-- transcripts en clair.
ALTER TABLE "voice_traces"
  ADD CONSTRAINT "voice_traces_retention_after_start"
  CHECK ("retentionExpiresAt" > "startedAt");

-- RLS (défense en profondeur multi-tenant). Les policies elles-mêmes vivent dans prisma/rls.sql,
-- rejoué après migration ; l'activation est posée ici pour qu'aucune fenêtre ne laisse la table
-- lisible cross-tenant entre `prisma migrate deploy` et l'exécution de rls.sql.
ALTER TABLE "voice_traces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "voice_traces" FORCE ROW LEVEL SECURITY;
