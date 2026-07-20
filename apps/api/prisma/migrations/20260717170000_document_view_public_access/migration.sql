-- Liens publics de VISUALISATION (devis/facture, sans signature) — canal d'envoi universel
-- (SMS/WhatsApp). Réutilise la table public_access_tokens DÉJÀ durcie (hashée, révocable,
-- auditée) : seuls les enums de scope/type de ressource s'élargissent. La policy RLS
-- `tenant_or_public_token_lookup` (résolution par tokenHash) et `revokeAllForCompany` (clôture
-- de compte, tous scopes confondus) couvrent déjà ce nouveau scope sans modification.

ALTER TYPE "PublicAccessScope" ADD VALUE 'document_view';
ALTER TYPE "PublicAccessResourceType" ADD VALUE 'invoice';
