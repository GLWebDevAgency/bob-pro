import { type ChantierProps } from '../../domain/chantier/chantier';

/**
 * Projection de liste (GET /chantiers) : le chantier réel + les compteurs journal/photos —
 * calculés côté serveur en agrégat bulk (groupBy sur chantier_notes/chantier_photos, JAMAIS en
 * N+1 par chantier). Purement un read-model d'affichage — n'entre PAS dans ChantierProps, qui
 * reste l'état persisté de l'agrégat Chantier.
 */
export interface ChantierListItem extends ChantierProps {
  readonly noteCount: number;
  readonly photoCount: number;
}
