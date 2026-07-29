-- PR-15b « Le métier » (Bloc C, C3, exigences 5-6) — fiche de passage (intervention).
-- Tables NEUVES (contraintes inline, patron equipments/chantier_notes) :
--   • FK composites (chantierId, companyId) / (customerId, companyId) / (equipmentId, companyId)
--     anti-IDOR, ON DELETE RESTRICT — une fiche n'est jamais orpheline ni inter-tenant ;
--   • CHECK status GÉNÉRÉ depuis la SOURCE TypeScript (InterventionStatus, intervention.ts) —
--     garde anti-drift dans interventions.postgres.test.ts ;
--   • `kind` LIBRE : bornes de FORME uniquement (btrim/longueur/cntrl), JAMAIS d'énumération
--     métier (direction 6 — `contractId` est le SEUL discriminant d'une visite contractuelle) ;
--   • cohérence statut ↔ FAITS (miroir exact des invariants du domaine, jamais un demi-état) :
--     in_progress/completed/signed ⇒ startedAt ; completed/signed ⇒ finishedAt ;
--     (status='signed') = (signatureProof IS NOT NULL) ; startedAt <= finishedAt ;
--   • [Revue P15] `id` GÉNÉRÉ CÔTÉ CLIENT (offline-first §3.6) : format uuid v4 STRICT en
--     défense en profondeur — la collision de PK reste un 409 générique côté use case
--     (jamais un oracle d'existence inter-tenant).
-- `contractId` est une colonne ADDITIVE SANS FK : la table `maintenance_contracts` appartient
-- au train Contrats. CreateIntervention ne l'accepte jamais — aucun lien non vérifié ne peut
-- naître ici ; la FK composite sera posée par le train qui crée la table cible.
-- RLS ENABLE+FORCE + policy tenant_isolation ; grants runtime par le socle grant_app_role de
-- release.sh, le DELETE est RETIRÉ explicitement (une fiche s'annule, ne se supprime jamais —
-- voir release.sh, REVOKE DELETE ON public.interventions).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "interventions" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "chantierId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "contractId" TEXT,
  "equipmentId" TEXT,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "plannedAt" TIMESTAMPTZ(6),
  "technicianLabel" TEXT,
  "startedAt" TIMESTAMPTZ(6),
  "finishedAt" TIMESTAMPTZ(6),
  "checklist" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "summary" TEXT,
  "signatureProof" JSONB,
  "reportDocumentId" TEXT,
  "billedInvoiceId" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "interventions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_intervention_id_company" UNIQUE ("id", "companyId"),
  CONSTRAINT "interventions_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "interventions_chantier_company_fkey"
    FOREIGN KEY ("chantierId", "companyId") REFERENCES "chantiers"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "interventions_customer_company_fkey"
    FOREIGN KEY ("customerId", "companyId") REFERENCES "customers"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "interventions_equipment_company_fkey"
    FOREIGN KEY ("equipmentId", "companyId") REFERENCES "equipments"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- [Revue P15] id client : uuid v4 canonique minuscule, rien d'autre.
  CONSTRAINT "interventions_id_uuid_v4_check"
    CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  -- Généré depuis la source TS (InterventionStatus) — leçon 25/07, drift gardé par le cert.
  CONSTRAINT "interventions_status_check"
    CHECK ("status" IN ('scheduled', 'in_progress', 'completed', 'signed', 'cancelled')),
  -- `kind` LIBRE : forme seulement (aucune liste fermée — contradiction P7 close).
  CONSTRAINT "interventions_kind_check"
    CHECK (
      char_length(btrim("kind")) BETWEEN 1 AND 200
      AND "kind" = btrim("kind")
      AND "kind" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "interventions_technician_check"
    CHECK (
      "technicianLabel" IS NULL
      OR (
        char_length(btrim("technicianLabel")) BETWEEN 1 AND 200
        AND "technicianLabel" = btrim("technicianLabel")
        AND "technicianLabel" !~ '[[:cntrl:]]'
      )
    ),
  -- Résumé de terrain MULTILIGNE (dictée) : \n et \t admis, tout AUTRE contrôle refusé.
  CONSTRAINT "interventions_summary_check"
    CHECK (
      "summary" IS NULL
      OR (
        char_length(btrim("summary")) BETWEEN 1 AND 2000
        AND "summary" = btrim("summary")
        AND translate("summary", E'\n\t', '') !~ '[[:cntrl:]]'
      )
    ),
  -- Checklist LIBRE mais toujours un TABLEAU JSON (jamais un objet, jamais un scalaire).
  CONSTRAINT "interventions_checklist_array_check"
    CHECK (jsonb_typeof("checklist") = 'array'),
  CONSTRAINT "interventions_signature_object_check"
    CHECK ("signatureProof" IS NULL OR jsonb_typeof("signatureProof") = 'object'),
  -- Cohérence statut ↔ faits : jamais un demi-état (miroir Intervention.record).
  CONSTRAINT "interventions_started_coherence_check"
    CHECK ("status" NOT IN ('in_progress', 'completed', 'signed') OR "startedAt" IS NOT NULL),
  CONSTRAINT "interventions_finished_coherence_check"
    CHECK ("status" NOT IN ('completed', 'signed') OR "finishedAt" IS NOT NULL),
  CONSTRAINT "interventions_chronology_check"
    CHECK ("startedAt" IS NULL OR "finishedAt" IS NULL OR "finishedAt" >= "startedAt"),
  -- Cohérence TRIPLE signature (même doctrine que retiredAt, revue P11) : signé ⟺ preuve.
  CONSTRAINT "interventions_signed_coherence_check"
    CHECK (("status" = 'signed') = ("signatureProof" IS NOT NULL)),
  CONSTRAINT "interventions_revision_check"
    CHECK ("revision" BETWEEN 1 AND 2147483647)
);

-- Fiches d'un site (écran parc/site) et planning du jour (« qu'est-ce que j'ai aujourd'hui ? »).
CREATE INDEX "interventions_company_chantier_status_idx"
  ON "interventions"("companyId", "chantierId", "status");
CREATE INDEX "interventions_company_status_planned_idx"
  ON "interventions"("companyId", "status", "plannedAt");

-- Défense en profondeur : même un défaut applicatif reste confiné au tenant courant.
ALTER TABLE "interventions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interventions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "interventions"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Réglages de fiche PAR SOCIÉTÉ : titre de PDF paramétrable (« Certificat sanitaire ») +
-- templates de checklist par `kind`. [Amélioration 10] un SEUL titre par société (limite
-- assumée, documentée) ; les templates restent un JSON libre, aucun moteur métier.
CREATE TABLE "company_intervention_settings" (
  "companyId" TEXT NOT NULL,
  "reportTitle" TEXT,
  "checklistTemplates" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "company_intervention_settings_pkey" PRIMARY KEY ("companyId"),
  CONSTRAINT "company_intervention_settings_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "company_intervention_settings_title_check"
    CHECK (
      "reportTitle" IS NULL
      OR (
        char_length(btrim("reportTitle")) BETWEEN 1 AND 120
        AND "reportTitle" = btrim("reportTitle")
        AND "reportTitle" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "company_intervention_settings_templates_check"
    CHECK (jsonb_typeof("checklistTemplates") = 'object'),
  CONSTRAINT "company_intervention_settings_revision_check"
    CHECK ("revision" BETWEEN 1 AND 2147483647)
);

ALTER TABLE "company_intervention_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_intervention_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "company_intervention_settings"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

COMMIT;
