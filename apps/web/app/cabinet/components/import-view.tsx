'use client';

import { formatEUR, type DateOnly, type LegalForm, type UrssafPeriodicity, type VatRegime } from '@bob/core';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { ImportIdentityInput, PendingFecImport } from '../cabinet-app';
import styles from '../cabinet.module.css';
import { AlertIcon, ArrowLeftIcon, CheckIcon, DocumentIcon, ShieldIcon, UploadIcon } from './icons';

interface ImportViewProps {
  busy: boolean;
  onCancel: () => void;
  onFile: (file: File) => void | Promise<void>;
  onSave: (identity: ImportIdentityInput) => void | Promise<void>;
  pending: PendingFecImport | null;
}

const LEGAL_FORMS: Array<{ value: LegalForm; label: string }> = [
  { value: 'EI', label: 'Entreprise individuelle' },
  { value: 'micro', label: 'Micro-entreprise' },
  { value: 'EURL', label: 'EURL' },
  { value: 'SARL', label: 'SARL' },
  { value: 'SASU', label: 'SASU' },
  { value: 'SAS', label: 'SAS' },
];

const VAT_REGIMES: Array<{ value: VatRegime; label: string }> = [
  { value: 'franchise', label: 'Franchise en base' },
  { value: 'reel_simpl', label: 'Réel simplifié' },
  { value: 'reel_normal', label: 'Réel normal' },
];

function initialForm(pending: PendingFecImport | null) {
  const previous = pending?.previous;
  return {
    clientName: previous?.clientName ?? '',
    siren: previous?.siren ?? pending?.suggestedSiren ?? '',
    legalForm: previous?.fiscal.legalForm ?? ('EI' as LegalForm),
    vatRegime: previous?.fiscal.vatRegime ?? ('reel_normal' as VatRegime),
    incomeTaxRegime: previous?.fiscal.incomeTaxRegime ?? ('IR' as const),
    fiscalYearEnd: previous?.fiscal.fiscalYearEnd ?? '12-31',
    urssafPeriodicity: previous?.fiscal.urssafPeriodicity ?? ('' as '' | UrssafPeriodicity),
    dateCreation: previous?.fiscal.dateCreation ?? '',
  };
}

export function ImportView({ busy, onCancel, onFile, onSave, pending }: ImportViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [form, setForm] = useState(() => initialForm(pending));

  useEffect(() => setForm(initialForm(pending)), [pending]);

  const receive = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void onFile(file);
  };

  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragActive(false);
    receive(event.dataTransfer.files);
  };

  const submit = () => {
    void onSave({
      clientName: form.clientName,
      siren: form.siren,
      legalForm: form.legalForm,
      vatRegime: form.vatRegime,
      incomeTaxRegime: form.incomeTaxRegime,
      fiscalYearEnd: /^\d{2}-\d{2}$/.test(form.fiscalYearEnd) ? form.fiscalYearEnd : null,
      urssafPeriodicity: form.urssafPeriodicity || null,
      dateCreation: form.dateCreation ? (form.dateCreation as DateOnly) : null,
    });
  };

  return (
    <section className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitleBlock}>
          <h1 className={styles.pageTitle}>{pending ? 'Qualifier le dossier' : 'Importer un FEC'}</h1>
          <p className={styles.pageIntro}>{pending ? 'Le FEC est analysé. Complétez uniquement les informations que le fichier réglementaire ne contient pas.' : 'Déposez le fichier des écritures comptables du client. Son contenu est décodé et contrôlé directement dans ce navigateur.'}</p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.button} onClick={onCancel} type="button"><ArrowLeftIcon />Retour aux dossiers</button>
        </div>
      </header>

      <div className={styles.trustBanner}><ShieldIcon /><span>Le fichier est lu en ISO 8859-15 sur ce poste. Ni son contenu, ni ses lignes d’écriture ne sont téléversés ou conservés dans le portefeuille.</span></div>

      {!pending ? (
        <div className={styles.importLayout}>
          <label
            className={`${styles.dropZone} ${dragActive ? styles.dropZoneActive : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
            onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={drop}
          >
            <input ref={inputRef} accept=".txt,text/plain" disabled={busy} onChange={(event) => { receive(event.target.files); event.currentTarget.value = ''; }} type="file" />
            <div>
              <span className={styles.dropIcon}><UploadIcon /></span>
              <h2>{busy ? 'Lecture du FEC…' : 'Glissez-déposez le FEC ici'}</h2>
              <p>ou cliquez pour choisir le fichier `.txt` exporté depuis Bob Pro ou un logiciel comptable compatible.</p>
              <span className={styles.dropMeta}>18 colonnes réglementaires · Latin-9 · 50 Mo maximum</span>
            </div>
          </label>
          <div className={styles.asideStack}>
            <aside className={styles.infoPanel}><h3>Ce que Bob vérifie</h3><ul><li>Structure et types des 18 colonnes FEC.</li><li>Partie double, écriture par écriture.</li><li>Balance générale, compte de résultat et bilan.</li><li>Cohérence du résultat dans les trois états.</li></ul></aside>
            <aside className={styles.infoPanel}><h3>Identité du client</h3><p>Le FEC ne contient ni le nom ni la forme juridique. Bob récupère le SIREN depuis un nom réglementaire quand il existe, puis le cabinet confirme les informations.</p></aside>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.importSummary}>
            <div className={styles.summaryItem}><span>Fichier</span><strong>{pending.fileName}</strong></div>
            <div className={styles.summaryItem}><span>Période détectée</span><strong>{pending.parsed.period.from} → {pending.parsed.period.to}</strong></div>
            <div className={styles.summaryItem}><span>Volume</span><strong>{pending.parsed.entries.length} écritures · {pending.parsed.rows.length} lignes</strong></div>
            <div className={styles.summaryItem}><span>Résultat net</span><strong className={pending.analysis.incomeStatement.resultatNetCents < 0 ? styles.negative : styles.positive}>{formatEUR(pending.analysis.incomeStatement.resultatNetCents)}</strong></div>
          </div>

          {pending.review.anomalieCount > 0 ? (
            <div className={styles.errorNotice}><AlertIcon /><span><strong>Revue de Bob : {pending.review.anomalieCount} anomalie(s) bloquante(s).</strong> Le dossier peut être conservé pour analyse, mais doit être corrigé avant la revue de l’expert-comptable.</span></div>
          ) : pending.review.attentionCount > 0 ? (
            <div className={styles.warningNotice}><AlertIcon /><span><strong>Revue de Bob : {pending.review.attentionCount} point(s) sous réserve.</strong> Aucune anomalie dure ; l’expert-comptable doit apprécier et justifier ces points avant sa conclusion.</span></div>
          ) : (
            <div className={styles.trustBanner}><CheckIcon /><span><strong>Revue de Bob : {pending.review.okCount} diligences passées.</strong> Le dossier est prêt pour la revue de l’expert-comptable, avec {pending.review.infoCount} information(s) ou limitation(s) à lire.</span></div>
          )}

          <div className={styles.panel}>
            <form className={styles.identityForm} onSubmit={(event) => { event.preventDefault(); submit(); }}>
              <section className={styles.formSection}>
                <div className={styles.formSectionTitle}><h2>Identité du dossier</h2><span>Absente du contenu FEC</span></div>
                <div className={styles.formGrid}>
                  <div className={styles.field}><label htmlFor="client-name">Nom ou raison sociale</label><input id="client-name" autoComplete="organization" required value={form.clientName} onChange={(event) => setForm((current) => ({ ...current, clientName: event.target.value }))} /></div>
                  <div className={styles.field}><label htmlFor="siren">SIREN</label><input id="siren" inputMode="numeric" pattern="[0-9 ]{9,11}" placeholder="123 456 789" required value={form.siren} onChange={(event) => setForm((current) => ({ ...current, siren: event.target.value }))} /><span className={styles.fieldHint}>{pending.suggestedSiren ? 'Déduit du nom réglementaire du fichier — à confirmer.' : 'Neuf chiffres ; aucune identité n’est inventée.'}</span></div>
                </div>
              </section>

              <section className={styles.formSection}>
                <div className={styles.formSectionTitle}><h2>Profil fiscal</h2><span>Alimente l’échéancier @bob/core</span></div>
                <div className={styles.formGridThree}>
                  <div className={styles.field}><label htmlFor="legal-form">Forme juridique</label><select id="legal-form" value={form.legalForm} onChange={(event) => { const legalForm = event.target.value as LegalForm; setForm((current) => ({ ...current, legalForm, ...(legalForm === 'micro' ? { vatRegime: 'franchise', incomeTaxRegime: 'IR' } : {}) })); }}>{LEGAL_FORMS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
                  <div className={styles.field}><label htmlFor="vat-regime">Régime de TVA</label><select id="vat-regime" value={form.vatRegime} onChange={(event) => setForm((current) => ({ ...current, vatRegime: event.target.value as VatRegime }))}>{VAT_REGIMES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
                  <div className={styles.field}><span className={styles.fieldLegend}>Imposition du bénéfice</span><div className={styles.radioGroup}><label className={styles.choice}><input checked={form.incomeTaxRegime === 'IR'} name="tax-regime" onChange={() => setForm((current) => ({ ...current, incomeTaxRegime: 'IR' }))} type="radio" />IR</label><label className={styles.choice}><input checked={form.incomeTaxRegime === 'IS'} name="tax-regime" onChange={() => setForm((current) => ({ ...current, incomeTaxRegime: 'IS' }))} type="radio" />IS</label></div></div>
                  <div className={styles.field}><label htmlFor="year-end">Clôture d’exercice</label><input id="year-end" inputMode="numeric" pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])" placeholder="12-31" value={form.fiscalYearEnd} onChange={(event) => setForm((current) => ({ ...current, fiscalYearEnd: event.target.value }))} /><span className={styles.fieldHint}>Format MM-JJ.</span></div>
                  <div className={styles.field}><label htmlFor="creation-date">Date de création</label><input id="creation-date" type="date" value={form.dateCreation} onChange={(event) => setForm((current) => ({ ...current, dateCreation: event.target.value }))} /></div>
                  <div className={styles.field}><label htmlFor="urssaf">Périodicité URSSAF</label><select id="urssaf" value={form.urssafPeriodicity} onChange={(event) => setForm((current) => ({ ...current, urssafPeriodicity: event.target.value as '' | UrssafPeriodicity }))}><option value="">Non concerné / inconnue</option><option value="monthly">Mensuelle</option><option value="quarterly">Trimestrielle</option></select></div>
                </div>
                {form.incomeTaxRegime === 'IR' ? <div className={styles.warningNotice}><AlertIcon /><span>Le moteur fiscal v1 ne génère pas encore les déclarations de résultat IR. Il masquera les échéances IS sans fabriquer de dates 2031/2035 ou 2042-C-PRO.</span></div> : null}
              </section>

              <div className={styles.formActions}>
                <button className={styles.button} onClick={() => inputRef.current?.click()} type="button"><DocumentIcon />Choisir un autre fichier</button>
                <input ref={inputRef} className={styles.srOnly} accept=".txt,text/plain" type="file" onChange={(event) => { receive(event.target.files); event.currentTarget.value = ''; }} />
                <button aria-busy={busy} className={styles.buttonPrimary} disabled={busy} type="submit"><CheckIcon />{busy ? 'Enregistrement…' : pending.previous ? 'Mettre à jour le dossier' : 'Ajouter au portefeuille'}</button>
              </div>
            </form>
          </div>
        </>
      )}
    </section>
  );
}
