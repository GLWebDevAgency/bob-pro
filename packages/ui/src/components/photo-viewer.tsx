/**
 * PhotoViewer — visionneuse plein écran du kit (Lot 4, plan DA 01/08 : « la visionneuse
 * devient réutilisable (documents, scan) au lieu d'une poche de hex »). Scrim
 * overlays.photoScrim (noir ≈ .92 tokenisé — la valeur que chantier/[id] posait en rgba),
 * chrome (fermer / supprimer) en overlays.scrimChrome (blanc plein, jamais un gris),
 * cibles 44 pt. Le fade d'ouverture est gaté reduce-motion FAIL-CLOSED (préférence non
 * résolue ⇒ Modal animationType 'none' — photo-viewer.logic). Le CONTENU central (image,
 * skeleton, erreur) reste à l'écran : le kit ne connaît ni les données ni leur chargement.
 * Tracés fermer/supprimer identiques à CloseIcon/TrashIcon d'icons.tsx (24×24 lucide).
 */
import type { ReactNode } from 'react';
import { Modal, Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { overlays } from '@bob/tokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { photoViewerAnimationType } from './photo-viewer.logic';

interface PhotoViewerBaseProps {
  readonly visible: boolean;
  readonly onRequestClose: () => void;
  /** Libellé i18n du bouton fermer — le kit ne fabrique aucune copy. */
  readonly closeAccessibilityLabel: string;
  /** Contenu central (image / skeleton / message d'erreur) — injecté par l'écran. */
  readonly children: ReactNode;
  readonly testID?: string;
}

/** La suppression est soit absente, soit complète avec son libellé i18n. */
type PhotoViewerDeleteProps =
  | { readonly onDelete?: undefined; readonly deleteAccessibilityLabel?: never }
  | { readonly onDelete: () => void; readonly deleteAccessibilityLabel: string };

export type PhotoViewerProps = PhotoViewerBaseProps & PhotoViewerDeleteProps;

/** Croix — même tracé que CloseIcon d'icons.tsx (24×24, 20/2.2). */
function CloseGlyph({ color }: { color: string }) {
  return (
    <Svg
      accessible={false}
      width={20}
      height={20}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={2.2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

/** Poubelle — même tracé que TrashIcon d'icons.tsx (24×24, 19/2). */
function TrashGlyph({ color }: { color: string }) {
  return (
    <Svg
      accessible={false}
      width={19}
      height={19}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M4 7h16" />
      <Path d="M9 7V4h6v3" />
      <Path d="M6 7l1 13h10l1-13" />
      <Path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function PhotoViewer({
  visible,
  onRequestClose,
  closeAccessibilityLabel,
  onDelete,
  deleteAccessibilityLabel,
  children,
  testID,
}: PhotoViewerProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  return (
    <Modal
      visible={visible}
      transparent
      // Fail-closed : préférence non résolue ou réduite ⇒ aucune animation d'ouverture.
      animationType={photoViewerAnimationType(reduceMotion)}
      onRequestClose={onRequestClose}
      {...(testID !== undefined ? { testID } : {})}
    >
      <View style={{ flex: 1, backgroundColor: overlays.photoScrim }}>
        <View
          style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 16,
            flexDirection: 'row',
            justifyContent: 'space-between',
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={closeAccessibilityLabel}
            onPress={onRequestClose}
            hitSlop={8}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <CloseGlyph color={overlays.scrimChrome} />
          </Pressable>
          {onDelete !== undefined
          && deleteAccessibilityLabel !== undefined
          && deleteAccessibilityLabel.trim().length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={deleteAccessibilityLabel}
              onPress={onDelete}
              hitSlop={8}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <TrashGlyph color={overlays.scrimChrome} />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>{children}</View>
      </View>
    </Modal>
  );
}
