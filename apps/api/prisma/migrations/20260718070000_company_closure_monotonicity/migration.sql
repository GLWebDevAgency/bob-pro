-- Défense en profondeur : la clôture d'une Company est une transition légale irréversible.
-- L'application prend déjà un verrou de cycle de vie et écrit avec WHERE closedAt IS NULL ; ce
-- trigger protège aussi contre une future requête SQL/ORM qui contournerait accidentellement ce port.
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_closure_reason_requires_closed_at"
  CHECK ("closureReason" IS NULL OR "closedAt" IS NOT NULL);

CREATE OR REPLACE FUNCTION enforce_company_closure_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Une row clôturée devient immuable. Un UPDATE strictement no-op reste toléré pour les outils
  -- d'exploitation idempotents, mais ni la réouverture ni une retouche légale ne sont possibles.
  IF OLD."closedAt" IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'COMPANY_CLOSED_IMMUTABLE'
        USING ERRCODE = '23514', CONSTRAINT = 'companies_closed_immutable';
    END IF;
    RETURN NEW;
  END IF;

  -- Un motif n'existe qu'avec une clôture effective.
  IF NEW."closedAt" IS NULL AND NEW."closureReason" IS NOT NULL THEN
    RAISE EXCEPTION 'COMPANY_CLOSURE_REASON_REQUIRES_CLOSED_AT'
      USING ERRCODE = '23514', CONSTRAINT = 'companies_closure_reason_requires_closed_at';
  END IF;

  -- La transaction qui ferme le compte ne peut modifier simultanément aucune donnée légale.
  IF NEW."closedAt" IS NOT NULL
     AND (to_jsonb(NEW) - 'closedAt' - 'closureReason')
       IS DISTINCT FROM (to_jsonb(OLD) - 'closedAt' - 'closureReason') THEN
    RAISE EXCEPTION 'COMPANY_CLOSE_CANNOT_MUTATE_LEGAL_IDENTITY'
      USING ERRCODE = '23514', CONSTRAINT = 'companies_close_identity_immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_closure_monotonicity ON "companies";
CREATE TRIGGER companies_closure_monotonicity
BEFORE UPDATE ON "companies"
FOR EACH ROW
EXECUTE FUNCTION enforce_company_closure_monotonicity();

COMMENT ON FUNCTION enforce_company_closure_monotonicity() IS
  'Interdit toute réouverture ou mutation d''une Company après CloseAccount.';
