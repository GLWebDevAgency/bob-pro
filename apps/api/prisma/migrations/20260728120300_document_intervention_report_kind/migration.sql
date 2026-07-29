-- PR-16 « Le métier » (Bloc C) — enums ADDITIFS du coffre documentaire, en migration DÉDIÉE
-- AVANT tout usage (risque §7.6 du document de conception : un ALTER TYPE ... ADD VALUE ne peut
-- pas être utilisé dans la transaction qui le crée) :
--   • StoredDocumentKind + 'intervention_report' — la fiche de passage PDF ARCHIVÉE IMMUABLE
--     (patron A8 : rendue une fois par état, jamais re-rendue) ;
--   • StoredDocumentLinkedEntityType + 'equipment' — la fiche suit l'ÉQUIPEMENT du passage quand
--     il en vise un (historique par équipement, PR-11), sinon elle reste liée au site.
--
-- AUDIT CONSOMMATEURS (leçon 25/07) — vérifié au repo, AUCUN corps de trigger n'est à redéfinir :
--   • guard_document_original_facts_v1 (20260721133300) fige déjà kind/filename/sha256/storageKey
--     de TOUT document : l'immutabilité de l'archive de fiche est acquise sans changement ;
--     sa branche `legal_original` reste volontairement bornée à invoice_pdf/facturx_xml/
--     signed_quote — une fiche de passage n'est pas une pièce fiscale, son rattachement reste
--     donc éditable (renommage de libellé, rangement) comme tout document non légal ;
--   • les prédicats d'archive légale (20260721133200/133800/134000) énumèrent explicitement les
--     kinds légaux : une valeur nouvelle NON citée y est neutre (aucune obligation créée) ;
--   • document_folders (20260713190000) restreint son classement automatique aux mêmes kinds
--     légaux : la fiche de passage n'y entre pas.
-- Writer N-1 : un writer antérieur n'émet jamais ces valeurs — l'ajout est strictement expansif.

ALTER TYPE "StoredDocumentKind" ADD VALUE IF NOT EXISTS 'intervention_report';
ALTER TYPE "StoredDocumentLinkedEntityType" ADD VALUE IF NOT EXISTS 'equipment';
