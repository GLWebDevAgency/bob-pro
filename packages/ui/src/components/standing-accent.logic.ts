/**
 * Fil rouge « couleur de l'argent » (Lot 4, plan DA 01/08 — coup de maître n° 3) : la teinte
 * du standing client (vert à jour / ambre en attente / rouge en retard) suit l'artisan du
 * carnet (rangée ClientRow) à la fiche (héros, encours en MoneyText teinté) jusqu'au geste
 * (StickyActionBar 'floating', liseré accent). UNE dérivation PURE — la référence est le
 * carnet C12 (le départ du fil) : le devis en attente est ambré comme l'attente, le client
 * nouveau reste neutre. Même dérivation deriveCustomerStandings en amont, ZÉRO logique
 * métier nouvelle ici : on ne fait que nommer le rôle sémantique de chaque standing.
 */
import type { CustomerStandingKind } from '@bob/core';

export type StandingAccentRole = 'success' | 'warning' | 'danger' | 'neutral';

/** Standing → rôle sémantique — identique aux trois niveaux (rangée, héros, liseré CTA). */
export function standingAccentRole(kind: CustomerStandingKind): StandingAccentRole {
  switch (kind) {
    case 'a_jour':
      return 'success';
    case 'en_retard':
      return 'danger';
    case 'en_attente':
      return 'warning';
    // Réf C12-frame : le devis en attente est ambré, comme l'attente.
    case 'devis':
      return 'warning';
    case 'nouveau':
      return 'neutral';
  }
}

/** Palette injectée depuis useTheme() — le kit ne connaît aucune couleur en dur. */
export interface StandingAccentPalette {
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly neutral: string;
}

/** Standing → couleur résolue : le MÊME token sémantique du carnet au geste. */
export function standingAccentColor(
  kind: CustomerStandingKind,
  palette: StandingAccentPalette,
): string {
  return palette[standingAccentRole(kind)];
}
