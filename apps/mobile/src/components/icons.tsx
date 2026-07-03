/**
 * Icônes vectorielles de l'écran « Aujourd'hui » + tab bar — tracés EXACTS de la
 * référence visuelle (design_handoff_bob_pro/Bob Pro.dc.html), lucide-style 24×24.
 * @bob/ui n'embarque aucune lib d'icônes : l'app injecte ces nœuds (couleur/taille du slot).
 * Stroke par défaut : 1.9 (tab bar §14) / 2.2 (KPI §5) / 2 (pastilles) — comme la réf.
 */
import Svg, { Circle, Path, Rect } from 'react-native-svg';

export interface IconProps {
  color: string;
  size?: number;
  strokeWidth?: number;
}

const common = { fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/* ── Tab bar (23, stroke 1.9) ─────────────────────────────────────────────── */

/** Aujourd'hui — lever de soleil (soleil + horizon + rayons). */
export function SunriseIcon({ color, size = 23, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M3 18h18" />
      <Path d="M7 18a5 5 0 0 1 10 0" />
      <Path d="M12 3v3" />
      <Path d="M5.2 7.2l1.6 1.6" />
      <Path d="M18.8 7.2l-1.6 1.6" />
      <Path d="M2 13h2" />
      <Path d="M20 13h2" />
    </Svg>
  );
}

/** Clients — deux personnes. */
export function PeopleIcon({ color, size = 23, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Circle cx={9} cy={8} r={3.2} />
      <Path d="M3 20a6 6 0 0 1 12 0" />
      <Path d="M16 5.5a3 3 0 0 1 0 5.5" />
      <Path d="M18 20a6 6 0 0 0-3-5.2" />
    </Svg>
  );
}

/** Argent — portefeuille (rect + fente + pastille). */
export function WalletIcon({ color, size = 23, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Rect x={2.5} y={6} width={19} height={13} rx={3} />
      <Path d="M2.5 10.5h19" />
      <Circle cx={17.5} cy={14.5} r={1.3} fill={color} stroke="none" />
    </Svg>
  );
}

/** Documents — dossier à onglet. */
export function FolderIcon({ color, size = 23, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M4 4h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    </Svg>
  );
}

/** Assistant — UNE étincelle 4 branches. */
export function SparkIcon({ color, size = 23, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    </Svg>
  );
}

/* ── KPI « En un coup d'œil » (16, stroke 2.2) ────────────────────────────── */

/** On te doit — flèche de tendance sur base. */
export function TrendUpIcon({ color, size = 16, strokeWidth = 2.2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M5 12l5-5" />
      <Path d="M5 7h5v5" />
      <Path d="M5 17h14" />
    </Svg>
  );
}

/** En retard — horloge. */
export function ClockIcon({ color, size = 16, strokeWidth = 2.2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 7v5l3 2" />
    </Svg>
  );
}

/** TVA à garder — glyphe monétaire de la réf. */
export function CurrencyIcon({ color, size = 16, strokeWidth = 2.2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M12 2v20" />
      <Path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </Svg>
  );
}

/** Fin de mois — calendrier. */
export function CalendarIcon({ color, size = 16, strokeWidth = 2.2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Rect x={3} y={4} width={18} height={16} rx={2} />
      <Path d="M3 9h18" />
      <Path d="M8 2v4" />
      <Path d="M16 2v4" />
    </Svg>
  );
}

/* ── Carte trésorerie & priorités ─────────────────────────────────────────── */

/** Chevron › (cercle de la carte tréso : 15/2.4 slate400 · CTA diagnostic : 15/2.2 blanc). */
export function ChevronRightIcon({ color, size = 15, strokeWidth = 2.4 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M9 6l6 6-6 6" />
    </Svg>
  );
}

/** « Tu peux te verser » — flèche déposée dans un bac (download-into-tray). */
export function DepositIcon({ color, size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M12 3v11" />
      <Path d="M7.5 9.5L12 14l4.5-4.5" />
      <Path d="M5 20h14" />
    </Svg>
  );
}

/** Conformité — bouclier (puce 26 radius 8 b2gBg, stroke b2g). */
export function ShieldIcon({ color, size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  );
}
