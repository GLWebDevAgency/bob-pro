const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Contact déjà injecté dans les binaires mobile preview/production. Il reste remplaçable au
 * build par une adresse de marque, sans inventer une boîte qui ne serait pas surveillée.
 */
export const DEFAULT_SUPPORT_EMAIL = 'ghassenelimame@gmail.com';

export function resolveSupportEmail(
  value: string | undefined,
  options: { requireConfigured?: boolean } = {},
): string {
  const normalized = value?.trim();
  if (!normalized) {
    if (options.requireConfigured) {
      throw new Error('NEXT_PUBLIC_SUPPORT_EMAIL est requis pour un build Vercel distribué.');
    }
    return DEFAULT_SUPPORT_EMAIL;
  }
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new Error('NEXT_PUBLIC_SUPPORT_EMAIL doit être une adresse email valide.');
  }
  return normalized;
}

export const SUPPORT_EMAIL = resolveSupportEmail(process.env.NEXT_PUBLIC_SUPPORT_EMAIL, {
  requireConfigured: process.env.VERCEL === '1',
});

const DELETION_REQUEST_SUBJECT = 'Demande de suppression de compte Bob Pro';
const DELETION_REQUEST_BODY = `Bonjour,

Je souhaite demander la suppression de mon compte Bob Pro.

Email utilisé pour le compte :
Nom de l’entreprise :

Je n’inclus dans ce premier message ni mot de passe, ni token, ni pièce d’identité, ni document métier. Je comprends que Bob Pro vérifiera mon identité avant toute suppression.

Merci.`;

export function buildDeletionRequestMailto(email: string): string {
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error('Une adresse support valide est requise.');
  }
  const query = new URLSearchParams({
    subject: DELETION_REQUEST_SUBJECT,
    body: DELETION_REQUEST_BODY,
  });
  return `mailto:${email}?${query.toString()}`;
}

export const DELETION_REQUEST_MAILTO = buildDeletionRequestMailto(SUPPORT_EMAIL);
