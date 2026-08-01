/**
 * ErrorSheet — PROMU @bob/ui au Lot 0 (plan DA 01/08, arbitrage GRAMMAIRE D'ERREUR).
 * Ce fichier n'est plus qu'un RÉEXPORT : les consommateurs (DocumentActions,
 * ShareQuoteLinkButton, CollectInvoiceButton) gardent leur import à l'identique, et
 * l'iso-rendu du chemin historique `showError` est prouvé par ErrorSheet.iso.test.tsx.
 * La face 2 faces (`showErrorFacts` — code, corrélation, partage sans PII) vit dans le kit.
 * @deprecated Importer `useErrorSheet` depuis `@bob/ui` (les nouveaux écrans directement).
 */
export { useErrorSheet, type ErrorSheetFacts, type ErrorSheetHandle } from '@bob/ui';
