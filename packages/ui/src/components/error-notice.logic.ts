/**
 * ErrorNotice — logique PURE des deux faces d'une erreur (SPEC_SYSTEME_ERREUR §6), testée sans
 * React Native :
 *  · face UTILISATEUR : message actionnable (i18n, fourni par l'écran — jamais reformulé ici) +
 *    code court discret « BOB-… » ;
 *  · face DÉVELOPPEUR : type (kind), corrélation complète, heure — dépliée au chevron (cible
 *    44 pt) ou à l'appui long, partageable en un texte SANS PII composé ici.
 */
import { t, type Personality } from '@bob/i18n';
import { surfaceTint } from '@bob/tokens';

/** Cible tactile minimale du bouton de repli (HIG iOS / WCAG 2.2 « Target Size » : ≥ 44 pt). */
export const ERROR_NOTICE_HIT_TARGET = 44;

/** Apparence du composant — `light` (défaut, rendu historique inchangé) ou `dark` (Lot 0). */
export type ErrorNoticeAppearance = 'light' | 'dark';

export interface ErrorNoticeDarkFace {
  readonly border: string;
  readonly bg: string;
  /** Texte principal (message, valeurs de DetailRow, bouton Partager). */
  readonly ink: string;
  /** Texte secondaire (chip de code, libellés, chevron). */
  readonly inkMuted: string;
  /** Fond du chip de code et filet de séparation de la face développeur. */
  readonly chipBg: string;
}

/**
 * FACE SOMBRE (Lot 0, plan DA 01/08 — pour les panneaux on-dark du diagnostic) : la
 * matière danger SOMBRE du kit (surfaceTint.dark.danger), dont les encres sont déjà
 * certifiées AA sur flat ET raised (surface-tint, index.test.ts de @bob/tokens).
 * Pure — testée en littéraux, sans React Native.
 */
export function errorNoticeDarkFace(): ErrorNoticeDarkFace {
  const spec = surfaceTint.dark.danger;
  return {
    border: spec.border,
    bg: spec.flat,
    ink: spec.ink,
    inkMuted: spec.inkMuted,
    chipBg: spec.raised,
  };
}

export interface ErrorNoticeFacts {
  /** Code court du registre fermé (`bobErrorCode` / `error.code`). */
  readonly code: string;
  /** Identifiant de corrélation complet — absent pour une erreur purement locale. */
  readonly correlationId?: string | null;
  /** `kind` de l'AppError — absent pour un échec non typé. */
  readonly kind?: string | null;
  /** Horodatage ISO de l'échec ; l'affichage court est dérivé ici. */
  readonly at?: string | null;
}

export interface ErrorNoticeCopy {
  readonly detailsLabel: string;
  readonly hideLabel: string;
  readonly shareLabel: string;
  readonly referenceLabel: string;
  readonly correlationLabel: string;
  readonly kindLabel: string;
  readonly atLabel: string;
  readonly detailsHint: string;
}

/** Chrome i18n ×3 tons — résolu ICI pour que chaque écran n'ait à fournir que message + faits. */
export function resolveErrorNoticeCopy(personality: Personality): ErrorNoticeCopy {
  const options = { personality };
  return {
    detailsLabel: t('errors.noticeDetails', options),
    hideLabel: t('errors.noticeHide', options),
    shareLabel: t('errors.noticeShare', options),
    referenceLabel: t('errors.noticeReference', options),
    correlationLabel: t('errors.noticeCorrelation', options),
    kindLabel: t('errors.noticeKind', options),
    atLabel: t('errors.noticeAt', options),
    detailsHint: t('errors.noticeDetailsHint', options),
  };
}

/** Forme courte affichable d'une corrélation (préfixe UUID grep-able côté Railway). */
export function shortCorrelation(correlationId: string): string {
  return correlationId.slice(0, 8);
}

/** Heure locale courte « HH:MM » d'un ISO — chaîne vide si l'horodatage est illisible. */
export function shortTime(atIso: string): string {
  const date = new Date(atIso);
  if (Number.isNaN(date.getTime())) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Texte de partage de la face développeur — SANS PII par construction : uniquement le code du
 * registre, la corrélation, le kind et l'heure. Jamais le message (il peut citer une donnée
 * saisie), jamais de route ni de contenu.
 */
export function errorNoticeReportText(facts: ErrorNoticeFacts): string {
  const parts = [`Bob Pro — rapport d'erreur`, `code ${facts.code}`];
  if (facts.correlationId) parts.push(`correlation ${facts.correlationId}`);
  if (facts.kind) parts.push(`kind ${facts.kind}`);
  if (facts.at) {
    const time = shortTime(facts.at);
    if (time !== '') parts.push(`heure ${time}`);
  }
  return parts.join(' · ');
}

/** Résumé lu par les lecteurs d'écran : message d'abord, référence ensuite. */
export function errorNoticeAccessibilitySummary(message: string, code: string): string {
  return `${message} (référence ${code})`;
}
