'use client';

import { formatEUR, type FiscalDeadline } from '@bob/core';
import { useRef } from 'react';
import { deriveCabinetFiscalCalendar } from '@/src/cabinet/fiscal-calendar';
import type { CabinetDossier } from '@/src/cabinet/types';
import styles from '../cabinet.module.css';
import { AlertIcon, CheckIcon, DownloadIcon, FolderIcon, PenIcon, ShieldIcon, TrashIcon, UploadIcon } from './icons';

interface DashboardViewProps {
  dossiers: CabinetDossier[];
  onDelete: (dossier: CabinetDossier) => void;
  onExport: () => void;
  onImportBackup: (file: File) => void | Promise<void>;
  onLetter: () => void;
  onNewImport: () => void;
  onOpen: (siren: string) => void;
}

function dateOnlyToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function frDate(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}

function periodLabel(dossier: CabinetDossier): string {
  return `${frDate(dossier.period.from)} – ${frDate(dossier.period.to)}`;
}

function formatSiren(siren: string): string {
  return siren.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
}

function nextDeadline(dossier: CabinetDossier): FiscalDeadline | null {
  try {
    return deriveCabinetFiscalCalendar({ fiscal: dossier.fiscal, asOf: dateOnlyToday(), horizonDays: 400 }).deadlines[0] ?? null;
  } catch {
    return null;
  }
}

function ReviewCell({ dossier }: { dossier: CabinetDossier }) {
  if (dossier.review) {
    const anomaly = dossier.review.verdict === 'anomalies';
    const reservations = dossier.review.verdict === 'reservations';
    return (
      <span className={`${styles.checkLabel} ${anomaly ? styles.checkDanger : reservations ? styles.checkWarning : ''}`}>
        {anomaly || reservations ? <AlertIcon /> : <CheckIcon />}
        {anomaly ? `${dossier.review.anomalyCount} anomalie(s)` : reservations ? `${dossier.review.attentionCount} réserve(s)` : 'Prêt pour revue'}
      </span>
    );
  }
  return (
    <span className={`${styles.checkLabel} ${dossier.analysis.checks.allPassed ? '' : styles.checkDanger}`}>
      {dossier.analysis.checks.allPassed ? <CheckIcon /> : <AlertIcon />}
      {dossier.analysis.checks.allPassed ? 'Contrôles essentiels OK' : 'Anomalies détectées'}
    </span>
  );
}

export function DashboardView({ dossiers, onDelete, onExport, onImportBackup, onLetter, onNewImport, onOpen }: DashboardViewProps) {
  const backupInput = useRef<HTMLInputElement>(null);
  const ordered = [...dossiers].sort((left, right) => right.lastImportedAt.localeCompare(left.lastImportedAt));

  return (
    <section className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitleBlock}>
          <h1 className={styles.pageTitle}>Dossiers clients</h1>
          <p className={styles.pageIntro}>Importez le FEC réel d’un client pour recalculer ses états, vérifier les équilibres et suivre ses prochaines échéances.</p>
        </div>
        <div className={styles.dashboardActions}>
          <button className={styles.buttonPrimary} onClick={onNewImport} type="button"><UploadIcon />Importer un FEC</button>
          <div className={styles.inlineActions}>
            <button className={styles.button} onClick={onLetter} type="button"><PenIcon />Lettre de mission</button>
            <button className={styles.button} onClick={() => backupInput.current?.click()} type="button"><UploadIcon />Restaurer</button>
            <button className={styles.button} onClick={onExport} type="button"><DownloadIcon />Sauvegarder</button>
          </div>
        </div>
      </header>

      <div className={styles.trustBanner}><ShieldIcon /><span>Vos dossiers restent dans ce navigateur — rien n’est envoyé à un serveur. Le FEC brut n’est pas conservé après l’analyse.</span></div>

      {ordered.length === 0 ? (
        <div className={styles.tablePanel}>
          <div className={styles.emptyState}>
            <div className={styles.emptyStateInner}>
              <span className={styles.emptyIcon}><FolderIcon /></span>
              <h2>Votre portefeuille est vide</h2>
              <p>Déposez le premier FEC. Bob vérifiera sa structure et produira la balance, le compte de résultat et le bilan directement sur ce poste.</p>
              <button className={styles.buttonPrimary} onClick={onNewImport} type="button"><UploadIcon />Importer un FEC</button>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.tablePanel}>
          <div className={styles.panelHeader}>
            <div><h2>Tableau de production</h2><p>{ordered.length} dossier{ordered.length > 1 ? 's' : ''} · mis à jour depuis la comptabilité réelle</p></div>
            <span className={styles.cellMeta}>Trié par dernier import</span>
          </div>
          <table className={styles.productionTable}>
            <thead><tr><th>Client</th><th>Période</th><th>Résultat</th><th>Équilibres</th><th>Prochaine échéance</th><th>Revue</th><th><span className={styles.srOnly}>Actions</span></th></tr></thead>
            <tbody>
              {ordered.map((dossier) => {
                const deadline = nextDeadline(dossier);
                const balanced = dossier.financial.trialBalanceBalanced && dossier.financial.balanceSheetBalanced;
                return (
                  <tr key={dossier.siren} onClick={() => onOpen(dossier.siren)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(dossier.siren); }}>
                    <td><div className={styles.clientCell}><strong>{dossier.clientName}</strong><span>SIREN {formatSiren(dossier.siren)} · {dossier.entryCount} écritures</span></div></td>
                    <td className={styles.numeric}>{periodLabel(dossier)}</td>
                    <td><div className={styles.clientCell}><strong className={`${styles.numeric} ${dossier.financial.resultCents < 0 ? styles.negative : ''}`}>{formatEUR(dossier.financial.resultCents)}</strong><span>CA {formatEUR(dossier.financial.turnoverCents)}</span></div></td>
                    <td><span className={`${styles.checkLabel} ${balanced ? '' : styles.checkDanger}`}>{balanced ? <CheckIcon /> : <AlertIcon />}{balanced ? 'Conformes' : 'À corriger'}</span></td>
                    <td>{deadline ? <div className={styles.deadlineCell}><strong>{deadline.label}</strong><span className={styles.cellMeta}>{frDate(deadline.date)} · {deadline.confidence === 'assumed' ? 'à confirmer' : 'date certaine'}</span></div> : <span className={styles.cellMeta}>Aucune date dans l’horizon</span>}</td>
                    <td><ReviewCell dossier={dossier} /></td>
                    <td><button aria-label={`Supprimer le dossier ${dossier.clientName}`} className={styles.iconButton} onClick={(event) => { event.stopPropagation(); onDelete(dossier); }} title="Supprimer le dossier" type="button"><TrashIcon /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <input ref={backupInput} className={styles.srOnly} accept="application/json,.json" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onImportBackup(file); event.currentTarget.value = ''; }} />

      <div className={styles.workflowPanel}>
        <div className={styles.workflowStep}><span className={styles.stepNumber}>1</span><div><strong>Importer le FEC</strong><p>Le fichier réglementaire reste sur le poste du cabinet.</p></div></div>
        <div className={styles.workflowStep}><span className={styles.stepNumber}>2</span><div><strong>Contrôles automatiques</strong><p>Bob rejoue les mêmes moteurs comptables que le mobile.</p></div></div>
        <div className={styles.workflowStep}><span className={styles.stepNumber}>3</span><div><strong>Revue de l’expert</strong><p>Le cabinet analyse les résultats et prépare ses conclusions.</p></div></div>
      </div>
    </section>
  );
}
