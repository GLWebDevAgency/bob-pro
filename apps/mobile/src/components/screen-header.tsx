/**
 * ScreenHeader — PROMU @bob/ui comme BackHeader canonique au Lot 0 (plan DA 01/08,
 * arbitrage HEADERS : il absorbe les 3 duplications de documents/[id], chantiers, ventes).
 * Ce fichier n'est plus qu'un RÉEXPORT : les 9 écrans consommateurs gardent leur import à
 * l'identique, et l'iso-rendu (chevron compris) est prouvé par screen-header.iso.test.tsx.
 * @deprecated Importer `BackHeader` depuis `@bob/ui` (les nouveaux écrans directement).
 */
export { BackHeader as ScreenHeader, type BackHeaderProps as ScreenHeaderProps } from '@bob/ui';
