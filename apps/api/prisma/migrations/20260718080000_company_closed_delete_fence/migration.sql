-- Défense privilégiée : même un outil d'exploitation connecté en admin ne doit pas effacer par
-- accident une société déjà clôturée. Ses pièces légales continuent de relire cette identité.
CREATE OR REPLACE FUNCTION prevent_closed_company_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."closedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'COMPANY_CLOSED_DELETE_FORBIDDEN'
      USING ERRCODE = '23514', CONSTRAINT = 'companies_closed_delete_forbidden';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS companies_closed_delete_fence ON "companies";
CREATE TRIGGER companies_closed_delete_fence
BEFORE DELETE ON "companies"
FOR EACH ROW
EXECUTE FUNCTION prevent_closed_company_hard_delete();

COMMENT ON FUNCTION prevent_closed_company_hard_delete() IS
  'Interdit le hard-delete d''une Company clôturée ; la purge légale exige une procédure privilégiée explicite.';
