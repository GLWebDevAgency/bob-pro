'use client';

import type { ClosingReview, DateOnly, LegalForm, UrssafPeriodicity, VatRegime } from '@bob/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyzeFec, deriveFecClosingReview, type FecAnalysis } from '@/src/fec/analyze-fec';
import { FecParseError, parseFec, type ParsedFec } from '@/src/fec/parse-fec';
import {
  deleteDossier,
  exportCabinetStateJson,
  importCabinetStateJson,
  loadCabinetState,
  normalizeSiren,
  saveCabinetState,
  upsertDossier,
} from '@/src/cabinet/storage';
import {
  createEmptyCabinetState,
  summarizeClosingReview,
  summarizeFecAnalysis,
  type CabinetDossier,
  type CabinetStateV1,
  type IncomeTaxRegime,
  type StoredFecAnalysis,
} from '@/src/cabinet/types';
import styles from './cabinet.module.css';
import { AppShell, type CabinetView } from './components/app-shell';
import { CheckIcon, CloseIcon } from './components/icons';
import { DashboardView } from './components/dashboard-view';
import { DossierView } from './components/dossier-view';
import { ImportView } from './components/import-view';
import { LetterView } from './components/letter-view';

const MAX_FEC_SIZE = 50 * 1024 * 1024;

export interface PendingFecImport {
  fileName: string;
  parsed: ParsedFec;
  analysis: FecAnalysis;
  review: ClosingReview;
  suggestedSiren: string;
  previous: CabinetDossier | null;
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

function errorMessage(error: unknown): string {
  if (error instanceof FecParseError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Une erreur inattendue empêche de lire ce fichier.';
}

function downloadText(fileName: string, content: string, mimeType = 'application/json;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function CabinetApp() {
  const [view, setView] = useState<CabinetView>('dossiers');
  const [state, setState] = useState<CabinetStateV1>(() => createEmptyCabinetState());
  const [hydrated, setHydrated] = useState(false);
  const [selectedSiren, setSelectedSiren] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingFecImport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, tone: ToastState['tone'] = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = setTimeout(() => setToast(null), 4_200);
  }, []);

  useEffect(() => {
    const loaded = loadCabinetState(window.localStorage);
    if (loaded.ok) setState(loaded.value);
    else showToast(loaded.error.message, 'error');
    setHydrated(true);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [showToast]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [selectedSiren, view]);

  const selectedDossier = useMemo(
    () => state.dossiers.find((dossier) => dossier.siren === selectedSiren) ?? null,
    [selectedSiren, state.dossiers],
  );

  const persist = useCallback(
    (next: CabinetStateV1): boolean => {
      const saved = saveCabinetState(window.localStorage, next);
      if (!saved.ok) {
        showToast(saved.error.message, 'error');
        return false;
      }
      setState(saved.value);
      return true;
    },
    [showToast],
  );

  const navigate = (nextView: CabinetView) => {
    if (nextView !== 'dossier') setView(nextView);
    if (nextView === 'import') setPendingImport(null);
  };

  const handleFecFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.txt')) {
        showToast('Sélectionnez un fichier FEC au format .txt.', 'error');
        return;
      }
      if (file.size === 0) {
        showToast('Ce fichier est vide.', 'error');
        return;
      }
      if (file.size > MAX_FEC_SIZE) {
        showToast('Ce FEC dépasse 50 Mo. Scindez la période ou utilisez un poste disposant de plus de mémoire.', 'error');
        return;
      }

      setImportBusy(true);
      try {
        const parsed = parseFec(await file.arrayBuffer());
        if (parsed.entries.length === 0 || parsed.period.from === null || parsed.period.to === null) {
          throw new Error('Le fichier porte les en-têtes FEC, mais aucune écriture exploitable.');
        }
        const analysis = analyzeFec(parsed);
        const review = deriveFecClosingReview(parsed);
        const suggestedSiren = extractSirenFromFecFilename(file.name);
        const previous = suggestedSiren
          ? (state.dossiers.find((dossier) => dossier.siren === suggestedSiren) ?? null)
          : null;
        setPendingImport({ fileName: file.name, parsed, analysis, review, suggestedSiren, previous });
        setView('import');
      } catch (error) {
        showToast(errorMessage(error), 'error');
      } finally {
        setImportBusy(false);
      }
    },
    [showToast, state.dossiers],
  );

  const saveImport = useCallback(
    (identity: ImportIdentityInput) => {
      if (!pendingImport || pendingImport.parsed.period.from === null || pendingImport.parsed.period.to === null) return;
      const normalizedSiren = normalizeSiren(identity.siren);
      if (normalizedSiren === null) {
        showToast('Le SIREN doit contenir neuf chiffres et être valide.', 'error');
        return;
      }
      if (identity.clientName.trim().length < 2) {
        showToast('Renseignez le nom réel du client.', 'error');
        return;
      }

      const analysis = toStoredAnalysis(pendingImport.analysis);
      const review = deriveFecClosingReview(pendingImport.parsed, {
        yearEnd: isYearEndImport(
          pendingImport.fileName,
          pendingImport.parsed.period.to,
          identity.fiscalYearEnd,
        ),
      });
      const dossier: CabinetDossier = {
        siren: normalizedSiren,
        clientName: identity.clientName.trim(),
        sourceFileName: pendingImport.fileName,
        entryCount: pendingImport.parsed.entries.length,
        rowCount: pendingImport.parsed.rows.length,
        period: {
          from: pendingImport.parsed.period.from as DateOnly,
          to: pendingImport.parsed.period.to as DateOnly,
        },
        financial: summarizeFecAnalysis(analysis),
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
        lastImportedAt: new Date().toISOString(),
      };
      const next = upsertDossier(state, dossier);
      if (!persist(next)) return;
      setSelectedSiren(normalizedSiren);
      setPendingImport(null);
      setView('dossier');
      showToast(
        pendingImport.previous
          ? `${dossier.clientName} a été mis à jour sans créer de doublon.`
          : `${dossier.clientName} a été ajouté au portefeuille.`,
      );
    },
    [pendingImport, persist, showToast, state],
  );

  const openDossier = (siren: string) => {
    setSelectedSiren(siren);
    setView('dossier');
  };

  const removeDossier = (dossier: CabinetDossier) => {
    if (!window.confirm(`Supprimer le dossier ${dossier.clientName} de ce navigateur ? Cette action ne peut pas être annulée sans sauvegarde JSON.`)) return;
    const next = deleteDossier(state, dossier.siren);
    if (!persist(next)) return;
    if (selectedSiren === dossier.siren) setSelectedSiren(null);
    setView('dossiers');
    showToast(`Le dossier ${dossier.clientName} a été supprimé.`);
  };

  const exportBackup = () => {
    const exported = exportCabinetStateJson(state);
    if (!exported.ok) {
      showToast(exported.error.message, 'error');
      return;
    }
    downloadText(`bob-cabinet-${new Date().toISOString().slice(0, 10)}.json`, exported.value);
    showToast('Sauvegarde JSON préparée.');
  };

  const importBackup = async (file: File) => {
    try {
      const imported = importCabinetStateJson(window.localStorage, await file.text());
      if (!imported.ok) {
        showToast(`${imported.error.message}${imported.error.path ? ` (${imported.error.path})` : ''}`, 'error');
        return;
      }
      setState(imported.value);
      setSelectedSiren(null);
      setView('dossiers');
      showToast(`${imported.value.dossiers.length} dossier(s) restauré(s).`);
    } catch (error) {
      showToast(errorMessage(error), 'error');
    }
  };

  let content;
  if (!hydrated) {
    content = (
      <section className={styles.emptyState} aria-live="polite">
        <div className={styles.emptyStateInner}>
          <span className={styles.emptyIcon}><CheckIcon /></span>
          <h2>Ouverture du portefeuille local</h2>
          <p>Bob vérifie les données présentes dans ce navigateur.</p>
        </div>
      </section>
    );
  } else if (view === 'import') {
    content = (
      <ImportView
        busy={importBusy}
        onCancel={() => { setPendingImport(null); setView('dossiers'); }}
        onFile={handleFecFile}
        onSave={saveImport}
        pending={pendingImport}
      />
    );
  } else if (view === 'dossier' && selectedDossier) {
    content = (
      <DossierView
        dossier={selectedDossier}
        onBack={() => setView('dossiers')}
        onDelete={() => removeDossier(selectedDossier)}
        onLetter={() => setView('lettre')}
        onUpdate={() => { setPendingImport(null); setView('import'); }}
      />
    );
  } else if (view === 'lettre') {
    content = <LetterView dossiers={state.dossiers} initialDossier={selectedDossier} onBack={() => setView('dossiers')} />;
  } else {
    content = (
      <DashboardView
        dossiers={state.dossiers}
        onDelete={removeDossier}
        onExport={exportBackup}
        onImportBackup={importBackup}
        onLetter={() => setView('lettre')}
        onNewImport={() => { setPendingImport(null); setView('import'); }}
        onOpen={openDossier}
      />
    );
  }

  return (
    <AppShell activeView={view} dossierName={selectedDossier?.clientName} onNavigate={navigate}>
      {content}
      {toast ? (
        <div className={`${styles.toast} ${toast.tone === 'error' ? styles.toastError : ''}`} role="status">
          {toast.tone === 'error' ? <CloseIcon /> : <CheckIcon />}
          {toast.message}
        </div>
      ) : null}
    </AppShell>
  );
}
