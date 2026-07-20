export const PASSWORD_RECOVERY_ROUTE = '/auth/recovery' as const;
export const PASSWORD_RECOVERY_SCHEME = 'bobpro' as const;

const MAX_RECOVERY_URL_LENGTH = 16_384;
const MAX_RECOVERY_PROOF_LENGTH = 12_288;
export const MIN_RECOVERY_PASSWORD_LENGTH = 8;
export const MAX_RECOVERY_PASSWORD_LENGTH = 256;

export type PasswordRecoveryProof =
  | Readonly<{ kind: 'implicit'; accessToken: string; refreshToken: string }>
  | Readonly<{ kind: 'pkce'; code: string }>;

export type PasswordRecoveryLinkFailure = 'not_recovery_route' | 'invalid_link' | 'expired_link';

export type ParsedPasswordRecoveryLink =
  | Readonly<{ ok: true; proof: PasswordRecoveryProof }>
  | Readonly<{ ok: false; reason: PasswordRecoveryLinkFailure }>;

export type PasswordRecoveryErrorCode =
  | 'invalid_link'
  | 'expired_link'
  | 'weak_password'
  | 'network'
  | 'rate_limited'
  | 'not_ready'
  | 'unknown';

export type PasswordRecoveryState = Readonly<{
  phase: 'idle' | 'establishing' | 'ready' | 'updating' | 'success' | 'error';
  error: PasswordRecoveryErrorCode | null;
}>;

export type PasswordRecoveryEvent =
  | Readonly<{ type: 'link_started' }>
  | Readonly<{ type: 'session_ready' }>
  | Readonly<{ type: 'link_failed'; error: PasswordRecoveryErrorCode }>
  | Readonly<{ type: 'update_started' }>
  | Readonly<{ type: 'update_succeeded' }>
  | Readonly<{ type: 'update_failed'; error: PasswordRecoveryErrorCode }>
  | Readonly<{ type: 'reset' }>;

export const initialPasswordRecoveryState: PasswordRecoveryState = {
  phase: 'idle',
  error: null,
};

/**
 * La forme `bobpro://auth/recovery` donne `auth` comme host, alors que la forme
 * triple-slash donne `/auth/recovery` comme pathname. Les deux sont valides, mais aucune
 * route voisine n'est acceptée : un lien OAuth générique ne doit jamais ouvrir ce flux.
 */
function isRecoveryUrlObject(url: URL): boolean {
  if (url.protocol !== `${PASSWORD_RECOVERY_SCHEME}:`) return false;
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return (
    (url.hostname === 'auth' && pathname === '/recovery') ||
    (url.hostname === '' && pathname === PASSWORD_RECOVERY_ROUTE)
  );
}

export function isPasswordRecoveryUrl(rawUrl: string): boolean {
  if (rawUrl.length === 0 || rawUrl.length > MAX_RECOVERY_URL_LENGTH) return false;
  try {
    return isRecoveryUrlObject(new URL(rawUrl));
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
  if (value.length === 0 || value.length > MAX_RECOVERY_PROOF_LENGTH) return 'ambiguous';
  return value;
}

function providerFailure(url: URL): PasswordRecoveryLinkFailure | null {
  const errorCode = singleValue(url, 'error_code');
  const error = singleValue(url, 'error');
  if (errorCode === 'ambiguous' || error === 'ambiguous') return 'invalid_link';
  if (errorCode === null && error === null) return null;
  const code = `${errorCode ?? ''} ${error ?? ''}`.toLowerCase();
  return /expired|otp_expired|access_denied/.test(code) ? 'expired_link' : 'invalid_link';
}

/**
 * Parse uniquement une URL Bob Pro de récupération. Le résultat contient la preuve le temps de
 * l'échange Supabase ; l'appelant doit ensuite remplacer l'URL de navigation pour supprimer
 * query et fragment. Aucun message provider (potentiellement sensible) n'est remonté.
 */
export function parsePasswordRecoveryUrl(rawUrl: string): ParsedPasswordRecoveryLink {
  if (rawUrl.length === 0 || rawUrl.length > MAX_RECOVERY_URL_LENGTH) {
    return { ok: false, reason: 'invalid_link' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_link' };
  }
  if (!isRecoveryUrlObject(url)) return { ok: false, reason: 'not_recovery_route' };

  const providerError = providerFailure(url);
  if (providerError) return { ok: false, reason: providerError };

  const type = singleValue(url, 'type');
  const code = singleValue(url, 'code');
  const accessToken = singleValue(url, 'access_token');
  const refreshToken = singleValue(url, 'refresh_token');
  if ([type, code, accessToken, refreshToken].includes('ambiguous')) {
    return { ok: false, reason: 'invalid_link' };
  }
  if (type !== null && type !== 'recovery') return { ok: false, reason: 'invalid_link' };

  const hasCode = typeof code === 'string';
  const hasAccessToken = typeof accessToken === 'string';
  const hasRefreshToken = typeof refreshToken === 'string';
  if (hasCode && (hasAccessToken || hasRefreshToken)) {
    return { ok: false, reason: 'invalid_link' };
  }
  if (hasCode) return { ok: true, proof: { kind: 'pkce', code } };
  if (hasAccessToken && hasRefreshToken && type === 'recovery') {
    return {
      ok: true,
      proof: { kind: 'implicit', accessToken, refreshToken },
    };
  }
  return { ok: false, reason: 'invalid_link' };
}

export type RecoveryPasswordValidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'required' | 'too_short' | 'too_long' | 'mismatch' }>;

export function validateRecoveryPassword(
  password: string,
  confirmation: string,
): RecoveryPasswordValidation {
  if (password.length === 0 || confirmation.length === 0) return { ok: false, reason: 'required' };
  if (password.length < MIN_RECOVERY_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
  if (password.length > MAX_RECOVERY_PASSWORD_LENGTH) return { ok: false, reason: 'too_long' };
  if (password !== confirmation) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}

export function passwordRecoveryReducer(
  state: PasswordRecoveryState,
  event: PasswordRecoveryEvent,
): PasswordRecoveryState {
  switch (event.type) {
    case 'link_started':
      return { phase: 'establishing', error: null };
    case 'session_ready':
      return { phase: 'ready', error: null };
    case 'link_failed':
      return { phase: 'error', error: event.error };
    case 'update_started':
      return state.phase === 'ready' ? { phase: 'updating', error: null } : state;
    case 'update_succeeded':
      return state.phase === 'updating' ? { phase: 'success', error: null } : state;
    case 'update_failed':
      if (state.phase !== 'updating') return state;
      return event.error === 'expired_link' ||
        event.error === 'invalid_link' ||
        event.error === 'not_ready'
        ? { phase: 'error', error: event.error }
        : { phase: 'ready', error: event.error };
    case 'reset':
      return initialPasswordRecoveryState;
  }
}
