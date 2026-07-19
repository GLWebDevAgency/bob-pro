/**
 * Devis (C21, REDÉCOUPE 2026-07-16) — flux modal 6 étapes qui s'ARRÊTE AU DEVIS.
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
 * logement → taux appliqué à tout le devis ; le taux est REVALIDÉ par le use case
 * CreateQuote via suggestVatRate — franchise/autoliquidation remontent en erreur réelle à
 * la création ; l'aperçu buildMentions n'est pas exposé côté client → carte informative
 * honnête) · 4 ACOMPTE (30 % défaut proto, éditable, net RÉEL computeTotals — cas d'or
 * 488,40 €) : le % est une clause CONTRACTUELLE du devis, décidée AVANT la signature — ce
 * n'est PAS une facture · 5 signature : choix sur place (pad @bob/ui, signerName + preuve)
 * ou envoi (l'artisan est devant le client, ce choix reste légitime au wizard) ·
 * 6 recap : confirmation typée OUTBOUND (même feuille que DocumentActions/C20) puis
 * createQuote → sendQuote (numéro légal, email avec le lien de signature) → signQuote
 * SEULEMENT si « sur place » (pad, preuve). Chaîne RÉSUMABLE (checkpoints par ref) : un
 * échec au milieu ne rejoue pas les use cases déjà passés.
 *
 * LA FACTURE N'EST PLUS CRÉÉE ICI. Elle avait déjà son chemin officiel post-signature
 * (QuoteActions sur /devis/[id], 3 états réels : aucune/acompte/finale) — l'enchaîner ici
 * doublait ce chemin et créait une pièce que personne n'avait explicitement décidée
 * (constat fondateur 2026-07-16 : « quand je fais un devis, je fais un devis »). Le recap
 * final propose la suite SANS jamais la déclencher : devis signé sur place → « facture
 * quand tu veux » (CTA vers /devis/[id], JAMAIS auto) ; devis envoyé à distance → aucune
 * proposition tant qu'il n'est pas signé (la carte Home « devis accepté » relaiera à la
 * signature). Facturation différée post-BC (grands comptes) : hors périmètre de cette
 * tranche — voir le rapport de la mission pour ce qui manque (purchaseOrderRef).
 *
 * Écarts assumés vs proto : le proto pré-remplit des lignes de démo (ici : données
 * réelles saisies, régime A1-C10 sans fixtures) ; ses 6 états (composer/envoyé/signature/
 * signé/facture/encaissé) sont re-séquencés par la machine core (client/lignes/TVA/
 * acompte/signature/recap) — la facture (génération ET encaissement) vit entièrement sur
 * l'écran /devis/[id] puis /facture/[id] (C16, parité InvoiceActions). Zéro hex/rgba —
 * tout vient de useTheme()/@bob/tokens.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { challengeFor, parseVoiceConsent } from '@bob/ai';
import {
  addDays,
  parisDateOnly,
  computeTotals,
  formatEUR,
  searchCatalogue,
  DEVIS_STEPS,
  type CataloguePrestation,
  type CustomerListItem,
  type DevisDraft,
  type DevisSignMode,
  type DevisStep,
  type DevisTvaContext,
  type LineCategory,
  type VatRate,
  matchSpokenCustomers,
  normalizeVoiceText,
  parseSpokenVatRate,
  frSpokenNumbersToDigits,
  type LineInput,
  parseVoiceQuoteLine,
  completePendingQuoteLinePrice,
  isVoiceAddLineUtterance,
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
  Sheet,
  StatusBadge,
  Stepper,
  Toast,
  font,
  useReduceMotion,
  useTheme,
  type SignaturePadValue,
  type StatusBadgeVariant,
} from '@bob/ui';
import {
  appErrorMessage,
  useCompanyMe,
  useCreateQuote,
  useCreateQuoteSignatureLink,
  useCustomers,
  useSendQuote,
  useSignQuote,
} from '../../src/data/hooks';
import { useCatalogue } from '../../src/data/catalogue';
import { useBillingPrefs } from '../../src/data/billing-prefs';
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
import {
  hasUnsavedQuoteDraftChanges,
  useQuoteDraft,
  type QuoteDraftError,
  type QuoteDraftProposal,
} from '../../src/quote-draft';

/** Profil de risque du recap (envoi du devis, éventuellement signature) — même palier
 * OUTBOUND que le bouton « Envoyer » de DocumentActions/C20. Ce n'est plus un acte fiscal :
 * aucune facture ne se crée plus dans ce flow. */
const OUTBOUND = { mutating: true, outbound: true, riskTier: 'outbound' } as const;

/** Titres des 6 étapes de la machine (Stepper + en-têtes). */
const STEP_KEYS: Record<DevisStep, I18nKey> = {
  client: 'devis.stepClient',
  lignes: 'devis.stepLines',
  tvaMentions: 'devis.stepVat',
  acompte: 'devis.stepDeposit',
  signature: 'devis.stepSignature',
  recap: 'devis.stepRecap',
};

/** Gardes de la machine → voix de Bob (champ de l'erreur VALIDATION → clé i18n). */
const GUARD_COPY: Readonly<Record<string, I18nKey>> = {
  customerId: 'devis.guardClient',
  lines: 'devis.guardLines',
  vatRate: 'devis.vatRequired',
  signMode: 'devis.guardSignMode',
  signerName: 'devis.guardSignature',
  depositPct: 'devis.guardDeposit',
};

function guardKeyOf(error: Pick<QuoteDraftError, 'field'>): I18nKey {
  const key = error.field === undefined ? undefined : GUARD_COPY[error.field];
  if (key !== undefined) return key;
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
type VatChoice =
  | 'standard'
  | 'special_reduced'
  | 'housing'
  | 'energy'
  | 'autoliquidation'
  | 'franchise';
type VatChoiceOption = {
  key: VatChoice;
  labelKey: I18nKey;
  rate: VatRate;
  /** Les deux booléens sont toujours présents : `null` reste l'état non confirmé. */
  context: DevisTvaContext;
};
const TAXABLE_VAT_CHOICES: readonly VatChoiceOption[] = [
  {
    key: 'standard',
    labelKey: 'devis.vatStandard',
    rate: 20,
    context: { housingOlderThan2y: false, energyRenovation: false },
  },
  {
    key: 'special_reduced',
    labelKey: 'devis.vatSpecialReduced',
    rate: 2.1,
    context: { housingOlderThan2y: false, energyRenovation: false },
  },
  {
    key: 'housing',
    labelKey: 'devis.vatHousing',
    rate: 10,
    context: { housingOlderThan2y: true, energyRenovation: false },
  },
  {
    key: 'energy',
    labelKey: 'devis.vatEnergy',
    rate: 5.5,
    context: { housingOlderThan2y: true, energyRenovation: true },
  },
  {
    key: 'autoliquidation',
    labelKey: 'devis.vatAutoliquidation',
    rate: 0,
    // Combinaison sentinelle du flow local ; le serveur n'accepte 0 que si le client est
    // réellement en sous-traitance BTP. Elle ne fabrique donc aucune éligibilité.
    context: { housingOlderThan2y: false, energyRenovation: true },
  },
];
const FRANCHISE_VAT_CHOICES: readonly VatChoiceOption[] = [
  {
    key: 'franchise',
    labelKey: 'devis.vatFranchise',
    rate: 0,
    context: { housingOlderThan2y: false, energyRenovation: false },
  },
];

/** Le choix courant se DÉRIVE du couple taux + contexte persisté, jamais du métier. */
function vatChoiceOf(
  context: DevisTvaContext | null,
  rate: VatRate | null,
  choices: readonly VatChoiceOption[],
): VatChoice | null {
  if (context === null || rate === null) return null;
  return choices.find(
    (choice) =>
      choice.rate === rate
      && choice.context.housingOlderThan2y === context.housingOlderThan2y
      && choice.context.energyRenovation === context.energyRenovation,
  )?.key ?? null;
}

/** Presets d'acompte (30 % = défaut proto, 0 = facture unique). */
const DEPOSIT_PRESETS: readonly number[] = [0, 10, 20, 30, 40, 50];

/** Choix de l'étape signature — parité avec le sheet officiel de QuoteActions (R4), réduit
 * aux deux options légitimes AU WIZARD (l'artisan est devant le client). */
const SIGN_MODE_CHOICES: readonly { key: DevisSignMode; labelKey: I18nKey; hintKey: I18nKey }[] = [
  { key: 'onsite', labelKey: 'devis.signModeOnsite', hintKey: 'devis.signModeOnsiteHint' },
  { key: 'remote', labelKey: 'devis.signModeRemote', hintKey: 'devis.signModeRemoteHint' },
];

/** Taux affiché à la française (5.5 → « 5,5 »). */
const fmtRate = (rate: number): string => String(rate).replace('.', ',');

const parsePositive = (value: string): number | null => {
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export default function DevisNew() {
  const { colors, semantic, controls, overlays, theme, radius, personality } = useTheme();
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const confirm = useConfirm();
  const quoteDraft = useQuoteDraft();
  const customers = useCustomers();
  const company = useCompanyMe();
  const catalogue = useCatalogue();
  // Réglages facturation §Valeurs par défaut — validité du devis (préférence LOCALE, cf.
  // billing-prefs.ts). CreateQuoteInput.validUntil existe déjà de bout en bout (core/API) mais
  // n'était jusqu'ici jamais posé par ce flow : SEUL branchement réel de ce réglage.
  const billingPrefs = useBillingPrefs();
  const createQuote = useCreateQuote();
  const sendQuote = useSendQuote();
  const signQuote = useSignQuote();
  const signatureLink = useCreateQuoteSignatureLink();

  // ── Machine RÉELLE @bob/core (C02), portée par le provider racine : une seule vérité ──
  const flow = quoteDraft.state.flow;
  const [guardMsg, setGuardMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Résultat du DEVIS créé (jamais une facture) — statut réel : signé sur place, ou envoyé
   * et en attente de signature. */
  const [quoteResult, setQuoteResult] = useState<{
    id: string;
    number: string;
    customerName: string;
    amount: string;
    status: 'signed' | 'sent';
    depositPct: number;
    depositAmount: string;
    emailSkipped: boolean;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [exitSheetOpen, setExitSheetOpen] = useState(false);
  const [exitActionBusy, setExitActionBusy] = useState(false);
  const [shareLinkBusy, setShareLinkBusy] = useState(false);

  // Saisie non validée : hors contenu financier, mais conservée par le provider pour la reprise.
  const lineLabel = quoteDraft.state.lineForm.label;
  const lineQty = quoteDraft.state.lineForm.quantity;
  const linePrice = quoteDraft.state.lineForm.unitPrice;
  const lineCat = quoteDraft.state.lineForm.category;
  const setLineLabel = (label: string): void => quoteDraft.updateLineForm({ label });
  const setLineQty = (quantity: string): void => quoteDraft.updateLineForm({ quantity });
  const setLinePrice = (unitPrice: string): void => quoteDraft.updateLineForm({ unitPrice });
  const setLineCat = (category: LineCategory): void => quoteDraft.updateLineForm({ category });
  const [cataloguePickerOpen, setCataloguePickerOpen] = useState(false);
  /** Proposition Bob EN ATTENTE : son diff est dans le modèle, jamais dans le devis avant accord. */
  const lineProposal = quoteDraft.state.proposal;

  // Signature (étape 4) — le tracé est présentation ; seul signerName entre dans la machine.
  const [signature, setSignature] = useState<SignaturePadValue | null>(null);
  const [signerName, setSignerName] = useState('');

  // Checkpoints de la chaîne (résumable après erreur — jamais de double use case). `number` et
  // `emailSkipped` sont capturés au SEUL appel réussi de sendQuote (un retry ne le rappelle pas).
  const chain = useRef<{
    quoteId: string | null;
    number: string | null;
    emailSkipped: boolean;
    sent: boolean;
    signed: boolean;
  }>({
    quoteId: null,
    number: null,
    emailSkipped: false,
    sent: false,
    signed: false,
  });
  const generationInFlight = useRef(false);
  const generationIntentInFlight = useRef(false);
  const exitActionInFlight = useRef(false);
  const allowNextRemoval = useRef(false);
  const pendingExit = useRef<null | (() => void)>(null);

  const draft = flow.draft;
  const customer = (customers.data ?? []).find((c) => c.id === draft.customerId) ?? null;
  const customerName = customer?.name ?? quoteDraft.state.customer?.name ?? 'le client';
  const contextCustomer = customer ?? quoteDraft.state.customer;
  const stepIndex = DEVIS_STEPS.indexOf(flow.step);
  const stepLabels = DEVIS_STEPS.map((s) => t(STEP_KEYS[s], { personality }));
  const isVatFranchise = company.data?.vatRegime === 'franchise';
  const vatChoices = company.data === undefined
    ? []
    : isVatFranchise
      ? FRANCHISE_VAT_CHOICES
      : TAXABLE_VAT_CHOICES;
  const vatChoice = vatChoiceOf(draft.tvaContext, draft.vatRate, vatChoices);
  // Un changement de régime société invalide honnêtement un ancien choix qui n'existe plus.
  const currentRate = vatChoice === null ? null : draft.vatRate;
  const totals = computeTotals([...draft.lines], { depositPct: draft.depositPct });
  // Vue « client » sur navy UNIQUEMENT quand le pad est effectivement montré (mode sur place
  // choisi) — le choix du mode et l'envoi à distance restent sur le thème clair habituel.
  const dark = flow.step === 'signature' && draft.signMode === 'onsite';

  // ── Transitions : écran et voix commandent le MÊME provider sérialisé ──────
  const goNext = (): void => {
    const result = quoteDraft.applyAtRevision({ type: 'next_step' }, quoteDraft.state.revision);
    if (!result.ok) {
      if (result.error.code === 'revision_conflict') return;
      setGuardMsg(t(guardKeyOf(result.error), { personality }));
      return;
    }
    setGuardMsg(null);
  };

  const goBack = (): void => {
    const result = quoteDraft.applyAtRevision({ type: 'previous_step' }, quoteDraft.state.revision);
    if (!result.ok && result.error.code === 'revision_conflict') return;
    if (!result.ok) return; // 'client' est le début, 'recap' est terminal — la table fait foi
    setGuardMsg(null);
  };

  // ── S2-GUIDÉ : pilotage VOCAL du wizard — parité stricte avec le geste manuel ──
  // Les affordances agissent via les MÊMES transitions machine (devisEdit/devisNext/devisBack)
  // que les boutons ; identité STABLE (refs) pour ne pas rebattre la publication à chaque rendu.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const quoteStateRef = useRef(quoteDraft.state);
  quoteStateRef.current = quoteDraft.state;

  // ── Entrée du wizard : TOUJOURS vierge, sauf reprise EXPLICITE (bug fondateur 2026-07-17 —
  // « Devis » ne doit plus jamais reprendre en silence ce qui traînait, l'utilisateur croyant
  // créer un nouveau devis retombait sur l'ancien). `?resume=1` — posé par la carte « brouillon »
  // de ventes.tsx — ramène le brouillon PARKÉ ; toute autre entrée (Vite fait, Fab, fiche
  // client…) démarre une session vierge et parque l'éventuel brouillon enregistré dans
  // `quoteDraft.pendingResume`, proposé PLUS BAS par une bannière discrète — jamais imposé.
  const { resume } = useLocalSearchParams<{ resume?: string }>();
  const resumeRequested = resume === '1';
  const freshnessApplied = useRef(false);
  const [freshnessReady, setFreshnessReady] = useState(false);
  useEffect(() => {
    if (freshnessApplied.current) return;
    freshnessApplied.current = true;
    if (resumeRequested) {
      // Rien à faire si la session déjà chargée EST le brouillon visé (ex. démarrage à froid,
      // jamais soft-resetée) — sinon, on ramène celui parké par une visite précédente.
      if (quoteStateRef.current.saved === null && quoteDraft.pendingResume !== null) {
        quoteDraft.resumePending();
      }
    } else {
      quoteDraft.startFresh();
    }
    setFreshnessReady(true);
    // Mount uniquement — une seule décision par ouverture d'écran (resumeRequested/quoteDraft
    // sont lus via refs/valeurs figées à l'ouverture ; les redemander ne doit rien redéclencher).
  }, []);
  const billingDefaultsApplied = useRef(false);
  const [billingDefaultsReady, setBillingDefaultsReady] = useState(false);
  useEffect(() => {
    if (billingDefaultsApplied.current || !freshnessReady) return;
    if (resumeRequested) {
      billingDefaultsApplied.current = true;
      setBillingDefaultsReady(true);
      return;
    }
    // Chargement/erreur des Réglages : le gate d'écran ci-dessous affiche spinner OU ErrorRetry
    // (la politique de retry bornée garantit qu'une query en échec finit toujours en isError).
    const prefs = billingPrefs.prefs;
    if (prefs === null) return;
    const applied = quoteDraft.applyAtRevision(
      { type: 'set_deposit_pct', depositPct: prefs.defaultDepositPercent },
      quoteDraft.state.revision,
    );
    // SORTIE GARANTIE du spinner (bug fondateur 2026-07-19 : le seed échouait en
    // invalid_transition — set_deposit_pct n'était accepté qu'à l'étape acompte — et l'écran
    // restait en chargement À VIE, sans erreur ni contenu). Un conflit de révision se rejoue
    // seul (la révision est une dépendance de cet effet) ; tout autre refus définitif dégrade
    // honnêtement sur l'acompte par défaut de la machine plutôt que d'emmurer l'utilisateur.
    if (!applied.ok && applied.error.code === 'revision_conflict') return;
    billingDefaultsApplied.current = true;
    setBillingDefaultsReady(true);
  }, [billingPrefs.prefs, freshnessReady, quoteDraft.state.revision, resumeRequested]);
  const [resumeBannerDismissed, setResumeBannerDismissed] = useState(false);

  // « Nouveau devis POUR Camping Les Pins » : le nom entendu (hint session) est résolu contre
  // les clients RÉELS dès leur chargement — client présélectionné + saut direct aux
  // prestations. Introuvable/ambigu → flux normal étape client (fail-safe, jamais de devinette).
  // Attend la décision fraîcheur ci-dessus : sinon `flowRef` porterait encore l'ancien brouillon.
  const [wizardHint] = useState(() => consumeWizardHint('devis-new'));
  const wizardHintRef = useRef(wizardHint);
  useEffect(() => {
    if (!freshnessReady) return;
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
    const matched = candidates[0]!;
    quoteDraft.applyAll([
      { type: 'select_customer', customer: { id: matched.id, name: matched.name } },
      { type: 'next_step' },
    ]);
  }, [customers.data, freshnessReady]);
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
  const catalogueAvailabilityRef = useRef({
    mode: catalogue.mode,
  });
  catalogueAvailabilityRef.current = {
    mode: catalogue.mode,
  };
  const currentRateRef = useRef(currentRate);
  currentRateRef.current = currentRate;
  const vatChoicesRef = useRef<readonly VatChoiceOption[]>(vatChoices);
  vatChoicesRef.current = vatChoices;
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
  /** Ligne EN ATTENTE de prix (qty/label/catégorie déjà extraits par la dictée, cf.
   * `missing_price`) — papa vocal : un simple suivi « 55 euros » la complète SANS repasser
   * par tout l'énoncé. Effacée dès qu'elle est complétée, rejetée, ou remplacée par un
   * nouvel ajout (jamais un état fantôme qui capture un énoncé sans rapport). */
  const pendingLineRef = useRef<{ label: string; qty: number; category: LineCategory } | null>(null);

  const voiceAffordances = useMemo<readonly AgentAffordance[]>(() => {
    const tt = (key: Parameters<typeof t>[0], params?: Record<string, string | number>): string =>
      t(key, { personality: personalityRef.current, ...(params ? { params } : {}) });

    const advance = (): string => {
      const current = flowRef.current;
      // PLANCHER DE SÉCURITÉ : signature (choix du mode + pad/preuve) et recap (ConfirmSheet +
      // chaîne createQuote/sendQuote/signQuote) ne se franchissent JAMAIS à la voix — l'écran
      // fait foi. L'acompte, lui, n'est plus qu'une clause chiffrée : voix-avançable comme TVA.
      if (current.step === 'signature' || current.step === 'recap') {
        return tt('devis.voice.screenOnlyStep');
      }
      const result = quoteDraft.applyAtRevision({ type: 'next_step' }, quoteStateRef.current.revision);
      if (!result.ok) return t(guardKeyOf(result.error), { personality: personalityRef.current });
      setGuardMsg(null);
      return tt('devis.voice.stepDone');
    };

    return [
      {
        // « TVA 20 » / « mets la TVA à 10 % » : même commande que les radios.
        // Un taux indisponible pour le régime courant n'est jamais appliqué par approximation.
        id: 'devis.selectVat',
        match: (utterance) => {
          const spokenRate = parseSpokenVatRate(normalizeVoiceText(utterance));
          if (spokenRate === null) return null;
          const choice = vatChoicesRef.current.find((candidate) => candidate.rate === spokenRate);
          if (choice === undefined) {
            return () => ({ say: tt('devis.voice.vatUnavailable') });
          }
          return () => {
            const selected = quoteDraft.applyAtRevision(
              { type: 'set_vat', context: choice.context, vatRate: choice.rate },
              quoteStateRef.current.revision,
            );
            return {
              say: selected.ok
                ? tt('devis.voice.vatSelected', { rate: fmtRate(choice.rate) })
                : tt('devis.voice.vatUnavailable'),
            };
          };
        },
      },
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
                ? tt('devis.voice.proposalApplied', { field: field.label, after: field.after })
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
            const metadata = quoteStateRef.current.lineMetadata[ordinal - 1];
            if (metadata === undefined) return { say: tt('devis.voice.proposalUnknownLine') };
            const proposed = quoteDraft.propose({
              source: 'bob_voice',
              title: `Ligne ${ordinal} → ${formatEUR(unitPriceHT)}`,
              commands: [{ type: 'update_line', lineId: metadata.id, patch: { unitPriceHT } }],
            });
            const field = proposed.ok ? proposed.value.proposal?.diff[0] : undefined;
            if (field === undefined) return { say: tt('devis.voice.proposalUnknownLine') };
            return {
              say: tt('devis.voice.proposalReady', { field: field.label, before: field.before, after: field.after }),
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
            const metadata = quoteStateRef.current.lineMetadata[ordinal - 1];
            if (metadata === undefined) return { say: tt('devis.voice.proposalUnknownLine') };
            const proposed = quoteDraft.propose({
              source: 'bob_voice',
              title: `Supprimer la ligne ${ordinal}`,
              commands: [{ type: 'remove_line', lineId: metadata.id }],
            });
            const field = proposed.ok ? proposed.value.proposal?.diff[0] : undefined;
            if (field === undefined) return { say: tt('devis.voice.proposalUnknownLine') };
            return {
              say: tt('devis.voice.proposalReady', { field: field.label, before: field.before, after: field.after }),
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
            const back = quoteDraft.applyAtRevision(
              { type: 'previous_step' },
              quoteStateRef.current.revision,
            );
            if (!back.ok) return { say: tt('devis.voice.screenOnlyStep') };
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
            const selected = quoteDraft.applyAll([
              { type: 'select_customer', customer: { id: matched.id, name: matched.name } },
              { type: 'next_step' },
            ]);
            if (!selected.ok) return { say: tt('devis.voice.screenOnlyStep') };
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
            const metadata = quoteStateRef.current.lineMetadata.at(-1);
            if (metadata === undefined) return { say: tt('devis.voice.nothingToRemove') };
            const removed = quoteDraft.applyAtRevision(
              { type: 'remove_line', lineId: metadata.id },
              quoteStateRef.current.revision,
            );
            if (!removed.ok) return { say: tt('devis.voice.nothingToRemove') };
            return { say: tt('devis.voice.lineRemoved', { label: last.label }) };
          };
        },
      },
      {
        // Dicter une LIGNE hors de l'étape lignes — client pas encore choisi, OU déjà avancé
        // à TVA/signature/acompte/facture : Bob GUIDE au lieu de tomber en silence sur le
        // hors-périmètre générique du cerveau serveur (bug fondateur 2026-07-16 : « ajoute
        // deux heures de main-d'œuvre » répondait « je ne m'occupe que d'administratif »,
        // faute d'affordance couvrant les étapes APRÈS lignes — le brouillon est 100 % local,
        // le classifieur serveur ne peut PHYSIQUEMENT pas ajouter une ligne à un devis qui
        // n'existe pas encore côté serveur). `devis.addLine` reste seul maître sur 'lignes'.
        id: 'devis.addLineOffLinesStep',
        match: (utterance) => {
          const step = flowRef.current.step;
          if (step === 'lignes') return null;
          if (!isVoiceAddLineUtterance(utterance)) return null;
          return () => ({
            say: step === 'client'
              ? `${tt('devis.voice.needClientFirst')} ${tt('devis.voice.greetClient')}`
              : tt('devis.voice.needLinesStep'),
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
            pendingLineRef.current = null; // un tour de soumission clôt toute attente de prix
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
          return () => {
            pendingLineRef.current = null;
            return {
              say: lineFormRef.current.reject() ? tt('devis.voice.lineRejected') : tt('devis.voice.nothingToRemove'),
            };
          };
        },
      },
      {
        // Ligne EN ATTENTE de prix (« ajoute deux heures de main-d'œuvre » sans montant) :
        // papa vocal — un simple suivi « 55 euros » / « à 55 € de l'heure » COMPLÈTE la ligne
        // déjà pré-remplie (qty/label/catégorie) SANS repasser par tout l'énoncé. Priorité
        // avant `devis.addLine` : ce suivi ne porte jamais de verbe d'ajout.
        id: 'devis.completePendingLinePrice',
        match: (utterance) => {
          if (flowRef.current.step !== 'lignes') return null;
          const pending = pendingLineRef.current;
          if (pending === null) return null;
          const price = completePendingQuoteLinePrice(utterance, pending.qty);
          if (price === null) return null; // pas un prix exploitable — laisse tenter les autres affordances
          return () => {
            pendingLineRef.current = null;
            lineFormRef.current.prepare({
              label: pending.label,
              qty: pending.qty,
              unitPriceHT: price,
              category: pending.category,
            });
            return {
              say:
                tt('devis.voice.linePrepared', {
                  label: pending.label,
                  qty: pending.qty,
                  price: formatEUR(price),
                })
                + (currentRateRef.current === null ? ` ${tt('devis.voice.vatRequired')}` : ''),
            };
          };
        },
      },
      {
        id: 'devis.addLine',
        match: (utterance) => {
          if (flowRef.current.step !== 'lignes') return null;
          // Déclencheur explicite : un verbe d'ajout — « où suis-je ? » reste au cerveau global.
          if (!isVoiceAddLineUtterance(utterance)) return null;
          return () => {
            const catalogueAvailability = catalogueAvailabilityRef.current;
            if (catalogueAvailability.mode === 'loading') {
              return { say: tt('catalogue.loading') };
            }
            if (catalogueAvailability.mode === 'error') {
              return { say: tt('catalogue.dataError') };
            }
            const parsed = parseVoiceQuoteLine(utterance, {
              prestations: prestationsRef.current,
              confirmedVatRate: currentRateRef.current,
            });
            if (parsed.kind === 'ambiguous') {
              pendingLineRef.current = null;
              return { say: tt('devis.voice.lineAmbiguous', { options: parsed.options.join(', ') }) };
            }
            if (parsed.kind === 'missing_price') {
              // Papa vocal (spec fondateur 2026-07-16) : qty/label/catégorie sont DÉJÀ sûrs —
              // Bob les redit, pré-remplit le formulaire visible et ne redemande QUE le prix
              // (« 55 euros » en suivi complète via `devis.completePendingLinePrice`, jamais
              // besoin de tout redicter).
              pendingLineRef.current = { label: parsed.label, qty: parsed.qty, category: parsed.category };
              lineFormRef.current.prepare({
                label: parsed.label,
                qty: parsed.qty,
                unitPriceHT: 0,
                category: parsed.category,
              });
              return { say: tt('devis.voice.missingPriceReady', { label: parsed.label, qty: parsed.qty }) };
            }
            if (parsed.kind === 'none') {
              pendingLineRef.current = null;
              return { say: tt('devis.voice.missingPrice', { label: '…' }) };
            }
            if (parsed.kind === 'missing_vat') {
              pendingLineRef.current = null;
              lineFormRef.current.prepare({
                label: parsed.line.label,
                qty: parsed.line.qty,
                unitPriceHT: parsed.line.unitPriceHT,
                category: parsed.line.category,
              });
              return {
                say: tt('devis.voice.missingVatReady', {
                  label: parsed.line.label,
                  qty: parsed.line.qty,
                  price: formatEUR(parsed.line.unitPriceHT),
                }),
              };
            }
            pendingLineRef.current = null;
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
              currentRateRef.current === null
                ? ` ${tt('devis.voice.vatRequired')}`
                : line.vatRate !== currentRateRef.current
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
    acompte: 'devis.voice.greetDeposit',
    signature: 'devis.voice.greetSignature',
  };
  const greetKey = GREET_BY_STEP[flow.step];
  const agentSurface = useMemo<AgentSurface>(
    () => ({
      ...(greetKey
        ? {
            greeting: {
              key: `devis-new:${quoteDraft.state.sessionId}:${flow.step}`,
              text: t(greetKey, { personality }),
            },
          }
        : {}),
      affordances: voiceAffordances,
    }),
    [flow.step, greetKey, personality, quoteDraft.state.sessionId, voiceAffordances],
  );
  const wizardAgentContext = useMemo<AgentContext>(
    () => ({
      screen: {
        name: '/devis/new',
        instanceId: `devis-new:${quoteDraft.state.sessionId}:${quoteDraft.state.revision}:${flow.step}`,
      },
      entities: contextCustomer
        ? [{ type: 'customer' as const, id: contextCustomer.id, label: contextCustomer.name }]
        : [],
      capabilities: ['screen.read', 'customer.read'],
    }),
    [contextCustomer, flow.step, quoteDraft.state.revision, quoteDraft.state.sessionId],
  );
  usePublishAgentContext(wizardAgentContext, { bottomAvoidance: 90 }, agentSurface);
  const agentSession = useAgentSession();

  // Une reprise de route obtient une nouvelle mission vocale, mais le même sessionId de brouillon.
  // Une proposition expirée reste un diff refusé, jamais une mutation différée.
  useEffect(() => {
    quoteDraft.expireProposal();
    if (quoteStateRef.current.mission.status !== 'active') {
      quoteDraft.startMission({ mode: 'guided_voice', startedFrom: '/devis/new' });
    }
    return () => {
      quoteDraft.stopMission('user');
    };
  }, [quoteDraft.expireProposal, quoteDraft.startMission, quoteDraft.stopMission]);

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
    if (exitActionInFlight.current) return;
    const name = signerName.trim();
    const committed = signature !== null && !signature.isEmpty && name.length >= 2 ? name : null;
    if (quoteStateRef.current.flow.draft.signerName !== committed) {
      quoteDraft.apply({ type: 'set_signer_name', signerName: committed });
    }
  }, [signature, signerName]);

  // ── Étape 2 : lignes ───────────────────────────────────────────────────────
  const lineQtyValue = parsePositive(lineQty);
  const linePriceValue = parsePositive(linePrice);
  const lineValid =
    lineLabel.trim() !== ''
    && lineQtyValue !== null
    && linePriceValue !== null
    && currentRate !== null;

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

  const addLine = (): LineInput | null => {
    if (
      !lineValid
      || lineQtyValue === null
      || linePriceValue === null
      || currentRate === null
    ) return null;
    const line: LineInput = {
      label: lineLabel.trim(),
      category: lineCat,
      qty: lineQtyValue,
      unitPriceHT: Math.round(linePriceValue * 100),
      vatRate: currentRate,
    };
    const added = quoteDraft.addLine({
      interaction: 'manual',
      expectedRevision: quoteDraft.state.revision,
      line,
    });
    if (!added.ok) {
      if (added.error.code === 'revision_conflict') return null;
      setGuardMsg(t(guardKeyOf(added.error), { personality }));
      return null;
    }
    quoteDraft.clearLineForm();
    return line;
  };

  const removeLine = (index: number): void => {
    const metadata = quoteDraft.state.lineMetadata[index];
    if (metadata === undefined) return;
    quoteDraft.applyAtRevision(
      { type: 'remove_line', lineId: metadata.id },
      quoteDraft.state.revision,
    );
  };

  /** Applique/rejette la proposition en attente — UN SEUL chemin, voix ET tap. */
  const applyLineProposal = (): QuoteDraftProposal | null => {
    const proposal = lineProposal;
    if (proposal === null) return null;
    const accepted = quoteDraft.acceptProposal(proposal.id);
    if (!accepted.ok && accepted.error.code === 'proposal_expired') quoteDraft.expireProposal();
    return accepted.ok ? proposal : null;
  };
  const rejectLineProposal = (): boolean => {
    if (lineProposal === null) return false;
    return quoteDraft.rejectProposal(lineProposal.id).ok;
  };
  const lineProposalRef = useRef<{
    apply: () => QuoteDraftProposal | null;
    reject: () => boolean;
    pending: () => QuoteDraftProposal | null;
  }>({
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
      // La fence de révision dans `addLine` rend un double consentement idempotent.
      return addLine();
    },
    reject: () => {
      const hadSomething = lineLabel.trim() !== '' || linePrice.trim() !== '';
      quoteDraft.clearLineForm();
      return hadSomething;
    },
  };

  // ── Étape 3 : choix TVA = contexte + taux, appliqué à tout le devis ────────
  const selectVat = (choice: VatChoiceOption): void => {
    quoteDraft.applyAtRevision(
      { type: 'set_vat', context: choice.context, vatRate: choice.rate },
      quoteDraft.state.revision,
    );
  };

  // ── Étape 5 : signature — sur place (pad) ou envoi (email avec le lien) ───
  const selectSignMode = (mode: DevisSignMode): void => {
    if (draft.signMode === mode) return;
    setSignature(null); // changer de mode invalide un tracé en cours (le domaine annule le nom)
    quoteDraft.applyAtRevision({ type: 'set_sign_mode', signMode: mode }, quoteDraft.state.revision);
  };

  // ── Étape 6 : recap — createQuote → sendQuote → signQuote SI sur place. Résumable
  // (checkpoints par ref) — mêmes use cases que Bob (parité), JAMAIS de facture ici. ──
  const runQuoteCreation = async (d: DevisDraft): Promise<void> => {
    // Ref synchrone : deux taps dans le même frame ne voient jamais deux `busy=false`.
    if (generationInFlight.current) return;
    if (
      d.customerId === null
      || d.tvaContext === null
      || d.vatRate === null
      || d.lines.some((line) => line.vatRate !== d.vatRate)
      || d.signMode === null
      || (d.signMode === 'onsite' && d.signerName === null)
    ) {
      setError(t('devis.errAction', { personality }));
      return;
    }
    generationInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let quoteId = chain.current.quoteId;
      if (quoteId === null) {
        // Validité du devis = préférence Réglages facturation (défaut 30 j) appliquée depuis
        // AUJOURD'HUI (pas depuis un instant figé au montage — le devis peut être terminé bien
        // après l'ouverture de l'écran).
        const prefs = billingPrefs.prefs;
        if (prefs === null) {
          setError(t('reglages.dataError', { personality }));
          return;
        }
        const validUntil = addDays(parisDateOnly(), prefs.defaultQuoteValidityDays);
        const created = await createQuote.mutateAsync({
          customerId: d.customerId,
          lines: d.lines.map((l) => ({ ...l })),
          context: {
            housingOlderThan2y: d.tvaContext.housingOlderThan2y === true,
            energyRenovation:
              d.tvaContext.energyRenovation === true
              && d.tvaContext.housingOlderThan2y === true,
          },
          ...(d.depositPct > 0 ? { depositPct: d.depositPct } : {}),
          validUntil,
        });
        quoteId = created.quoteId;
        chain.current.quoteId = quoteId;
      }
      if (!chain.current.sent) {
        // sendQuote alloue le numéro légal ET envoie l'e-mail avec le lien de signature (si le
        // client a une adresse) — c'est LÀ que « envoyer » se produit, pas une étape à part.
        const sent = await sendQuote.mutateAsync(quoteId);
        chain.current.sent = true;
        chain.current.number = sent.number;
        chain.current.emailSkipped = sent.deliveryStatus === 'skipped';
      }
      if (d.signMode === 'onsite' && !chain.current.signed) {
        // R4 : le tracé du pad (étape signature) accompagne la signature — le serveur en
        // calcule le hash de preuve (onsite_draw). La garde devisNext exige un tracé non vide
        // pour franchir l'étape en mode « sur place », donc `signature.dataUrl` existe ici ;
        // on reste défensif (spread).
        await signQuote.mutateAsync({
          quoteId,
          signerName: d.signerName!,
          ...(signature?.dataUrl ? { proofDataUrl: signature.dataUrl } : {}),
        });
        chain.current.signed = true;
      }
      const number = chain.current.number;
      if (number === null) {
        // Défensif : sendQuote a nécessairement réussi ci-dessus (ou lors d'un essai
        // précédent) pour atteindre ce point — un numéro manquant serait une incohérence.
        setError(t('devis.errAction', { personality }));
        return;
      }
      // Le devis est créé/envoyé (et peut-être signé), mais l'ancien brouillon ne doit jamais
      // ressusciter au prochain boot. On attend donc la suppression CAS du slot PostgreSQL avant
      // d'afficher le recap. Un échec reste retryable : les checkpoints gardent les ids réels
      // et empêchent toute double création — JAMAIS de facture, quel que soit l'état atteint.
      const draftCleared = await quoteDraft.complete(quoteId);
      if (!draftCleared) {
        setError(t('devis.errAction', { personality }));
        return;
      }
      const finalTotals = computeTotals([...d.lines], { depositPct: d.depositPct });
      setQuoteResult({
        id: quoteId,
        number,
        customerName,
        amount: formatEUR(finalTotals.ttc),
        status: d.signMode === 'onsite' ? 'signed' : 'sent',
        depositPct: d.depositPct,
        depositAmount: formatEUR(finalTotals.netToPay),
        emailSkipped: chain.current.emailSkipped,
      });
      setToast(
        t(d.signMode === 'onsite' ? 'devis.toastSigned' : 'devis.toastSent', {
          personality,
          params: { number },
        }),
      );
    } catch (e) {
      setError(appErrorMessage(e));
    } finally {
      generationInFlight.current = false;
      setBusy(false);
    }
  };

  const onFinalize = async (): Promise<void> => {
    if (generationIntentInFlight.current || generationInFlight.current) return;
    const mode = draft.signMode;
    if (mode === null) return; // bouton désactivé tant que le mode n'est pas choisi
    generationIntentInFlight.current = true;
    try {
      const confirmedRevision = quoteDraft.state.revision;
      const amount = formatEUR(totals.ttc);
      const ok = await confirm({
        title: t(mode === 'onsite' ? 'devis.confirmSignTitle' : 'devis.confirmSendTitle', { personality }),
        message: t(mode === 'onsite' ? 'devis.confirmSignBody' : 'devis.confirmSendBody', {
          personality,
          params: { name: customerName, amount },
        }),
        challenge: challengeFor(OUTBOUND, 'confirm_all'),
      });
      if (!ok) return;
      const next = quoteDraft.applyAtRevision({ type: 'next_step' }, confirmedRevision);
      if (!next.ok) {
        setGuardMsg(t(guardKeyOf(next.error), { personality }));
        return;
      }
      setGuardMsg(null);
      await runQuoteCreation(next.value.flow.draft);
    } finally {
      generationIntentInFlight.current = false;
    }
  };

  /** Recap, statut « envoyé » : si l'e-mail a été sauté (client sans adresse), permet quand
   * même de délivrer le lien de signature (partage natif) — parité avec « Envoyer le lien »
   * de QuoteActions/R4. Aucun sortant caché : Share reste un geste explicite de l'artisan. */
  const shareSignatureLink = async (): Promise<void> => {
    if (quoteResult === null || shareLinkBusy) return;
    setShareLinkBusy(true);
    try {
      const result = await signatureLink.mutateAsync(quoteResult.id);
      await Share.share({
        message: `Bonjour, voici le lien pour signer le devis${quoteResult.number ? ` ${quoteResult.number}` : ''} : ${result.signatureUrl}`,
      });
    } catch (e) {
      setError(appErrorMessage(e));
    } finally {
      setShareLinkBusy(false);
    }
  };

  // ── Sortie sûre : bouton, back Android et swipe iOS passent par la même décision ──
  const hasUnpersistedSignature = signature !== null && !signature.isEmpty;
  const needsExitDecision = quoteResult === null
    && (
      hasUnsavedQuoteDraftChanges(quoteDraft.state)
      || hasUnpersistedSignature
      || lineProposal !== null
    );
  // Une chaîne partiellement exécutée ne se transforme pas en « brouillon local » : quitter
  // ferait perdre les checkpoints et pourrait provoquer un double envoi/signature au retry.
  const generationExitLocked = quoteResult === null && flow.step === 'recap';

  useEffect(() => navigation.addListener('beforeRemove', (event) => {
    if (allowNextRemoval.current) {
      allowNextRemoval.current = false;
      return;
    }
    if (!needsExitDecision && !generationExitLocked) return;
    event.preventDefault();
    pendingExit.current = () => navigation.dispatch(event.data.action);
    setExitSheetOpen(true);
  }), [generationExitLocked, navigation, needsExitDecision]);

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !needsExitDecision && !generationExitLocked });
  }, [generationExitLocked, navigation, needsExitDecision]);

  const leave = (action: () => void): void => {
    allowNextRemoval.current = true;
    setExitSheetOpen(false);
    pendingExit.current = null;
    action();
  };

  const requestClose = (): void => {
    const action = () => router.back();
    if (!needsExitDecision && !generationExitLocked) {
      leave(action);
      return;
    }
    pendingExit.current = action;
    setExitSheetOpen(true);
  };

  const continueEditing = (): void => {
    if (exitActionInFlight.current) return;
    pendingExit.current = null;
    setExitSheetOpen(false);
  };

  const saveAndExit = async (): Promise<void> => {
    if (generationExitLocked || exitActionInFlight.current) return;
    exitActionInFlight.current = true;
    setExitActionBusy(true);
    const action = pendingExit.current ?? (() => router.back());

    // La sanitisation (signature, proposition, mission) se fait à la frontière V2→V1 et ne
    // remplace l'état mémoire qu'APRÈS le commit CAS du slot BDD. Si le serveur échoue, rien de ce
    // que la personne voit — tracé, proposition ou guidage — n'est détruit avant son retry.
    const persisted = await quoteDraft.save();
    if (persisted) {
      leave(action);
      return;
    }
    // Le sheet reste ouvert : la personne peut réessayer ou continuer à éditer, sans faux succès.
    exitActionInFlight.current = false;
    setExitActionBusy(false);
  };

  const discardAndExit = async (): Promise<void> => {
    if (generationExitLocked || exitActionInFlight.current) return;
    exitActionInFlight.current = true;
    setExitActionBusy(true);
    const action = pendingExit.current ?? (() => router.back());
    const discarded = await quoteDraft.discard();
    if (discarded) {
      leave(action);
      return;
    }
    exitActionInFlight.current = false;
    setExitActionBusy(false);
  };

  // ════════ RECAP (machine: 'recap', devis réel créé — JAMAIS de facture) ═════
  if (!billingDefaultsReady) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          paddingTop: insets.top + 24,
          paddingHorizontal: 18,
          justifyContent: 'center',
        }}
      >
        {billingPrefs.isError ? (
          <ErrorRetry
            message={t('reglages.dataError', { personality })}
            onRetry={() => { void billingPrefs.refetch(); }}
          />
        ) : (
          <ActivityIndicator color={semantic.ai} size="large" />
        )}
      </View>
    );
  }

  if (quoteResult !== null) {
    const signed = quoteResult.status === 'signed';
    const tint = signed ? semantic.success : semantic.warning;
    return (
      <View style={{ flex: 1, backgroundColor: tint }}>
        {signed ? (
          <LinearGradient
            pointerEvents="none"
            colors={[semantic.success, themes.foret.d1]}
            start={{ x: 0.45, y: 0 }}
            end={{ x: 0.55, y: 1 }}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          />
        ) : null}
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
            {signed ? (
              <CheckIcon color={semantic.success} size={48} strokeWidth={2.6} />
            ) : (
              <Ionicons name="paper-plane-outline" size={44} color={semantic.warning} />
            )}
          </View>
          <Text style={[font('screenH1'), { color: colors.surface, textAlign: 'center', marginBottom: 8 }]}>
            {t(signed ? 'devis.recapSignedTitle' : 'devis.recapSentTitle', { personality })}
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
                marginBottom: signed && quoteResult.depositPct >= 0 ? 18 : 30,
              },
            ]}
          >
            {t(signed ? 'devis.recapSignedBody' : 'devis.recapSentBody', {
              personality,
              params: {
                number: quoteResult.number,
                name: quoteResult.customerName,
                amount: quoteResult.amount,
              },
            })}
          </Text>
          {/* Parcours ① (signature sur place) SEULEMENT : la facture reste une PROPOSITION,
              jamais déclenchée d'ici — le CTA route vers le chemin officiel (/devis/[id],
              QuoteActions R5). Parcours ② (envoi à distance) : AUCUNE proposition tant que
              le client n'a pas signé — la carte Home « devis accepté » prendra le relais. */}
          {signed ? (
            <View
              style={{
                alignSelf: 'stretch',
                maxWidth: 320,
                backgroundColor: overlays.white10,
                borderRadius: 16,
                padding: 14,
                marginBottom: 18,
              }}
            >
              <Text style={[font('label', 700), { fontSize: 11.5, color: colors.surface, marginBottom: 4 }]}>
                {t('devis.recapProposalTitle', { personality }).toUpperCase()}
              </Text>
              <Text style={[font('sub'), { color: overlays.white70, lineHeight: 19 }]}>
                {t(
                  quoteResult.depositPct > 0 ? 'devis.recapProposalBodyDeposit' : 'devis.recapProposalBodyFull',
                  { personality, params: { pct: quoteResult.depositPct, amount: quoteResult.depositAmount } },
                )}
              </Text>
            </View>
          ) : null}
          {!signed && quoteResult.emailSkipped ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('devis.shareLink', { personality })}
              disabled={shareLinkBusy}
              onPress={() => void shareSignatureLink()}
              style={{
                alignSelf: 'stretch',
                maxWidth: 320,
                borderWidth: 1,
                borderColor: overlays.white14,
                borderRadius: 14,
                paddingVertical: 12,
                alignItems: 'center',
                marginBottom: 14,
                opacity: shareLinkBusy ? 0.6 : 1,
              }}
            >
              <Text style={[font('label', 600), { color: colors.surface }]}>
                {shareLinkBusy ? t('devis.generating', { personality }) : t('devis.shareLink', { personality })}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('devis.seeQuote', { personality })}
            onPress={() => router.replace(`/devis/${quoteResult.id}`)}
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
            <Text style={[font('button'), { color: tint }]}>
              {t('devis.seeQuote', { personality })}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('devis.close', { personality })}
            onPress={requestClose}
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

  // ════════ FLUX (machine: client → … → recap en cours) ═══════════════════════
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
          {stepIndex > 0 && flow.step !== 'recap' ? (
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
            onPress={requestClose}
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

        {/* Bannière discrète de reprise (bug fondateur 2026-07-17) : jamais de résurrection
            silencieuse — le wizard démarre vierge, mais un brouillon enregistré parké reste
            proposé, pas imposé. Visible seulement à l'étape client (juste après l'ouverture) et
            tant que rien n'a été saisi dans CETTE session. */}
        {quoteDraft.pendingResume !== null && !resumeBannerDismissed && flow.step === 'client' && draft.customerId === null ? (
          <View style={{ paddingHorizontal: 18, paddingBottom: 4 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => quoteDraft.resumePending()}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: semantic.warning,
                backgroundColor: semantic.warningBg,
                paddingVertical: 10,
                paddingHorizontal: 12,
              }}
            >
              <Ionicons name="document-text-outline" size={18} color={semantic.warning} />
              <Text style={[font('sub'), { flex: 1, color: colors.ink800, lineHeight: 18 }]}>
                {t(
                  quoteDraft.pendingResume.customer !== null ? 'devis.resumeBanner.prompt' : 'devis.resumeBanner.promptNoName',
                  { personality, params: { name: quoteDraft.pendingResume.customer?.name ?? '' } },
                )}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('devis.resumeBanner.dismiss', { personality })}
                hitSlop={8}
                onPress={(e) => {
                  e.stopPropagation();
                  setResumeBannerDismissed(true);
                }}
                style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
              >
                <CloseIcon color={colors.slate500} size={13} strokeWidth={2.4} />
              </Pressable>
            </Pressable>
          </View>
        ) : null}

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
                  retrying={customers.isRefetching}
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
                      onPress={() => {
                        quoteDraft.applyAtRevision(
                          { type: 'select_customer', customer: { id: c.id, name: c.name } },
                          quoteDraft.state.revision,
                        );
                        setGuardMsg(null);
                      }}
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
            contextCustomer !== null ? (
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
                    {contextCustomer.name}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('devis.clientTagRemove', { personality })}
                    hitSlop={8}
                    onPress={() => quoteDraft.applyAtRevision(
                      { type: 'clear_customer' },
                      quoteDraft.state.revision,
                    )}
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
                    onPress={() => quoteDraft.applyAtRevision(
                      { type: 'select_customer', customer: { id: c.id, name: c.name } },
                      quoteDraft.state.revision,
                    )}
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
                {lineProposal.title.toUpperCase()}
              </Text>
              {lineProposal.diff.map((field) => (
                <Text key={field.key} style={[font('sub'), { color: colors.ink800, marginTop: 4 }]}>
                  {field.label} : {field.before} → {field.after}
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
                    maxLength={500}
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
                {catalogue.isError ? (
                  <View style={{ marginTop: 10 }}>
                    <ErrorRetry
                      message={t('catalogue.dataError', { personality })}
                      onRetry={catalogue.refetch}
                      retrying={catalogue.isRefetching}
                    />
                  </View>
                ) : null}
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
                      maxLength={64}
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
                      maxLength={64}
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
                <Text style={[font('meta', 600), { color: colors.slate500, marginTop: 12 }]}>
                  {t('devis.vatRequiredLabel', { personality })}
                </Text>
                {company.isError ? (
                  <View style={{ marginTop: 8 }}>
                    <ErrorRetry
                      message={t('devis.vatProfileUnavailable', { personality })}
                      onRetry={() => void company.refetch()}
                      retrying={company.isRefetching}
                    />
                  </View>
                ) : company.isLoading ? (
                  <View style={{ marginTop: 8 }}>
                    <SkeletonRow avatar={false} lines={1} trailing="pill" />
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                    {vatChoices.map((choice) => (
                      <Chip
                        key={choice.key}
                        label={t(choice.labelKey, { personality })}
                        active={vatChoice === choice.key}
                        onPress={() => selectVat(choice)}
                      />
                    ))}
                  </View>
                )}
                {currentRate === null && !company.isLoading && !company.isError ? (
                  <Text
                    accessibilityRole="alert"
                    style={[font('meta'), { color: semantic.danger, marginTop: 8 }]}
                  >
                    {t('devis.vatRequired', { personality })}
                  </Text>
                ) : null}
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
              {vatChoices.map((choice) => {
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
                {currentRate === null
                  ? t('devis.vatRequired', { personality })
                  : t('devis.vatHint', {
                      personality,
                      params: { rate: fmtRate(currentRate) },
                    })}
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

          {/* ── Étape 4 — acompte : le % CONTRACTUEL, décidé AVANT la signature (pas une
              facture) — 30 % défaut, net réel du core. ── */}
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
                    onPress={() => quoteDraft.applyAtRevision(
                      { type: 'set_deposit_pct', depositPct: pct },
                      quoteDraft.state.revision,
                    )}
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

          {/* ── Étape 5 — signature : sur place (pad, vue client navy) ou envoi (email +
              lien de signature, l'artisan reste devant son propre écran). ── */}
          {flow.step === 'signature' ? (
            <>
              <Text style={[font('screenH1'), { fontSize: 24, color: titleColor }]}>
                {t('devis.signTitle', { personality })}
              </Text>
              <Text style={[font('sub'), { color: subColor, marginBottom: 4 }]}>
                {t('devis.signSub', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {SIGN_MODE_CHOICES.map((choice) => {
                  const selected = draft.signMode === choice.key;
                  return (
                    <Pressable
                      key={choice.key}
                      onPress={() => selectSignMode(choice.key)}
                      accessibilityRole="radio"
                      accessibilityLabel={t(choice.labelKey, { personality })}
                      accessibilityState={{ selected }}
                      style={{
                        flex: 1,
                        gap: 4,
                        borderRadius: radius.card,
                        borderWidth: selected ? 2 : 1,
                        borderColor: selected
                          ? (dark ? colors.surface : theme.ink)
                          : (dark ? overlays.white14 : controls.cardBorder),
                        backgroundColor: dark ? (selected ? overlays.white14 : overlays.white10) : colors.surface,
                        padding: 14,
                      }}
                    >
                      <Text style={[font('label', 700), { fontSize: 14, color: dark ? colors.surface : colors.ink900 }]}>
                        {t(choice.labelKey, { personality })}
                      </Text>
                      <Text
                        style={[
                          font('meta'),
                          { fontSize: 11.5, lineHeight: 15, color: dark ? overlays.white60 : colors.slate400 },
                        ]}
                      >
                        {t(choice.hintKey, { personality })}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {draft.signMode === 'onsite' ? (
                <>
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
              {draft.signMode === 'remote' ? (
                <Card radius={18} padding={16}>
                  <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink900, marginBottom: 6 }]}>
                    {t('devis.signModeRemoteSummaryTitle', { personality })}
                  </Text>
                  <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20 }]}>
                    {t('devis.signModeRemoteSummaryBody', { personality, params: { name: customerName } })}
                  </Text>
                </Card>
              ) : null}
            </>
          ) : null}

          {/* ── Étape 6 — recap : envoi/signature en cours ou erreur (le résultat a son écran) ── */}
          {flow.step === 'recap' && quoteResult === null ? (
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
                      onPress={() => void runQuoteCreation(flow.draft)}
                    />
                  </View>
                </>
              )}
            </View>
          ) : null}
        </ScrollView>

        {/* Garde bloquante (voix de Bob) + CTA d'avancement — chaque Suivant = devisNext */}
        <Sheet
          visible={exitSheetOpen}
          onClose={continueEditing}
          accessibilityLabel={t('devis.draftExit.title', { personality })}
          closeAccessibilityLabel={t('devis.draftExit.close', { personality })}
        >
          <View style={{ gap: 12 }}>
            <Text style={[font('section'), { color: colors.ink900 }]}>
              {t('devis.draftExit.title', { personality })}
            </Text>
            <Text style={[font('body'), { color: colors.slate500, lineHeight: 22 }]}>
              {t(
                generationExitLocked ? 'devis.draftExit.generationBody' : 'devis.draftExit.body',
                { personality },
              )}
            </Text>
            {hasUnpersistedSignature && !generationExitLocked ? (
              <Text style={[font('meta'), { color: semantic.warning, lineHeight: 18 }]}>
                {t('devis.draftExit.signatureBody', { personality })}
              </Text>
            ) : null}
            {lineProposal !== null && !generationExitLocked ? (
              <Text style={[font('meta'), { color: semantic.aiInk, lineHeight: 18 }]}>
                {t('devis.draftExit.proposalBody', { personality })}
              </Text>
            ) : null}
            {quoteDraft.persistence.error !== null ? (
              <Card style={{ borderColor: semantic.danger }}>
                <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger }]}>
                  {t(
                    quoteDraft.persistence.error === 'conflict'
                      ? 'devis.draftExit.persistenceConflict'
                      : 'devis.draftExit.persistenceError',
                    { personality },
                  )}
                </Text>
              </Card>
            ) : null}
            <Button
              title={t('devis.draftExit.continue', { personality })}
              onPress={continueEditing}
              disabled={exitActionBusy}
            />
            <Button
              title={t('devis.draftExit.save', { personality })}
              variant="secondary"
              onPress={() => { void saveAndExit(); }}
              loading={exitActionBusy && quoteDraft.persistence.status === 'saving'}
              disabled={exitActionBusy || generationExitLocked}
            />
            <Button
              title={t('devis.draftExit.discard', { personality })}
              variant="danger"
              onPress={() => { void discardAndExit(); }}
              loading={exitActionBusy && quoteDraft.persistence.status === 'clearing'}
              disabled={exitActionBusy || generationExitLocked}
            />
          </View>
        </Sheet>

        {/* Picker catalogue (parité manuelle du « catalogue d'abord » vocal) */}
        <Modal
          visible={cataloguePickerOpen}
          animationType={reduceMotion ? 'none' : 'slide'}
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
              {catalogue.mode === 'loading' ? (
                <View
                  accessibilityRole="progressbar"
                  accessibilityLiveRegion="polite"
                  style={{ alignItems: 'center', paddingVertical: 20, gap: 10 }}
                >
                  <ActivityIndicator color={semantic.ai} />
                  <Text style={[font('sub'), { color: colors.slate500 }]}>
                    {t('catalogue.loading', { personality })}
                  </Text>
                </View>
              ) : catalogue.mode === 'error' ? (
                <ErrorRetry
                  message={t('catalogue.dataError', { personality })}
                  onRetry={catalogue.refetch}
                  retrying={catalogue.isRefetching}
                />
              ) : catalogue.prestations.length === 0 ? (
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
        {flow.step !== 'recap' ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 6, paddingBottom: insets.bottom + 16, gap: 10 }}>
            {guardMsg !== null ? (
              <Text
                accessibilityLiveRegion="polite"
                style={[font('sub'), { textAlign: 'center', color: semantic.dangerVivid }]}
              >
                {guardMsg}
              </Text>
            ) : null}
            {flow.step === 'signature' ? (
              // `dark` (navy, pad visible) n'est vrai QUE sur cette étape (signMode === 'onsite') :
              // le CTA dédié couvre donc aussi le cas où la vue est passée en navy — jamais le
              // bouton clair générique ci-dessous, qui serait illisible sur fond sombre.
              <Button
                title={t(
                  draft.signMode === 'remote'
                    ? 'devis.sendCta'
                    : draft.signMode === 'onsite'
                      ? 'devis.signOnsiteCta'
                      : 'devis.next',
                  { personality },
                )}
                disabled={draft.signMode === null}
                onPress={() => void onFinalize()}
              />
            ) : (
              <Button title={t('devis.next', { personality })} onPress={goNext} />
            )}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}
