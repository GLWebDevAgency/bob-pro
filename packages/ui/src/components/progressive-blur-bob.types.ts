/**
 * CONTRAT EXÉCUTABLE DU PORT `renderBlurLayer` — transcription LITTÉRALE de
 * `docs/mobile-experience/04-navigation-scroll-surfaces.md`
 * § « Couture du port », sous-section 1 « Signature du port — le type exact ».
 *
 * CE FICHIER SE DIFFE MOT POUR MOT CONTRE LE DOCUMENT. Il ne contient QUE ce que le contrat
 * y place, et ses deux seuls imports de types viennent de `react` et de `react-native` — rien
 * d'`expo-blur` n'apparaît dans `@bob/ui`, ni ici ni ailleurs. Tout ce que le kit ajoute
 * au-delà du contrat vit dans `progressive-blur-bob.logic.ts` et est nommé comme un ajout :
 * mélanger les deux rendrait la conformité invérifiable.
 */
import type { ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/** Description d'UNE couche, entièrement calculée par `@bob/ui`. */
export interface BlurLayerSpec {
  /** Rang de la couche. 0 = la plus haute (100 %), N−1 = la plus courte. */
  readonly index: number;
  /** Nombre total de couches demandées (`N`). Invariant : `0 <= index < layerCount`. */
  readonly layerCount: number;
  /** Hauteur de la couche en POURCENTAGE de la hauteur d'enveloppe, profil § Mode flouté. */
  readonly heightPercent: number;
  /** Intensité `expo-blur`, identique pour toutes les couches (valeur Bob : 5). */
  readonly intensity: number;
  /** Teinte `expo-blur`. Jamais `'dark'` — contrainte du contrat de props ci-dessus. */
  readonly tint: 'light' | 'default';
  /** Bord ancré de la retombée : `'bottom'` pour un chrome bas, `'top'` pour un chrome haut. */
  readonly anchor: 'top' | 'bottom';
  /** Position absolue déjà résolue par `@bob/ui`. À appliquer TEL QUEL, sans recalcul. */
  readonly style: StyleProp<ViewStyle>;
}

/** Rend une couche, et rien d'autre : ni voile, ni dégradé, ni conteneur. */
export type RenderBlurLayer = (spec: BlurLayerSpec) => ReactElement | null;

export interface ProgressiveBlurBobProps {
  readonly anchor: 'top' | 'bottom';
  /** Hauteur d'enveloppe en points — fixe, § Pourquoi l'enveloppe est fixe. */
  readonly height: number;
  /** `N`. `0` = mode nominal teinté, seul défaut livrable. */
  readonly layers?: number;
  /** Port injecté. ABSENT = repli opaque unique, sans autre condition. */
  readonly renderBlurLayer?: RenderBlurLayer;
}
