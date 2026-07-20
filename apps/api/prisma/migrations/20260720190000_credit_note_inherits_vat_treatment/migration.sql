-- CORRECTIF — un AVOIR hérite du régime de TVA de sa facture source DÈS SA CRÉATION.
--
-- Incident terrain du 20/07/2026, capturé par Sentry (BOB-PRO-API-2, 2 occurrences) :
-- POST /invoices/:id/credit-note échouait en 23514 sur
-- « invoices_vat_treatment_requires_issue », rendant la création d'avoir IMPOSSIBLE.
--
-- La contrainte posée le 19/07 (migration 20260719160000) exigeait `issuedAt IS NOT NULL`
-- dès que `vatTreatmentAtIssuance` est renseigné, au motif qu'« un régime figé sans émission
-- n'existe pas : il est constaté À l'émission ». Cette prémisse est vraie pour une facture
-- ordinaire, mais FAUSSE pour un avoir : celui-ci ne constate pas un régime à sa propre
-- émission, il REPREND celui de la pièce qu'il rectifie (art. 272 CGI — la TVA récupérée est
-- celle de la facture initiale ; Invoice.creditNoteFor le copie à la création, jamais recalculé).
-- Un avoir naît donc BROUILLON (issuedAt NULL) en portant déjà un régime hérité — état
-- parfaitement légitime que la contrainte interdisait.
--
-- L'invariant utile est conservé pour toutes les autres pièces : elles ne peuvent porter un
-- régime figé qu'une fois émises.
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_vat_treatment_requires_issue";

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_vat_treatment_requires_issue"
  CHECK ("vatTreatmentAtIssuance" IS NULL
         OR "issuedAt" IS NOT NULL
         OR "kind" = 'credit_note');
