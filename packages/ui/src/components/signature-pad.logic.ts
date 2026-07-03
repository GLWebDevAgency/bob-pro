/**
 * SignaturePad — logique pure de capture/lissage/sérialisation (réserve C03, C21).
 * Aucun import react-native : un tracé = liste de points, la sortie = SVG path
 * lissé (courbes quadratiques par points-milieux) et dataURL SVG auto-portée.
 * La couleur d'encre est INJECTÉE par le composant (useTheme) — aucun hex ici.
 */

export interface StrokePoint {
  readonly x: number;
  readonly y: number;
}

/** Un tracé continu (doigt posé → levé). */
export type Stroke = readonly StrokePoint[];

/** Distance minimale entre deux points retenus (px) — filtre le bruit du doigt. */
export const SIGNATURE_MIN_DISTANCE = 2;
/** Épaisseur du trait (réf proto : signature encre 2.4). */
export const SIGNATURE_STROKE_WIDTH = 2.4;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Ajoute un point au tracé s'il s'éloigne assez du précédent (anti-jitter),
 * en arrondissant à 0,1 px (sérialisation compacte, déterministe).
 */
export function appendPoint(
  stroke: Stroke,
  point: StrokePoint,
  minDistance: number = SIGNATURE_MIN_DISTANCE,
): Stroke {
  const last = stroke[stroke.length - 1];
  if (last !== undefined && Math.hypot(point.x - last.x, point.y - last.y) < minDistance) {
    return stroke;
  }
  return [...stroke, { x: round1(point.x), y: round1(point.y) }];
}

/** true tant qu'aucun point d'encre n'a été posé. */
export function isSignatureEmpty(strokes: readonly Stroke[]): boolean {
  return strokes.every((stroke) => stroke.length === 0);
}

/**
 * Lissage : la polyline du doigt (anguleuse) devient une suite de courbes
 * quadratiques passant par les points-milieux — rendu « encre ». Un point
 * isolé devient un point d'encre (micro-segment, visible avec linecap round).
 */
export function strokeToSvgPath(stroke: Stroke): string {
  const first = stroke[0];
  if (first === undefined) return '';
  if (stroke.length === 1) return `M ${first.x} ${first.y} l 0.1 0`;
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < stroke.length - 1; i++) {
    const control = stroke[i];
    const next = stroke[i + 1];
    if (control === undefined || next === undefined) break;
    d += ` Q ${control.x} ${control.y} ${round1((control.x + next.x) / 2)} ${round1((control.y + next.y) / 2)}`;
  }
  const last = stroke[stroke.length - 1];
  if (last !== undefined) d += ` L ${last.x} ${last.y}`;
  return d;
}

/** Un path par tracé (les tracés vides sont ignorés). */
export function strokesToSvgPaths(strokes: readonly Stroke[]): string[] {
  return strokes.map(strokeToSvgPath).filter((d) => d !== '');
}

export interface SignatureSvgOptions {
  width: number;
  height: number;
  /** Couleur d'encre injectée depuis le thème (jamais de hex en dur ici). */
  strokeColor: string;
  strokeWidth?: number;
}

/** Document SVG auto-porté de la signature (viewBox = zone de tracé). */
export function signatureToSvg(strokes: readonly Stroke[], options: SignatureSvgOptions): string {
  const strokeWidth = options.strokeWidth ?? SIGNATURE_STROKE_WIDTH;
  const paths = strokesToSvgPaths(strokes)
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="${options.strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}">${paths}</svg>`;
}

/** dataURL de la signature (image SVG) — null si rien n'a été tracé. */
export function signatureToDataUrl(
  strokes: readonly Stroke[],
  options: SignatureSvgOptions,
): string | null {
  if (isSignatureEmpty(strokes)) return null;
  return `data:image/svg+xml;utf8,${encodeURIComponent(signatureToSvg(strokes, options))}`;
}
