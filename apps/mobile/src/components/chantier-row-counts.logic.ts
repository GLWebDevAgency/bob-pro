import { t, type Personality } from '@bob/i18n';

export interface ChantierRowCounts {
  readonly noteCount: number;
  readonly photoCount: number;
}

/**
 * Compteurs notes/photos d'une rangée de liste de chantiers (fiche client onglet Chantiers/Projets
 * ET écran standalone /chantiers). Purement affichage : le décompte lui-même vient d'un agrégat
 * bulk serveur (BackendService.listChantiers — jamais un N+1 côté client), cette fonction ne fait
 * que décider CE QUI s'affiche (rien si 0, singulier/pluriel sinon) — sobre, jamais de rangée
 * fantôme pour un chantier sans journal ni photo.
 */
export function visibleChantierRowCounts(counts: ChantierRowCounts): ChantierRowCounts {
  return {
    noteCount: Math.max(0, counts.noteCount),
    photoCount: Math.max(0, counts.photoCount),
  };
}

/** Libellé accessible complet (« 3 notes, 1 photo ») — les puces visuelles ne montrent qu'une
 * icône + un nombre, ce texte porte l'information pour les lecteurs d'écran. `null` si les deux
 * compteurs sont à 0 (rien à annoncer, la puce ne rend rien non plus). */
export function chantierRowCountsAccessibilityLabel(
  counts: ChantierRowCounts,
  personality: Personality,
): string | null {
  const { noteCount, photoCount } = visibleChantierRowCounts(counts);
  const parts: string[] = [];
  if (noteCount > 0) {
    parts.push(
      t(noteCount === 1 ? 'chantierFiche.rowNotesCount' : 'chantierFiche.rowNotesCountPlural', {
        personality,
        params: { count: noteCount },
      }),
    );
  }
  if (photoCount > 0) {
    parts.push(
      t(photoCount === 1 ? 'chantierFiche.rowPhotosCount' : 'chantierFiche.rowPhotosCountPlural', {
        personality,
        params: { count: photoCount },
      }),
    );
  }
  return parts.length > 0 ? parts.join(', ') : null;
}
