function requiredPublicConfig(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Configuration mobile incomplète : ${name} est requis.`);
  }
  return normalized;
}

/**
 * Mentions légales in-app. Les valeurs sont injectées par l'environnement certifié : aucun
 * domaine de démonstration ni contact fictif ne peut se retrouver silencieusement dans le binaire.
 * Le garde Expo valide en plus leur forme avant toute build.
 */
export const LEGAL_URLS = {
  terms: requiredPublicConfig('EXPO_PUBLIC_TERMS_URL', process.env.EXPO_PUBLIC_TERMS_URL),
  privacy: requiredPublicConfig('EXPO_PUBLIC_PRIVACY_URL', process.env.EXPO_PUBLIC_PRIVACY_URL),
} as const;

export const SUPPORT_EMAIL = requiredPublicConfig(
  'EXPO_PUBLIC_SUPPORT_EMAIL',
  process.env.EXPO_PUBLIC_SUPPORT_EMAIL,
);

export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
