/**
 * Devis → signature → facture — flux modal 6 étapes (claim C21, réfs proto §showDevis).
 * PILOTÉ par la machine RÉELLE @bob/core flows/devis (C02) : startDevis → devisEdit
 * (saisie, jamais un changement d'étape) → devisNext (garde par étape → message i18n
 * à la voix de Bob si bloqué) → devisBack (correction, brouillon conservé). L'état des
 * étapes N'EXISTE QUE dans la machine — aucun useState d'étape parallèle.
 *
 * Étapes : 1 client (liste RÉELLE useCustomers, états vide/erreur de premier rang) ·
 * 2 lignes (saisie libre label/qté/PU/catégorie + SUGGESTIONS du catalogue C27 au fil de
 * la saisie du libellé — searchCatalogue @bob/core sur useCatalogue : tap = pré-remplit
 * libellé/PU/catégorie, la TVA reste pilotée par l'étape 3 qui s'applique à TOUT le devis ;
 * la saisie libre reste INTACTE, la suggestion est optionnelle) · 3 TVA/mentions (contexte
 * logement → taux appliqué à
 * tout le devis ; le taux est REVALIDÉ par le use case CreateQuote via suggestVatRate
 * — franchise/autoliquidation remontent en erreur réelle à la génération ; l'aperçu
 * buildMentions n'est pas exposé côté client → carte informative honnête) ·
 * 4 signature au doigt (SignaturePad @bob/ui → signerName commité dans la machine ;
 * le dataURL SVG est capturé mais l'API signQuote n'accepte que signerName — TODO C40) ·
 * 5 acompte (30 % défaut proto, éditable, net RÉEL computeTotals — cas d'or 488,40 €) ·
 * 6 génération : confirmation typée (challengeFor fiscal, même feuille que DocumentActions
 * /C20) puis LA chaîne EXACTE de l'app (devis/new historique + voix.tsx) : createQuote →
 * sendQuote → signQuote → generateInvoice (acompte si depositPct — parentQuoteId posé par
 * le domaine) → issueInvoice (numéro légal). Chaîne RÉSUMABLE (checkpoints par ref) : un
 * échec au milieu ne rejoue pas les use cases déjà passés. Succès → numéro réel + CTA
 * « Voir la facture » → /facture/[id] (pont C16) + Toast.
 *
 * Écarts assumés vs proto : le proto pré-remplit des lignes de démo (ici : données
 * réelles saisies, régime A1-C10 sans fixtures) ; ses 6 états (composer/envoyé/signature/
 * signé/facture/encaissé) sont re-séquencés par la machine core (client/lignes/TVA/
 * signature/acompte/facture) — l'encaissement vit sur l'écran facture (C16, parité
 * InvoiceActions). Zéro hex/rgba — tout vient de useTheme()/@bob/tokens.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { challengeFor, parseVoiceConsent } from '@bob/ai';
import {
  computeTotals,
  devisBack,
  devisEdit,
  devisNext,
  formatEUR,
  searchCatalogue,
  startDevis,
  DEVIS_STEPS,
  type CataloguePrestation,
  type CustomerListItem,
  type DevisDraft,
  type DevisFlowState,
  type DevisStep,
  type DevisTvaContext,
  type DomainError,
  type LineCategory,
  type VatRate,
  matchSpokenCustomers,
  normalizeVoiceText,
  devisDiff,
  frSpokenNumbersToDigits,
  withLineRemoved,
  withLineUpdated,
  type DevisProposal,
  type LineInput,
  parseVoiceQuoteLine,
  type VoicePrestation,
} from '@bob/core';
import { shadowNative, themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Avatar,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorRetry,
  MoneyText,
  SignaturePad,
  SkeletonRow,
  StatusBadge,
  Stepper,
  Toast,
  font,
  useTheme,
  type SignaturePadValue,
  type StatusBadgeVariant,
} from '@bob/ui';
import {
  appErrorMessage,
  useCreateQuote,
  useCustomers,
  useGenerateInvoice,
  useIssueInvoice,
  useProfile,
  useSendQuote,
  useSignQuote,
} from '../../src/data/hooks';
import { useCatalogue } from '../../src/data/catalogue';
import {
  consumeWizardHint,
  usePublishAgentContext,
  useAgentSession,
  type AgentAffordance,
  type AgentContext,
  type AgentSurface,
} from '../../src/agent';
import { useConfirm } from '../../src/components/ConfirmSheet';
import { CheckIcon, ChevronLeftIcon, CloseIcon } from '../../src/components/icons';

/** Profil de risque de la génération (émission = acte fiscal) — même palier que DocumentActions/C20. */
const FISCAL = { mutating: true, outbound: false, riskTier: 'fiscal' } as const;

/** Titres des 6 étapes de la machine (Stepper + en-têtes). */
const STEP_KEYS: Record<DevisStep, I18nKey> = {
  client: 'devis.stepClient',
  lignes: 'devis.stepLines',
  tvaMentions: 'devis.stepVat',
  signature: 'devis.stepSignature',
  acompte: 'devis.stepDeposit',
  facture: 'devis.stepInvoice',
};

/** Gardes de la machine → voix de Bob (champ de l'erreur VALIDATION → clé i18n). */
const GUARD_COPY: Readonly<Record<string, I18nKey>> = {
  customerId: 'devis.guardClient',
  lines: 'devis.guardLines',
  signerName: 'devis.guardSignature',
  depositPct: 'devis.guardDeposit',
};

function guardKeyOf(error: DomainError): I18nKey {
  if (error.code === 'VALIDATION') {
    const key = GUARD_COPY[error.field];
    if (key !== undefined) return key;
  }
  return 'devis.errAction';
}

/** Pastilles par type de client — mêmes teintes que le carnet C12 / la revue C20. */
const CUSTOMER_TONE: Record<CustomerListItem['type'], StatusBadgeVariant> = {
  b2c: 'particulier',
  b2b: 'b2b',
  b2g: 'b2g',
};
const CUSTOMER_BADGE: Record<CustomerListItem['type'], I18nKey> = {
  b2c: 'clients.badgeB2c',
  b2b: 'clients.badgeB2b',
  b2g: 'clients.badgeB2g',
};

/** Catégories de ligne proposées à la saisie (libellés partagés avec la revue C20). */
const LINE_CATEGORIES: readonly { key: LineCategory; labelKey: I18nKey }[] = [
  { key: 'labor', labelKey: 'voix.catLabor' },
  { key: 'supply', labelKey: 'voix.catSupply' },
  { key: 'travel', labelKey: 'voix.catTravel' },
];

/**
 * Choix de TVA de l'étape 3 : le taux et le contexte fiscal forment UN choix utilisateur
 * (mêmes couples que suggestVatRate — le use case CreateQuote fait foi et revalide :
 * requestedRate hors ensemble, franchise 293 B ou autoliquidation ⇒ erreur réelle).
 */
type VatChoice = 'standard' | 'housing' | 'energy';
const VAT_CHOICES: readonly {
  key: VatChoice;
  labelKey: I18nKey;
  rate: VatRate;
  context: DevisTvaContext | null;
}[] = [
  { key: 'standard', labelKey: 'devis.vatStandard', rate: 20, context: null },
  { key: 'housing', labelKey: 'devis.vatHousing', rate: 10, context: { housingOlderThan2y: true } },
  {
    key: 'energy',
    labelKey: 'devis.vatEnergy',
    rate: 5.5,
    context: { housingOlderThan2y: true, energyRenovation: true },
  },
];

/** Le choix courant se DÉRIVE du brouillon de la machine (source unique). */
function vatChoiceOf(context: DevisTvaContext | null): VatChoice {
  if (context?.energyRenovation) return 'energy';
  if (context?.housingOlderThan2y) return 'housing';
  return 'standard';
}

/** Presets d'acompte (30 % = défaut proto, 0 = facture unique). */
const DEPOSIT_PRESETS: readonly number[] = [0, 10, 20, 30, 40, 50];

/** Taux affiché à la française (5.5 → « 5,5 »). */
const fmtRate = (rate: number): string => String(rate).replace('.', ',');

const parsePositive = (value: string): number | null => {
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export default function DevisNew() {
  const { colors, semantic, controls, overlays, theme, radius, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const confirm = useConfirm();
  const customers = useCustomers();
  const { data: profile } = useProfile();
  const catalogue = useCatalogue();
  const createQuote = useCreateQuote();
  const sendQuote = useSendQuote();
  const signQuote = useSignQuote();
  const generateInvoice = useGenerateInvoice();
  const issueInvoice = useIssueInvoice();

  // ── Machine RÉELLE @bob/core (C02) : seule source de vérité des 6 étapes ──
  const [flow, setFlow] = useState<DevisFlowState>(() => startDevis());
  const [guardMsg, setGuardMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invoice, setInvoice] = useState<{ id: string; number: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Saisie d'une ligne (étape 2) — état de formulaire local, la donnée vit dans la machine.
  const [lineLabel, setLineLabel] = useState('');
  const [cataloguePickerOpen, setCataloguePickerOpen] = useState(false);
  /** S2 : proposition core EN ATTENTE (« corrige la ligne 2 → 450 € ») — patch NON appliqué,
   * diff visible, acceptée par la voix (consentement déterministe) OU par le tap (parité). */
  const [lineProposal, setLineProposal] = useState<DevisProposal | null>(null);
  const [lineQty, setLineQty] = useState('1');
  const [linePrice, setLinePrice] = useState('');
  const [lineCat, setLineCat] = useState<LineCategory>('labor');

  // Signature (étape 4) — le tracé est présentation ; seul signerName entre dans la machine.
  const [signature, setSignature] = useState<SignaturePadValue | null>(null);
  const [signerName, setSignerName] = useState('');

  // Checkpoints de la chaîne de génération (résumable après erreur — jamais de double use case).
  const chain = useRef<{ quoteId: string | null; sent: boolean; signed: boolean; invoiceId: string | null }>({
    quoteId: null,
    sent: false,
    signed: false,
    invoiceId: null,
  });

  const draft = flow.draft;
  const customer = (customers.data ?? []).find((c) => c.id === draft.customerId) ?? null;
  const customerName = customer?.name ?? 'le client';
  const stepIndex = DEVIS_STEPS.indexOf(flow.step);
  const stepLabels = DEVIS_STEPS.map((s) => t(STEP_KEYS[s], { personality }));
  const vatChoice = vatChoiceOf(draft.tvaContext);
  const currentRate = VAT_CHOICES.find((c) => c.key === vatChoice)?.rate ?? 20;
  const totals = computeTotals([...draft.lines], { depositPct: draft.depositPct });
  const dark = flow.step === 'signature'; // vue signature sur navy (réf proto « vue client »)

  // ── Transitions : TOUT passe par la machine ────────────────────────────────
  const edit = (patch: Partial<DevisDraft>): void => {
    setGuardMsg(null);
    setFlow((f) => devisEdit(f, patch));
  };

  const goNext = (): void => {
    const next = devisNext(flow);
    if (!next.ok) {
      setGuardMsg(t(guardKeyOf(next.error), { personality }));
      return;
    }
    setGuardMsg(null);
    setFlow(next.value);
  };

  const goBack = (): void => {
    const back = devisBack(flow);
    if (!back.ok) return; // 'client' est le début, 'facture' est terminal — la table fait foi
    setGuardMsg(null);
    setFlow(back.value);
  };

  // ── S2-GUIDÉ : pilotage VOCAL du wizard — parité stricte avec le geste manuel ──
  // Les affordances agissent via les MÊMES transitions machine (devisEdit/devisNext/devisBack)
  // que les boutons ; identité STABLE (refs) pour ne pas rebattre la publication à chaque rendu.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  // « Nouveau devis POUR Camping Les Pins » : le nom entendu (hint session) est résolu contre
  // les clients RÉELS dès leur chargement — client présélectionné + saut direct aux
  // prestations. Introuvable/ambigu → flux normal étape client (fail-safe, jamais de devinette).
  const [wizardHint] = useState(() => consumeWizardHint('devis-new'));
  const wizardHintRef = useRef(wizardHint);
  useEffect(() => {
    const hint = wizardHintRef.current;
    const reference = hint?.customerReference;
    if (!reference) return;
    const list = customers.data;
    if (!list || list.length === 0) return;
    if (flowRef.current.step !== 'client' || flowRef.current.draft.customerId !== null) return;
    wizardHintRef.current = null; // consommé — une seule tentative
    // Ambiguïté (deux « Camping ») → PAS de saut : l'étape client tranche à l'écran/à la voix.
    const candidates = matchSpokenCustomers(normalizeVoiceText(reference), list);
    if (candidates.length !== 1) return;
    const matchedId = candidates[0]!.id;
    setFlow((f) => {
      const edited = devisEdit(f, { customerId: matchedId });
      const next = devisNext(edited);
      return next.ok ? next.value : edited;
    });
  }, [customers.data]);
  const customersRef = useRef(customers.data ?? []);
  customersRef.current = customers.data ?? [];
  const prestationsRef = useRef<readonly VoicePrestation[]>([]);
  prestationsRef.current = catalogue.prestations
    .filter((p) => p.indicative !== true)
    .map((p) => ({
      label: p.label,
      category: p.category,
      unitPriceHT: p.unitPriceHT,
      vatRate: p.vatRate,
    }));
  const currentRateRef = useRef(currentRate);
  currentRateRef.current = currentRate;
  const personalityRef = useRef(personality);
  personalityRef.current = personality;
  /** Pont voix → formulaire (parité stricte) : la dictée PRÉPARE les champs visibles ;
   * « valide la ligne » appuie sur le MÊME bouton Ajouter que le doigt. */
  const lineFormRef = useRef<{
    prepare: (line: { label: string; qty: number; unitPriceHT: number; category: LineCategory }) => void;
    /** Soumet via le MÊME chemin que le bouton ; retourne la ligne EFFECTIVEMENT ajoutée. */
    submit: () => LineInput | null;
    reject: () => boolean;
  }>({ prepare: () => undefined, submit: () => null, reject: () => false });

  const voiceAffordances = useMemo<readonly AgentAffordance[]>(() => {
    const tt = (key: Parameters<typeof t>[0], params?: Record<string, string | number>): string =>
      t(key, { personality: personalityRef.current, ...(params ? { params } : {}) });

    const advance = (): string => {
      const current = flowRef.current;
      // PLANCHER DE SÉCURITÉ : signature, acompte (génération) et facture ne se franchissent
      // JAMAIS à la voix — ces étapes portent ConfirmSheet/runGeneration, l'écran fait foi.
      if (current.step === 'signature' || current.step === 'acompte' || current.step === 'facture') {
        return tt('devis.voice.screenOnlyStep');
      }
      // Résultat calculé sur l'état CANONIQUE avant de committer : Bob ne ment jamais.
      const next = devisNext(current);
      if (!next.ok) return t(guardKeyOf(next.error), { personality: personalityRef.current });
      setFlow(next.value);
      setGuardMsg(null);
      return tt('devis.voice.stepDone');
    };

    return [
      {
        // PRIORITÉ ABSOLUE quand une proposition attend : « oui/je confirme » applique,
        // « non/annule » rejette — parsé par NOTRE parseur déterministe, jamais par un LLM.
        id: 'devis.proposalConsent',
        match: (utterance) => {
          if (lineProposalRef.current.pending() === null) return null;
          const consent = parseVoiceConsent(utterance);
          if (consent === 'unclear') return null; // un autre ordre passe aux affordances suivantes
          return () => {
            if (consent === 'cancel') {
              lineProposalRef.current.reject();
              return { say: tt('devis.voice.proposalRejected') };
            }
            const applied = lineProposalRef.current.apply();
            const field = applied?.diff[0];
            return {
              say: field
                ? tt('devis.voice.proposalApplied', { field: field.field, after: field.after })
                : tt('devis.voice.proposalRejected'),
            };
          };
        },
      },
      {
        // « Corrige la ligne 2, c'est 450 pas 540 » / « passe la ligne 1 à 60 euros » —
        // le CAS FONDATEUR : patch core NON appliqué + diff parlé et affiché, puis consentement.
        id: 'devis.editLine',
        match: (utterance) => {
          if (flowRef.current.step !== 'lignes') return null;
          const n = frSpokenNumbersToDigits(normalizeVoiceText(utterance));
          const m = /(corrige|modifie|change|passe|mets?) (?:la |sur la )?ligne (\d{1,2})\b/.exec(n);
          if (!m || m[2] === undefined) return null;
          const ordinal = Number(m[2]);
          const price = /(?:a|à) (\d[\d ]*(?:,\d{1,2})?) ?(?:€|euros?)(?! .{0,10}pas )/.exec(n) ?? /c est (\d[\d ]*(?:,\d{1,2})?) ?(?:€|euros?)? pas /.exec(n);
          if (!price || price[1] === undefined) return null;
          const int = Number(price[1].replace(/\s+/g, '').replace(',', '.'));
          if (!Number.isFinite(int) || int <= 0) return null;
          const unitPriceHT = Math.round(int * 100);
          return () => {
            const draft = flowRef.current.draft;
            const patch = withLineUpdated(draft, ordinal, { unitPriceHT });
            if (!patch.ok) return { say: tt('devis.voice.proposalUnknownLine') };
            const diff = devisDiff(draft, { ...draft, ...patch.value });
            const field = diff[0];
            if (!field) return { say: tt('devis.voice.proposalUnknownLine') };
            setLineProposal({ label: `Ligne ${ordinal} → ${formatEUR(unitPriceHT)}`, patch: patch.value, diff });
            return {
              say: tt('devis.voice.proposalReady', { field: field.field, before: field.before, after: field.after }),
            };
          };
        },
      },
      {
        // « Supprime la ligne 2 » — même mécanique : proposition + diff + consentement.
        id: 'devis.removeLineByOrdinal',
        match: (utterance) => {
          if (flowRef.current.step !== 'lignes') return null;
          const n = frSpokenNumbersToDigits(normalizeVoiceText(utterance));
          const m = /(supprime|enleve|retire|efface) (?:la )?ligne (\d{1,2})\b/.exec(n);
          if (!m || m[2] === undefined) return null;
          const ordinal = Number(m[2]);
          return () => {
            const draft = flowRef.current.draft;
            const patch = withLineRemoved(draft, ordinal);
            if (!patch.ok) return { say: tt('devis.voice.proposalUnknownLine') };
            const diff = devisDiff(draft, { ...draft, ...patch.value });
            const field = diff[0];
            if (!field) return { say: tt('devis.voice.proposalUnknownLine') };
            setLineProposal({ label: `Supprimer la ligne ${ordinal}`, patch: patch.value, diff });
            return {
              say: tt('devis.voice.proposalReady', { field: field.field, before: field.before, after: field.after }),
            };
          };
        },
      },
      {
        id: 'devis.next',
        match: (utterance) => {
          const n = normalizeVoiceText(utterance);
          if (/ pour la ligne /.test(n)) return null; // « c'est bon pour la ligne » = validation de LIGNE
          if (!/( etape suivante | continue | suivant | c est bon | on continue )/.test(n)) return null;
          return () => ({ say: advance() });
        },
      },
      {
        id: 'devis.back',
        match: (utterance) => {
          const n = normalizeVoiceText(utterance);
          if (!/( etape precedente | reviens | retour en arriere )/.test(n)) return null;
          return () => {
            const back = devisBack(flowRef.current);
            if (!back.ok) return { say: tt('devis.voice.screenOnlyStep') };
            setFlow(back.value);
            setGuardMsg(null);
            return { say: tt('devis.voice.stepDone') };
          };
        },
      },
      {
        id: 'devis.selectClient',
        match: (utterance) => {
          if (flowRef.current.step !== 'client') return null;
          const n = normalizeVoiceText(utterance);
          // Négation = jamais une sélection (« je ne veux pas Camping Les Pins »).
          if (/( ne | n | pas | jamais | sans | sauf )/.test(n)) return null;
          const candidates = matchSpokenCustomers(n, customersRef.current);
          if (candidates.length === 0) return null;
          if (candidates.length > 1) {
            // Deux « Camping » ne se départagent JAMAIS en silence — question honnête.
            return () => ({
              say: tt('devis.voice.clientAmbiguous', {
                options: candidates.map((c) => c.name).join(', '),
              }),
            });
          }
          const matched = candidates[0]!;
          return () => {
            setFlow((f) => {
              const edited = devisEdit(f, { customerId: matched.id });
              const next = devisNext(edited);
              return next.ok ? next.value : edited;
            });
            setGuardMsg(null);
            return { say: `${tt('devis.voice.clientSet', { name: matched.name })} ${tt('devis.voice.greetLines')}` };
          };
        },
      },
      {
        id: 'devis.removeLastLine',
        match: (utterance) => {
          const n = normalizeVoiceText(utterance);
          if (flowRef.current.step !== 'lignes') return null;
          if (!/( (retire|enleve|supprime) (la )?(derniere|cette) (ligne)?| annule la ligne )/.test(n)) return null;
          return () => {
            const lines = flowRef.current.draft.lines;
            const last = lines[lines.length - 1];
            if (!last) return { say: tt('devis.voice.nothingToRemove') };
            setFlow((f) => devisEdit(f, { lines: f.draft.lines.slice(0, -1) }));
            return { say: tt('devis.voice.lineRemoved', { label: last.label }) };
          };
        },
      },
      {
        // Dicter une LIGNE alors qu'on est encore au choix du CLIENT : Bob guide au lieu du
        // refus générique hors-périmètre (UX niveau Claude Code : jamais de mur, un chemin).
        id: 'devis.lineBeforeClient',
        match: (utterance) => {
          if (flowRef.current.step !== 'client') return null;
          if (!/^\s*(ajoute[rz]?|rajoute[rz]?|mets?|met)\b/i.test(utterance)) return null;
          return () => ({
            say: `${tt('devis.voice.needClientFirst')} ${tt('devis.voice.greetClient')}`,
          });
        },
      },
      {
        id: 'devis.confirmLine',
        match: (utterance) => {
          if (flowRef.current.step !== 'lignes') return null;
          const n = normalizeVoiceText(utterance);
          if (!/( (valide|ajoute|confirme) (la |cette )?ligne | c est bon pour la ligne )/.test(n)) return null;
          return () => {
            const added = lineFormRef.current.submit();
            if (added === null) return { say: tt('devis.voice.lineInvalid') };
            return {
              say: tt('devis.voice.lineAdded', {
                label: added.label,
                qty: added.qty,
                price: formatEUR(added.unitPriceHT),
                rate: added.vatRate,
              }),
            };
          };
        },
      },
      {
        id: 'devis.rejectLine',
        match: (utterance) => {
          if (flowRef.current.step !== 'lignes') return null;
          const n = normalizeVoiceText(utterance);
          if (!/( (annule|oublie|laisse tomber|efface) (la |cette )?(ligne|preparation) | non pas ca )/.test(n)) return null;
          return () => ({
            say: lineFormRef.current.reject() ? tt('devis.voice.lineRejected') : tt('devis.voice.nothingToRemove'),
          });
        },
      },
      {
        id: 'devis.addLine',
        match: (utterance) => {
          if (flowRef.current.step !== 'lignes') return null;
          // Déclencheur explicite : un verbe d'ajout — « où suis-je ? » reste au cerveau global.
          if (!/^\s*(ajoute[rz]?|rajoute[rz]?|mets?|met|facture)\b/i.test(utterance)) return null;
          return () => {
            const parsed = parseVoiceQuoteLine(utterance, {
              prestations: prestationsRef.current,
              defaultVatRate: currentRateRef.current,
            });
            if (parsed.kind === 'ambiguous') {
              return { say: tt('devis.voice.lineAmbiguous', { options: parsed.options.join(', ') }) };
            }
            if (parsed.kind === 'missing_price') {
              return { say: tt('devis.voice.missingPrice', { label: parsed.label }) };
            }
            if (parsed.kind === 'none') {
              return { say: tt('devis.voice.missingPrice', { label: '…' }) };
            }
            // PROPOSER → VALIDER (spec fondateur) : la dictée remplit les CHAMPS VISIBLES du
            // formulaire — rien n'entre au brouillon sans « valide la ligne » (voix) ou le
            // bouton Ajouter (doigt). Un seul canal d'écriture : le manuel.
            const line = parsed.line;
            lineFormRef.current.prepare({
              label: line.label,
              qty: line.qty,
              unitPriceHT: line.unitPriceHT,
              category: line.category,
            });
            // TVA : UNE par devis (étape TVA). Si la dictée/le catalogue en voulait une autre,
            // on le DIT — jamais une perte silencieuse.
            const vatNotice =
              line.vatRate !== currentRateRef.current
                ? ` ${tt('devis.voice.vatNotice', { rate: currentRateRef.current })}`
                : '';
            return {
              say:
                tt(line.source === 'catalogue' ? 'devis.voice.linePreparedCatalogue' : 'devis.voice.linePrepared', {
                  label: line.label,
                  qty: line.qty,
                  price: formatEUR(line.unitPriceHT),
                }) + vatNotice,
            };
          };
        },
      },
    ];
  }, []);

  const GREET_BY_STEP: Partial<Record<DevisStep, I18nKey>> = {
    client: 'devis.voice.greetClient',
    lignes: 'devis.voice.greetLines',
    tvaMentions: 'devis.voice.greetVat',
    signature: 'devis.voice.greetSignature',
    acompte: 'devis.voice.greetDeposit',
  };
  const greetKey = GREET_BY_STEP[flow.step];
  const agentSurface = useMemo<AgentSurface>(
    () => ({
      ...(greetKey
        ? { greeting: { key: `devis-new:${flow.step}`, text: t(greetKey, { personality }) } }
        : {}),
      affordances: voiceAffordances,
    }),
    [flow.step, greetKey, personality, voiceAffordances],
  );
  const wizardAgentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: '/devis/new', instanceId: `devis-new:${flow.step}` },
      entities: customer ? [{ type: 'customer' as const, id: customer.id, label: customer.name }] : [],
      capabilities: ['screen.read', 'customer.read'],
    }),
    [customer, flow.step],
  );
  usePublishAgentContext(wizardAgentContext, { bottomAvoidance: 90 }, agentSurface);
  const agentSession = useAgentSession();

  // Défaut métier (BTP ⇒ TVA 10 = logement > 2 ans, comme le proto) : semé UNE fois
  // dans le brouillon de la machine, tant que rien n'est saisi — jamais écrasé ensuite.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || profile === undefined) return;
    seeded.current = true;
    if (profile.defaultVatRate === 10) {
      setFlow((f) =>
        f.draft.tvaContext === null && f.draft.lines.length === 0
          ? devisEdit(f, { tvaContext: { housingOlderThan2y: true } })
          : f,
      );
    }
  }, [profile]);

  // À chaque (re)entrée sur l'étape signature : pad remonté VIERGE ⇒ capture réinitialisée
  // (ce qui est affiché = ce qui est commité — revenir en arrière exige de re-signer),
  // et nom du signataire pré-rempli avec le client choisi.
  useEffect(() => {
    if (flow.step !== 'signature') return;
    setSignature(null);
    if (signerName === '' && customer !== null) setSignerName(customer.name);
  }, [flow.step]);

  // signerName n'est commité dans la machine QUE si le pad porte un tracé ET un nom
  // valide (≥ 2 caractères — même plancher que SignQuote) : la garde devisNext reste
  // l'unique juge du passage. Le dataURL (signature.dataUrl) part avec signQuote (preuve R4).
  useEffect(() => {
    const name = signerName.trim();
    const committed = signature !== null && !signature.isEmpty && name.length >= 2 ? name : null;
    setFlow((f) => (f.draft.signerName === committed ? f : devisEdit(f, { signerName: committed })));
  }, [signature, signerName]);

  // ── Étape 2 : lignes ───────────────────────────────────────────────────────
  const lineQtyValue = parsePositive(lineQty);
  const linePriceValue = parsePositive(linePrice);
  const lineValid = lineLabel.trim() !== '' && lineQtyValue !== null && linePriceValue !== null;

  // Suggestions du catalogue (C27) au fil de la saisie du libellé — searchCatalogue @bob/core
  // (accents/casse ignorés). La saisie LIBRE reste reine : proposer n'impose jamais.
  const suggestions = useMemo<CataloguePrestation[]>(() => {
    const q = lineLabel.trim();
    if (q.length < 2) return [];
    const exact = q.toLowerCase();
    return searchCatalogue(catalogue.prestations, q)
      .filter((p) => p.label.toLowerCase() !== exact) // suggestion déjà reprise → plus rien à proposer
      .slice(0, 4);
  }, [catalogue.prestations, lineLabel]);

  /** Tap suggestion : pré-remplit libellé/PU/catégorie — la TVA reste pilotée par l'étape 3
   * (UN taux pour tout le devis, revalidé par CreateQuote) ; tout reste éditable après. */
  const applySuggestion = (p: CataloguePrestation): void => {
    setLineLabel(p.label);
    setLinePrice((p.unitPriceHT / 100).toFixed(2).replace('.', ','));
    setLineCat(p.category);
  };

  const addLine = (): void => {
    if (!lineValid || lineQtyValue === null || linePriceValue === null) return;
    edit({
      lines: [
        ...draft.lines,
        {
          label: lineLabel.trim(),
          category: lineCat,
          qty: lineQtyValue,
          unitPriceHT: Math.round(linePriceValue * 100),
          vatRate: currentRate,
        },
      ],
    });
    setLineLabel('');
    setLineQty('1');
    setLinePrice('');
  };

  const removeLine = (index: number): void => {
    edit({ lines: draft.lines.filter((_, i) => i !== index) });
  };

  /** Applique/rejette la proposition en attente — UN SEUL chemin, voix ET tap. */
  const applyLineProposal = (): DevisProposal | null => {
    const proposal = lineProposal;
    if (proposal === null) return null;
    edit(proposal.patch);
    setLineProposal(null);
    return proposal;
  };
  const rejectLineProposal = (): boolean => {
    if (lineProposal === null) return false;
    setLineProposal(null);
    return true;
  };
  const lineProposalRef = useRef<{ apply: () => DevisProposal | null; reject: () => boolean; pending: () => DevisProposal | null }>({
    apply: () => null,
    reject: () => false,
    pending: () => null,
  });
  lineProposalRef.current = { apply: applyLineProposal, reject: rejectLineProposal, pending: () => lineProposal };

  // Pont voix → formulaire : préparer = poser les champs VISIBLES ; soumettre = le MÊME
  // addLine que le bouton (lineValid fait foi — jamais un second chemin d'écriture).
  lineFormRef.current = {
    prepare: (line) => {
      setLineLabel(line.label);
      setLineQty(String(line.qty));
      setLinePrice((line.unitPriceHT / 100).toFixed(2).replace('.', ','));
      setLineCat(line.category);
    },
    submit: () => {
      if (!lineValid || lineQtyValue === null || linePriceValue === null) return null;
      const added: LineInput = {
        label: lineLabel.trim(),
        category: lineCat,
        qty: lineQtyValue,
        unitPriceHT: Math.round(linePriceValue * 100),
        vatRate: currentRate,
      };
      addLine();
      return added; // la valeur canonique du formulaire à l'instant T — pas une relecture React
    },
    reject: () => {
      const hadSomething = lineLabel.trim() !== '' || linePrice.trim() !== '';
      setLineLabel('');
      setLineQty('1');
      setLinePrice('');
      return hadSomething;
    },
  };

  // ── Étape 3 : choix TVA = contexte + taux, appliqué à tout le devis ────────
  const selectVat = (choice: (typeof VAT_CHOICES)[number]): void => {
    edit({
      tvaContext: choice.context,
      lines: draft.lines.map((l) => ({ ...l, vatRate: choice.rate })),
    });
  };

  // ── Étape 6 : LA chaîne réelle, résumable — mêmes use cases que Bob (parité) ──
  const runGeneration = async (d: DevisDraft): Promise<void> => {
    if (busy) return;
    if (d.customerId === null || d.signerName === null) {
      setError(t('devis.errAction', { personality }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let quoteId = chain.current.quoteId;
      if (quoteId === null) {
        const created = await createQuote.mutateAsync({
          customerId: d.customerId,
          lines: d.lines.map((l) => ({ ...l })),
          ...(d.tvaContext !== null ? { context: d.tvaContext } : {}),
          ...(d.depositPct > 0 ? { depositPct: d.depositPct } : {}),
        });
        quoteId = created.quoteId;
        chain.current.quoteId = quoteId;
      }
      if (!chain.current.sent) {
        await sendQuote.mutateAsync(quoteId);
        chain.current.sent = true;
      }
      if (!chain.current.signed) {
        // R4 : le tracé du pad (étape 4) accompagne la signature — le serveur en calcule le
        // hash de preuve (onsite_draw). La garde devisNext exige un tracé non vide pour
        // franchir l'étape, donc `signature.dataUrl` existe ici ; on reste défensif (spread).
        await signQuote.mutateAsync({
          quoteId,
          signerName: d.signerName,
          ...(signature?.dataUrl ? { proofDataUrl: signature.dataUrl } : {}),
        });
        chain.current.signed = true;
      }
      let invoiceId = chain.current.invoiceId;
      if (invoiceId === null) {
        // Le mode fait partie de l'intention persistée : un retry réseau rejoue exactement la
        // même pièce fiscale et ne peut pas passer implicitement de l'acompte à la finale.
        const generated = await generateInvoice.mutateAsync({
          quoteId,
          mode: d.depositPct > 0 ? 'deposit' : 'final',
        });
        invoiceId = generated.invoiceId;
        chain.current.invoiceId = invoiceId;
      }
      const issued = await issueInvoice.mutateAsync(invoiceId);
      setInvoice({ id: invoiceId, number: issued.number });
      setToast(t('devis.toastDone', { personality, params: { number: issued.number } }));
    } catch (e) {
      setError(appErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onGenerate = async (): Promise<void> => {
    const next = devisNext(flow); // garde acompte (0–100) — la machine juge
    if (!next.ok) {
      setGuardMsg(t(guardKeyOf(next.error), { personality }));
      return;
    }
    const amount = formatEUR(totals.netToPay);
    const ok = await confirm({
      title: t('devis.confirmTitle', { personality }),
      message: t('devis.confirmBody', { personality, params: { name: customerName, amount } }),
      challenge: challengeFor(FISCAL, 'confirm_all'),
    });
    if (!ok) return; // transition non commitée : l'utilisateur reste à l'étape acompte
    setGuardMsg(null);
    setFlow(next.value);
    void runGeneration(flow.draft);
  };

  // ════════ SUCCÈS (machine: 'facture', numéro légal réel) ═══════════════════
  if (flow.step === 'facture' && invoice !== null) {
    return (
      <View style={{ flex: 1, backgroundColor: semantic.success }}>
        <LinearGradient
          pointerEvents="none"
          colors={[semantic.success, themes.foret.d1]}
          start={{ x: 0.45, y: 0 }}
          end={{ x: 0.55, y: 1 }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <View
            style={{
              width: 96,
              height: 96,
              borderRadius: 48,
              backgroundColor: colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 26,
              ...shadowNative.e3,
            }}
          >
            <CheckIcon color={semantic.success} size={48} strokeWidth={2.6} />
          </View>
          <Text style={[font('screenH1'), { color: colors.surface, textAlign: 'center', marginBottom: 8 }]}>
            {t('devis.successTitle', { personality })}
          </Text>
          <Text
            style={[
              font('body'),
              {
                fontSize: 15.5,
                lineHeight: 23,
                maxWidth: 300,
                textAlign: 'center',
                color: overlays.white70,
                marginBottom: 30,
              },
            ]}
          >
            {t('devis.successBody', {
              personality,
              params: {
                number: invoice.number,
                name: customerName,
                amount: formatEUR(totals.netToPay),
              },
            })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('devis.seeInvoice', { personality })}
            onPress={() => router.replace(`/facture/${invoice.id}`)}
            style={({ pressed }) => ({
              alignSelf: 'stretch',
              maxWidth: 320,
              backgroundColor: colors.surface,
              borderRadius: 16,
              paddingVertical: 15,
              alignItems: 'center',
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <Text style={[font('button'), { color: semantic.success }]}>
              {t('devis.seeInvoice', { personality })}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('devis.close', { personality })}
            onPress={() => router.back()}
            style={{ marginTop: 14, minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={[font('label', 600), { color: overlays.white70 }]}>
              {t('devis.close', { personality })}
            </Text>
          </Pressable>
        </View>
        <Toast
          message={toast ?? ''}
          visible={toast !== null}
          onHide={() => setToast(null)}
          icon={<CheckIcon color={colors.surface} size={16} strokeWidth={2.4} />}
        />
      </View>
    );
  }

  // ════════ FLUX (machine: client → … → facture en cours) ════════════════════
  const titleColor = dark ? colors.surface : colors.ink900;
  const subColor = dark ? overlays.white60 : colors.slate500;

  return (
    <View style={{ flex: 1, backgroundColor: dark ? theme.d1 : colors.bg }}>
      {dark ? (
        <LinearGradient
          pointerEvents="none"
          colors={[theme.d2, theme.d1]}
          start={{ x: 0.4, y: 0 }}
          end={{ x: 0.6, y: 1 }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
      ) : null}
      <KeyboardAvoidingView style={{ flex: 1 }} {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
        {/* En-tête : Retour (devisBack) · titre · Fermer */}
        <View
          style={{
            paddingTop: insets.top + 10,
            paddingHorizontal: 18,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {stepIndex > 0 && flow.step !== 'facture' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('devis.back', { personality })}
              onPress={goBack}
              hitSlop={6}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, minWidth: 44 }}
            >
              <ChevronLeftIcon color={dark ? colors.surface : colors.ink600} size={18} strokeWidth={2.2} />
              <Text style={[font('label', 600), { fontSize: 15, color: dark ? colors.surface : colors.ink600 }]}>
                {t('devis.back', { personality })}
              </Text>
            </Pressable>
          ) : (
            <Text style={[font('eyebrow'), { color: dark ? overlays.white60 : colors.slate400 }]}>
              {t('devis.title', { personality })}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('devis.close', { personality })}
            onPress={() => router.back()}
            hitSlop={6}
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: dark ? overlays.white10 : controls.segmentedTrack,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CloseIcon color={dark ? colors.surface : colors.slate500} size={16} />
          </Pressable>
        </View>

        {/* Progression — Stepper @bob/ui piloté par l'index de la machine */}
        <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 4 }}>
          <Stepper
            total={DEVIS_STEPS.length}
            current={stepIndex}
            labels={stepLabels}
            accessibilityLabel={t('devis.title', { personality })}
          />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 24, gap: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Étape 1 — client (liste réelle) ── */}
          {flow.step === 'client' ? (
            <>
              <Text style={[font('screenH1'), { fontSize: 24, color: titleColor }]}>
                {t('devis.clientTitle', { personality })}
              </Text>
              <Text style={[font('sub'), { color: subColor, marginBottom: 4 }]}>
                {t('devis.clientSub', { personality })}
              </Text>
              {customers.isLoading ? (
                <>
                  <SkeletonRow avatar="circle" lines={2} trailing="pill" />
                  <SkeletonRow avatar="circle" lines={2} trailing="pill" />
                  <SkeletonRow avatar="circle" lines={2} trailing="pill" />
                </>
              ) : customers.isError ? (
                <ErrorRetry
                  message={t('devis.dataError', { personality })}
                  onRetry={() => void customers.refetch()}
                />
              ) : (customers.data ?? []).length === 0 ? (
                <Card>
                  {/* Pas de cta ici : la création client (C40) vit UNIQUEMENT dans une Sheet
                      locale à (tabs)/clients.tsx (zone d'un autre agent, aucune route dédiée
                      genre /client/new n'existe) — un cta y pointant serait un chemin fantôme. */}
                  <EmptyState body={t('devis.noCustomers', { personality })} />
                </Card>
              ) : (
                (customers.data ?? []).map((c) => {
                  const selected = draft.customerId === c.id;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => edit({ customerId: c.id })}
                      accessibilityRole="radio"
                      accessibilityLabel={c.name}
                      accessibilityState={{ selected }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        minHeight: 44,
                        backgroundColor: colors.surface,
                        borderRadius: radius.cardLg,
                        borderWidth: selected ? 2 : 1,
                        borderColor: selected ? theme.ink : controls.cardBorder,
                        paddingVertical: 13,
                        paddingHorizontal: 14,
                        ...shadowNative.e1,
                      }}
                    >
                      <Avatar name={c.name} size={42} tone={CUSTOMER_TONE[c.type]} />
                      <View style={{ flex: 1 }}>
                        <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink900 }]}>{c.name}</Text>
                        {c.siren !== null ? (
                          <Text style={[font('meta'), { fontSize: 12.5, color: colors.slate400, marginTop: 1 }]}>
                            {t('fiche.sirenLabel', { personality, params: { siren: c.siren } })}
                          </Text>
                        ) : null}
                      </View>
                      <StatusBadge label={t(CUSTOMER_BADGE[c.type], { personality })} variant={CUSTOMER_TONE[c.type]} />
                      {selected ? <CheckIcon color={theme.ink} size={18} strokeWidth={2.4} /> : null}
                    </Pressable>
                  );
                })
              )}
            </>
          ) : null}

          {/* ── Étape 2 — lignes (saisie libre + totaux réels) ── */}
          {/* Tag CLIENT sur l'étape prestations (spec fondateur) : sélectionné → chip + ✕
              (désélection) ; aucun → scroll horizontal des clients, un tap sélectionne. */}
          {flow.step === 'lignes' ? (
            customer !== null ? (
              <View style={{ flexDirection: 'row', marginBottom: 10 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    borderWidth: 1,
                    borderColor: controls.cardBorder,
                    backgroundColor: colors.surface,
                    borderRadius: 999,
                    paddingLeft: 12,
                    paddingRight: 6,
                    paddingVertical: 6,
                  }}
                >
                  <Text style={[font('meta', 700), { color: colors.ink900 }]} numberOfLines={1}>
                    {customer.name}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('devis.clientTagRemove', { personality })}
                    hitSlop={8}
                    onPress={() => setFlow((f) => devisEdit(f, { customerId: null }))}
                    style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Ionicons name="close" size={16} color={colors.slate500} />
                  </Pressable>
                </View>
              </View>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
                style={{ marginBottom: 10 }}
              >
                {(customers.data ?? []).map((c) => (
                  <Pressable
                    key={c.id}
                    accessibilityRole="button"
                    accessibilityLabel={c.name}
                    onPress={() => setFlow((f) => devisEdit(f, { customerId: c.id }))}
                    style={{
                      borderWidth: 1,
                      borderColor: colors.line,
                      borderRadius: 999,
                      paddingHorizontal: 12,
                      paddingVertical: 7,
                    }}
                  >
                    <Text style={[font('meta', 600), { color: colors.ink800 }]} numberOfLines={1}>
                      {c.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )
          ) : null}
          {flow.step === 'lignes' && lineProposal !== null ? (
            <Card radius={16} padding={14} style={{ borderColor: semantic.ai, borderWidth: 1 }}>
              <Text style={[font('label'), { fontSize: 11.5, color: semantic.aiInk }]}>
                {lineProposal.label.toUpperCase()}
              </Text>
              {lineProposal.diff.map((field) => (
                <Text key={field.field} style={[font('sub'), { color: colors.ink800, marginTop: 4 }]}>
                  {field.field} : {field.before} → {field.after}
                </Text>
              ))}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title={t('devis.proposalApply', { personality })}
                    onPress={() => {
                      applyLineProposal();
                    }}
                  />
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('devis.proposalReject', { personality })}
                  onPress={() => {
                    rejectLineProposal();
                  }}
                  style={{
                    paddingHorizontal: 16,
                    justifyContent: 'center',
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: colors.line,
                  }}
                >
                  <Text style={[font('body'), { color: colors.ink800 }]}>
                    {t('devis.proposalReject', { personality })}
                  </Text>
                </Pressable>
              </View>
            </Card>
          ) : null}
          {flow.step === 'lignes' ? (
            <>
              <Text style={[font('screenH1'), { fontSize: 24, color: titleColor }]}>
                {t('devis.linesTitle', { personality })}
              </Text>
              <Text style={[font('sub'), { color: subColor, marginBottom: 4 }]}>
                {t('devis.linesSub', { personality })}
              </Text>

              {/* Saisie d'une ligne */}
              <Card radius={18} padding={16}>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <TextInput
                    value={lineLabel}
                    onChangeText={setLineLabel}
                    placeholder={t('devis.lineLabelPlaceholder', { personality })}
                    placeholderTextColor={colors.slate400}
                    accessibilityLabel={t('devis.lineLabelPlaceholder', { personality })}
                    style={[
                      font('body'),
                      {
                        flex: 1,
                        minHeight: 44,
                        color: colors.ink900,
                        borderWidth: 1,
                        borderColor: colors.line,
                        borderRadius: 12,
                        paddingHorizontal: 12,
                      },
                    ]}
                  />
                  {/* Parité manuel↔vocal : le picker remplit via applySuggestion, EXACTEMENT
                      comme la sélection vocale « catalogue d'abord ». */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('devis.cataloguePickOpen', { personality })}
                    hitSlop={8}
                    onPress={() => setCataloguePickerOpen(true)}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: colors.line,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="book-outline" size={20} color={semantic.ai} />
                  </Pressable>
                </View>

                {/* Suggestions du catalogue (C27) — tap = pré-remplit, saisie libre intacte */}
                {suggestions.length > 0 ? (
                  <View style={{ marginTop: 10, gap: 6 }}>
                    <Text style={[font('label', 700), { fontSize: 11.5, color: colors.slate400 }]}>
                      {t('catalogue.suggestTitle', { personality }).toUpperCase()}
                    </Text>
                    {suggestions.map((p) => (
                      <Pressable
                        key={p.id}
                        onPress={() => applySuggestion(p)}
                        accessibilityRole="button"
                        accessibilityLabel={`${p.label} · ${formatEUR(p.unitPriceHT)}`}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                          minHeight: 44,
                          borderWidth: 1,
                          borderColor: controls.cardBorder,
                          borderRadius: 12,
                          paddingHorizontal: 12,
                          paddingVertical: 9,
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[font('label', 600), { fontSize: 13.5, color: colors.ink900 }]}>
                            {p.label}
                          </Text>
                          {p.indicative ? (
                            <Text style={[font('meta'), { fontSize: 11.5, color: colors.slate400, marginTop: 1 }]}>
                              {t('catalogue.indicative', { personality })}
                            </Text>
                          ) : null}
                        </View>
                        <Text
                          style={[
                            font('label', 700),
                            { fontSize: 13.5, color: colors.ink800, fontVariant: ['tabular-nums'] },
                          ]}
                        >
                          {formatEUR(p.unitPriceHT)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}

                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <View style={{ width: 86 }}>
                    <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
                      {t('devis.qtyLabel', { personality })}
                    </Text>
                    <TextInput
                      value={lineQty}
                      onChangeText={setLineQty}
                      keyboardType="decimal-pad"
                      accessibilityLabel={t('devis.qtyLabel', { personality })}
                      style={[
                        font('body'),
                        {
                          minHeight: 44,
                          color: colors.ink900,
                          borderWidth: 1,
                          borderColor: colors.line,
                          borderRadius: 12,
                          paddingHorizontal: 12,
                        },
                      ]}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
                      {t('devis.unitPriceLabel', { personality })}
                    </Text>
                    <TextInput
                      value={linePrice}
                      onChangeText={setLinePrice}
                      keyboardType="decimal-pad"
                      placeholder="0,00"
                      placeholderTextColor={colors.slate400}
                      accessibilityLabel={t('devis.unitPriceLabel', { personality })}
                      style={[
                        font('body'),
                        {
                          minHeight: 44,
                          color: colors.ink900,
                          borderWidth: 1,
                          borderColor: colors.line,
                          borderRadius: 12,
                          paddingHorizontal: 12,
                        },
                      ]}
                    />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                  {LINE_CATEGORIES.map((cat) => (
                    <Chip
                      key={cat.key}
                      label={t(cat.labelKey, { personality })}
                      active={lineCat === cat.key}
                      onPress={() => setLineCat(cat.key)}
                    />
                  ))}
                </View>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 10 }]}>
                  {t('devis.vatSuggested', { personality, params: { rate: fmtRate(currentRate) } })}
                </Text>
                <View style={{ marginTop: 12 }}>
                  <Button
                    title={t('devis.addLine', { personality })}
                    variant="secondary"
                    disabled={!lineValid}
                    onPress={addLine}
                  />
                </View>
              </Card>

              {/* Lignes ajoutées + totaux (computeTotals — le core calcule, l'écran affiche) */}
              <Card radius={18} padding={16}>
                {draft.lines.length === 0 ? (
                  <Text style={[font('sub'), { color: colors.slate500 }]}>
                    {t('devis.linesEmpty', { personality })}
                  </Text>
                ) : (
                  <>
                    {draft.lines.map((line, i) => {
                      const badge = LINE_CATEGORIES.find((c) => c.key === line.category);
                      return (
                        <View
                          key={`${line.label}-${i}`}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'flex-start',
                            gap: 10,
                            paddingVertical: 9,
                            borderBottomWidth: 1,
                            borderBottomColor: colors.lineSoft,
                          }}
                        >
                          <View style={{ flex: 1, gap: 3 }}>
                            <Text style={[font('label', 600), { fontSize: 14, color: colors.ink900 }]}>
                              {line.label}
                            </Text>
                            <Text style={[font('meta'), { color: colors.slate400 }]}>
                              {line.qty} × {formatEUR(line.unitPriceHT)} ·{' '}
                              {t('devis.vatRate', { personality, params: { rate: fmtRate(line.vatRate) } })}
                              {badge !== undefined ? ` · ${t(badge.labelKey, { personality })}` : ''}
                            </Text>
                          </View>
                          <MoneyText cents={Math.round(line.qty * line.unitPriceHT)} />
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('devis.removeLine', {
                              personality,
                              params: { label: line.label },
                            })}
                            onPress={() => removeLine(i)}
                            hitSlop={10}
                            style={{
                              width: 26,
                              height: 26,
                              borderRadius: 13,
                              backgroundColor: controls.segmentedTrack,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <CloseIcon color={colors.slate400} size={11} strokeWidth={2.6} />
                          </Pressable>
                        </View>
                      );
                    })}
                    <View style={{ paddingTop: 13 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                        <Text style={[font('sub'), { color: colors.slate500 }]}>
                          {t('devis.totalHt', { personality })}
                        </Text>
                        <Text style={[font('sub'), { color: colors.slate500, fontVariant: ['tabular-nums'] }]}>
                          {formatEUR(totals.ht)}
                        </Text>
                      </View>
                      {Object.entries(totals.vatByRate).map(([rate, cents]) => (
                        <View
                          key={rate}
                          style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}
                        >
                          <Text style={[font('sub'), { color: colors.slate500 }]}>
                            {t('devis.vatRate', { personality, params: { rate: fmtRate(Number(rate)) } })}
                          </Text>
                          <Text style={[font('sub'), { color: colors.slate500, fontVariant: ['tabular-nums'] }]}>
                            {formatEUR(cents)}
                          </Text>
                        </View>
                      ))}
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginTop: 6,
                          paddingTop: 9,
                          borderTopWidth: 1,
                          borderTopColor: colors.lineSoft,
                        }}
                      >
                        <Text style={[font('cardTitle'), { color: colors.ink900 }]}>
                          {t('devis.totalTtc', { personality })}
                        </Text>
                        <MoneyText cents={totals.ttc} variant="big" />
                      </View>
                    </View>
                  </>
                )}
              </Card>
            </>
          ) : null}

          {/* ── Étape 3 — TVA & mentions ── */}
          {flow.step === 'tvaMentions' ? (
            <>
              <Text style={[font('screenH1'), { fontSize: 24, color: titleColor }]}>
                {t('devis.vatTitle', { personality })}
              </Text>
              <Text style={[font('sub'), { color: subColor, marginBottom: 4 }]}>
                {t('devis.vatSub', { personality })}
              </Text>
              {VAT_CHOICES.map((choice) => {
                const selected = vatChoice === choice.key;
                return (
                  <Pressable
                    key={choice.key}
                    onPress={() => selectVat(choice)}
                    accessibilityRole="radio"
                    accessibilityLabel={t(choice.labelKey, { personality })}
                    accessibilityState={{ selected }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      minHeight: 52,
                      backgroundColor: colors.surface,
                      borderRadius: radius.card,
                      borderWidth: selected ? 2 : 1,
                      borderColor: selected ? theme.ink : controls.cardBorder,
                      paddingHorizontal: 14,
                      ...shadowNative.e1,
                    }}
                  >
                    <Text style={[font('label', 600), { fontSize: 14.5, color: colors.ink900, flex: 1 }]}>
                      {t(choice.labelKey, { personality })}
                    </Text>
                    {selected ? <CheckIcon color={theme.ink} size={16} strokeWidth={2.6} /> : null}
                  </Pressable>
                );
              })}
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20 }]}>
                {t('devis.vatHint', { personality, params: { rate: fmtRate(currentRate) } })}
              </Text>
              <Card radius={16} padding={15} style={{ backgroundColor: semantic.successBg, borderColor: semantic.successBg }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                  <CheckIcon color={semantic.success} size={14} strokeWidth={2.6} />
                  <Text style={[font('label', 700), { fontSize: 12.5, color: semantic.success }]}>
                    {t('devis.mentionsTitle', { personality })}
                  </Text>
                </View>
                <Text style={[font('sub'), { fontSize: 12.5, color: semantic.success, lineHeight: 20 }]}>
                  {t('devis.mentionsBody', { personality })}
                </Text>
              </Card>
            </>
          ) : null}

          {/* ── Étape 4 — signature au doigt (vue client, navy) ── */}
          {flow.step === 'signature' ? (
            <>
              <Text style={[font('screenH1'), { fontSize: 24, color: titleColor }]}>
                {t('devis.signTitle', { personality })}
              </Text>
              <Text style={[font('sub'), { color: subColor, marginBottom: 4 }]}>
                {t('devis.signSub', { personality })}
              </Text>
              <Card radius={18} padding={16}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink900 }]}>{customerName}</Text>
                    <Text style={[font('meta'), { fontSize: 12.5, color: colors.slate400, marginTop: 1 }]}>
                      {t('devis.totalTtc', { personality })}
                    </Text>
                  </View>
                  <MoneyText cents={totals.ttc} variant="big" />
                </View>
              </Card>
              <SignaturePad
                clearLabel={t('devis.signClear', { personality })}
                placeholder={t('devis.signPlaceholder', { personality })}
                accessibilityLabel={t('devis.signTitle', { personality })}
                onChange={setSignature}
              />
              <View>
                <Text style={[font('label', 600), { fontSize: 12.5, color: overlays.white60, marginBottom: 8 }]}>
                  {t('devis.signerLabel', { personality })}
                </Text>
                <TextInput
                  value={signerName}
                  onChangeText={setSignerName}
                  placeholder={t('devis.signerPlaceholder', { personality })}
                  placeholderTextColor={overlays.white50}
                  accessibilityLabel={t('devis.signerLabel', { personality })}
                  style={[
                    font('body'),
                    {
                      minHeight: 46,
                      color: colors.surface,
                      backgroundColor: overlays.white10,
                      borderWidth: 1,
                      borderColor: overlays.white14,
                      borderRadius: 14,
                      paddingHorizontal: 14,
                    },
                  ]}
                />
              </View>
            </>
          ) : null}

          {/* ── Étape 5 — acompte (30 % défaut, net réel du core) ── */}
          {flow.step === 'acompte' ? (
            <>
              <Text style={[font('screenH1'), { fontSize: 24, color: titleColor }]}>
                {t('devis.depositTitle', { personality })}
              </Text>
              <Text style={[font('sub'), { color: subColor, marginBottom: 4 }]}>
                {t('devis.depositSub', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {DEPOSIT_PRESETS.map((pct) => (
                  <Chip
                    key={pct}
                    label={
                      pct === 0
                        ? t('devis.depositNone', { personality })
                        : t('devis.depositPct', { personality, params: { pct } })
                    }
                    active={draft.depositPct === pct}
                    onPress={() => edit({ depositPct: pct })}
                  />
                ))}
              </View>
              <Card radius={18} padding={16}>
                <Text style={[font('label', 600), { fontSize: 12.5, color: colors.slate400, marginBottom: 6 }]}>
                  {draft.depositPct > 0
                    ? t('devis.depositNetLabel', { personality })
                    : t('devis.depositFullLabel', { personality })}
                </Text>
                <MoneyText cents={totals.netToPay} variant="big" />
                {draft.depositPct > 0 ? (
                  <Text style={[font('sub'), { color: colors.slate500, marginTop: 8 }]}>
                    {t('devis.depositSummary', {
                      personality,
                      params: { pct: draft.depositPct, amount: formatEUR(totals.netToPay) },
                    })}
                  </Text>
                ) : null}
              </Card>
            </>
          ) : null}

          {/* ── Étape 6 — génération en cours / erreur (le succès a son écran) ── */}
          {flow.step === 'facture' && invoice === null ? (
            <View style={{ alignItems: 'center', paddingTop: 60, gap: 16 }}>
              {busy ? (
                <>
                  <ActivityIndicator size="large" color={colors.ink800} />
                  <Text style={[font('body'), { color: colors.slate500 }]}>
                    {t('devis.generating', { personality })}
                  </Text>
                </>
              ) : (
                <>
                  <Card style={{ alignSelf: 'stretch', borderColor: semantic.danger }}>
                    <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger }]}>
                      {error ?? t('devis.errAction', { personality })}
                    </Text>
                  </Card>
                  <View style={{ alignSelf: 'stretch' }}>
                    <Button
                      title={t('devis.retry', { personality })}
                      onPress={() => void runGeneration(flow.draft)}
                    />
                  </View>
                </>
              )}
            </View>
          ) : null}
        </ScrollView>

        {/* Garde bloquante (voix de Bob) + CTA d'avancement — chaque Suivant = devisNext */}
        {/* Picker catalogue (parité manuelle du « catalogue d'abord » vocal) */}
        <Modal
          visible={cataloguePickerOpen}
          animationType="slide"
          transparent
          onRequestClose={() => setCataloguePickerOpen(false)}
        >
          <Pressable
            style={{ flex: 1, backgroundColor: 'rgba(10,15,30,0.45)' }}
            accessibilityLabel={t('devis.cataloguePickTitle', { personality })}
            onPress={() => setCataloguePickerOpen(false)}
          />
          <View
            style={{
              maxHeight: '65%',
              backgroundColor: colors.surface,
              borderTopLeftRadius: 22,
              borderTopRightRadius: 22,
              paddingTop: 14,
              paddingBottom: insets.bottom + 12,
            }}
          >
            <Text style={[font('section'), { color: colors.ink900, paddingHorizontal: 20, marginBottom: 8 }]}>
              {t('devis.cataloguePickTitle', { personality })}
            </Text>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 8, paddingBottom: 8 }}>
              {catalogue.prestations.length === 0 ? (
                <Text style={[font('sub'), { color: colors.slate500 }]}>
                  {t('devis.cataloguePickEmpty', { personality })}
                </Text>
              ) : (
                catalogue.prestations.map((p) => (
                  <Pressable
                    key={p.id}
                    accessibilityRole="button"
                    accessibilityLabel={p.label}
                    onPress={() => {
                      applySuggestion(p);
                      setCataloguePickerOpen(false);
                    }}
                    style={{
                      borderWidth: 1,
                      borderColor: colors.line,
                      borderRadius: 12,
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={[font('body', 600), { color: colors.ink900 }]}>
                        {p.label}
                      </Text>
                      <Text style={[font('meta'), { color: colors.slate500 }]}>
                        {t(LINE_CATEGORIES.find((c) => c.key === p.category)?.labelKey ?? 'voix.catLabor', { personality })}
                        {p.unit ? ` · ${p.unit}` : ''}
                        {p.indicative === true ? ` · ${t('catalogue.indicative', { personality })}` : ''}
                      </Text>
                    </View>
                    <Text style={[font('body', 700), { color: colors.ink900 }]}>
                      {formatEUR(p.unitPriceHT)}
                    </Text>
                  </Pressable>
                ))
              )}
            </ScrollView>
          </View>
        </Modal>

        {/* S2-GUIDÉ : la session vocale reste VISIBLE sur la modale (le bouton Bob global est
            masqué par les modales natives) — état + dernière réponse, tap = stop. */}
        {agentSession.active || agentSession.response !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('agent.global.stop', { personality })}
            accessibilityLiveRegion="polite"
            onPress={agentSession.active ? agentSession.stop : agentSession.dismissResponse}
            style={{
              marginHorizontal: 20,
              marginBottom: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: controls.cardBorder,
              backgroundColor: colors.surface,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: agentSession.phase === 'listening' ? semantic.success : semantic.ai,
              }}
            />
            <Text numberOfLines={2} style={[font('meta'), { color: colors.ink800, flex: 1 }]}>
              {agentSession.response ??
                t(
                  agentSession.phase === 'listening'
                    ? 'agent.global.listening'
                    : agentSession.phase === 'thinking'
                      ? 'agent.global.thinking'
                      : agentSession.phase === 'speaking'
                        ? 'agent.global.speaking'
                        : 'agent.global.idle',
                  { personality },
                )}
            </Text>
          </Pressable>
        ) : null}
        {flow.step !== 'facture' ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 6, paddingBottom: insets.bottom + 16, gap: 10 }}>
            {guardMsg !== null ? (
              <Text
                accessibilityLiveRegion="polite"
                style={[font('sub'), { textAlign: 'center', color: semantic.dangerVivid }]}
              >
                {guardMsg}
              </Text>
            ) : null}
            {flow.step === 'acompte' ? (
              <Button title={t('devis.generateCta', { personality })} onPress={() => void onGenerate()} />
            ) : dark ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('devis.next', { personality })}
                onPress={goNext}
                style={({ pressed }) => ({
                  backgroundColor: colors.surface,
                  borderRadius: 16,
                  paddingVertical: 15,
                  alignItems: 'center',
                  transform: [{ scale: pressed ? 0.97 : 1 }],
                })}
              >
                <Text style={[font('button'), { color: colors.ink900 }]}>{t('devis.next', { personality })}</Text>
              </Pressable>
            ) : (
              <Button title={t('devis.next', { personality })} onPress={goNext} />
            )}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}
