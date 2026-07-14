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

/** « Trésorerie mobilisable » — flèche déposée dans un bac (download-into-tray). */
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

/* ── Écran Clients (C12) ──────────────────────────────────────────────────── */

/** Recherche — loupe (champ « Rechercher un client… », 18/2 slate300 — tracé exact du proto). */
export function SearchIcon({ color, size = 18, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Circle cx={11} cy={11} r={7} />
      <Path d="M21 21l-4.3-4.3" />
    </Svg>
  );
}

/** Plus — nouveau client (bouton navy du header : 22/2.4 blanc — tracé exact du proto). */
export function PlusIcon({ color, size = 22, strokeWidth = 2.4 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/* ── Fiche client (C13) ───────────────────────────────────────────────────── */

/** Chevron ‹ — barre retour « ‹ Clients » (18/2.2 ink800). */
export function ChevronLeftIcon({ color, size = 18, strokeWidth = 2.2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M15 6l-6 6 6 6" />
    </Svg>
  );
}

/** « … » — menu de la fiche (3 points pleins, pastille du header). */
export function EllipsisIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={5} cy={12} r={1.7} fill={color} />
      <Circle cx={12} cy={12} r={1.7} fill={color} />
      <Circle cx={19} cy={12} r={1.7} fill={color} />
    </Svg>
  );
}

/** Document à coin plié + lignes — tuile « Devis » et rangées d'activité (lucide file-text). */
export function FileTextIcon({ color, size = 18, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <Path d="M14 3v5h5" />
      <Path d="M9 13h6" />
      <Path d="M9 17h6" />
    </Svg>
  );
}

/** Avion papier — tuile « Relancer » (lucide send). */
export function SendIcon({ color, size = 18, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M22 2L11 13" />
      <Path d="M22 2l-7 20-4-9-9-4z" />
    </Svg>
  );
}

/** Combiné — tuile « Appeler » (lucide phone). */
export function PhoneIcon({ color, size = 18, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </Svg>
  );
}

/** Enveloppe — tuile « Email » (lucide mail). */
export function MailIcon({ color, size = 18, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Rect x={3} y={5} width={18} height={14} rx={2} />
      <Path d="M3 7l9 6 9-6" />
    </Svg>
  );
}

/* ── Écran Documents (C14) — tracés exacts du proto §isDocs ───────────────── */

/** Tuile dossier — dossier plat 18/2 (différent du dossier à onglet de la tab bar). */
export function FolderSmallIcon({ color, size = 18, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M3 7h5l2 2h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
    </Svg>
  );
}

/** « Mois prêt pour le comptable » — presse-papiers coché 17/2 success. */
export function ClipboardCheckIcon({ color, size = 17, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <Rect x={9} y={2} width={6} height={4} rx={1} />
      <Path d="M9 14l2 2 4-4" />
    </Svg>
  );
}

/** Mémoire fournisseurs — bulle de dialogue 16/2 violet deep. */
export function ChatIcon({ color, size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M4 4h16v12H5.2L4 17.2z" />
      <Path d="M8 9h8" />
      <Path d="M8 12h5" />
    </Svg>
  );
}

/** Suggestion IA de la carte « À valider » — petite étincelle 15/2 indigo. */
export function SparkSmallIcon({ color, size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M12 3l1.6 4.6L18 9l-4.4 1.4L12 15l-1.6-4.6L6 9l4.4-1.4z" />
    </Svg>
  );
}

/* ── Écran Assistant (C15) — tracés exacts du proto §isAssistant ──────────── */

/** Micro — bouton dictée de l'input (18/2 slate500 — branché au claim C20). */
export function MicIcon({ color, size = 18, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Rect x={9} y={2} width={6} height={12} rx={3} />
      <Path d="M5 10a7 7 0 0 0 14 0" />
      <Path d="M12 18v3" />
    </Svg>
  );
}

/** Rangée facture récente — fichier à coin plié 16/2 (tracé Feather « file » du proto). */
export function FileIcon({ color, size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <Path d="M14 2v6h6" />
    </Svg>
  );
}

/* ── Flux « Facture à la voix » (C20) — tracés exacts du proto §showVoice ──── */

/** Fermer — croix des surcouches plein écran (16/2.2 sur pastille). */
export function CloseIcon({ color, size = 16, strokeWidth = 2.2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

/** Coche — succès (écran vert 48/2.6, toast 16). */
export function CheckIcon({ color, size = 16, strokeWidth = 2.6 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M4 12.5l5 5L20 6.5" />
    </Svg>
  );
}

/* ── Écran Détail pièce (C16) — tracés exacts du proto §showPiece ───────────
   NB coordination : CloseIcon (C20, plus haut) et SendIcon (C13) existent déjà —
   mêmes tracés, seul le défaut de taille diffère : passer size/strokeWidth au call-site. */

/** Pièce liée — flèche de retour 17/2 (devis d'origine ↔ facture). */
export function ReturnArrowIcon({ color, size = 17, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M4 7h11a4 4 0 0 1 0 8H9" />
      <Path d="M8 11l-4 4 4 4" />
    </Svg>
  );
}

/** Avoir — flèche circulaire 17/2. */
export function RotateIcon({ color, size = 17, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M3 12a9 9 0 1 0 9-9" />
      <Path d="M3 4v5h5" />
    </Svg>
  );
}

/** Situation de travaux — courbe d'avancement 17/2. */
export function ChartIcon({ color, size = 17, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Path d="M3 3v18h18" />
      <Path d="M7 14l3-3 3 3 5-6" />
    </Svg>
  );
}

/** Cadenas — mentions figées 11/2.4. */
export function LockIcon({ color, size = 11, strokeWidth = 2.4 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...common}>
      <Rect x={5} y={11} width={14} height={10} rx={2} />
      <Path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  );
}
