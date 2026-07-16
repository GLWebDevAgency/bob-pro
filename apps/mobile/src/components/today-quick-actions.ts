import type { I18nKey } from '@bob/i18n';
import type { QuickActionTone } from '@bob/ui';

export type TodayQuickAction = Readonly<{
  id: 'quote' | 'scan' | 'collect' | 'catalogue';
  labelKey: I18nKey;
  route: '/devis/new' | '/scan-document' | '/ventes' | '/catalogue';
  icon: 'file' | 'camera' | 'credit-card' | 'book';
  tone: Extract<QuickActionTone, 'b2b' | 'ai' | 'warning' | 'success'>;
}>;

/**
 * Raccourcis manuels de la Home. La voix n'est volontairement pas une action de cette liste :
 * son point d'entrée unique est l'orbe Bob persistante, qui conserve la conversation et le
 * contexte au lieu d'ouvrir l'ancien wizard facture.
 */
export const TODAY_QUICK_ACTIONS: readonly TodayQuickAction[] = Object.freeze([
  Object.freeze({
    id: 'quote',
    labelKey: 'today.quickQuote',
    route: '/devis/new',
    icon: 'file',
    tone: 'b2b',
  }),
  Object.freeze({
    id: 'scan',
    labelKey: 'today.quickScan',
    route: '/scan-document',
    icon: 'camera',
    tone: 'ai',
  }),
  Object.freeze({
    id: 'collect',
    labelKey: 'today.quickCollect',
    route: '/ventes',
    icon: 'credit-card',
    tone: 'warning',
  }),
  Object.freeze({
    id: 'catalogue',
    labelKey: 'today.quickCatalogue',
    route: '/catalogue',
    icon: 'book',
    tone: 'success',
  }),
]);
