import { t, type I18nKey } from '@bob/i18n';

export type CabinetI18nKey = Extract<I18nKey, `cabinet.${string}`>;

export function tc(
  key: CabinetI18nKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  return t(key, params === undefined ? { personality: 'pro' } : { personality: 'pro', params });
}
