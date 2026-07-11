'use client';

import { formatEUR, type FiscalDeadline } from '@bob/core';
import { useMemo, useState } from 'react';
import { deriveCabinetFiscalCalendar, type CabinetFiscalCalendar } from '@/src/cabinet/fiscal-calendar';
import type { CabinetDossier, CabinetReviewSummary } from '@/src/cabinet/types';
import styles from '../cabinet.module.css';
import { AlertIcon, ArrowLeftIcon, CalendarIcon, CheckIcon, DocumentIcon, PenIcon, RefreshIcon, TrashIcon, UploadIcon } from './icons';

interface DossierViewProps {
  dossier: CabinetDossier;
  onBack: () => void;
  onDelete: () => void;
  onLetter: () => void;
  onUpdate: () => void;
}

function localDateOnly(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function frDate(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}

function frInstant(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatSiren(siren: string): string {
  return siren.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
}

function deadlineKind(deadline: FiscalDeadline): string {
  return ({ tva: 'TVA', urssaf: 'URSSAF', is: 'IS', cfe: 'CFE', comptes: 'COMPTES', ir: 'IR' } as const)[deadline.kind];
}

function deriveCalendar(dossier: CabinetDossier): CabinetFiscalCalendar | null {
  try {
    return deriveCabinetFiscalCalendar({ fiscal: dossier.fiscal, asOf: localDateOnly(), horizonDays: 400 });
  } catch {
    return null;
  }
}

function StatusIcon({ ok, neutral = false }: { ok: boolean; neutral?: boolean }) {
  if (neutral) return <DocumentIcon className={styles.warningIcon} />;
  return ok ? <CheckIcon className={styles.checkIcon} /> : <AlertIcon className={styles.dangerIcon} />;
}

function ReviewSummaryIcon({ review }: { review: CabinetReviewSummary | null }) {
  if (review === null) return <DocumentIcon className={styles.warningIcon} />;
  if (review.verdict === 'ready') return <CheckIcon className={styles.checkIcon} />;
  return <AlertIcon className={review.verdict === 'reservations' ? styles.warningIcon : styles.dangerIcon} />;
}

export function DossierView({ dossier, onBack, onDelete, onLetter, onUpdate }: DossierViewProps) {
  const [closingText, setClosingText] = useState<string | null>(null);
  const [closingFileName, setClosingFileName] = useState<string | null>(null);
  const [closingError, setClosingError] = useState<string | null>(null);
  const calendar = useMemo(() => deriveCalendar(dossier), [dossier]);
  const checks = dossier.analysis.checks;
  const reviewVerdict = dossier.review?.verdict ?? (checks.allPassed ? 'ready' : 'anomalies');
  const reviewTitle = dossier.review === null
    ? checks.allPassed ? 'Contrôles essentiels conformes' : 'Anomalies comptables détectées'
    : reviewVerdict === 'ready'
      ? 'Revue de Bob : prêt pour l’expert'
      : reviewVerdict === 'reservations'
        ? 'Revue de Bob : points sous réserve'
        : 'Revue de Bob : anomalies bloquantes';
  const reviewSubtitle = dossier.review === null
    ? checks.allPassed ? 'Actualisez le FEC pour lancer la revue approfondie' : 'À corriger avant toute conclusion'
    : reviewVerdict === 'ready'
      ? 'Prêt à être révisé par l’expert-comptable'
      : reviewVerdict === 'reservations'
        ? 'Appréciation et justificatifs attendus du cabinet'
        : 'À corriger avant la revue de l’expert-comptable';
  const income = dossier.analysis.incomeStatement;
  const balance = dossier.analysis.balanceSheet;

  const controls = [
    { title: 'Structure du FEC', detail: `${dossier.rowCount} lignes et 18 colonnes reconnues`, ok: true },
    { title: 'Écritures comptables', detail: checks.entriesBalanced ? `${dossier.entryCount} écritures équilibrées une à une` : `${dossier.analysis.unbalancedEntries.length} écriture(s) déséquilibrée(s)`, ok: checks.entriesBalanced },
    { title: 'Balance générale', detail: checks.trialBalanceBalanced ? 'Débit et crédit concordent au centime' : 'Écart global entre débit et crédit', ok: checks.trialBalanceBalanced },
    { title: 'Bilan', detail: checks.balanceSheetBalanced ? 'Actif et passif concordent au centime' : `Écart de ${formatEUR(Math.abs(balance.ecartCents))}`, ok: checks.balanceSheetBalanced },
    { title: 'Cohérence des états', detail: checks.resultConsistent ? 'Résultat identique dans les trois états' : 'Résultats divergents entre les états', ok: checks.resultConsistent },
  ];

  const readClosingText = async (file: File) => {
    setClosingError(null);
    if (!file.name.toLowerCase().endsWith('.txt')) {
      setClosingError('Le dossier de clôture doit être un fichier texte .txt.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setClosingError('Ce document dépasse 2 Mo ; vérifiez qu’il s’agit bien de la note de synthèse texte.');
      return;
    }
    try {
      setClosingText(await file.text());
      setClosingFileName(file.name);
    } catch {
      setClosingError('Impossible de lire ce document texte sur ce poste.');
    }
  };

  return (
    <section className={styles.page}>
      <header className={styles.dossierHeader}>
        <div className={styles.pageTitleBlock}>
          <button className={styles.button} onClick={onBack} type="button"><ArrowLeftIcon />Dossiers</button>
          <p className={styles.eyebrow} style={{ marginTop: 20 }}>Dossier client</p>
          <h1 className={styles.dossierTitle}>{dossier.clientName}</h1>
          <div className={styles.dossierMeta}>
            <span>SIREN {formatSiren(dossier.siren)}</span>
            <span>{dossier.fiscal.legalForm} · {dossier.fiscal.incomeTaxRegime}</span>
            <span>{dossier.sourceFileName}</span>
            <span>Importé le {frInstant(dossier.lastImportedAt)}</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.button} onClick={onLetter} type="button"><PenIcon />Lettre de mission</button>
          <button className={styles.button} onClick={onUpdate} type="button"><RefreshIcon />Actualiser le FEC</button>
          <button className={styles.buttonDanger} onClick={onDelete} type="button"><TrashIcon />Supprimer</button>
        </div>
      </header>

      <div className={styles.reviewBand}>
        <div className={`${styles.reviewVerdict} ${reviewVerdict === 'reservations' ? styles.reviewVerdictWarning : reviewVerdict === 'anomalies' ? styles.reviewVerdictDanger : ''}`}>
          <span className={styles.reviewVerdictIcon}>{reviewVerdict === 'ready' ? <CheckIcon /> : <AlertIcon />}</span>
          <div><strong>{reviewTitle}</strong><span>{reviewSubtitle}</span></div>
        </div>
        <div className={styles.reviewMetric}><span>Débit = Crédit</span><strong className={checks.trialBalanceBalanced ? styles.positive : styles.negative}>{checks.trialBalanceBalanced ? formatEUR(dossier.financial.totalDebitCents) : 'Écart détecté'}</strong></div>
        <div className={styles.reviewMetric}><span>Actif = Passif</span><strong className={checks.balanceSheetBalanced ? styles.positive : styles.negative}>{checks.balanceSheetBalanced ? formatEUR(balance.actif.totalCents) : formatEUR(balance.ecartCents)}</strong></div>
        <div className={styles.reviewMetric}><span>Résultat cohérent</span><strong className={checks.resultConsistent ? styles.positive : styles.negative}>{checks.resultConsistent ? formatEUR(income.resultatNetCents) : 'Divergence'}</strong></div>
      </div>

      {dossier.review === null ? (
        <div className={styles.notice}><DocumentIcon /><span>Ce dossier a été importé avant le branchement du moteur de revue approfondie. Actualisez son FEC pour exécuter les diligences officielles de `@bob/core`.</span></div>
      ) : dossier.review.verdict === 'anomalies' ? (
        <div className={styles.errorNotice}><AlertIcon /><span><strong>Revue de Bob : {dossier.review.anomalyCount} anomalie(s), {dossier.review.attentionCount} point(s) d’attention.</strong> {dossier.review.okCount} diligence(s) ont néanmoins été passées ; seul l’expert-comptable formule la conclusion et signe.</span></div>
      ) : dossier.review.verdict === 'reservations' ? (
        <div className={styles.warningNotice}><AlertIcon /><span><strong>Revue de Bob : aucune anomalie dure, {dossier.review.attentionCount} point(s) sous réserve.</strong> {dossier.review.okCount} diligence(s) passées et {dossier.review.infoCount} information(s) ou limitation(s) à apprécier par le cabinet.</span></div>
      ) : (
        <div className={styles.trustBanner}><CheckIcon /><span><strong>Revue de Bob : {dossier.review.okCount} diligences passées, aucune anomalie ni réserve.</strong> {dossier.review.infoCount} information(s) ou limitation(s) restent à lire ; le dossier est prêt pour la revue de l’expert-comptable.</span></div>
      )}

      <div className={styles.dossierWorkspace}>
        <aside>
          <div className={styles.panelHeader}><div><h2>Contrôles automatiques</h2><p>Même vérité comptable que le mobile</p></div></div>
          <div className={styles.controlList}>
            {controls.map((control, index) => (
              <div className={styles.controlRow} key={control.title}>
                <span className={styles.controlIndex}>{index + 1}</span>
                <div><strong>{control.title}</strong><p>{control.detail}</p></div>
                <StatusIcon ok={control.ok} />
              </div>
            ))}
            <div className={styles.controlRow}>
              <span className={styles.controlIndex}>6</span>
              <div><strong>Revue approfondie de Bob</strong><p>{dossier.review === null ? 'Actualisez le FEC pour exécuter le moteur core' : `${dossier.review.okCount} OK · ${dossier.review.attentionCount} attention · ${dossier.review.anomalyCount} anomalie`}</p></div>
              <ReviewSummaryIcon review={dossier.review} />
            </div>
          </div>
        </aside>

        <div className={styles.statementStack}>
          <section className={styles.statementPanel}>
            <div className={styles.panelHeader}><div><h2>Balance générale</h2><p>{dossier.analysis.trialBalance.rows.length} comptes mouvementés · {dossier.entryCount} écritures</p></div><span className={styles.numeric}>{frDate(dossier.period.from)} → {frDate(dossier.period.to)}</span></div>
            <div className={styles.tableScroll}>
              <table className={styles.balanceTable}>
                <thead><tr><th>Compte</th><th>Libellé</th><th>Débit</th><th>Crédit</th><th>Solde</th></tr></thead>
                <tbody>{dossier.analysis.trialBalance.rows.map((row) => <tr key={row.account}><td>{row.account}</td><td>{row.label}</td><td>{formatEUR(row.debitCents)}</td><td>{formatEUR(row.creditCents)}</td><td className={row.balanceCents < 0 ? styles.negative : ''}>{formatEUR(row.balanceCents)}</td></tr>)}</tbody>
                <tfoot><tr><td colSpan={2}>Totaux</td><td>{formatEUR(dossier.analysis.trialBalance.totalDebitCents)}</td><td>{formatEUR(dossier.analysis.trialBalance.totalCreditCents)}</td><td>{formatEUR(dossier.analysis.trialBalance.totalDebitCents - dossier.analysis.trialBalance.totalCreditCents)}</td></tr></tfoot>
              </table>
            </div>
            <div className={styles.statementCheck}><span>Débit = Crédit</span><strong>{checks.trialBalanceBalanced ? <CheckIcon /> : <AlertIcon />} {formatEUR(Math.abs(dossier.analysis.trialBalance.totalDebitCents - dossier.analysis.trialBalance.totalCreditCents))}</strong></div>
          </section>

          <div className={styles.statementColumns}>
            <section className={styles.statementPanel}>
              <div className={styles.panelHeader}><div><h2>Compte de résultat</h2><p>Lecture en cascade</p></div></div>
              <table className={styles.statementTable}>
                <tbody>
                  <tr><td>Produits d’exploitation</td><td>{formatEUR(income.exploitationProduitsCents)}</td></tr>
                  <tr><td>Charges d’exploitation</td><td>-{formatEUR(income.exploitationChargesCents)}</td></tr>
                  <tr className={styles.statementTotal}><td>Résultat d’exploitation</td><td>{formatEUR(income.resultatExploitationCents)}</td></tr>
                  <tr><td>Produits financiers</td><td>{formatEUR(income.financierProduitsCents)}</td></tr>
                  <tr><td>Charges financières</td><td>-{formatEUR(income.financierChargesCents)}</td></tr>
                  <tr className={styles.statementTotal}><td>Résultat courant</td><td>{formatEUR(income.resultatCourantCents)}</td></tr>
                  <tr><td>Résultat exceptionnel</td><td>{formatEUR(income.resultatExceptionnelCents)}</td></tr>
                  <tr><td>Participation</td><td>-{formatEUR(income.participationCents)}</td></tr>
                  <tr><td>Impôt sur les bénéfices</td><td>-{formatEUR(income.impotBeneficesCents)}</td></tr>
                  <tr className={styles.statementTotal}><td>Résultat net</td><td className={income.resultatNetCents < 0 ? styles.negative : styles.positive}>{formatEUR(income.resultatNetCents)}</td></tr>
                </tbody>
              </table>
              <div className={styles.statementCheck}><span>Résultat concordant</span><strong>{checks.resultConsistent ? <CheckIcon /> : <AlertIcon />} {checks.resultConsistent ? 'Oui' : 'Non'}</strong></div>
            </section>

            <section className={styles.statementPanel}>
              <div className={styles.panelHeader}><div><h2>Bilan</h2><p>au {frDate(dossier.period.to)}</p></div></div>
              <div className={styles.bilanGrid}>
                <div className={styles.bilanColumn}><h4>Actif</h4><div className={styles.bilanRow}><span>Immobilisations nettes</span><strong>{formatEUR(balance.actif.immobilisationsNettesCents)}</strong></div><div className={styles.bilanRow}><span>Stocks</span><strong>{formatEUR(balance.actif.stocksCents)}</strong></div><div className={styles.bilanRow}><span>Créances</span><strong>{formatEUR(balance.actif.creancesCents)}</strong></div><div className={styles.bilanRow}><span>Disponibilités</span><strong>{formatEUR(balance.actif.disponibilitesCents)}</strong></div><div className={`${styles.bilanRow} ${styles.bilanTotal}`}><span>Total actif</span><strong>{formatEUR(balance.actif.totalCents)}</strong></div></div>
                <div className={styles.bilanColumn}><h4>Passif</h4><div className={styles.bilanRow}><span>Capitaux propres</span><strong>{formatEUR(balance.passif.capitauxPropresCents)}</strong></div><div className={styles.bilanRow}><span>Résultat net</span><strong>{formatEUR(balance.passif.resultatNetCents)}</strong></div><div className={styles.bilanRow}><span>Provisions & emprunts</span><strong>{formatEUR(balance.passif.provisionsCents + balance.passif.empruntsCents)}</strong></div><div className={styles.bilanRow}><span>Dettes & découvert</span><strong>{formatEUR(balance.passif.dettesCents + balance.passif.decouvertCents)}</strong></div><div className={`${styles.bilanRow} ${styles.bilanTotal}`}><span>Total passif</span><strong>{formatEUR(balance.passif.totalCents)}</strong></div></div>
              </div>
              <div className={styles.statementCheck}><span>Actif = Passif</span><strong>{checks.balanceSheetBalanced ? <CheckIcon /> : <AlertIcon />} {formatEUR(Math.abs(balance.ecartCents))}</strong></div>
            </section>
          </div>
        </div>
      </div>

      <section className={`${styles.panel} ${styles.deadlinePanel}`}>
        <div className={styles.formSectionTitle}><div><h2>Suivi de production fiscal</h2><span>{dossier.fiscal.vatRegime} · {dossier.fiscal.incomeTaxRegime} · clôture {dossier.fiscal.fiscalYearEnd ?? 'à confirmer'}</span></div><CalendarIcon /></div>
        {calendar && calendar.deadlines.length > 0 ? <div className={styles.deadlineGrid}>{calendar.deadlines.slice(0, 6).map((deadline) => <article className={styles.deadlineCard} key={deadline.id}><header><span className={styles.deadlineKind}>{deadlineKind(deadline)}</span><time dateTime={deadline.date}>{frDate(deadline.date)}</time></header><strong>{deadline.label}</strong><p>{deadline.explain}</p></article>)}</div> : <p className={styles.pageIntro}>Aucune échéance dérivée dans les 400 prochains jours avec ce profil.</p>}
        {calendar?.limitations.map((limitation) => <p className={styles.fieldHint} key={limitation.code}>{limitation.message}</p>)}
      </section>

      <section className={`${styles.panel} ${styles.textDossier}`}>
        <div><h3>Dossier de clôture texte</h3><p>Ajoutez la note de synthèse produite par le mobile. Elle reste en mémoire uniquement pendant cette consultation.</p></div>
        <div>
          <label className={styles.compactDrop}><input accept=".txt,text/plain" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readClosingText(file); event.currentTarget.value = ''; }} /><UploadIcon /><span><strong>{closingFileName ?? 'Déposer la note de synthèse .txt'}</strong><span>UTF-8 · affichage texte sécurisé · aucun envoi</span></span></label>
          {closingError ? <div className={styles.errorNotice} style={{ marginTop: 12 }}><AlertIcon />{closingError}</div> : null}
          {closingText !== null ? <pre className={styles.dossierPre} style={{ marginTop: 14 }}>{closingText}</pre> : null}
        </div>
      </section>
    </section>
  );
}
