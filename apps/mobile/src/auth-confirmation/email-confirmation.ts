/**
 * Confirmation d'inscription (bug fondateur « email → localhost », 2026-07) : le signUp Supabase
 * n'envoyait AUCUN `emailRedirectTo` → GoTrue retombait sur la Site URL du projet (défaut
 * `http://localhost:3000`) et le lien de confirmation était inutilisable. Ce module porte :
 *   1. la cible de redirection explicite du signUp/resend (page relais sign-web `/auth/confirme`
 *      si configurée, sinon deep link `bobpro:///auth/callback`) ;
 *   2. le parseur durci du deep link de retour (miroir de password-recovery.ts) : PKCE `?code=`
 *      prioritaire, implicite `#access_token…&type=signup` accepté, erreurs provider mappées
 *      sans jamais remonter un message brut.
 * Les DEUX cibles doivent figurer dans Supabase Auth → URL Configuration → Redirect URLs
 * (voir docs/deploiement/urls-et-redirections.md pour les valeurs exactes par environnement).
 */
export const EMAIL_CONFIRMATION_ROUTE = '/auth/callback' as const;
export const EMAIL_CONFIRMATION_SCHEME = 'bobpro' as const;
/** Chemin de la page relais web (sign-web) — reçoit le redirect http(s) de GoTrue puis rouvre l'app. */
export const EMAIL_CONFIRMATION_WEB_RELAY_PATH = '/auth/confirme' as const;

const MAX_CONFIRMATION_URL_LENGTH = 16_384;
const MAX_CONFIRMATION_PROOF_LENGTH = 12_288;

export type EmailConfirmationProof =
  | Readonly<{ kind: 'implicit'; accessToken: string; refreshToken: string }>
  | Readonly<{ kind: 'pkce'; code: string }>;

export type EmailConfirmationLinkFailure =
  | 'not_confirmation_route'
  | 'invalid_link'
  | 'expired_link';

/**
 * `proof: null` = retour de confirmation SANS preuve de session : GoTrue ne redirige vers
 * `redirect_to` qu'APRÈS avoir vérifié l'email — l'arrivée sans paramètre d'erreur signifie
 * « compte confirmé, connexion manuelle » (ex. lien ouvert sur un autre appareil que celui
 * du signUp : le code PKCE y est inutilisable, le compte est pourtant bien activé).
 */
export type ParsedEmailConfirmationLink =
  | Readonly<{ ok: true; proof: EmailConfirmationProof | null }>
  | Readonly<{ ok: false; reason: EmailConfirmationLinkFailure }>;

export type EmailConfirmationErrorCode =
  | 'invalid_link'
  | 'expired_link'
  | 'network'
  | 'rate_limited'
  | 'unknown';

export type EmailConfirmationState = Readonly<{
  /**
   * `signed_in` : preuve échangée, session publiée — l'app entre directement.
   * `confirmed` : email vérifié mais pas de session sur CET appareil — connexion manuelle.
   */
  phase: 'idle' | 'confirming' | 'signed_in' | 'confirmed' | 'error';
  error: EmailConfirmationErrorCode | null;
}>;

export const initialEmailConfirmationState: EmailConfirmationState = {
  phase: 'idle',
  error: null,
};

/**
 * Cible http(s) du `emailRedirectTo` d'inscription : la page relais sign-web. Origine durcie
 * comme SIGN_WEB_BASE_URL côté API : HTTPS canonique, jamais localhost/démo, jamais de
 * credentials/query/hash. Valeur absente → null (l'appelant retombe sur le deep link) ;
 * valeur PRÉSENTE mais invalide → erreur franche au démarrage (même politique que supabase.ts :
 * une config d'auth cassée ne doit jamais échouer en silence vers localhost).
 */
export function emailConfirmationWebRelayUrl(raw: string | undefined): string | null {
  const configured = raw?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      'EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL invalide : URL absolue HTTPS attendue.',
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === 'demo.bobpro.fr' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL doit être une URL HTTPS live canonique ' +
        '(sans localhost/démo, sans identifiants, sans query ni fragment).',
    );
  }
  return url.toString();
}

/**
 * Même dualité que le parseur recovery : `bobpro://auth/callback` donne `auth` comme host,
 * la forme triple-slash donne `/auth/callback` comme pathname. Aucune route voisine acceptée.
 */
function isConfirmationUrlObject(url: URL): boolean {
  if (url.protocol !== `${EMAIL_CONFIRMATION_SCHEME}:`) return false;
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return (
    (url.hostname === 'auth' && pathname === '/callback') ||
    (url.hostname === '' && pathname === EMAIL_CONFIRMATION_ROUTE)
  );
}

export function isEmailConfirmationUrl(rawUrl: string): boolean {
  if (rawUrl.length === 0 || rawUrl.length > MAX_CONFIRMATION_URL_LENGTH) return false;
  try {
    return isConfirmationUrlObject(new URL(rawUrl));
  } catch {
    return false;
  }
}

function collectValues(url: URL, name: string): string[] {
  const query = url.searchParams.getAll(name);
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  return [...query, ...fragment.getAll(name)];
}

function singleValue(url: URL, name: string): string | null | 'ambiguous' {
  const values = collectValues(url, name);
  if (values.length === 0) return null;
  if (values.length !== 1) return 'ambiguous';
  const value = values[0]?.trim() ?? '';
  if (value.length === 0 || value.length > MAX_CONFIRMATION_PROOF_LENGTH) return 'ambiguous';
  return value;
}

function providerFailure(url: URL): EmailConfirmationLinkFailure | null {
  const errorCode = singleValue(url, 'error_code');
  const error = singleValue(url, 'error');
  if (errorCode === 'ambiguous' || error === 'ambiguous') return 'invalid_link';
  if (errorCode === null && error === null) return null;
  const code = `${errorCode ?? ''} ${error ?? ''}`.toLowerCase();
  return /expired|otp_expired|access_denied/.test(code) ? 'expired_link' : 'invalid_link';
}

/**
 * Parse uniquement une URL Bob Pro de retour de confirmation. La preuve éventuelle ne vit que
 * le temps de l'échange Supabase ; l'appelant remplace ensuite l'URL de navigation pour
 * supprimer query et fragment. Aucun message provider (potentiellement sensible) n'est remonté.
 */
export function parseEmailConfirmationUrl(rawUrl: string): ParsedEmailConfirmationLink {
  if (rawUrl.length === 0 || rawUrl.length > MAX_CONFIRMATION_URL_LENGTH) {
    return { ok: false, reason: 'invalid_link' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_link' };
  }
  if (!isConfirmationUrlObject(url)) return { ok: false, reason: 'not_confirmation_route' };

  const providerError = providerFailure(url);
  if (providerError) return { ok: false, reason: providerError };

  const type = singleValue(url, 'type');
  const code = singleValue(url, 'code');
  const accessToken = singleValue(url, 'access_token');
  const refreshToken = singleValue(url, 'refresh_token');
  if ([type, code, accessToken, refreshToken].includes('ambiguous')) {
    return { ok: false, reason: 'invalid_link' };
  }
  // `signup` (confirmation initiale) et `email_change` restent hors du flux recovery ; le
  // PKCE arrive sans `type` du tout (`?code=` seul).
  if (type !== null && type !== 'signup') return { ok: false, reason: 'invalid_link' };

  const hasCode = typeof code === 'string';
  const hasAccessToken = typeof accessToken === 'string';
  const hasRefreshToken = typeof refreshToken === 'string';
  if (hasCode && (hasAccessToken || hasRefreshToken)) {
    return { ok: false, reason: 'invalid_link' };
  }
  if (hasCode) return { ok: true, proof: { kind: 'pkce', code } };
  if (hasAccessToken && hasRefreshToken && type === 'signup') {
    return {
      ok: true,
      proof: { kind: 'implicit', accessToken, refreshToken },
    };
  }
  if (hasAccessToken || hasRefreshToken) return { ok: false, reason: 'invalid_link' };
  // Redirect de vérification abouti sans preuve exploitable : compte confirmé, connexion manuelle.
  return { ok: true, proof: null };
}
