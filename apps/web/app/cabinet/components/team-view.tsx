'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { canEditCabinetMemberRole, type CabinetAccessContext, type CabinetRole } from '@/src/cabinet/access';
import { CabinetApiError, type CabinetInvitationSummary, type CabinetMemberStatus, type CabinetMemberSummary } from '@/src/cabinet/api';
import { tc } from '@/src/cabinet/i18n';
import styles from '../cabinet.module.css';
import { AlertIcon, CheckIcon, RefreshIcon } from './icons';

type AuthenticatedAccess = Extract<CabinetAccessContext, { readonly mode: 'authenticated' }>;
type TeamState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly members: readonly CabinetMemberSummary[];
      readonly memberCursor: string | null;
      readonly hasMoreMembers: boolean;
      readonly invitations: readonly CabinetInvitationSummary[];
      readonly invitationCursor: string | null;
      readonly hasMoreInvitations: boolean;
    }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error' };

const ROLE_LABELS: Readonly<Record<CabinetRole, string>> = {
  admin: tc('cabinet.shell.roleAdmin'),
  manager: tc('cabinet.shell.roleManager'),
  collaborator: tc('cabinet.shell.roleCollaborator'),
};

const STATUS_LABELS: Readonly<Record<CabinetMemberStatus, string>> = {
  active: tc('cabinet.team.active'),
  suspended: tc('cabinet.team.suspended'),
  revoked: tc('cabinet.team.revoked'),
};

function dateLabel(value: string | null): string {
  if (value === null) return '—';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(value));
}

export function TeamView({ access }: { readonly access: AuthenticatedAccess }) {
  const [state, setState] = useState<TeamState>({ kind: 'loading' });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CabinetRole>('collaborator');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ readonly tone: 'success' | 'error'; readonly text: string } | null>(null);
  const canInvite = access.selectedCabinet.role === 'admin' || access.selectedCabinet.role === 'manager';

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const [memberPage, invitationPage] = await Promise.all([
        access.team.listMembers(access.selectedCabinet.id),
        canInvite
          ? access.team.listInvitations(access.selectedCabinet.id)
          : Promise.resolve({ items: [], nextCursor: null, hasMore: false }),
      ]);
      setState({
        kind: 'ready',
        members: memberPage.items,
        memberCursor: memberPage.nextCursor,
        hasMoreMembers: memberPage.hasMore,
        invitations: invitationPage.items,
        invitationCursor: invitationPage.nextCursor,
        hasMoreInvitations: invitationPage.hasMore,
      });
    } catch (error) {
      setState(error instanceof CabinetApiError && error.status === 403 ? { kind: 'forbidden' } : { kind: 'error' });
    }
  }, [access.selectedCabinet.id, access.team, canInvite]);

  useEffect(() => { void load(); }, [load]);

  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canInvite || busyId !== null) return;
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return;
    setBusyId('invite');
    setNotice(null);
    try {
      const invitation = await access.team.inviteMember(access.selectedCabinet.id, normalized, role);
      setEmail('');
      setNotice({ tone: 'success', text: tc('cabinet.team.invited', { email: invitation.email }) });
      await load();
    } catch {
      setNotice({ tone: 'error', text: tc('cabinet.team.error') });
    } finally {
      setBusyId(null);
    }
  };

  const mutate = async (
    member: CabinetMemberSummary,
    input: { readonly role?: CabinetRole; readonly status?: CabinetMemberStatus },
  ) => {
    if (busyId !== null) return;
    setBusyId(member.id);
    setNotice(null);
    try {
      const updated = await access.team.updateMember(access.selectedCabinet.id, member.id, input);
      setState((current) => current.kind === 'ready'
        ? { ...current, members: current.members.map((candidate) => candidate.id === updated.id ? updated : candidate) }
        : current);
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof CabinetApiError && error.code === 'CABINET_LAST_ADMIN_REQUIRED'
          ? tc('cabinet.team.lastAdmin')
          : tc('cabinet.team.error'),
      });
    } finally {
      setBusyId(null);
    }
  };

  const revokeInvitation = async (invitation: CabinetInvitationSummary) => {
    if (busyId !== null) return;
    if (!window.confirm(tc('cabinet.team.confirmRevokeInvitation'))) return;
    setBusyId(invitation.id);
    setNotice(null);
    try {
      await access.team.revokeInvitation(access.selectedCabinet.id, invitation.id);
      setState((current) => current.kind === 'ready'
        ? { ...current, invitations: current.invitations.filter((candidate) => candidate.id !== invitation.id) }
        : current);
    } catch {
      setNotice({ tone: 'error', text: tc('cabinet.team.error') });
    } finally {
      setBusyId(null);
    }
  };

  const loadMoreInvitations = async () => {
    if (state.kind !== 'ready' || !state.hasMoreInvitations || state.invitationCursor === null || busyId !== null) return;
    setBusyId('invitations-more');
    setNotice(null);
    try {
      const page = await access.team.listInvitations(access.selectedCabinet.id, state.invitationCursor);
      setState((current) => {
        if (current.kind !== 'ready') return current;
        const byId = new Map(current.invitations.map((invitation) => [invitation.id, invitation]));
        for (const invitation of page.items) byId.set(invitation.id, invitation);
        return {
          ...current,
          invitations: [...byId.values()],
          invitationCursor: page.nextCursor,
          hasMoreInvitations: page.hasMore,
        };
      });
    } catch {
      setNotice({ tone: 'error', text: tc('cabinet.team.error') });
    } finally {
      setBusyId(null);
    }
  };

  const loadMoreMembers = async () => {
    if (state.kind !== 'ready' || !state.hasMoreMembers || state.memberCursor === null || busyId !== null) return;
    setBusyId('members-more');
    setNotice(null);
    try {
      const page = await access.team.listMembers(access.selectedCabinet.id, state.memberCursor);
      setState((current) => {
        if (current.kind !== 'ready') return current;
        const byId = new Map(current.members.map((member) => [member.id, member]));
        for (const member of page.items) byId.set(member.id, member);
        return {
          ...current,
          members: [...byId.values()],
          memberCursor: page.nextCursor,
          hasMoreMembers: page.hasMore,
        };
      });
    } catch {
      setNotice({ tone: 'error', text: tc('cabinet.team.error') });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitleBlock}>
          <h1 className={styles.pageTitle}>{tc('cabinet.team.title')}</h1>
          <p className={styles.pageIntro}>{tc('cabinet.team.intro')}</p>
        </div>
        <button className={styles.button} onClick={() => void load()} type="button"><RefreshIcon />{tc('cabinet.state.retry')}</button>
      </header>

      {notice ? (
        <div className={notice.tone === 'error' ? styles.errorNotice : styles.trustBanner} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.tone === 'error' ? <AlertIcon /> : <CheckIcon />}<span>{notice.text}</span>
        </div>
      ) : null}

      {canInvite ? (
        <section className={styles.panel}>
          <div className={styles.panelHeader}><h2>{tc('cabinet.team.inviteTitle')}</h2></div>
          <form className={styles.teamInviteForm} onSubmit={(event) => void invite(event)}>
            <div className={styles.field}>
              <label htmlFor="team-email">{tc('cabinet.team.email')}</label>
              <input autoComplete="email" id="team-email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
            </div>
            <div className={styles.field}>
              <label htmlFor="team-role">{tc('cabinet.team.role')}</label>
              <select id="team-role" onChange={(event) => setRole(event.target.value as CabinetRole)} value={role}>
                <option value="collaborator">{ROLE_LABELS.collaborator}</option>
                {access.selectedCabinet.role === 'admin' ? <option value="manager">{ROLE_LABELS.manager}</option> : null}
                {access.selectedCabinet.role === 'admin' ? <option value="admin">{ROLE_LABELS.admin}</option> : null}
              </select>
            </div>
            <button aria-busy={busyId === 'invite'} className={styles.buttonPrimary} disabled={busyId !== null} type="submit">
              {busyId === 'invite' ? tc('cabinet.team.inviting') : tc('cabinet.team.invite')}
            </button>
          </form>
          {state.kind === 'ready' && state.invitations.length > 0 ? (
            <div className={styles.pendingInvitations}>
              <strong>{tc('cabinet.team.pendingInvitations')}</strong>
              {state.invitations.map((invitation) => {
                const canRevoke = access.selectedCabinet.role === 'admin' || invitation.role === 'collaborator';
                return (
                  <div key={invitation.id}>
                    <span><strong>{invitation.email}</strong><small>{ROLE_LABELS[invitation.role]} · {tc('cabinet.team.expiresAt', { date: dateLabel(invitation.expiresAt) })}</small></span>
                    {canRevoke ? <button aria-label={tc('cabinet.team.revokeInvitation', { email: invitation.email })} className={styles.buttonDanger} disabled={busyId === invitation.id} onClick={() => void revokeInvitation(invitation)} type="button">{tc('cabinet.team.revoke')}</button> : null}
                  </div>
                );
              })}
              {state.hasMoreInvitations ? (
                <button
                  aria-busy={busyId === 'invitations-more'}
                  className={styles.button}
                  disabled={busyId !== null}
                  onClick={() => void loadMoreInvitations()}
                  type="button"
                >
                  {busyId === 'invitations-more'
                    ? tc('cabinet.team.loadingMoreInvitations')
                    : tc('cabinet.team.loadMoreInvitations')}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className={styles.tablePanel} aria-busy={state.kind === 'loading'}>
        <div className={styles.panelHeader}><h2>{tc('cabinet.team.membersTitle')}</h2></div>
        {state.kind === 'loading' ? <p className={styles.teamState} role="status">{tc('cabinet.team.loading')}</p> : null}
        {state.kind === 'forbidden' ? <p className={styles.teamState}>{tc('cabinet.team.forbidden')}</p> : null}
        {state.kind === 'error' ? <p className={styles.teamState} role="alert">{tc('cabinet.team.error')}</p> : null}
        {state.kind === 'ready' && state.members.length === 0 ? <p className={styles.teamState}>{tc('cabinet.team.empty')}</p> : null}
        {state.kind === 'ready' && state.members.length > 0 ? (
          <>
            <div className={styles.teamTableScroll}>
              <table className={styles.productionTable}>
              <thead><tr><th>{tc('cabinet.team.user')}</th><th>{tc('cabinet.team.role')}</th><th>{tc('cabinet.team.status')}</th><th>{tc('cabinet.team.joinedAt')}</th><th><span className={styles.srOnly}>{tc('cabinet.dashboard.actions')}</span></th></tr></thead>
              <tbody>
                {state.members.map((member) => {
                  const manageable = access.selectedCabinet.role === 'admin' || (access.selectedCabinet.role === 'manager' && member.role === 'collaborator');
                  const identityLabel = member.displayName ?? member.email ?? member.userId;
                  return (
                    <tr key={member.id}>
                      <td data-label={tc('cabinet.team.user')}><div className={styles.clientCell}><strong>{identityLabel}</strong><span>{member.email && member.displayName ? member.email : member.userId}</span></div></td>
                      <td data-label={tc('cabinet.team.role')}>
                        {manageable && canEditCabinetMemberRole(access.selectedCabinet.role, member.status) ? (
                          <select
                            aria-label={tc('cabinet.team.updateRole', { userId: identityLabel })}
                            disabled={busyId !== null}
                            onChange={(event) => {
                              const nextRole = event.target.value as CabinetRole;
                              if (nextRole === 'admin' && member.role !== 'admin' && !window.confirm(tc('cabinet.team.confirmAdminRole'))) return;
                              void mutate(member, { role: nextRole });
                            }}
                            value={member.role}
                          >
                            <option value="collaborator">{ROLE_LABELS.collaborator}</option><option value="manager">{ROLE_LABELS.manager}</option><option value="admin">{ROLE_LABELS.admin}</option>
                          </select>
                        ) : ROLE_LABELS[member.role]}
                      </td>
                      <td data-label={tc('cabinet.team.status')}><span className={`${styles.memberStatus} ${member.status === 'active' ? styles.memberStatusActive : ''}`}>{STATUS_LABELS[member.status]}</span></td>
                      <td data-label={tc('cabinet.team.joinedAt')}>{dateLabel(member.joinedAt)}</td>
                      <td>
                        {manageable && member.status !== 'revoked' ? (
                          <div className={styles.inlineActions}>
                            <button className={styles.button} disabled={busyId !== null} onClick={() => void mutate(member, { status: member.status === 'suspended' ? 'active' : 'suspended' })} type="button">
                              {member.status === 'suspended' ? tc('cabinet.team.reactivate') : tc('cabinet.team.suspend')}
                            </button>
                            <button className={styles.buttonDanger} disabled={busyId !== null} onClick={() => { if (window.confirm(tc('cabinet.team.confirmRevoke'))) void mutate(member, { status: 'revoked' }); }} type="button">{tc('cabinet.team.revoke')}</button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>
            {state.hasMoreMembers ? (
              <button
                aria-busy={busyId === 'members-more'}
                className={styles.button}
                disabled={busyId !== null}
                onClick={() => void loadMoreMembers()}
                type="button"
              >
                {busyId === 'members-more'
                  ? tc('cabinet.team.loadingMoreMembers')
                  : tc('cabinet.team.loadMoreMembers')}
              </button>
            ) : null}
          </>
        ) : null}
      </section>
    </section>
  );
}
