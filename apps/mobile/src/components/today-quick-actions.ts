import type { I18nKey } from '@bob/i18n';
import type { QuickActionTone } from '@bob/ui';

export type TodayQuickAction = Readonly<{
  id: 'quote' | 'invoice' | 'scan' | 'collect' | 'catalogue';
  labelKey: I18nKey;
  route: '/devis/new' | '/facture/new' | '/scan-document' | '/ventes' | '/catalogue';
  icon: 'file' | 'file-plus' | 'camera' | 'credit-card' | 'book';
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
  // B1 : la facture DIRECTE (sans devis signé) a sa place dans « Vite fait » — le dépannage
  // urgent et la fin de mois de régie se facturent en trois étapes depuis la Home.
  Object.freeze({
    id: 'invoice',
    labelKey: 'today.quickInvoice',
    route: '/facture/new',
    icon: 'file-plus',
    tone: 'success',
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
