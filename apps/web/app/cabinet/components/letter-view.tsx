'use client';

import { useMemo, useState } from 'react';
import {
  buildMissionLetter,
  MISSION_KINDS,
  MISSION_LETTER_DISCLAIMER,
  type MissionKind,
  type MissionLetterDocument,
  type MissionLetterInput,
} from '@/src/cabinet/mission-letter';
import type { CabinetDossier } from '@/src/cabinet/types';
import styles from '../cabinet.module.css';
import { AlertIcon, ArrowLeftIcon, PrintIcon, RefreshIcon, ShieldIcon } from './icons';

interface LetterViewProps {
  dossiers: CabinetDossier[];
  initialDossier: CabinetDossier | null;
  onBack: () => void;
}

interface LetterFormState {
  selectedSiren: string;
  cabinetName: string;
  expertName: string;
  orderRegistration: string;
  cabinetAddress: string;
  cabinetEmail: string;
  clientName: string;
  clientLegalForm: string;
  siren: string;
  activity: string;
  clientAddress: string;
  representativeName: string;
  missions: MissionKind[];
  feeKind: 'fixed' | 'hourly';
  fixedAmountEuros: string;
  frequency: 'monthly' | 'quarterly' | 'annual';
  hourlyRateEuros: string;
  estimatedHours: string;
  paymentTerms: string;
  revisionTerms: string;
  expensesPolicy: string;
  startsOn: string;
  term: 'fixed' | 'indefinite';
  endsOn: string;
  renewal: 'none' | 'tacit';
  noticeMonths: string;
  terminationTerms: string;
  documentsDue: string;
  exchangeChannel: string;
  deliveryCommitment: string;
  signaturePlace: string;
}

const MISSION_LABELS: Record<MissionKind, string> = {
  bookkeeping: 'Tenue comptable',
  review: 'Révision',
  annual_accounts: 'Comptes annuels',
  tax_returns: 'Déclarations fiscales',
  social: 'Mission sociale',
};

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function initialState(dossier: CabinetDossier | null): LetterFormState {
  return {
    selectedSiren: dossier?.siren ?? '',
    cabinetName: '',
    expertName: '',
    orderRegistration: '',
    cabinetAddress: '',
    cabinetEmail: '',
    clientName: dossier?.clientName ?? '',
    clientLegalForm: dossier?.fiscal.legalForm ?? '',
    siren: dossier?.siren ?? '',
    activity: '',
    clientAddress: '',
    representativeName: '',
    missions: ['bookkeeping', 'review', 'annual_accounts', 'tax_returns'],
    feeKind: 'fixed',
    fixedAmountEuros: '1200,00',
    frequency: 'annual',
    hourlyRateEuros: '100,00',
    estimatedHours: '',
    paymentTerms: 'Facturation selon l’échéancier convenu, payable à 30 jours.',
    revisionTerms: 'Révision annuelle après information du client et accord écrit.',
    expensesPolicy: 'Frais et débours facturés sur justificatifs après accord préalable.',
    startsOn: today(),
    term: 'indefinite',
    endsOn: '',
    renewal: 'none',
    noticeMonths: '3',
    terminationTerms: 'Résiliation par écrit, sous réserve du préavis et de la remise des éléments nécessaires à la continuité du dossier.',
    documentsDue: 'Calendrier de remise des pièces à compléter avant signature.',
    exchangeChannel: 'Espace sécurisé Bob Pro ou autre canal validé par le cabinet.',
    deliveryCommitment: 'Délais à définir selon la mission, après réception complète des pièces.',
    signaturePlace: '',
  };
}

function eurosToCents(value: string): number {
  const normalized = value.trim().replace('.', ',');
  const match = /^(\d+)(?:,(\d{1,2}))?$/.exec(normalized);
  if (!match) return 0;
  const cents = BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : 0;
}

function buildInput(form: LetterFormState): MissionLetterInput {
  const fees: MissionLetterInput['fees'] = form.feeKind === 'fixed'
    ? {
        kind: 'fixed',
        amountExcludingTaxCents: eurosToCents(form.fixedAmountEuros),
        frequency: form.frequency,
        paymentTerms: form.paymentTerms,
        revisionTerms: form.revisionTerms,
        expensesPolicy: form.expensesPolicy,
      }
    : {
        kind: 'hourly',
        hourlyRateExcludingTaxCents: eurosToCents(form.hourlyRateEuros),
        estimatedHours: form.estimatedHours.trim() ? Number(form.estimatedHours) : null,
        paymentTerms: form.paymentTerms,
        revisionTerms: form.revisionTerms,
        expensesPolicy: form.expensesPolicy,
      };
  return {
    generatedOn: today(),
    cabinet: {
      name: form.cabinetName,
      charteredAccountantName: form.expertName,
      orderRegistration: form.orderRegistration,
      address: form.cabinetAddress,
      ...(form.cabinetEmail.trim() ? { email: form.cabinetEmail } : {}),
    },
    client: {
      name: form.clientName,
      legalForm: form.clientLegalForm,
      siren: form.siren,
      activity: form.activity,
      address: form.clientAddress,
      ...(form.representativeName.trim() ? { representativeName: form.representativeName } : {}),
    },
    missions: form.missions,
    fees,
    duration: {
      startsOn: form.startsOn,
      term: form.term,
      endsOn: form.term === 'fixed' && form.endsOn ? form.endsOn : null,
      renewal: form.renewal,
      noticeMonths: Number(form.noticeMonths),
      terminationTerms: form.terminationTerms,
    },
    workingArrangements: {
      documentsDue: form.documentsDue,
      exchangeChannel: form.exchangeChannel,
      deliveryCommitment: form.deliveryCommitment,
    },
    signature: {
      place: form.signaturePlace,
      signedOn: null,
    },
  };
}

function buildDocument(form: LetterFormState): { document: MissionLetterDocument | null; error: string | null } {
  try {
    return { document: buildMissionLetter(buildInput(form)), error: null };
  } catch (error) {
    return { document: null, error: error instanceof Error ? error.message : 'Le document ne peut pas être généré.' };
  }
}

function LetterPreview({ document }: { document: MissionLetterDocument }) {
  return (
    <article className={styles.letterPaper} id="mission-letter-preview">
      <h1>{document.title}</h1>
      <p><strong>Référence :</strong> {document.reference}</p>
      <p><strong>Établie le :</strong> {document.generatedOn}</p>
      <div className={styles.letterParties}>
        {document.introduction.map((paragraph, index) => <p className={styles.letterParty} key={index}>{paragraph}</p>)}
      </div>
      {document.sections.map((section) => (
        <section key={section.id}>
          <h2>{section.title}</h2>
          {section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
          {section.items.length > 0 ? <ul className={styles.missionList}>{section.items.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
        </section>
      ))}
      <div className={styles.letterSignatures}>
        {document.signatures.map((signature) => <div key={signature.party}><strong>{signature.label}</strong><p>{signature.signerName}</p><p>Fait à {signature.place}, le {signature.signedOn}</p><p>{signature.approvalMention}</p><div className={styles.signatureLine} /><span className={styles.signatureLabel}>Signature</span></div>)}
      </div>
    </article>
  );
}

export function LetterView({ dossiers, initialDossier, onBack }: LetterViewProps) {
  const [form, setForm] = useState(() => initialState(initialDossier));
  const preview = useMemo(() => buildDocument(form), [form]);

  const chooseDossier = (siren: string) => {
    const dossier = dossiers.find((candidate) => candidate.siren === siren) ?? null;
    setForm((current) => ({
      ...current,
      selectedSiren: siren,
      clientName: dossier?.clientName ?? '',
      clientLegalForm: dossier?.fiscal.legalForm ?? '',
      siren: dossier?.siren ?? '',
    }));
  };

  const toggleMission = (mission: MissionKind) => {
    setForm((current) => ({
      ...current,
      missions: current.missions.includes(mission)
        ? current.missions.filter((candidate) => candidate !== mission)
        : [...current.missions, mission],
    }));
  };

  return (
    <section className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitleBlock}>
          <h1 className={styles.pageTitle}>Lettre de mission</h1>
          <p className={styles.pageIntro}>Préparez une base structurée, adaptez chaque clause à la mission réelle, puis imprimez ou enregistrez le document en PDF depuis le navigateur.</p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.button} onClick={onBack} type="button"><ArrowLeftIcon />Dossiers</button>
          <button className={styles.buttonPrimary} disabled={preview.document === null} onClick={() => window.print()} type="button"><PrintIcon />Imprimer / Enregistrer en PDF</button>
        </div>
      </header>

      <div className={styles.trustBanner}><ShieldIcon /><span>Aucune donnée n’est envoyée. Les champs restent dans la mémoire de cette page et ne sont pas ajoutés au portefeuille.</span></div>

      <div className={styles.letterWorkspace}>
        <div className={styles.formPanel}>
          <form className={styles.letterForm} onSubmit={(event) => event.preventDefault()}>
            <section className={styles.formSection}>
              <div className={styles.formSectionTitle}><h2>Préremplissage</h2><span>Optionnel</span></div>
              <div className={styles.fieldFull}><label htmlFor="letter-dossier">Dossier client</label><select id="letter-dossier" value={form.selectedSiren} onChange={(event) => chooseDossier(event.target.value)}><option value="">Aucun dossier</option>{dossiers.map((dossier) => <option key={dossier.siren} value={dossier.siren}>{dossier.clientName} · {dossier.siren}</option>)}</select></div>
            </section>

            <section className={styles.formSection}>
              <div className={styles.formSectionTitle}><h2>1. Cabinet</h2><span>Champs obligatoires</span></div>
              <div className={styles.formGrid}>
                <div className={styles.field}><label htmlFor="cabinet-name">Raison sociale du cabinet</label><input id="cabinet-name" required value={form.cabinetName} onChange={(event) => setForm((current) => ({ ...current, cabinetName: event.target.value }))} /></div>
                <div className={styles.field}><label htmlFor="expert-name">Expert-comptable</label><input id="expert-name" required value={form.expertName} onChange={(event) => setForm((current) => ({ ...current, expertName: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="order-registration">Inscription à l’Ordre</label><input id="order-registration" placeholder="Numéro et Conseil régional" required value={form.orderRegistration} onChange={(event) => setForm((current) => ({ ...current, orderRegistration: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="cabinet-address">Adresse</label><input id="cabinet-address" required value={form.cabinetAddress} onChange={(event) => setForm((current) => ({ ...current, cabinetAddress: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="cabinet-email">Adresse de contact RGPD</label><input id="cabinet-email" type="email" value={form.cabinetEmail} onChange={(event) => setForm((current) => ({ ...current, cabinetEmail: event.target.value }))} /></div>
              </div>
            </section>

            <section className={styles.formSection}>
              <div className={styles.formSectionTitle}><h2>2. Client</h2><span>À vérifier avant signature</span></div>
              <div className={styles.formGridThree}>
                <div className={styles.field}><label htmlFor="letter-client-name">Raison sociale</label><input id="letter-client-name" required value={form.clientName} onChange={(event) => setForm((current) => ({ ...current, clientName: event.target.value }))} /></div>
                <div className={styles.field}><label htmlFor="client-form">Forme juridique</label><input id="client-form" required value={form.clientLegalForm} onChange={(event) => setForm((current) => ({ ...current, clientLegalForm: event.target.value }))} /></div>
                <div className={styles.field}><label htmlFor="letter-siren">SIREN</label><input id="letter-siren" inputMode="numeric" required value={form.siren} onChange={(event) => setForm((current) => ({ ...current, siren: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="activity">Activité</label><input id="activity" required value={form.activity} onChange={(event) => setForm((current) => ({ ...current, activity: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="client-address">Adresse</label><input id="client-address" required value={form.clientAddress} onChange={(event) => setForm((current) => ({ ...current, clientAddress: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="representative">Représentant légal</label><input id="representative" value={form.representativeName} onChange={(event) => setForm((current) => ({ ...current, representativeName: event.target.value }))} /></div>
              </div>
            </section>

            <section className={styles.formSection}>
              <div className={styles.formSectionTitle}><h2>3. Périmètre de la mission</h2><span>Au moins une mission</span></div>
              <div className={styles.checkGroup}>{MISSION_KINDS.map((mission) => <label className={styles.choice} key={mission}><input checked={form.missions.includes(mission)} onChange={() => toggleMission(mission)} type="checkbox" />{MISSION_LABELS[mission]}</label>)}</div>
              <div className={styles.formGridThree}>
                <div className={styles.fieldFull}><label htmlFor="documents-due">Remise des pièces</label><input id="documents-due" value={form.documentsDue} onChange={(event) => setForm((current) => ({ ...current, documentsDue: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="exchange-channel">Canal d’échange sécurisé</label><input id="exchange-channel" value={form.exchangeChannel} onChange={(event) => setForm((current) => ({ ...current, exchangeChannel: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="delivery-commitment">Délais du cabinet</label><input id="delivery-commitment" value={form.deliveryCommitment} onChange={(event) => setForm((current) => ({ ...current, deliveryCommitment: event.target.value }))} /></div>
              </div>
            </section>

            <section className={styles.formSection}>
              <div className={styles.formSectionTitle}><h2>4. Honoraires</h2><span>HT</span></div>
              <div className={styles.radioGroup}><label className={styles.choice}><input checked={form.feeKind === 'fixed'} name="fee-kind" onChange={() => setForm((current) => ({ ...current, feeKind: 'fixed' }))} type="radio" />Forfait</label><label className={styles.choice}><input checked={form.feeKind === 'hourly'} name="fee-kind" onChange={() => setForm((current) => ({ ...current, feeKind: 'hourly' }))} type="radio" />Taux horaire</label></div>
              <div className={styles.formGridThree}>
                {form.feeKind === 'fixed' ? <><div className={styles.field}><label htmlFor="fixed-amount">Montant HT</label><input id="fixed-amount" inputMode="decimal" value={form.fixedAmountEuros} onChange={(event) => setForm((current) => ({ ...current, fixedAmountEuros: event.target.value }))} /></div><div className={styles.field}><label htmlFor="frequency">Périodicité</label><select id="frequency" value={form.frequency} onChange={(event) => setForm((current) => ({ ...current, frequency: event.target.value as LetterFormState['frequency'] }))}><option value="monthly">Mensuelle</option><option value="quarterly">Trimestrielle</option><option value="annual">Annuelle</option></select></div></> : <><div className={styles.field}><label htmlFor="hourly-rate">Taux horaire HT</label><input id="hourly-rate" inputMode="decimal" value={form.hourlyRateEuros} onChange={(event) => setForm((current) => ({ ...current, hourlyRateEuros: event.target.value }))} /></div><div className={styles.field}><label htmlFor="estimated-hours">Heures estimées</label><input id="estimated-hours" inputMode="decimal" value={form.estimatedHours} onChange={(event) => setForm((current) => ({ ...current, estimatedHours: event.target.value }))} /></div></>}
                <div className={styles.fieldFull}><label htmlFor="payment-terms">Facturation et règlement</label><input id="payment-terms" value={form.paymentTerms} onChange={(event) => setForm((current) => ({ ...current, paymentTerms: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="revision-terms">Révision des honoraires</label><input id="revision-terms" value={form.revisionTerms} onChange={(event) => setForm((current) => ({ ...current, revisionTerms: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="expenses-policy">Frais et débours</label><input id="expenses-policy" value={form.expensesPolicy} onChange={(event) => setForm((current) => ({ ...current, expensesPolicy: event.target.value }))} /></div>
              </div>
            </section>

            <section className={styles.formSection}>
              <div className={styles.formSectionTitle}><h2>5. Durée et renouvellement</h2><span>À adapter</span></div>
              <div className={styles.formGridThree}>
                <div className={styles.field}><label htmlFor="starts-on">Date de début</label><input id="starts-on" type="date" value={form.startsOn} onChange={(event) => setForm((current) => ({ ...current, startsOn: event.target.value }))} /></div>
                <div className={styles.field}><label htmlFor="term">Durée</label><select id="term" value={form.term} onChange={(event) => { const term = event.target.value as LetterFormState['term']; setForm((current) => ({ ...current, term, renewal: term === 'indefinite' ? 'none' : current.renewal })); }}><option value="indefinite">Indéterminée</option><option value="fixed">Déterminée</option></select></div>
                {form.term === 'fixed' ? <div className={styles.field}><label htmlFor="ends-on">Date de fin</label><input id="ends-on" type="date" value={form.endsOn} onChange={(event) => setForm((current) => ({ ...current, endsOn: event.target.value }))} /></div> : null}
                <div className={styles.field}><label htmlFor="renewal">Renouvellement</label><select id="renewal" value={form.renewal} onChange={(event) => setForm((current) => ({ ...current, renewal: event.target.value as LetterFormState['renewal'] }))}><option value="tacit">Tacite</option><option value="none">Aucun</option></select></div>
                <div className={styles.field}><label htmlFor="notice">Préavis (mois)</label><input id="notice" inputMode="numeric" min="0" max="24" type="number" value={form.noticeMonths} onChange={(event) => setForm((current) => ({ ...current, noticeMonths: event.target.value }))} /></div>
                <div className={styles.field}><label htmlFor="signature-place">Lieu de signature</label><input id="signature-place" value={form.signaturePlace} onChange={(event) => setForm((current) => ({ ...current, signaturePlace: event.target.value }))} /></div>
                <div className={styles.fieldFull}><label htmlFor="termination-terms">Modalités de résiliation</label><textarea id="termination-terms" value={form.terminationTerms} onChange={(event) => setForm((current) => ({ ...current, terminationTerms: event.target.value }))} /></div>
              </div>
            </section>

            <div className={styles.formActions}><button className={styles.button} onClick={() => { if (window.confirm('Réinitialiser tous les champs de la lettre ?')) setForm(initialState(initialDossier)); }} type="button"><RefreshIcon />Réinitialiser</button><button className={styles.buttonPrimary} disabled={preview.document === null} onClick={() => window.print()} type="button"><PrintIcon />Imprimer / PDF</button></div>
          </form>
        </div>

        <aside className={styles.paperPanel}>
          <div className={styles.paperToolbar}><strong>Aperçu du document</strong><span className={preview.document ? styles.positive : styles.negative}>{preview.document ? 'Document prêt à relire' : 'Champs à compléter'}</span></div>
          {preview.document ? <LetterPreview document={preview.document} /> : <div className={styles.emptyState} style={{ minHeight: 700, background: '#fff' }}><div className={styles.emptyStateInner}><span className={styles.emptyIcon}><AlertIcon /></span><h2>Complétez les identités</h2><p>{preview.error}. L’aperçu complet apparaîtra sans envoyer les informations.</p></div></div>}
          <div className={styles.letterDisclaimer}><AlertIcon /> {MISSION_LETTER_DISCLAIMER} Les mentions entre crochets, la médiation et la qualification RGPD doivent être complétées avant signature.</div>
        </aside>
      </div>
    </section>
  );
}
