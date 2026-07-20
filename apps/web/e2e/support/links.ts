function candidateUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function linksFromPart(part: unknown): string[] {
  if (typeof part !== 'object' || part === null) return [];
  const record = part as Record<string, unknown>;
  const structured = Array.isArray(record.links)
    ? record.links.flatMap((link) => {
        if (typeof link !== 'object' || link === null) return [];
        const href = (link as Record<string, unknown>).href;
        return typeof href === 'string' ? [href] : [];
      })
    : [];
  const body = typeof record.body === 'string' ? record.body : '';
  return [...structured, ...(body.match(/https:\/\/[^\s<>"']+/g) ?? [])];
}

export function extractHttpsLinks(message: unknown): URL[] {
  if (typeof message !== 'object' || message === null) return [];
  const record = message as Record<string, unknown>;
  const unique = new Map<string, URL>();
  for (const value of [...linksFromPart(record.html), ...linksFromPart(record.text)]) {
    const parsed = candidateUrl(value.replace(/[).,;]+$/, ''));
    if (parsed !== null) unique.set(parsed.toString(), parsed);
  }
  return [...unique.values()];
}

export function isSupabaseMagicLink(
  link: URL,
  supabaseOrigin: string,
  webOrigin: string,
): boolean {
  if (link.origin !== supabaseOrigin || link.pathname !== '/auth/v1/verify') return false;
  const redirect = link.searchParams.get('redirect_to');
  if (!redirect) return false;
  try {
    const destination = new URL(redirect);
    return destination.origin === webOrigin && destination.pathname === '/auth/callback';
  } catch {
    return false;
  }
}

export function invitationTokenFromLink(link: URL, webOrigin: string): string | null {
  if (link.origin !== webOrigin || link.pathname !== '/cabinet') return null;
  const token = new URLSearchParams(link.hash.replace(/^#/, '')).get('invitation');
  return token && token.length >= 20 && token.length <= 256 ? token : null;
}
