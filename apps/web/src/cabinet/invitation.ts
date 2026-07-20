export const CABINET_INVITATION_COOKIE = 'bob_cabinet_invitation';

export function invitationFromFragment(fragment: string): string | null {
  const token = new URLSearchParams(fragment.replace(/^#/, '')).get('invitation');
  return token && token.length >= 20 && token.length <= 1_024 ? token : null;
}

export async function stashInvitation(rawToken: string): Promise<boolean> {
  const response = await fetch('/auth/invitation/stash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: rawToken }),
  });
  return response.ok;
}

export async function acceptStashedInvitation(): Promise<'none' | 'accepted'> {
  const response = await fetch('/auth/invitation/accept', { method: 'POST' });
  if (!response.ok) throw new Error('invitation_accept_failed');
  if (response.status === 204) return 'none';
  const payload = await response.json() as { accepted?: unknown };
  return payload.accepted === true ? 'accepted' : 'none';
}
