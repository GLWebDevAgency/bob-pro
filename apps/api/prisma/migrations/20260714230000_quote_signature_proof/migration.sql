-- R4 — preuve de signature honnête (additif, aucun backfill) :
-- JSON { method: 'onsite_draw' | 'remote_link', sha256?: hex(64), capturedAt?: ISO }.
-- Les lignes historiques restent NULL : la méthode réelle est inconnue et le mapper les
-- réhydrate 'legacy_declared' — jamais une méthode réinventée (c'était le P0 : le serveur
-- fabriquait `draw` sans avoir reçu de tracé). V1 : hash + méta uniquement, pas d'image.
ALTER TABLE "quotes" ADD COLUMN "signatureProof" JSONB;

-- Garde-fou en base (défense en profondeur, même rôle que les triggers d'immutabilité voisins) :
-- une preuve, si présente, porte une méthode connue et un hash hex de 64 caractères si fourni.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_signature_proof_shape"
  CHECK (
    "signatureProof" IS NULL
    OR (
      jsonb_typeof("signatureProof") = 'object'
      AND "signatureProof"->>'method' IN ('onsite_draw', 'remote_link')
      AND ("signatureProof"->>'sha256' IS NULL OR "signatureProof"->>'sha256' ~ '^[0-9a-f]{64}$')
    )
  );
