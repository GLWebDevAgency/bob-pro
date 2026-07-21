'use client';

import { formatEUR, type FiscalDeadline } from '@bob/core';
import { deriveCabinetFiscalCalendar } from '@/src/cabinet/fiscal-calendar';
import { tc } from '@/src/cabinet/i18n';
import type { CabinetDossierListItem } from '@/src/cabinet/api';
import styles from '../cabinet.module.css';
import { AlertIcon, CheckIcon, FolderIcon, PenIcon, ShieldIcon, TrashIcon, UploadIcon } from './icons';

interface DashboardViewProps {
  canDelete: boolean;
  cabinetName: string;
  dossiers: readonly CabinetDossierListItem[];
  mutationBusy: boolean;
  onDelete: (dossier: CabinetDossierListItem) => void;
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

function periodLabel(dossier: CabinetDossierListItem): string {
  return `${frDate(dossier.period.from)} – ${frDate(dossier.period.to)}`;
}

function formatSiren(siren: string): string {
  return siren.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
}

function nextDeadline(dossier: CabinetDossierListItem): FiscalDeadline | null {
  try {
    return deriveCabinetFiscalCalendar({ fiscal: dossier.fiscal, asOf: dateOnlyToday(), horizonDays: 400 }).deadlines[0] ?? null;
  } catch {
    return null;
  }
}

function ReviewCell({ dossier }: { dossier: CabinetDossierListItem }) {
  if (dossier.review) {
    const anomaly = dossier.review.verdict === 'anomalies';
    const reservations = dossier.review.verdict === 'reservations';
    return (
      <span className={`${styles.checkLabel} ${anomaly ? styles.checkDanger : reservations ? styles.checkWarning : ''}`}>
        {anomaly || reservations ? <AlertIcon /> : <CheckIcon />}
        {anomaly ? tc('cabinet.dashboard.reviewAnomalies', { count: dossier.review.anomalyCount }) : reservations ? tc('cabinet.dashboard.reviewReservations', { count: dossier.review.attentionCount }) : tc('cabinet.dashboard.reviewReady')}
      </span>
    );
  }
  const essentialChecksPassed = dossier.financial.trialBalanceBalanced
    && dossier.financial.balanceSheetBalanced
    && dossier.financial.statementsConsistent;
  return (
    <span className={`${styles.checkLabel} ${essentialChecksPassed ? '' : styles.checkDanger}`}>
      {essentialChecksPassed ? <CheckIcon /> : <AlertIcon />}
      {essentialChecksPassed ? tc('cabinet.dashboard.essentialChecksOk') : tc('cabinet.dashboard.anomaliesDetected')}
    </span>
  );
}

export function DashboardView({ canDelete, cabinetName, dossiers, mutationBusy, onDelete, onLetter, onNewImport, onOpen }: DashboardViewProps) {
  const ordered = [...dossiers].sort((left, right) => right.lastImportedAt.localeCompare(left.lastImportedAt));

  return (
    <section className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitleBlock}>
          <h1 className={styles.pageTitle}>{tc('cabinet.dashboard.title')}</h1>
          <p className={styles.pageIntro}>{tc('cabinet.dashboard.intro')}</p>
        </div>
        <div className={styles.dashboardActions}>
          <button className={styles.buttonPrimary} onClick={onNewImport} type="button"><UploadIcon />{tc('cabinet.dashboard.import')}</button>
          <div className={styles.inlineActions}>
            <button className={styles.button} onClick={onLetter} type="button"><PenIcon />{tc('cabinet.dashboard.letter')}</button>
          </div>
        </div>
      </header>

      <div className={styles.trustBanner}><ShieldIcon /><span>Les analyses structurées sont enregistrées dans l’espace sécurisé de {cabinetName}. Le FEC brut et ses lignes ne sont jamais téléversés.</span></div>

      {ordered.length === 0 ? (
        <div className={styles.tablePanel}>
          <div className={styles.emptyState}>
            <div className={styles.emptyStateInner}>
              <span className={styles.emptyIcon}><FolderIcon /></span>
              <h2>{tc('cabinet.dashboard.emptyTitle')}</h2>
              <p>Déposez le premier FEC réel. Bob l’analyse sur ce poste, puis enregistre uniquement les états structurés et contrôlés dans le cabinet sécurisé.</p>
              <button className={styles.buttonPrimary} onClick={onNewImport} type="button"><UploadIcon />{tc('cabinet.dashboard.import')}</button>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.tablePanel}>
          <div className={styles.panelHeader}>
            <div><h2>{tc('cabinet.dashboard.tableTitle')}</h2><p>{tc('cabinet.dashboard.tableSubtitle', { count: ordered.length })}</p></div>
            <span className={styles.cellMeta}>{tc('cabinet.dashboard.sorted')}</span>
          </div>
          <table className={styles.productionTable}>
            <thead><tr><th>{tc('cabinet.dashboard.client')}</th><th>{tc('cabinet.dashboard.period')}</th><th>{tc('cabinet.dashboard.result')}</th><th>{tc('cabinet.dashboard.balances')}</th><th>{tc('cabinet.dashboard.nextDeadline')}</th><th>{tc('cabinet.dashboard.review')}</th><th><span className={styles.srOnly}>{tc('cabinet.dashboard.actions')}</span></th></tr></thead>
            <tbody>
              {ordered.map((dossier) => {
                const deadline = nextDeadline(dossier);
                const balanced = dossier.financial.trialBalanceBalanced && dossier.financial.balanceSheetBalanced;
                return (
                  <tr key={dossier.siren}>
                    <td><button className={styles.clientCellButton} onClick={() => onOpen(dossier.siren)} type="button"><strong>{dossier.clientName}</strong><span>SIREN {formatSiren(dossier.siren)} · {dossier.entryCount} écritures</span></button></td>
                    <td className={styles.numeric}>{periodLabel(dossier)}</td>
                    <td><div className={styles.clientCell}><strong className={`${styles.numeric} ${dossier.financial.resultCents < 0 ? styles.negative : ''}`}>{formatEUR(dossier.financial.resultCents)}</strong><span>{tc('cabinet.dashboard.turnover', { amount: formatEUR(dossier.financial.turnoverCents) })}</span></div></td>
                    <td><span className={`${styles.checkLabel} ${balanced ? '' : styles.checkDanger}`}>{balanced ? <CheckIcon /> : <AlertIcon />}{balanced ? tc('cabinet.dashboard.compliant') : tc('cabinet.dashboard.toCorrect')}</span></td>
                    <td>{deadline ? <div className={styles.deadlineCell}><strong>{deadline.label}</strong><span className={styles.cellMeta}>{frDate(deadline.date)} · {deadline.confidence === 'assumed' ? tc('cabinet.dashboard.assumed') : tc('cabinet.dashboard.certain')}</span></div> : <span className={styles.cellMeta}>{tc('cabinet.dashboard.noDeadline')}</span>}</td>
                    <td><ReviewCell dossier={dossier} /></td>
                    <td>{canDelete ? <button aria-label={tc('cabinet.dashboard.deleteLabel', { name: dossier.clientName })} className={styles.iconButton} disabled={mutationBusy} onClick={() => onDelete(dossier)} title={tc('cabinet.dashboard.deleteTitle')} type="button"><TrashIcon /></button> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.workflowPanel}>
        <div className={styles.workflowStep}><span className={styles.stepNumber}>1</span><div><strong>{tc('cabinet.dashboard.workflowImport')}</strong><p>{tc('cabinet.dashboard.workflowImportHint')}</p></div></div>
        <div className={styles.workflowStep}><span className={styles.stepNumber}>2</span><div><strong>{tc('cabinet.dashboard.workflowChecks')}</strong><p>{tc('cabinet.dashboard.workflowChecksHint')}</p></div></div>
        <div className={styles.workflowStep}><span className={styles.stepNumber}>3</span><div><strong>{tc('cabinet.dashboard.workflowReview')}</strong><p>{tc('cabinet.dashboard.workflowReviewHint')}</p></div></div>
      </div>
    </section>
  );
}
