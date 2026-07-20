/**
 * SignaturePad — signature au doigt (réserve C03, flux devis C21).
 * PanResponder (RN core : @bob/ui n'ajoute pas de dépendance gesture-handler) +
 * react-native-svg : chaque tracé est rendu en SVG path lissé par la logique pure
 * (signature-pad.logic — testée sans react-native). Cadre controls.cardBorder sur
 * fond surface, placeholder tant que rien n'est tracé, bouton Effacer (hit ≥ 44,
 * libellés injectés — la copy i18n reste côté app). `onChange` émet à chaque fin
 * de tracé / effacement : { isEmpty, strokes, dataUrl } — le dataURL est l'image
 * SVG de la signature (encre = ink900 du thème par défaut ; zéro hex ici).
 */
import { useRef, useState } from 'react';
import { PanResponder, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { font, useTheme } from '../theme';
import {
  appendPoint,
  isSignatureEmpty,
  signatureToDataUrl,
  strokeToSvgPath,
  SIGNATURE_STROKE_WIDTH,
  type Stroke,
  type StrokePoint,
} from './signature-pad.logic';

export type { Stroke, StrokePoint };

export interface SignaturePadValue {
  isEmpty: boolean;
  strokes: readonly Stroke[];
  /** Image SVG de la signature (dataURL) — null tant que rien n'est tracé. */
  dataUrl: string | null;
}

export interface SignaturePadProps {
  /** Hauteur de la zone de tracé (défaut 160 — hit-target largement ≥ 44). */
  height?: number;
  /** Encre (défaut ink900) — toujours un token du thème. */
  strokeColor?: string;
  strokeWidth?: number;
  /** Libellé du bouton Effacer (i18n injecté par l'app). */
  clearLabel: string;
  /** Invite affichée tant que la zone est vierge (i18n injecté). */
  placeholder?: string;
  accessibilityLabel?: string;
  onChange?: (value: SignaturePadValue) => void;
}

/** Hauteur par défaut de la zone de tracé (réf proto : pad 128 + marge de confort doigt). */
const DEFAULT_PAD_HEIGHT = 160;

export function SignaturePad({
  height = DEFAULT_PAD_HEIGHT,
  strokeColor,
  strokeWidth = SIGNATURE_STROKE_WIDTH,
  clearLabel,
  placeholder,
  accessibilityLabel,
  onChange,
}: SignaturePadProps) {
  const { colors, controls, radius } = useTheme();
  const ink = strokeColor ?? colors.ink900;

  const [strokes, setStrokes] = useState<readonly Stroke[]>([]);
  const [active, setActive] = useState<Stroke | null>(null);

  // Les handlers PanResponder sont créés UNE fois : tout état lu pendant le geste
  // passe par des refs (jamais de closure périmée), le rendu passe par setState.
  const activeRef = useRef<Stroke>([]);
  const strokesRef = useRef<readonly Stroke[]>([]);
  const renderRef = useRef({ ink, strokeWidth, size: { width: 0, height } });
  renderRef.current.ink = ink;
  renderRef.current.strokeWidth = strokeWidth;
  renderRef.current.size.height = height;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const emitRef = useRef((all: readonly Stroke[]): void => {
    const { ink: color, strokeWidth: width, size } = renderRef.current;
    onChangeRef.current?.({
      isEmpty: isSignatureEmpty(all),
      strokes: all,
      dataUrl: signatureToDataUrl(all, {
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height)),
        strokeColor: color,
        strokeWidth: width,
      }),
    });
  });

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        activeRef.current = appendPoint([], {
          x: event.nativeEvent.locationX,
          y: event.nativeEvent.locationY,
        });
        setActive(activeRef.current);
      },
      onPanResponderMove: (event) => {
        activeRef.current = appendPoint(activeRef.current, {
          x: event.nativeEvent.locationX,
          y: event.nativeEvent.locationY,
        });
        setActive(activeRef.current);
      },
      onPanResponderRelease: () => {
        if (activeRef.current.length > 0) {
          strokesRef.current = [...strokesRef.current, activeRef.current];
          setStrokes(strokesRef.current);
          emitRef.current(strokesRef.current);
        }
        activeRef.current = [];
        setActive(null);
      },
      onPanResponderTerminate: () => {
        activeRef.current = [];
        setActive(null);
      },
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  const onLayout = (event: LayoutChangeEvent): void => {
    renderRef.current.size = {
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height,
    };
  };

  const clear = (): void => {
    strokesRef.current = [];
    activeRef.current = [];
    setStrokes([]);
    setActive(null);
    emitRef.current([]);
  };

  const rendered = active !== null ? [...strokes, active] : strokes;
  const empty = rendered.every((stroke) => stroke.length === 0) && active === null;

  return (
    <View>
      <View
        onLayout={onLayout}
        {...pan.panHandlers}
        accessibilityRole="image"
        {...(accessibilityLabel !== undefined ? { accessibilityLabel } : {})}
        style={{
          height,
          borderRadius: radius.card,
          borderWidth: 1,
          borderColor: controls.cardBorder,
          backgroundColor: colors.surface,
          overflow: 'hidden',
        }}
      >
        {empty && placeholder !== undefined ? (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={[font('sub', 600), { color: colors.slate300 }]}>{placeholder}</Text>
          </View>
        ) : null}
        <Svg width="100%" height="100%">
          {rendered.map((stroke, i) => {
            const d = strokeToSvgPath(stroke);
            if (d === '') return null;
            return (
              <Path
                key={i}
                d={d}
                fill="none"
                stroke={ink}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
        </Svg>
      </View>
      <Pressable
        onPress={clear}
        disabled={strokes.length === 0}
        accessibilityRole="button"
        accessibilityLabel={clearLabel}
        accessibilityState={{ disabled: strokes.length === 0 }}
        style={{ alignSelf: 'flex-end', minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 8 }}
      >
        <Text
          style={[
            font('label', 600),
            { color: strokes.length === 0 ? colors.slate300 : colors.slate500 },
          ]}
        >
          {clearLabel}
        </Text>
      </Pressable>
    </View>
  );
}
