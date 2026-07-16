'use client';

import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CabinetAccessSummary } from '@/src/cabinet/access';
import { CabinetApiClient, CabinetApiError, getCabinetApiUrl } from '@/src/cabinet/api';
import { tc } from '@/src/cabinet/i18n';
import { acceptStashedInvitation, invitationFromFragment, stashInvitation } from '@/src/cabinet/invitation';
import {
  getSupabaseBrowserClient,
  getSupabasePublicConfig,
  isLocalCabinetDemoEnabled,
} from '@/src/cabinet/supabase';
import styles from './cabinet.module.css';
import { CabinetApp } from './cabinet-app';
import { AlertIcon, CheckIcon, ChevronIcon, LockIcon, RefreshIcon } from './components/icons';

type PortfolioState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly cabinets: readonly CabinetAccessSummary[] }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error' };

function StatePanel({
  description,
  icon,
  title,
  children,
}: {
  readonly description: string;
  readonly icon: 'alert' | 'check' | 'lock';
  readonly title: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <main className={styles.accessPage} id="main-content" tabIndex={-1}>
      <section className={styles.accessCard}>
        <span className={styles.accessIcon} aria-hidden="true">
          {icon === 'alert' ? <AlertIcon /> : icon === 'lock' ? <LockIcon /> : <CheckIcon />}
        </span>
        <p className={styles.accessEyebrow}>{tc('cabinet.auth.eyebrow')}</p>
        <h1>{title}</h1>
        <p>{description}</p>
        {children}
      </section>
    </main>
  );
}

function SignIn({ onSession }: { readonly onSession: (session: Session) => void }) {
  const config = useMemo(() => getSupabasePublicConfig(), []);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config === null) return;
    const client = getSupabaseBrowserClient(config);
    void client.auth.getSession().then(({ data }) => {
      if (data.session) onSession(data.session);
    });
  }, [config, onSession]);

  if (config === null) {
    return (
      <StatePanel
        description={tc('cabinet.auth.missingConfigDescription')}
        icon="lock"
        title={tc('cabinet.auth.missingConfigTitle')}
      >
        {isLocalCabinetDemoEnabled() ? <LocalDemoButton /> : null}
      </StatePanel>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      setError(tc('cabinet.auth.invalidEmail'));
      return;
    }
    setBusy(true);
    setError(null);
    const { error: signInError } = await getSupabaseBrowserClient(config).auth.signInWithOtp({
      email: normalized,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/cabinet` },
    });
    setBusy(false);
    if (signInError) {
      setError(signInError.status === 429 ? tc('cabinet.auth.rateLimited') : tc('cabinet.auth.genericError'));
      return;
    }
    setSentTo(normalized);
  };

  return (
    <main className={styles.authPage} id="main-content" tabIndex={-1}>
      <section className={styles.authStory} aria-labelledby="auth-title">
        <div className={styles.authMark} aria-hidden="true">B</div>
        <p className={styles.accessEyebrow}>{tc('cabinet.auth.eyebrow')}</p>
        <h1 id="auth-title">{tc('cabinet.auth.title')}</h1>
        <p>{tc('cabinet.auth.description')}</p>
        <div className={styles.authProof}>
          <LockIcon />
          <span>{tc('cabinet.shell.secureAccess')}</span>
        </div>
      </section>
      <section className={styles.authPanel} aria-live="polite">
        {sentTo ? (
          <div className={styles.authSent}>
            <span className={styles.accessIcon} aria-hidden="true"><CheckIcon /></span>
            <h2>{tc('cabinet.auth.sentTitle')}</h2>
            <p>{tc('cabinet.auth.sentDescription', { email: sentTo })}</p>
            <button className={styles.button} onClick={() => setSentTo(null)} type="button">
              {tc('cabinet.auth.useAnotherEmail')}
            </button>
          </div>
        ) : (
          <form className={styles.authForm} onSubmit={(event) => void submit(event)}>
            <label htmlFor="cabinet-email">{tc('cabinet.auth.emailLabel')}</label>
            <input
              autoComplete="email"
              id="cabinet-email"
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder={tc('cabinet.auth.emailPlaceholder')}
              required
              type="email"
              value={email}
            />
            {error ? <p className={styles.authError} role="alert">{error}</p> : null}
            <button aria-busy={busy} className={styles.buttonPrimary} disabled={busy} type="submit">
              {busy ? tc('cabinet.auth.submitting') : tc('cabinet.auth.submit')}
              {!busy ? <ChevronIcon /> : null}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

function LocalDemoButton() {
  const [open, setOpen] = useState(false);
  if (open) return <CabinetApp access={{ mode: 'local' }} />;
  return (
    <div className={styles.demoRail}>
      <strong>{tc('cabinet.state.demoBadge')}</strong>
      <span>{tc('cabinet.state.demoDescription')}</span>
      <button className={styles.button} onClick={() => setOpen(true)} type="button">
        {tc('cabinet.state.openDemo')}
      </button>
    </div>
  );
}

function CabinetPortfolio({
  onInvitationConsumed,
  invitationPending,
  session,
  onSignOut,
}: {
  readonly onInvitationConsumed: () => void;
  readonly invitationPending: boolean;
  readonly session: Session;
  readonly onSignOut: () => Promise<void>;
}) {
  const apiUrl = getCabinetApiUrl();
  const [state, setState] = useState<PortfolioState>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cabinetName, setCabinetName] = useState('');
  const [creating, setCreating] = useState(false);
  const [invitationState, setInvitationState] = useState<'idle' | 'accepting' | 'error'>(
    invitationPending ? 'accepting' : 'idle',
  );

  const api = useMemo(
    () => apiUrl === null ? null : new CabinetApiClient(apiUrl, session.access_token),
    [apiUrl, session.access_token],
  );

  const load = useCallback(async () => {
    if (api === null) {
      setState({ kind: 'error' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      try {
        await acceptStashedInvitation();
        setInvitationState('idle');
      } catch {
        setInvitationState('error');
        return;
      } finally {
        onInvitationConsumed();
      }
      const cabinets = await api.listCabinets();
      setState({ kind: 'ready', cabinets });
      setSelectedId((current) => {
        if (current && cabinets.some((cabinet) => cabinet.id === current)) return current;
        const saved = window.sessionStorage.getItem('bob.cabinet.selected');
        return cabinets.find((cabinet) => cabinet.id === saved)?.id ?? cabinets[0]?.id ?? null;
      });
    } catch (error) {
      if (error instanceof CabinetApiError && error.status === 401) {
        await onSignOut();
        return;
      }
      setState(error instanceof CabinetApiError && error.status === 403 ? { kind: 'forbidden' } : { kind: 'error' });
    }
  }, [api, onInvitationConsumed, onSignOut]);

  useEffect(() => { void load(); }, [load]);

  const select = (cabinetId: string) => {
    setSelectedId(cabinetId);
    window.sessionStorage.setItem('bob.cabinet.selected', cabinetId);
  };

  if (invitationState === 'accepting') {
    return <StatePanel description={tc('cabinet.invitation.acceptingDescription')} icon="lock" title={tc('cabinet.invitation.acceptingTitle')} />;
  }
  if (invitationState === 'error') {
    return (
      <StatePanel description={tc('cabinet.invitation.errorDescription')} icon="alert" title={tc('cabinet.invitation.errorTitle')}>
        <button className={styles.buttonPrimary} onClick={() => { setInvitationState('accepting'); void load(); }} type="button">{tc('cabinet.invitation.dismiss')}</button>
      </StatePanel>
    );
  }

  if (state.kind === 'loading') {
    return <StatePanel description={tc('cabinet.state.loadingDescription')} icon="check" title={tc('cabinet.state.loadingTitle')} />;
  }
  if (state.kind === 'forbidden') {
    return <StatePanel description={tc('cabinet.state.forbiddenDescription')} icon="lock" title={tc('cabinet.state.forbiddenTitle')} />;
  }
  if (state.kind === 'error') {
    return (
      <StatePanel description={tc('cabinet.state.errorDescription')} icon="alert" title={tc('cabinet.state.errorTitle')}>
        <button className={styles.buttonPrimary} onClick={() => void load()} type="button"><RefreshIcon />{tc('cabinet.state.retry')}</button>
      </StatePanel>
    );
  }
  if (state.cabinets.length === 0) {
    const create = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (api === null || cabinetName.trim().length < 2) return;
      setCreating(true);
      try {
        const cabinet = await api.createCabinet(cabinetName);
        setState({ kind: 'ready', cabinets: [cabinet] });
        select(cabinet.id);
      } catch {
        setState({ kind: 'error' });
      } finally {
        setCreating(false);
      }
    };
    return (
      <StatePanel description={tc('cabinet.state.emptyDescription')} icon="check" title={tc('cabinet.state.emptyTitle')}>
        <form className={styles.emptyCabinetForm} onSubmit={(event) => void create(event)}>
          <label htmlFor="new-cabinet-name">{tc('cabinet.state.createLabel')}</label>
          <input id="new-cabinet-name" onChange={(event) => setCabinetName(event.target.value)} placeholder={tc('cabinet.state.createPlaceholder')} required value={cabinetName} />
          <button aria-busy={creating} className={styles.buttonPrimary} disabled={creating} type="submit">
            {creating ? tc('cabinet.state.creating') : tc('cabinet.state.createAction')}
          </button>
        </form>
      </StatePanel>
    );
  }

  const selectedCabinet = state.cabinets.find((cabinet) => cabinet.id === selectedId) ?? state.cabinets[0];
  if (selectedCabinet === undefined || api === null) return null;
  const connectedApi = api;
  return (
    <CabinetApp
      access={{
        mode: 'authenticated',
        cabinets: state.cabinets,
        selectedCabinet,
        team: {
          listMembers: (cabinetId, cursor) => connectedApi.listMembers(cabinetId, cursor),
          listInvitations: (cabinetId, cursor) => connectedApi.listInvitations(cabinetId, cursor),
          revokeInvitation: (cabinetId, invitationId) => connectedApi.revokeInvitation(cabinetId, invitationId),
          inviteMember: (cabinetId, email, role) => connectedApi.inviteMember(cabinetId, { email, role }),
          updateMember: (cabinetId, memberId, input) => connectedApi.updateMember(cabinetId, memberId, input),
        },
        userEmail: session.user.email ?? session.user.id,
        onSelectCabinet: select,
        onSignOut,
      }}
    />
  );
}

export function CabinetGateway() {
  const config = useMemo(() => getSupabasePublicConfig(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(config === null);
  const [invitationPending, setInvitationPending] = useState(false);
  const [fragmentReady, setFragmentReady] = useState(false);
  const [fragmentError, setFragmentError] = useState(false);
  const [authError, setAuthError] = useState(false);
  const consumeInvitation = useCallback(() => setInvitationPending(false), []);

  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.has('auth_error')) {
      currentUrl.searchParams.delete('auth_error');
      window.history.replaceState(window.history.state, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      setAuthError(true);
    }
    const rawToken = invitationFromFragment(window.location.hash);
    if (rawToken === null) {
      setFragmentReady(true);
      return;
    }
    // Once copied into memory, remove the bearer secret before any fallible
    // network operation so it cannot linger in screenshots or browser history.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    let cancelled = false;
    void (async () => {
      try {
        const stashed = await stashInvitation(rawToken);
        if (cancelled) return;
        if (stashed) setInvitationPending(true);
        else setFragmentError(true);
      } catch {
        if (!cancelled) setFragmentError(true);
      } finally {
        if (!cancelled) setFragmentReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (config === null) return;
    const client = getSupabaseBrowserClient(config);
    void client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, [config]);

  const signOut = useCallback(async () => {
    if (config !== null) await getSupabaseBrowserClient(config).auth.signOut();
    window.sessionStorage.removeItem('bob.cabinet.selected');
    setSession(null);
  }, [config]);

  if (!ready || !fragmentReady) {
    return <StatePanel description={tc('cabinet.state.loadingDescription')} icon="lock" title={tc('cabinet.auth.loading')} />;
  }
  if (fragmentError) {
    return (
      <StatePanel description={tc('cabinet.invitation.errorDescription')} icon="alert" title={tc('cabinet.invitation.errorTitle')}>
        <button className={styles.buttonPrimary} onClick={() => window.location.reload()} type="button">{tc('cabinet.state.retry')}</button>
      </StatePanel>
    );
  }
  if (authError) {
    return (
      <StatePanel description={tc('cabinet.auth.callbackErrorDescription')} icon="alert" title={tc('cabinet.auth.callbackErrorTitle')}>
        <button className={styles.buttonPrimary} onClick={() => window.location.reload()} type="button">{tc('cabinet.state.retry')}</button>
      </StatePanel>
    );
  }
  if (session === null) return <SignIn onSession={setSession} />;
  return <CabinetPortfolio invitationPending={invitationPending} onInvitationConsumed={consumeInvitation} onSignOut={signOut} session={session} />;
}
