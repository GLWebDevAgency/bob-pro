/**
 * LegalHint — logique PURE de la divulgation progressive des protections légales, testée sans
 * React Native. Trois niveaux (doctrine fondateur : la formulation in-line dit le BÉNÉFICE,
 * jamais la contrainte) :
 *  (a) phrase in-line courte (label fourni par l'écran, déjà i18n ×3 tons) ;
 *  (b) icône « ? » discrète, cible tactile ≥ 44 pt ;
 *  (c) au tap : feuille 2 blocs — « Ce que dit la loi » (2-3 phrases simples) puis
 *      « Pourquoi Bob fait ça » (protection concrète) — et la source (article) en petit.
 * Les textes viennent de @bob/i18n via des CLÉS (props lawKey/whyKey) : le composant suit la
 * personnalité active (useTheme) sans que l'écran recompose jamais la copy légale.
 */
import { t, type I18nKey, type Personality } from '@bob/i18n';

/** Cible tactile MINIMALE de l'icône « ? » (HIG iOS / WCAG 2.2 « Target Size » : ≥ 44 pt). */
export const LEGAL_HINT_HIT_TARGET = 44;
/** Diamètre VISUEL de la pastille « ? » — discret ; la hitbox est étendue par hitSlop. */
export const LEGAL_HINT_ICON_DIAMETER = 22;
/**
 * Extension hitSlop du Pressable (pastille 22 pt → cible 44 pt RÉELLE). React Native ne délivre
 * JAMAIS une touche hors des bounds du parent (systématique sur Android) : des marges négatives
 * donneraient une hitbox fictive écrasée par la rangée — c'est pourquoi le composant impose
 * AUSSI `minHeight: LEGAL_HINT_HIT_TARGET` à sa rangée, pour que la zone étendue existe
 * physiquement dans le layout. Invariant testé : diamètre + 2 × slop ≥ cible.
 */
export const LEGAL_HINT_ICON_HIT_SLOP = (LEGAL_HINT_HIT_TARGET - LEGAL_HINT_ICON_DIAMETER) / 2;

export interface LegalHintContentInput {
  /** Clé i18n du bloc « Ce que dit la loi » (2-3 phrases simples, ×3 tons). */
  readonly lawKey: I18nKey;
  /** Clé i18n du bloc « Pourquoi Bob fait ça » (protection concrète, ×3 tons). */
  readonly whyKey: I18nKey;
  /** Source légale citée telle quelle (ex. « art. L221-10 du code de la consommation »). */
  readonly source: string;
  /** Interpolations partagées par les deux blocs (ex. { date: '09/06/2026' }). */
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface LegalHintCopy {
  readonly lawTitle: string;
  readonly lawBody: string;
  readonly whyTitle: string;
  readonly whyBody: string;
  /** Ligne source complète (« Source : art. … ») — affichée en petit, jamais tronquée. */
  readonly sourceLine: string;
  /** Libellé d'accessibilité du bouton « ? ». */
  readonly iconLabel: string;
  /** Hint d'accessibilité du bouton « ? » (ce que le tap ouvre). */
  readonly iconHint: string;
  /** Libellé annoncé à l'ouverture de la feuille. */
  readonly sheetLabel: string;
}

/** Résout toute la copy du hint pour la personnalité active — source unique, zéro texte en dur. */
export function resolveLegalHintCopy(
  input: LegalHintContentInput,
  personality: Personality,
): LegalHintCopy {
  const options = { personality, ...(input.params ? { params: input.params } : {}) };
  return {
    lawTitle: t('legalHint.lawTitle', { personality }),
    lawBody: t(input.lawKey, options),
    whyTitle: t('legalHint.whyTitle', { personality }),
    whyBody: t(input.whyKey, options),
    sourceLine: t('legalHint.sourceLabel', { personality, params: { source: input.source } }),
    iconLabel: t('legalHint.iconAccessibilityLabel', { personality }),
    iconHint: t('legalHint.iconAccessibilityHint', { personality }),
    sheetLabel: t('legalHint.sheetAccessibilityLabel', { personality }),
  };
}
