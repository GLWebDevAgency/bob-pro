'use client';

import type { ClosingReview, DateOnly, LegalForm, UrssafPeriodicity, VatRegime } from '@bob/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canDeleteCabinetDossier,
  type CabinetAccessContext,
} from '@/src/cabinet/access';
import {
  CabinetApiError,
  type CabinetDossierDetail,
  type CabinetDossierListItem,
  type CabinetDossierWrite,
} from '@/src/cabinet/api';
import {
  loadCabinetDossierPortfolio,
  replaceDossierSummary,
} from '@/src/cabinet/dossier-portfolio';
import { tc } from '@/src/cabinet/i18n';
import { analyzeFec, deriveFecClosingReview, type FecAnalysis } from '@/src/fec/analyze-fec';
import { FecParseError, parseFec, type ParsedFec } from '@/src/fec/parse-fec';
import {
  summarizeClosingReview,
  type IncomeTaxRegime,
  type StoredFecAnalysis,
} from '@/src/cabinet/types';
import styles from './cabinet.module.css';
import { AppShell, type CabinetView } from './components/app-shell';
import { AlertIcon, CheckIcon, CloseIcon, RefreshIcon } from './components/icons';
import { DashboardView } from './components/dashboard-view';
import { DossierView } from './components/dossier-view';
import { ImportView } from './components/import-view';
import { LetterView } from './components/letter-view';
import { TeamView } from './components/team-view';

const MAX_FEC_SIZE = 50 * 1024 * 1024;

type PortfolioState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly dossiers: readonly CabinetDossierListItem[] }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error' };

type DetailState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly siren: string }
  | { readonly kind: 'ready'; readonly dossier: CabinetDossierDetail }
  | { readonly kind: 'forbidden'; readonly siren: string }
  | { readonly kind: 'error'; readonly siren: string };

export interface PendingFecImport {
  fileName: string;
  parsed: ParsedFec;
  analysis: FecAnalysis;
  review: ClosingReview;
  suggestedSiren: string;
  previous: CabinetDossierListItem | null;
}

export interface ImportIdentityInput {
  clientName: string;
  siren: string;
  legalForm: LegalForm;
  vatRegime: VatRegime;
  incomeTaxRegime: IncomeTaxRegime;
  fiscalYearEnd: string | null;
  urssafPeriodicity: UrssafPeriodicity | null;
  dateCreation: DateOnly | null;
}

interface ToastState {
  message: string;
  tone: 'success' | 'error';
}

function normalizeSiren(value: string): string | null {
  const digits = value.replace(/[ .-]/g, '');
  if (!/^\d{9}$/.test(digits)) return null;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0 ? digits : null;
}

function extractSirenFromFecFilename(fileName: string): string {
  const match = /^(\d{9})FEC\d{8}\.txt$/i.exec(fileName.trim());
  if (!match) return '';
  return normalizeSiren(match[1] ?? '') ?? '';
}

function isYearEndImport(fileName: string, periodTo: string, fiscalYearEnd: string | null): boolean {
  if (fiscalYearEnd === null) return false;
  const canonicalDate = /^\d{9}FEC(\d{4})(\d{2})(\d{2})\.txt$/i.exec(fileName.trim());
  const closingMonthDay = canonicalDate
    ? `${canonicalDate[2]}-${canonicalDate[3]}`
    : periodTo.slice(5);
  return closingMonthDay === fiscalYearEnd;
}

function toStoredAnalysis(analysis: FecAnalysis): StoredFecAnalysis {
  return {
    trialBalance: {
      ...analysis.trialBalance,
      rows: analysis.trialBalance.rows.map((row) => ({ ...row })),
    },
    incomeStatement: { ...analysis.incomeStatement },
    balanceSheet: {
      ...analysis.balanceSheet,
      actif: { ...analysis.balanceSheet.actif },
      passif: { ...analysis.balanceSheet.passif },
    },
    turnoverCents: analysis.turnoverCents,
    unbalancedEntries: analysis.unbalancedEntries.map((entry) => ({
      ...entry,
      entryDate: entry.entryDate as DateOnly,
    })),
    checks: { ...analysis.checks },
  };
}

function fecErrorMessage(error: unknown): string {
  if (error instanceof FecParseError) return error.message;
  if (error instanceof Error) return error.message;
  return tc('cabinet.local.unexpectedError');
}

function RemoteStatePanel({
  description,
  title,
  tone,
  onRetry,
}: {
  readonly description: string;
  readonly title: string;
  readonly tone: 'loading' | 'error' | 'forbidden';
  readonly onRetry?: () => void;
}) {
  return (
    <section aria-live={tone === 'error' ? 'assertive' : 'polite'} className={styles.tablePanel} role={tone === 'error' ? 'alert' : 'status'}>
      <div className={styles.emptyState}>
        <div className={styles.emptyStateInner}>
          <span className={styles.emptyIcon}>
            {tone === 'loading' ? <CheckIcon /> : tone === 'forbidden' ? <CloseIcon /> : <AlertIcon />}
          </span>
          <h2>{title}</h2>
          <p>{description}</p>
          {onRetry ? <button className={styles.buttonPrimary} onClick={onRetry} type="button"><RefreshIcon />{tc('cabinet.state.retry')}</button> : null}
        </div>
      </div>
    </section>
  );
}

export function CabinetApp({ access }: { readonly access: CabinetAccessContext }) {
  const [view, setView] = useState<CabinetView>('dossiers');
  const [portfolio, setPortfolio] = useState<PortfolioState>({ kind: 'loading' });
  const [detail, setDetail] = useState<DetailState>({ kind: 'idle' });
  const [selectedSiren, setSelectedSiren] = useState<string | null>(null);
  const [replacementSiren, setReplacementSiren] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingFecImport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portfolioRequest = useRef(0);
  const detailRequest = useRef(0);
  const activeCabinetId = useRef(access.selectedCabinet.id);
  activeCabinetId.current = access.selectedCabinet.id;

  const cabinetId = access.selectedCabinet.id;
  const dossierTransport = access.dossiers;
  const canDelete = canDeleteCabinetDossier(access.selectedCabinet.role);

  const showToast = useCallback((message: string, tone: ToastState['tone'] = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = setTimeout(() => setToast(null), 4_200);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const signOutIfUnauthorized = useCallback(async (error: unknown): Promise<boolean> => {
    if (!(error instanceof CabinetApiError) || error.status !== 401) return false;
    await access.onSignOut();
    return true;
  }, [access]);

  const loadPortfolio = useCallback(async (showLoading = true) => {
    const requestId = ++portfolioRequest.current;
    if (showLoading) setPortfolio({ kind: 'loading' });
    try {
      const dossiers = await loadCabinetDossierPortfolio(dossierTransport, cabinetId);
      if (requestId !== portfolioRequest.current || activeCabinetId.current !== cabinetId) return;
      setPortfolio({ kind: 'ready', dossiers });
    } catch (error) {
      if (requestId !== portfolioRequest.current || activeCabinetId.current !== cabinetId) return;
      if (await signOutIfUnauthorized(error)) return;
      setPortfolio(error instanceof CabinetApiError && error.status === 403
        ? { kind: 'forbidden' }
        : { kind: 'error' });
    }
  }, [cabinetId, dossierTransport, signOutIfUnauthorized]);

  useEffect(() => {
    portfolioRequest.current += 1;
    detailRequest.current += 1;
    setView('dossiers');
    setPortfolio({ kind: 'loading' });
    setDetail({ kind: 'idle' });
    setSelectedSiren(null);
    setReplacementSiren(null);
    setPendingImport(null);
    setImportBusy(false);
    setMutationBusy(false);
    void loadPortfolio();
    return () => {
      portfolioRequest.current += 1;
      detailRequest.current += 1;
    };
  }, [cabinetId, loadPortfolio]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [selectedSiren, view]);

  const dossiers = portfolio.kind === 'ready' ? portfolio.dossiers : [];
  const selectedSummary = useMemo(
    () => dossiers.find((dossier) => dossier.siren === selectedSiren) ?? null,
    [dossiers, selectedSiren],
  );
  const selectedDetail = detail.kind === 'ready' && detail.dossier.siren === selectedSiren
    ? detail.dossier
    : null;

  const navigate = (nextView: CabinetView) => {
    if (nextView !== 'dossier') setView(nextView);
    if (nextView === 'import') {
      setPendingImport(null);
      setReplacementSiren(null);
    }
  };

  const handleFecFile = useCallback(async (file: File) => {
    if (portfolio.kind !== 'ready') return;
    if (!file.name.toLowerCase().endsWith('.txt')) {
      showToast(tc('cabinet.local.invalidFecType'), 'error');
      return;
    }
    if (file.size === 0) {
      showToast(tc('cabinet.local.emptyFec'), 'error');
      return;
    }
    if (file.size > MAX_FEC_SIZE) {
      showToast(tc('cabinet.local.fecTooLarge'), 'error');
      return;
    }

    const extractedSiren = extractSirenFromFecFilename(file.name);
    if (replacementSiren !== null && extractedSiren !== '' && extractedSiren !== replacementSiren) {
      showToast('Le SIREN du nom de fichier ne correspond pas au dossier à actualiser.', 'error');
      return;
    }

    setImportBusy(true);
    try {
      const parsed = parseFec(await file.arrayBuffer());
      if (parsed.entries.length === 0 || parsed.period.from === null || parsed.period.to === null) {
        throw new Error(tc('cabinet.local.noEntries'));
      }
      const analysis = analyzeFec(parsed);
      const review = deriveFecClosingReview(parsed);
      const suggestedSiren = replacementSiren ?? extractedSiren;
      const previous = suggestedSiren
        ? (portfolio.dossiers.find((dossier) => dossier.siren === suggestedSiren) ?? null)
        : null;
      setPendingImport({ fileName: file.name, parsed, analysis, review, suggestedSiren, previous });
      setView('import');
    } catch (error) {
      showToast(fecErrorMessage(error), 'error');
    } finally {
      setImportBusy(false);
    }
  }, [portfolio, replacementSiren, showToast]);

  const saveImport = useCallback(async (identity: ImportIdentityInput) => {
    if (pendingImport === null || portfolio.kind !== 'ready') return;
    if (pendingImport.parsed.period.from === null || pendingImport.parsed.period.to === null) return;
    const normalizedSiren = normalizeSiren(identity.siren);
    if (normalizedSiren === null) {
      showToast(tc('cabinet.local.invalidSiren'), 'error');
      return;
    }
    if (identity.clientName.trim().length < 2) {
      showToast(tc('cabinet.local.invalidClientName'), 'error');
      return;
    }
    if (replacementSiren !== null && normalizedSiren !== replacementSiren) {
      showToast('Le SIREN d’un dossier existant ne peut pas être remplacé pendant son actualisation.', 'error');
      return;
    }

    const existing = portfolio.dossiers.find((dossier) => dossier.siren === normalizedSiren) ?? null;
    const analysis = toStoredAnalysis(pendingImport.analysis);
    const review = deriveFecClosingReview(pendingImport.parsed, {
      yearEnd: isYearEndImport(
        pendingImport.fileName,
        pendingImport.parsed.period.to,
        identity.fiscalYearEnd,
      ),
    });
    const input: CabinetDossierWrite = {
      siren: normalizedSiren,
      clientName: identity.clientName.trim(),
      sourceFileName: pendingImport.fileName,
      entryCount: pendingImport.parsed.entries.length,
      rowCount: pendingImport.parsed.rows.length,
      period: {
        from: pendingImport.parsed.period.from as DateOnly,
        to: pendingImport.parsed.period.to as DateOnly,
      },
      analysis,
      review: summarizeClosingReview(review),
      fiscal: {
        legalForm: identity.legalForm,
        vatRegime: identity.vatRegime,
        incomeTaxRegime: identity.incomeTaxRegime,
        fiscalYearEnd: identity.fiscalYearEnd,
        urssafPeriodicity: identity.urssafPeriodicity,
        dateCreation: identity.dateCreation,
      },
      expectedRevision: existing?.revision ?? null,
    };

    setImportBusy(true);
    setMutationBusy(true);
    try {
      const saved = await dossierTransport.saveDossier(cabinetId, input);
      if (activeCabinetId.current !== cabinetId) return;
      setPortfolio((current) => current.kind === 'ready'
        ? { kind: 'ready', dossiers: replaceDossierSummary(current.dossiers, saved) }
        : current);
      setSelectedSiren(saved.siren);
      setDetail({ kind: 'ready', dossier: saved });
      setPendingImport(null);
      setReplacementSiren(null);
      setView('dossier');
      showToast(existing
        ? tc('cabinet.local.updated', { name: saved.clientName })
        : tc('cabinet.local.added', { name: saved.clientName }));
    } catch (error) {
      if (activeCabinetId.current !== cabinetId) return;
      if (await signOutIfUnauthorized(error)) return;
      if (error instanceof CabinetApiError && error.status === 409) {
        showToast('Ce dossier a été modifié par un autre membre. La version du serveur a été rechargée.', 'error');
        await loadPortfolio(false);
      } else if (error instanceof CabinetApiError && error.status === 403) {
        showToast('Votre rôle ne permet pas d’enregistrer ce dossier.', 'error');
      } else {
        showToast('Impossible d’enregistrer ce dossier dans l’espace sécurisé. Réessayez.', 'error');
      }
    } finally {
      if (activeCabinetId.current === cabinetId) {
        setImportBusy(false);
        setMutationBusy(false);
      }
    }
  }, [cabinetId, dossierTransport, loadPortfolio, pendingImport, portfolio, replacementSiren, showToast, signOutIfUnauthorized]);

  const openDossier = useCallback(async (siren: string) => {
    const requestId = ++detailRequest.current;
    setSelectedSiren(siren);
    setDetail({ kind: 'loading', siren });
    setView('dossier');
    try {
      const dossier = await dossierTransport.getDossier(cabinetId, siren);
      if (requestId !== detailRequest.current || activeCabinetId.current !== cabinetId) return;
      setDetail({ kind: 'ready', dossier });
    } catch (error) {
      if (requestId !== detailRequest.current || activeCabinetId.current !== cabinetId) return;
      if (await signOutIfUnauthorized(error)) return;
      setDetail(error instanceof CabinetApiError && error.status === 403
        ? { kind: 'forbidden', siren }
        : { kind: 'error', siren });
    }
  }, [cabinetId, dossierTransport, signOutIfUnauthorized]);

  const removeDossier = useCallback(async (dossier: CabinetDossierListItem) => {
    if (!canDelete || mutationBusy) return;
    if (!window.confirm(`Supprimer définitivement le dossier ${dossier.clientName} du cabinet ?`)) return;
    setMutationBusy(true);
    try {
      await dossierTransport.deleteDossier(cabinetId, dossier.siren, dossier.revision);
      if (activeCabinetId.current !== cabinetId) return;
      setPortfolio((current) => current.kind === 'ready'
        ? { kind: 'ready', dossiers: current.dossiers.filter((candidate) => candidate.siren !== dossier.siren) }
        : current);
      if (selectedSiren === dossier.siren) {
        setSelectedSiren(null);
        setDetail({ kind: 'idle' });
      }
      setView('dossiers');
      showToast(tc('cabinet.local.deleted', { name: dossier.clientName }));
    } catch (error) {
      if (activeCabinetId.current !== cabinetId) return;
      if (await signOutIfUnauthorized(error)) return;
      if (error instanceof CabinetApiError && error.status === 409) {
        showToast('Ce dossier a changé depuis son affichage. La version du serveur a été rechargée.', 'error');
        await loadPortfolio(false);
      } else if (error instanceof CabinetApiError && error.status === 403) {
        showToast('Seul un administrateur du cabinet peut supprimer définitivement ce dossier.', 'error');
      } else {
        showToast('La suppression n’a pas abouti. Aucune donnée locale n’a été utilisée en remplacement.', 'error');
      }
    } finally {
      if (activeCabinetId.current === cabinetId) setMutationBusy(false);
    }
  }, [cabinetId, canDelete, dossierTransport, loadPortfolio, mutationBusy, selectedSiren, showToast, signOutIfUnauthorized]);

  let content;
  if (view === 'equipe') {
    content = <TeamView key={cabinetId} access={access} />;
  } else if (portfolio.kind === 'loading') {
    content = <RemoteStatePanel description={tc('cabinet.state.loadingDescription')} title={tc('cabinet.state.loadingTitle')} tone="loading" />;
  } else if (portfolio.kind === 'forbidden') {
    content = <RemoteStatePanel description={tc('cabinet.state.forbiddenDescription')} title={tc('cabinet.state.forbiddenTitle')} tone="forbidden" />;
  } else if (portfolio.kind === 'error') {
    content = <RemoteStatePanel description={tc('cabinet.state.errorDescription')} onRetry={() => void loadPortfolio()} title={tc('cabinet.state.errorTitle')} tone="error" />;
  } else if (view === 'import') {
    content = (
      <ImportView
        busy={importBusy}
        onCancel={() => { setPendingImport(null); setReplacementSiren(null); setView('dossiers'); }}
        onFile={handleFecFile}
        onSave={saveImport}
        pending={pendingImport}
      />
    );
  } else if (view === 'dossier') {
    if (selectedDetail !== null) {
      content = (
        <DossierView
          canDelete={canDelete}
          dossier={selectedDetail}
          mutationBusy={mutationBusy}
          onBack={() => setView('dossiers')}
          onDelete={() => void removeDossier(selectedDetail)}
          onLetter={() => setView('lettre')}
          onUpdate={() => { setPendingImport(null); setReplacementSiren(selectedDetail.siren); setView('import'); }}
        />
      );
    } else if (detail.kind === 'forbidden') {
      content = <RemoteStatePanel description={tc('cabinet.state.forbiddenDescription')} title={tc('cabinet.state.forbiddenTitle')} tone="forbidden" />;
    } else if (detail.kind === 'error') {
      content = <RemoteStatePanel description="Le dossier n’a pas pu être chargé depuis le serveur. Aucune copie locale n’est affichée." onRetry={() => void openDossier(detail.siren)} title="Dossier indisponible" tone="error" />;
    } else {
      content = <RemoteStatePanel description="Bob charge les états comptables depuis la source sécurisée du cabinet." title="Chargement du dossier" tone="loading" />;
    }
  } else if (view === 'lettre') {
    content = <LetterView dossiers={portfolio.dossiers} initialDossier={selectedSummary} onBack={() => setView('dossiers')} />;
  } else {
    content = (
      <DashboardView
        cabinetName={access.selectedCabinet.name}
        canDelete={canDelete}
        dossiers={portfolio.dossiers}
        mutationBusy={mutationBusy}
        onDelete={(dossier) => void removeDossier(dossier)}
        onLetter={() => setView('lettre')}
        onNewImport={() => { setPendingImport(null); setReplacementSiren(null); setView('import'); }}
        onOpen={(siren) => void openDossier(siren)}
      />
    );
  }

  const dossierName = selectedDetail?.clientName
    ?? selectedSummary?.clientName
    ?? (detail.kind === 'loading' || detail.kind === 'forbidden' || detail.kind === 'error'
      ? detail.siren
      : undefined);

  return (
    <AppShell access={access} activeView={view} dossierName={dossierName} onNavigate={navigate}>
      {content}
      {toast ? (
        <div aria-atomic="true" aria-live={toast.tone === 'error' ? 'assertive' : 'polite'} className={`${styles.toast} ${toast.tone === 'error' ? styles.toastError : ''}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.tone === 'error' ? <CloseIcon /> : <CheckIcon />}
          {toast.message}
        </div>
      ) : null}
    </AppShell>
  );
}
