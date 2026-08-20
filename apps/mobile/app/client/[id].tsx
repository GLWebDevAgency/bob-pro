/**
 * Fiche client (claim C13, réfs claims/ref/C13-frame-p1/p2.png — fiche SARL Martin).
 * Composition @bob/ui : barre retour « ‹ Clients » + menu « … » (no-op accessible, TODO)
 * → en-tête (Avatar squircle tone par type · nom · partyLine ADAPTATIF : badge type +
 * SIREN seulement b2b/b2g, RIEN pour un particulier) → 4 actions rapides (Devis /
 * Relancer / Appeler / Email — tuiles blanches icône+label) → 3 KPI (Encours teinté par
 * statut · Délai moyen · CA 12 mois) → Card « Historique de paiement » avec statut
 * de rapprochement explicite (aucun score inventé) → carte conformité e-invoicing (canal
 * einvoiceChannelFor @bob/core : PA b2b / e-reporting b2c / Chorus Pro b2g) → Segmented
 * onglets Activité/Chantiers/Docs/Infos (Activité fonctionnelle, le reste en état vide
 * propre) → CTA sticky contextuelle par standing.
 *
 * DONNÉES 100 % RÉELLES (A1-C10 généralisé) : useCustomers + useInvoices + useQuotes
 * filtrées par id ; le standing et les montants viennent de deriveCustomerStandings
 * (@bob/core, use case pur — zéro duplication) ; le doc/montant de la CTA « Relancer »
 * et les jours de retard des rangées viennent de deriveTodayPriorities (le MÊME moteur
 * que la carte relance C10) ; le CA 12 mois de revenueLast12MonthsCents (@bob/core).
 * AUCUN repli fixtures : loading → skeletons · erreur → voix de Bob (fiche.dataError) ·
 * client introuvable → fiche.notFound + retour · 0 pièce → fiche.activityEmpty.
 *
 * PARITÉ D'ACTIONS humain ↔ Bob (directive 23:52) :
 * · Relancer (tuile + CTA sticky retard/devis) → /(tabs)/assistant — même point d'entrée
 *   que Bob (prompt → runtime agent, use cases relance @bob/core, comme C10/C11) ;
 * · Devis (tuile + CTA sticky à jour) → /devis/new (create-quote, le use case que Bob invoque) ;
 * · Appeler / Email → Linking tel:/mailto: (actions device, hors périmètre agent).
 *
 * Écarts assumés vs réfs (composants @bob/ui figés pour ce claim) :
 * · avatar en pastel sémantique par type (Avatar tone — gamme tokens), pas l'aplat navy
 *   du proto (hex hors tokens) — même écart documenté que C12 ; taille 54 (réf) au-delà
 *   de la fourchette 34–44 des redlines §8 (avatars de liste) ;
 * · la date des rangées d'activité : devis = date d'établissement (issuedAt, repli
 *   validUntil pour les vues legacy) ; factures = échéance (dueAt) ;
 * · pas de rangée « Règlement reçu » : aucun flux paiements par client côté BobClient
 *   aujourd'hui (TODO C40) — les statuts Réglée/Réglée en partie portent l'info.
 * Zéro hex/rgba : useTheme()/@bob/tokens. Zéro import de src/components/ui (ancien kit).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
  findNodeHandle,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deriveCustomerStandings,
  deriveTodayPriorities,
  einvoiceChannelFor,
  formatEURWhole,
  revenueLast12MonthsCents,
  tradeToWorksiteTerminology,
  type CustomerListItem,
  type CustomerStanding,
  type EinvoiceChannel,
  type RelancePriority,
} from '@bob/core';
import type { InvoiceView, UpdateCustomerClientInput } from '@bob/api-client';
import { shadowNative } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Avatar,
  BobSurface,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  ErrorRetry,
  FadeIn,
  IconTile,
  KpiTile,
  MoneyText,
  QuickAction,
  SegmentedControl,
  Sheet,
  Skeleton,
  SkeletonRow,
  StatusBadge,
  StickyActionBar,
  Toast,
  font,
  standingAccentColor,
  statusBadgeColors,
  useStatusBadgePalette,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import {
  useChantiers,
  useCreateChantier,
  useCustomers,
  useProfile,
  useQuotes,
  useInvoices,
  useSearchAddress,
  useUpdateCustomer,
} from '../../src/data/hooks';
import { useDocuments } from '../../src/data/documents';
import { useBobClient } from '../../src/data/client';
import { hasBlockingAuthoritativeDataError } from '../../src/data/authoritative-query-state';
import {
  jarvisFrameTargetsCustomer,
  usePublishAgentContext,
  useJarvisOpenRun,
  useJarvisRunFrame,
  type AgentContext,
  type AgentAccessLayout,
} from '../../src/agent';
import { JarvisConfirmationCard } from '../../src/components/jarvis-confirmation-card';
import { CustomerForm, type CustomerFormInitial } from '../../src/components/customer-form';
import { formatSiret } from '../../src/components/CompanyFicheCard';
import { CustomerBillingSections } from '../../src/components/CustomerBillingSections';
import { CustomerContactsCard } from '../../src/components/CustomerContactsCard';
import {
  CustomerContractsCard,
  type CustomerContractsCardState,
} from '../../src/components/CustomerContractsCard';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  FileIcon,
  FileTextIcon,
  FolderSmallIcon,
  MailIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
  SendIcon,
  ShieldIcon,
} from '../../src/components/icons';
import { firstQueryErrorFacts } from '../../src/data/query-error-facts';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { ChantierRowCountBadges } from '../../src/components/chantier-row-counts';
import { DEFAULT_WORKSITE_TERM, worksiteParamsFor } from '../../src/lib/worksite-terminology';
import { consumeContractDeletedNotice } from '../../src/lib/navigation-notice';

const SEARCH_DEBOUNCE_MS = 350;

/** Badge type + pastel d'avatar (tokens sémantiques §7) — partyLine b2b/b2g uniquement. */
const TONE_BY_TYPE: Record<CustomerListItem['type'], StatusBadgeVariant> = {
  b2c: 'particulier',
  b2b: 'b2b',
  b2g: 'b2g',
};

const TAB_KEYS = ['activity', 'chantiers', 'docs', 'infos'] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABEL: Record<TabKey, I18nKey> = {
  activity: 'fiche.tabActivity',
  chantiers: 'fiche.tabChantiers',
  docs: 'fiche.tabDocs',
  infos: 'fiche.tabInfos',
};

/** États vides des onglets (états de premier rang — jamais une liste inventée). */
const TAB_EMPTY: Record<Exclude<TabKey, 'activity'>, I18nKey> = {
  chantiers: 'fiche.chantiersEmpty',
  docs: 'fiche.docsEmpty',
  infos: 'fiche.infosEmpty',
};

/** Libellé du type client (mêmes clés que le détail de pièce C16 — source unique). */
const TYPE_KEY: Record<CustomerListItem['type'], I18nKey> = {
  b2b: 'piece.typeB2b',
  b2c: 'piece.typeB2c',
  b2g: 'piece.typeB2g',
};

const DOC_LABEL: Record<InvoiceView['kind'], I18nKey> = {
  final: 'fiche.docInvoice',
  deposit: 'fiche.docDeposit',
  situation: 'fiche.docSituation',
  credit_note: 'fiche.docCreditNote',
};

const MONTHS_SHORT = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
] as const;

/** Date locale du jour (DateOnly) — l'échéance d'une facture se juge en calendrier local, pas UTC. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** « 2026-05-15 » → « 15 mai » (réf : dates courtes fr, sans Intl — comme formatEUR). */
function dateLabel(date: string): string {
  const month = MONTHS_SHORT[Number(date.slice(5, 7)) - 1] ?? '';
  return `${Number(date.slice(8, 10))} ${month}`;
}

/** « 821503646 » → « 821 503 642 » (réf : SIREN groupé par 3). */
function formatSiren(siren: string): string {
  return siren.replace(/(\d{3})(?=\d)/g, '$1 ');
}

/** Rangée d'activité projetée (pièce réelle → titre, date, note, montant teinté). */
interface ActivityItem {
  key: string;
  title: string;
  /** DateOnly de référence (échéance/validité) — null si la pièce n'en expose pas. */
  date: string | null;
  note: string;
  amountCents: number;
  amountColor: string;
  iconTone: StatusBadgeVariant;
  /** Détail de pièce C16 — la rangée navigue (retour humain 20:27 : « plus cliquables »). */
  href: `/facture/${string}` | `/devis/${string}`;
}

/** Rangée d'activité (pièce réelle) : pastille doc → titre + « date · note » → montant teinté. */
function ActivityRow({
  item,
  divider,
  onPress,
}: {
  item: ActivityItem;
  divider: boolean;
  onPress: () => void;
}) {
  const { colors, controls } = useTheme();
  const palette = useStatusBadgePalette();
  const meta = item.date !== null ? `${dateLabel(item.date)} · ${item.note}` : item.note;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${meta}, ${formatEURWhole(item.amountCents)}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingVertical: 11,
        opacity: pressed ? 0.7 : 1,
        ...(divider ? { borderBottomWidth: 1, borderBottomColor: colors.lineSoft } : {}),
      })}
    >
      <IconTile tone={item.iconTone} size={30} radius={9}>
        <FileTextIcon color={statusBadgeColors(item.iconTone, palette).fg} size={15} />
      </IconTile>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[font('sub', 700), { color: colors.ink800 }]}>
          {item.title}
        </Text>
        <Text
          numberOfLines={1}
          style={[font('meta'), { fontSize: 11.5, color: colors.slate400, marginTop: 1 }]}
        >
          {meta}
        </Text>
      </View>
      <Text style={[font('sub', 700), { color: item.amountColor, fontVariant: ['tabular-nums'] }]}>
        {formatEURWhole(item.amountCents)}
      </Text>
      <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
    </Pressable>
  );
}

/** Skeleton fidèle aux rangées Chantiers/Docs : tuile 34 + 2 lignes + statut. */
function TabRowsSkeleton() {
  const { colors } = useTheme();
  return (
    <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
      {[0, 1].map((index) => (
        <SkeletonRow
          key={index}
          avatar="square"
          avatarSize={34}
          lines={2}
          trailing="pill"
          style={{
            minHeight: 58,
            borderBottomWidth: index === 0 ? 1 : 0,
            borderBottomColor: colors.lineSoft,
          }}
        />
      ))}
    </Card>
  );
}

export default function ClientDetail() {
  const { personality, colors, semantic, theme, radius, controls } = useTheme();
  const palette = useStatusBadgePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    id: string;
    edit?: string;
    tab?: string;
    noticeToken?: string;
  }>();
  const id = typeof params.id === 'string' ? params.id : '';
  // `?edit=1` : la fiche s'ouvre DIRECTEMENT sur son formulaire d'édition. Utilisé par la carte
  // « devis à transmettre » du briefing (il manque l'e-mail du client) — l'action proposée
  // atterrit sur le geste exact à faire, jamais sur un écran où il faut re-chercher le bouton.
  const editRequested = params.edit === '1';
  const contractsRequested = params.tab === 'contracts';
  const contractDeletedNoticeToken =
    typeof params.noticeToken === 'string' && params.noticeToken.length > 0
      ? params.noticeToken
      : null;

  const client = useBobClient();
  const customers = useCustomers();
  const invoices = useInvoices();
  const quotes = useQuotes();
  // A1-C13 : onglets remplis — chantiers réels du client + docs liés à SES pièces.
  const chantiers = useChantiers();
  const documents = useDocuments();
  const profile = useProfile();
  const createChantier = useCreateChantier();
  const updateCustomer = useUpdateCustomer();
  // Un contrat supprimé ailleurs revient sur la seule liste métier existante : les contrats de
  // la fiche client, dans l'onglet Infos. La destination est déterministe, même depuis un deep link.
  const [tab, setTab] = useState<TabKey>(contractsRequested ? 'infos' : 'activity');
  const [chantierCreateOpen, setChantierCreateOpen] = useState(false);
  const [chantierName, setChantierName] = useState('');
  const [chantierNotes, setChantierNotes] = useState('');
  const [chantierAddressQuery, setChantierAddressQuery] = useState('');
  const [chantierAddressLocked, setChantierAddressLocked] = useState(false);
  const [chantierError, setChantierError] = useState(false);
  const chantierAddressSearch = useSearchAddress();
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState(false);
  const [ficheToast, setFicheToast] = useState<string | null>(null);
  const [ficheToastKind, setFicheToastKind] = useState<'success' | 'notice'>('success');
  const [contractsSectionState, setContractsSectionState] =
    useState<CustomerContractsCardState>('loading');
  const scrollViewRef = useRef<ScrollView>(null);
  const contractsSectionRef = useRef<View>(null);
  const contractsHeaderRef = useRef<Text>(null);
  const settledContractNoticeToken = useRef<string | null>(null);

  // Terminologie adaptative par métier (tradeToWorksiteTerminology @bob/core) — un plombier
  // parle de « chantier », un freelance IT de « mission »… Repli neutre tant que non chargé.
  const worksiteTerm = profile.data ? tradeToWorksiteTerminology(profile.data.trade) : DEFAULT_WORKSITE_TERM;
  const worksiteParams = worksiteParamsFor(worksiteTerm);
  const chantiersModuleActive = (profile.data?.modules ?? []).some(
    (m) => m.key === 'chantiers' && m.active,
  );

  const today = localToday();
  const customer = customers.data?.find((c) => c.id === id) ?? null;
  const customerSnapshotReady = customers.data !== undefined;
  const customerBlockingError = hasBlockingAuthoritativeDataError([customers]);
  const customerStaleError = customerSnapshotReady && customers.isError;
  const customerFresh = customerSnapshotReady && !customerStaleError;
  const piecesReady = invoices.data !== undefined && quotes.data !== undefined;
  const piecesBlockingError = hasBlockingAuthoritativeDataError([invoices, quotes]);
  const piecesStaleError = piecesReady && (invoices.isError || quotes.isError);
  const piecesFresh = piecesReady && !piecesStaleError;

  // Pièces réelles DU client (les vues arrivent typées du BobClient — jamais de fixtures).
  const custInvoices = useMemo(
    () => (invoices.data ?? []).filter((i) => i.customerId === id),
    [invoices.data, id],
  );
  const custQuotes = useMemo(
    () => (quotes.data ?? []).filter((q) => q.customerId === id),
    [quotes.data, id],
  );

  // Standing + montants : aucune identité/statut de secours. Sans les deux collections
  // autoritatives, l'UI affiche « — » et ferme les actions au lieu de fabriquer « nouveau / 0 € ».
  const standing = useMemo<CustomerStanding | null>(() => {
    if (customer === null || invoices.data === undefined || quotes.data === undefined) return null;
    return deriveCustomerStandings({
      customers: [customer],
      invoices: invoices.data,
      quotes: quotes.data,
      today,
    })[0] ?? null;
  }, [customer, invoices.data, quotes.data, today]);

  // Relances : le MÊME moteur que la carte C10 (deriveTodayPriorities) — la CTA sticky
  // et les jours de retard des rangées citent le doc réel, trié retard puis montant.
  const relances = useMemo<RelancePriority[]>(() => {
    if (!customer || !invoices.data || !quotes.data) return [];
    return deriveTodayPriorities({
      invoices: custInvoices,
      quotes: custQuotes,
      // L'e-mail est transporté tel quel : le moteur en a besoin pour d'autres priorités
      // (« devis à transmettre ») et ne doit jamais recevoir une projection amputée.
      customers: [{ id: customer.id, name: customer.name, email: customer.email }],
      today,
    }).filter((p): p is RelancePriority => p.kind === 'relance');
  }, [customer, invoices.data, quotes.data, custInvoices, custQuotes, today]);
  const daysLateByInvoice = useMemo(
    () => new Map(relances.map((r) => [r.invoiceId, r.daysLate])),
    [relances],
  );

  // Coordonnées et métriques qualifiées. `null` reste « inconnu », jamais transformé en zéro.
  const siren = customer?.siren ?? null;
  const siret = customer?.siret ?? null;
  const tvaIntracom = customer?.tvaIntracom ?? null;
  const email = customer?.email ?? null;
  const phone = customer?.phone ?? null;
  const avgDelayDays = customer?.avgDelayDays ?? null;

  // Chantiers DU client (module vertical BTP) — rangées réelles, aucun détail fantôme.
  const custChantiers = useMemo(
    () => chantiers.data?.filter((c) => c.customerId === id) ?? [],
    [chantiers.data, id],
  );
  const agentContext = useMemo<AgentContext>(
    () => {
      const contextReady = customer !== null && customerFresh && piecesFresh;
      return {
        screen: { name: '/client/[id]', instanceId: `customer:${id}` },
        entities: contextReady
          ? [
              { type: 'customer' as const, id: customer.id, label: customer.name },
              ...custInvoices.slice(0, 8).map((invoice) => ({
                type: 'invoice' as const,
                id: invoice.id,
                label: invoice.number ? `Facture ${invoice.number}` : 'Facture brouillon',
              })),
              ...custQuotes.slice(0, 8).map((quote) => ({
                type: 'quote' as const,
                id: quote.id,
                label: quote.number ? `Devis ${quote.number}` : 'Devis brouillon',
              })),
            ]
          : [],
        capabilities: contextReady
          ? ['screen.read', 'customer.read', 'invoice.read', 'quote.read']
          : [],
      };
    },
    [custInvoices, custQuotes, customer, customerFresh, id, piecesFresh],
  );
  const agentLayout = useMemo<AgentAccessLayout>(() => ({ bottomAvoidance: 78 }), []);
  usePublishAgentContext(agentContext, agentLayout);
  /**
   * U1-e §3 — SECOND HÔTE du run Jarvis. La fiche est la surface cataloguée de
   * `client-modifier@1`, le seul écran qui possède l'« avant », et elle n'a AUCUNE garde
   * d'entitlement : une proposition de modification y reste visible même quand l'onglet assistant
   * est fermé par l'abonnement. Le run découvert est le même (même clé de query, même registre de
   * `commandId`) : monter la carte dans les deux hôtes est idempotent, jamais deux commandes.
   */
  const jarvis = useJarvisRunFrame();
  /**
   * U1-f §3 — LE GESTE D'OUVERTURE. La fiche est la surface cataloguée de `client-modifier@1` :
   * c'est ici que l'artisan demande à Bob de modifier ce qu'il a sous les yeux. Le reçu déclenche
   * `jarvis.refresh()`, et la carte apparaît EN PLACE — aucune navigation, aucune perte de
   * contexte. [DÉCISION D1] Aucun gate d'entitlement : l'artisan modifie sa fiche à la main sans
   * abonnement, Bob qui l'assiste sur la MÊME surface suit la même règle (parité humain↔Bob).
   */
  const jarvisOpen = useJarvisOpenRun({ client, onOpened: jarvis.refresh });
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: 150 });

  // Docs DU client = documents du coffre liés à SES pièces (factures, devis, chantiers).
  const custDocs = useMemo(() => {
    if (
      documents.data === undefined
      || invoices.data === undefined
      || quotes.data === undefined
      || chantiers.data === undefined
    ) return [];
    const invoiceIds = new Set(custInvoices.map((i) => i.id));
    const quoteIds = new Set(custQuotes.map((q) => q.id));
    const chantierIds = new Set(custChantiers.map((c) => c.id));
    return documents.data
      .filter(
        (d) =>
          d.linkedEntityId !== null &&
          ((d.linkedEntityType === 'invoice' && invoiceIds.has(d.linkedEntityId)) ||
            (d.linkedEntityType === 'quote' && quoteIds.has(d.linkedEntityId)) ||
            (d.linkedEntityType === 'chantier' && chantierIds.has(d.linkedEntityId))),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [chantiers.data, documents.data, invoices.data, quotes.data, custInvoices, custQuotes, custChantiers]);

  // Ouverture d'un document = même chemin que le coffre C14 (URL signée → viewer système).
  const openDocument = async (docId: string): Promise<void> => {
    const r = await client.documentDownloadUrl(docId);
    if (r.ok) await Linking.openURL(r.value.url);
  };

  // Coordonnées réelles (onglet Infos) — chaque rangée n'existe que si la donnée existe.
  const infoRows = useMemo(() => {
    if (!customer) return [] as { key: I18nKey; value: string }[];
    return [
      { key: 'fiche.infoType' as I18nKey, value: t(TYPE_KEY[customer.type], { personality }) },
      ...(siret
        ? [{ key: 'auth.companySiretLabel' as I18nKey, value: formatSiret(siret) }]
        : []),
      ...(siren ? [{ key: 'fiche.infoSiren' as I18nKey, value: formatSiren(siren) }] : []),
      ...(tvaIntracom
        ? [{ key: 'auth.companyTvaLabel' as I18nKey, value: tvaIntracom }]
        : []),
      ...(customer.contactName
        ? [{ key: 'clients.createContactNameLabel' as I18nKey, value: customer.contactName }]
        : []),
      ...(email ? [{ key: 'fiche.infoEmail' as I18nKey, value: email }] : []),
      ...(phone ? [{ key: 'fiche.infoPhone' as I18nKey, value: phone }] : []),
      ...(customer.address.line1
        ? [{ key: 'clients.createAddressLabel' as I18nKey, value: `${customer.address.line1}, ${customer.address.zip} ${customer.address.city}` }]
        : []),
      ...(avgDelayDays !== null
        ? [
            {
              key: 'fiche.infoDelay' as I18nKey,
              value: t('fiche.infoDelayDays', { personality, params: { days: avgDelayDays } }),
            },
          ]
        : []),
    ];
  }, [customer, siret, siren, tvaIntracom, email, phone, avgDelayDays, personality]);

  // Préremplissage de l'édition (fiche.editCta) — prénom/nom reconstitués depuis `name` (le
  // domaine n'a qu'un seul champ, cf. chaîne complète C13/C40 TODO partagé) : premier mot =
  // prénom, reste = nom (repli honnête, l'utilisateur corrige si besoin).
  const customerFormInitial = useMemo<CustomerFormInitial | undefined>(() => {
    if (!customer) return undefined;
    const [firstWord, ...rest] = customer.name.trim().split(/\s+/);
    const hasStructuredAddress = customer.address.line1 !== '' || customer.address.city !== '';
    return {
      type: customer.type,
      firstName: customer.type === 'b2c' ? (firstWord ?? '') : '',
      lastName: customer.type === 'b2c' ? rest.join(' ') : '',
      companyName: customer.type === 'b2c' ? '' : customer.name,
      siren: siren,
      siret,
      tvaIntracom,
      contactName: customer.contactName ?? '',
      email: email ?? '',
      phone: phone ?? '',
      address: hasStructuredAddress ? customer.address : null,
      addressLabel: hasStructuredAddress
        ? `${customer.address.line1}, ${customer.address.zip} ${customer.address.city}`
        : '',
    };
  }, [customer, siren, siret, tvaIntracom, email, phone]);

  // Ouverture du chantier/projet : adresse PRÉ-REMPLIE depuis la fiche client (arbitrage fondateur).
  const openChantierCreate = (): void => {
    if (!customerFresh || !chantiersFresh || !chantiersModuleActive) return;
    setChantierName('');
    setChantierNotes('');
    setChantierError(false);
    const prefill = customer?.address.line1
      ? `${customer.address.line1}, ${customer.address.zip} ${customer.address.city}`
      : '';
    setChantierAddressQuery(prefill);
    setChantierAddressLocked(prefill !== '');
    chantierAddressSearch.reset();
    setChantierCreateOpen(true);
  };
  const closeChantierCreate = (): void => setChantierCreateOpen(false);

  useEffect(() => {
    if (!chantierCreateOpen) return;
    const query = chantierAddressQuery.trim();
    if (query.length < 3 || chantierAddressLocked) {
      chantierAddressSearch.reset();
      return;
    }
    const timeout = setTimeout(() => chantierAddressSearch.mutate(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [chantierAddressQuery, chantierAddressLocked, chantierCreateOpen]);

  const submitChantierCreate = (): void => {
    const trimmedName = chantierName.trim();
    if (!trimmedName || createChantier.isPending || !customerFresh || !chantiersFresh) return;
    setChantierError(false);
    createChantier.mutate(
      {
        name: trimmedName,
        customerId: id,
        address: chantierAddressQuery.trim() || null,
        notes: chantierNotes.trim() || null,
      },
      {
        onSuccess: () => {
          setChantierCreateOpen(false);
          setFicheToastKind('success');
          setFicheToast(
            t('fiche.chantierCreatedToast', { personality, params: { ...worksiteParams, name: trimmedName } }),
          );
        },
        onError: () => setChantierError(true),
      },
    );
  };

  const submitEdit = (payload: UpdateCustomerClientInput): void => {
    if (!customerFresh || customer === null) return;
    setEditError(false);
    // Remplacement complet SANS PERTE (B4/B6) : le formulaire général ne connaît ni les
    // conditions de paiement, ni le canal, ni les faits fiscaux — ils repartent tels quels.
    const preserved: Partial<UpdateCustomerClientInput> = {
      ...(customer.paymentTermsLabel != null ? { paymentTermsLabel: customer.paymentTermsLabel } : {}),
      ...(customer.paymentTerms != null ? { paymentTerms: customer.paymentTerms } : {}),
      ...(customer.billingChannel != null ? { billingChannel: customer.billingChannel } : {}),
      ...(customer.isInternational === true ? { isInternational: true } : {}),
      ...(customer.isSubcontractingBtp === true ? { isSubcontractingBtp: true } : {}),
    };
    updateCustomer.mutate(
      { id, patch: { ...preserved, ...payload } },
      {
        onSuccess: () => {
          setEditOpen(false);
          setFicheToastKind('success');
          setFicheToast(t('fiche.editSuccess', { personality }));
        },
        onError: () => setEditError(true),
      },
    );
  };

  const booting =
    (!customerSnapshotReady && !customerBlockingError)
    || (!piecesReady && !piecesBlockingError);
  // Une liste en cache peut être vide au moment où son rafraîchissement échoue : ne jamais
  // transformer cet échec en « client introuvable ». Si la fiche ciblée est en cache, on la
  // conserve et on expose l'échec de rafraîchissement en ligne.
  const customerUnavailable = customerBlockingError || (customers.isError && customer === null);
  const customerRefreshFailed = customerStaleError && customer !== null;
  const docsUnavailable = !piecesReady;
  const hasDocsError = piecesBlockingError || piecesStaleError;
  const chantiersReady = chantiers.data !== undefined && profile.data !== undefined;
  const chantiersBlockingError = hasBlockingAuthoritativeDataError([chantiers, profile]);
  const chantiersStaleError =
    chantiersReady && (chantiers.isError || profile.isError);
  const chantiersFresh = chantiersReady && !chantiersStaleError;
  const relatedDocumentsReady =
    documents.data !== undefined
    && invoices.data !== undefined
    && quotes.data !== undefined
    && chantiers.data !== undefined;
  const relatedDocumentsBlockingError = hasBlockingAuthoritativeDataError([
    documents,
    invoices,
    quotes,
    chantiers,
  ]);
  const relatedDocumentsStaleError =
    relatedDocumentsReady
    && (documents.isError || invoices.isError || quotes.isError || chantiers.isError);
  const refreshing =
    customers.isRefetching ||
    invoices.isRefetching ||
    quotes.isRefetching ||
    chantiers.isRefetching ||
    documents.isRefetching ||
    profile.isRefetching;

  const retryPieces = (): void => {
    void Promise.all([invoices.refetch(), quotes.refetch()]);
  };

  const refreshAll = (): void => {
    void Promise.all([
      customers.refetch(),
      invoices.refetch(),
      quotes.refetch(),
      chantiers.refetch(),
      documents.refetch(),
      profile.refetch(),
    ]);
  };

  useEffect(() => {
    if (!customerFresh) setEditOpen(false);
    if (!customerFresh || !chantiersFresh) setChantierCreateOpen(false);
  }, [chantiersFresh, customerFresh]);

  // Ouverture demandée par `?edit=1` — UNE SEULE fois, et seulement une fois la fiche
  // autoritative chargée (jamais un formulaire préremplissable par un état de secours).
  // Le drapeau consommé n'est jamais réarmé : refermer la feuille la laisse fermée.
  const editRequestConsumed = useRef(false);
  useEffect(() => {
    if (!editRequested || editRequestConsumed.current) return;
    if (!customerFresh || customer === null) return;
    editRequestConsumed.current = true;
    setEditOpen(true);
  }, [editRequested, customerFresh, customer]);

  // Le message terminal d'un contrat supprimé appartient à CET écran, une fois sa section
  // Contrats réellement rendue. Le token éphémère est lié au client et consommable une fois :
  // un deep link forgé ou une restauration après redémarrage n'affiche rien.
  useEffect(() => {
    if (
      contractDeletedNoticeToken === null
      || contractsSectionState === 'loading'
      || settledContractNoticeToken.current === contractDeletedNoticeToken
    ) {
      return;
    }
    settledContractNoticeToken.current = contractDeletedNoticeToken;
    const notice = consumeContractDeletedNotice(contractDeletedNoticeToken, id);
    router.setParams({ noticeToken: undefined });
    if (notice === null) return;

    const deliver = (): void => {
      const headerHandle = findNodeHandle(contractsHeaderRef.current);
      if (headerHandle !== null) AccessibilityInfo.setAccessibilityFocus(headerHandle);
      setFicheToastKind('notice');
      setFicheToast(
        t(
          contractsSectionState === 'error'
            ? 'fiche.contractDeletedListErrorToast'
            : 'fiche.contractDeletedToast',
          { personality },
        ),
      );
    };
    const section = contractsSectionRef.current;
    const scrollNode = scrollViewRef.current?.getNativeScrollRef() ?? null;
    if (section === null || scrollNode === null) {
      deliver();
      return;
    }
    section.measureLayout(
      scrollNode,
      (_left, top) => {
        scrollViewRef.current?.scrollTo({ y: Math.max(0, top - 16), animated: false });
        deliver();
      },
      deliver,
    );
  }, [
    contractDeletedNoticeToken,
    contractsSectionState,
    id,
    personality,
    router,
  ]);

  // KPI dérivés : encours = standing (retard/attente = dû réel) · CA 12 mois = @bob/core.
  const outstandingCents =
    standing !== null && (standing.kind === 'en_retard' || standing.kind === 'en_attente')
      ? standing.amountCents
      : standing === null
        ? null
        : 0;
  // Fil rouge « couleur de l'argent » (Lot 4) : LA palette du standing — le MÊME token du
  // carnet (ClientRow tone) au héros (MoneyText) au geste (liseré StickyActionBar).
  // danger = dangerVivid (le token de ClientRow/KpiTile), neutral = slate500.
  const standingPalette = {
    success: semantic.success,
    warning: semantic.warning,
    danger: semantic.dangerVivid,
    neutral: colors.slate500,
  } as const;
  const outstandingColor =
    standing === null ? colors.slate300 : standingAccentColor(standing.kind, standingPalette);
  const revenue12m =
    invoices.data !== undefined ? revenueLast12MonthsCents(custInvoices, today) : null;

  // Conformité e-invoicing : canal par type (règle @bob/core), copy dédiée par canal ;
  // b2b/b2g sans SIREN = état honnête « à compléter » (jamais un « tout est prêt » inventé).
  const channel: EinvoiceChannel | null = customer === null ? null : einvoiceChannelFor(customer.type);
  const sirenReady = siren !== null;
  const compliance =
    channel === null
      ? null
      : channel === 'pa'
      ? {
          title: 'fiche.compliTitlePa' as I18nKey,
          body: (sirenReady ? 'fiche.compliBodyPa' : 'fiche.compliSirenMissing') as I18nKey,
          tone: (sirenReady ? 'success' : 'danger') as StatusBadgeVariant,
        }
      : channel === 'chorus_pro'
        ? {
            title: 'fiche.compliTitleB2g' as I18nKey,
            body: (sirenReady ? 'fiche.compliBodyB2g' : 'fiche.compliSirenMissing') as I18nKey,
            tone: (sirenReady ? 'b2g' : 'danger') as StatusBadgeVariant,
          }
        : {
            title: 'fiche.compliTitleB2c' as I18nKey,
            body: 'fiche.compliBodyB2c' as I18nKey,
            tone: 'success' as StatusBadgeVariant,
          };

  // Activité : pièces réelles projetées (type, numéro, date, note statut, montant teinté), tri date desc.
  const activity = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [];
    for (const inv of custInvoices) {
      if (inv.status === 'draft' || inv.status === 'cancelled') continue;
      const daysLate = daysLateByInvoice.get(inv.id) ?? 0;
      const overdue = daysLate > 0 || inv.status === 'late';
      const note =
        inv.status === 'paid'
          ? t('fiche.statusPaid', { personality })
          : overdue
            ? daysLate > 0
              ? t('fiche.statusLate', { personality, params: { days: daysLate } })
              : t('fiche.statusLateBare', { personality })
            : inv.status === 'partially_paid'
              ? t('fiche.statusPartial', { personality })
              : t('fiche.statusIssued', { personality });
      const signedCents = inv.kind === 'credit_note' ? -inv.totals.netToPay : inv.totals.netToPay;
      items.push({
        href: `/facture/${inv.id}` as const,
        key: `invoice-${inv.id}`,
        title: `${t(DOC_LABEL[inv.kind], { personality })}${inv.number ? ` ${inv.number}` : ''}`,
        date: inv.dueAt,
        note,
        amountCents: signedCents,
        amountColor:
          inv.kind === 'credit_note'
            ? colors.slate500
            : inv.status === 'paid'
              ? semantic.success
              : overdue
                ? semantic.danger
                : semantic.warning,
        iconTone: 'b2b',
      });
    }
    for (const quote of custQuotes) {
      if (quote.status === 'draft') continue;
      const note: I18nKey =
        quote.status === 'signed'
          ? 'fiche.statusQuoteSigned'
          : quote.status === 'refused'
            ? 'fiche.statusQuoteRefused'
            : quote.status === 'expired'
              ? 'fiche.statusQuoteExpired'
              : 'fiche.statusQuotePending';
      items.push({
        href: `/devis/${quote.id}` as const,
        key: `quote-${quote.id}`,
        title: `${t('fiche.docQuote', { personality })}${quote.number ? ` ${quote.number}` : ''}`,
        // La date d'ÉVÉNEMENT (établissement) — pas la fin de validité, qui se lisait comme
        // une date de signature (« 2 sept. · Signé » pour un devis signé le 3 août).
        date: quote.issuedAt ?? quote.validUntil,
        note: t(note, { personality }),
        amountCents: quote.totals.ttc,
        amountColor:
          quote.status === 'signed'
            ? semantic.success
            : quote.status === 'refused' || quote.status === 'expired'
              ? colors.slate400
              : semantic.warning,
        iconTone: 'particulier',
      });
    }
    // Tri par date décroissante, pièces sans date en fin (jamais une date inventée).
    return items.sort((a, b) => {
      if (a.date === null) return b.date === null ? 0 : 1;
      if (b.date === null) return -1;
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
  }, [custInvoices, custQuotes, daysLateByInvoice, personality, colors, semantic]);

  // CTA sticky contextuelle par standing (contrat C13) : en retard → « Relancer {doc} ·
  // {montant} » (le doc vient du moteur C10) · devis en attente → « Relancer le devis » —
  // les deux vers /(tabs)/assistant (parité Bob) · à jour / en attente (échéance non
  // dépassée : on ne relance pas) / nouveau → « Nouveau devis » → /devis/new.
  const topRelance = relances[0];
  const cta =
    standing === null
      ? null
      : standing.kind === 'en_retard'
      ? {
          label:
            topRelance && topRelance.docNumber !== null
              ? t('fiche.ctaRelanceDoc', {
                  personality,
                  params: {
                    doc: topRelance.docNumber,
                    amount: formatEURWhole(topRelance.amountCents),
                  },
                })
              : t('fiche.ctaRelanceAmount', {
                  personality,
                  params: { amount: formatEURWhole(standing.amountCents) },
                }),
          // ?prompt=relance : l'assistant pré-remplit ET soumet la demande (C15).
          onPress: () =>
            router.push({ pathname: '/(tabs)/assistant', params: { prompt: 'relance' } }),
        }
      : standing.kind === 'devis'
        ? {
            label: t('fiche.ctaRelanceQuote', { personality }),
            // relance de devis = renvoi au client (envoyer_devis) — même use case que Bob.
            onPress: () =>
              router.push({ pathname: '/(tabs)/assistant', params: { prompt: 'relance_devis' } }),
          }
        : {
            label: t('fiche.ctaNewQuote', { personality }),
            onPress: () => router.push('/devis/new'),
          };

  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/clients');
  };

  /** Lien device (tel:/mailto:) — l'échec remonte à la voix de Bob, jamais silencieux. */
  const openLink = (url: string): void => {
    void Linking.openURL(url).catch(() => Alert.alert(t('fiche.linkError', { personality })));
  };

  const tabOptions = TAB_KEYS.map((key) => ({
    key,
    label: t(TAB_LABEL[key], { personality, params: key === 'chantiers' ? worksiteParams : undefined }),
  }));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        ref={scrollViewRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        accessibilityState={{ busy: refreshing }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshAll}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        {/* ── Barre retour + menu « … » ─────────────────────────────────────── */}
        <View
          style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 18,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('fiche.back', { personality })}
            onPress={goBack}
            hitSlop={8}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 44 }}
          >
            <ChevronLeftIcon color={colors.ink800} />
            <Text style={[font('body', 600), { color: colors.ink800 }]}>
              {t('fiche.back', { personality })}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('fiche.editCta', { personality })}
            accessibilityState={{ disabled: !customerFresh || customer === null }}
            disabled={!customerFresh || customer === null}
            onPress={() => {
              if (customerFresh && customer !== null) setEditOpen(true);
            }}
            hitSlop={8}
            style={({ pressed }) => [
              {
                width: 44,
                height: 44,
                borderRadius: radius.pill,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: controls.cardBorder,
                alignItems: 'center',
                justifyContent: 'center',
                ...shadowNative.e1,
              },
              !customerFresh || customer === null ? { opacity: 0.45 } : null,
              pressed && customerFresh && customer !== null ? { transform: [{ scale: 0.94 }] } : null,
            ]}
          >
            {/* Lot 4 : le « … » muet devient un crayon qui dit ce qu'il fait — annoncé
                « Modifier » (fiche.editCta, déjà porté par le label) ET dessiné crayon. */}
            <PencilIcon color={colors.ink600} />
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: 18, paddingTop: 16, gap: 14 }}>
          {customerUnavailable ? (
            // Le carnet ne répond pas : relance sur place + sortie secondaire, sans perdre le contexte par défaut.
            <ErrorRetry
              message={t('fiche.dataError', { personality })}
              onRetry={() => void customers.refetch()}
              retrying={customers.isRefetching}
              secondaryLabel={t('fiche.backToClients', { personality })}
              onSecondaryAction={goBack}
            />
          ) : booting ? (
            // Skeletons — même gabarit que la fiche chargée (états du contrat C13).
            <View
              accessible
              accessibilityLabel={t('clients.title', { personality })}
              accessibilityLiveRegion="polite"
              accessibilityState={{ busy: true }}
              style={{ gap: 14 }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
                <Skeleton width={54} height={54} radius={radius.squircle} />
                <View style={{ flex: 1, gap: 8 }}>
                  <Skeleton width="62%" height={17} />
                  <Skeleton width="44%" height={12} />
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 9 }}>
                {TAB_KEYS.map((key) => (
                  <Card
                    key={key}
                    radius={16}
                    padding={13}
                    style={{ flex: 1, alignItems: 'center' }}
                  >
                    <Skeleton width={18} height={18} />
                    <View style={{ marginTop: 7 }}>
                      <Skeleton width={34} height={10} />
                    </View>
                  </Card>
                ))}
              </View>
              <View style={{ flexDirection: 'row', gap: 9 }}>
                <Card radius={16} padding={12} style={{ flex: 1 }}>
                  <Skeleton width="70%" height={11} />
                  <View style={{ marginTop: 8 }}>
                    <Skeleton width="55%" height={16} />
                  </View>
                </Card>
                <Card radius={16} padding={12} style={{ flex: 1 }}>
                  <Skeleton width="70%" height={11} />
                  <View style={{ marginTop: 8 }}>
                    <Skeleton width="55%" height={16} />
                  </View>
                </Card>
                <Card radius={16} padding={12} style={{ flex: 1 }}>
                  <Skeleton width="70%" height={11} />
                  <View style={{ marginTop: 8 }}>
                    <Skeleton width="55%" height={16} />
                  </View>
                </Card>
              </View>
              <Card radius={18} padding={16}>
                <Skeleton width="45%" height={15} />
                <View style={{ marginTop: 12 }}>
                  <Skeleton width="100%" height={8} />
                </View>
                <View style={{ marginTop: 10 }}>
                  <Skeleton width="58%" height={11} />
                </View>
              </Card>
            </View>
          ) : customer === null ? (
            // Client introuvable (id inconnu / supprimé) : message + retour.
            <Card radius={18} padding={18}>
              <EmptyState
                body={t('fiche.notFound', { personality })}
                cta={{
                  label: t('fiche.backToClients', { personality }),
                  onPress: goBack,
                }}
              />
            </Card>
          ) : (
            <>
              {/* ── Héros BobSurface marine (Lot 4, parité fiche équipement/contrat) :
                   avatar + nom en pageTitle + partyLine ADAPTATIF (b2c : rien), puis
                   l'ENCOURS en MoneyText moneyHero teinté par le standing — le fil rouge
                   « couleur de l'argent » au niveau fiche. ── */}
              <BobSurface tone="marine" emphasis="raised">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
                  <Avatar name={customer.name} size={54} tone={TONE_BY_TYPE[customer.type]} />
                  <View style={{ flex: 1 }}>
                    <Text
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.6}
                      style={[font('pageTitle'), { color: colors.ink900 }]}
                    >
                      {customer.name}
                    </Text>
                    {customer.type !== 'b2c' ? (
                      <View
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 }}
                      >
                        <StatusBadge
                          label={t(customer.type === 'b2b' ? 'fiche.badgeB2b' : 'fiche.badgeB2g', {
                            personality,
                          })}
                          variant={TONE_BY_TYPE[customer.type]}
                        />
                        {siren !== null ? (
                          <Text style={[font('meta'), { fontSize: 11.5, color: colors.slate400 }]}>
                            {t('fiche.sirenLabel', {
                              personality,
                              params: { siren: formatSiren(siren) },
                            })}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                </View>
                <View style={{ marginTop: 14 }}>
                  <Text style={[font('meta'), { color: colors.slate500 }]}>
                    {t('fiche.kpiOutstanding', { personality })}
                  </Text>
                  {outstandingCents === null ? (
                    <Text
                      style={[
                        font('bigNum'),
                        { color: colors.slate300, fontVariant: ['tabular-nums'], marginTop: 2 },
                      ]}
                    >
                      —
                    </Text>
                  ) : (
                    <View style={{ marginTop: 2 }}>
                      <MoneyText cents={outstandingCents} variant="moneyHero" whole color={outstandingColor} />
                    </View>
                  )}
                </View>
              </BobSurface>

              {/* ── Proposition de Bob sur CETTE fiche (run Jarvis `customer_contact@1`,
                   U1-e §3) : ancrée AVANT les gestes manuels concurrents — on voit ce que Bob
                   propose avant de refaire la même chose à la main. Gate stricte : seule une
                   MODIFICATION visant cet id s'affiche ici (jarvisFrameTargetsCustomer). ── */}
              {jarvis.state.phase === 'ready' &&
              jarvisFrameTargetsCustomer(jarvis.state.frame, id) ? (
                <JarvisConfirmationCard
                  frame={jarvis.state.frame}
                  coordinator={jarvis.coordinator}
                  ports={jarvis.state.ports}
                  onAuthoritativeRefresh={jarvis.refresh}
                />
              ) : null}

              {/* ── 4 actions rapides — QuickAction kit (Lot 4 ; parité humain ↔ Bob ;
                   tel:/mailto: = device). Tones : devis b2b (même canal que la Home),
                   relance ai (c'est Bob qui agit — l'indigo est SON canal), appel success,
                   email warning — pastilles distinctes, icônes teintées comme la Home. ── */}
              <View style={{ flexDirection: 'row', gap: 9 }}>
                {jarvisOpen.supported ? (
                  <QuickAction
                    style={{ flex: 1 }}
                    label={t('fiche.actionBobEdit', { personality })}
                    tone="ai"
                    icon={<PencilIcon color={semantic.ai} size={18} />}
                    // Même gate d'écriture que les autres gestes : sur une fiche qu'on n'a pas
                    // pu relire, on ne demande à personne de la modifier.
                    disabled={!customerFresh || jarvisOpen.state.kind === 'opening'}
                    onPress={() => jarvisOpen.open(id)}
                  />
                ) : null}
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('fiche.actionQuote', { personality })}
                  tone="b2b"
                  icon={<FileTextIcon color={semantic.b2b} size={18} />}
                  disabled={!customerFresh}
                  onPress={() => router.push('/devis/new')}
                />
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('fiche.actionRelance', { personality })}
                  tone="ai"
                  icon={<SendIcon color={semantic.ai} size={18} />}
                  disabled={!customerFresh || !piecesFresh}
                  onPress={() =>
                    router.push({ pathname: '/(tabs)/assistant', params: { prompt: 'relance' } })
                  }
                />
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('fiche.actionCall', { personality })}
                  tone="success"
                  icon={<PhoneIcon color={semantic.success} size={18} />}
                  disabled={phone === null || !customerFresh}
                  {...(phone !== null
                    ? { onPress: () => openLink(`tel:${phone.replace(/[^+\d]/g, '')}`) }
                    : {})}
                />
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('fiche.actionEmail', { personality })}
                  tone="warning"
                  icon={<MailIcon color={semantic.warning} size={18} />}
                  disabled={email === null || !customerFresh}
                  {...(email !== null ? { onPress: () => openLink(`mailto:${email}`) } : {})}
                />
              </View>

              {jarvisOpen.state.kind === 'busy' || jarvisOpen.state.kind === 'failed' ? (
                <View accessibilityLiveRegion="polite" style={{ marginTop: 9 }}>
                  <ErrorRetry
                    message={
                      jarvisOpen.state.kind === 'busy'
                        ? t('fiche.bobEditBusy', { personality })
                        : t('fiche.bobEditFailed', { personality })
                    }
                    onRetry={() =>
                      jarvisOpen.state.kind === 'busy' ? jarvisOpen.dismiss() : jarvisOpen.open(id)
                    }
                  />
                </View>
              ) : null}

              {customerRefreshFailed ? (
                <ErrorRetry
                  message={t('fiche.dataError', { personality })}
                  onRetry={() => void customers.refetch()}
                  retrying={customers.isRefetching}
                />
              ) : null}

              {hasDocsError ? (
                // Les pièces ne répondent pas : la fiche reste utile, mais l'échec n'est jamais présenté comme du vide.
                <ErrorRetry
                  message={t('fiche.dataError', { personality })}
                  onRetry={retryPieces}
                  retrying={invoices.isRefetching || quotes.isRefetching}
                />
              ) : null}

              {/* ── KPI (KpiTile kit, Lot 4) : Délai moyen · CA 12 mois — l'encours vit
                   désormais dans le héros (MoneyText teinté par le standing), même
                   information, aucun doublon. Donnée absente = « — », jamais un zéro. ── */}
              <View style={{ flexDirection: 'row', gap: 9 }}>
                <KpiTile
                  style={{ flex: 1 }}
                  label={t('fiche.kpiAvgDelay', { personality })}
                  {...(avgDelayDays !== null
                    ? {
                        valueText: t('fiche.kpiDays', {
                          personality,
                          params: { days: avgDelayDays },
                        }),
                      }
                    : {})}
                />
                <KpiTile
                  style={{ flex: 1 }}
                  label={t('fiche.kpiRevenue12m', { personality })}
                  {...(revenue12m !== null ? { amountCents: revenue12m } : {})}
                />
              </View>

              {/* ── Historique de paiement qualifié — aucun score sans modèle ratifié ── */}
              <Card radius={18} padding={16} elevation="e2">
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                  }}
                >
                  <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink800 }]}>
                    {t('fiche.paymentHistoryTitle', { personality })}
                  </Text>
                  <StatusBadge
                    label={
                      customer.paymentHistoryStatus === 'known' && customer.paidOnTimeRatio !== null
                        ? t('fiche.paymentHistoryKnownBadge', { personality })
                        : t('fiche.paymentHistoryPendingBadge', { personality })
                    }
                    variant={
                      customer.paymentHistoryStatus === 'known' && customer.paidOnTimeRatio !== null
                        ? 'success'
                        : 'particulier'
                    }
                  />
                </View>
                <Text
                  style={[font('meta'), { fontSize: 12, color: colors.slate400, lineHeight: 17, marginTop: 9 }]}
                >
                  {customer.paymentHistoryStatus === 'known' && customer.paidOnTimeRatio !== null
                    ? t('fiche.paymentHistoryKnown', {
                        personality,
                        params: {
                          count: customer.settledInvoiceCount,
                          ratio: Math.round(customer.paidOnTimeRatio * 100),
                        },
                      })
                    : customer.paymentHistoryStatus === 'incomplete'
                      ? t('fiche.paymentHistoryIncomplete', { personality })
                      : t('fiche.paymentHistoryInsufficient', {
                          personality,
                          params: { count: customer.settledInvoiceCount },
                        })}
                </Text>
              </Card>

              {/* ── Conformité e-invoicing (canal einvoiceChannelFor @bob/core) ── */}
              {compliance !== null ? <Card radius={18} padding={15}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <IconTile tone={compliance.tone} size={34} radius={11}>
                    <ShieldIcon color={statusBadgeColors(compliance.tone, palette).fg} size={16} />
                  </IconTile>
                  <View style={{ flex: 1 }}>
                    <Text style={[font('sub', 700), { fontSize: 14, color: colors.ink800 }]}>
                      {t(compliance.title, { personality })}
                    </Text>
                    <Text
                      style={[
                        font('meta'),
                        { fontSize: 11.5, color: colors.slate400, lineHeight: 16, marginTop: 3 },
                      ]}
                    >
                      {t(compliance.body, { personality })}
                    </Text>
                  </View>
                </View>
              </Card> : null}

              {/* ── Onglets Activité / Chantiers / Docs / Infos ── */}
              <SegmentedControl
                options={tabOptions}
                value={tab}
                onChange={setTab}
                accessibilityLabel={t('fiche.tabActivity', { personality })}
              />

              {/* Lot 4 : FadeIn au changement d'onglet (remonté via key) — fail-closed
                  hérité de useReduceMotion : préférence non résolue = bascule sèche. */}
              <FadeIn key={tab} index={0}>
              {tab === 'activity' ? (
                docsUnavailable ? null /* erreur : la carte fiche.dataError ci-dessus parle déjà */ : activity.length ===
                  0 ? (
                  // 0 pièce : état vide de premier rang — la voix de Bob, aucune rangée fantôme.
                  <Card>
                    <EmptyState body={t('fiche.activityEmpty', { personality })} />
                  </Card>
                ) : (
                  <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
                    {activity.map((item, index) => (
                      <ActivityRow
                        key={item.key}
                        item={item}
                        divider={index < activity.length - 1}
                        onPress={() => router.push(item.href)}
                      />
                    ))}
                  </Card>
                )
              ) : tab === 'chantiers' ? (
                !chantiersReady && !chantiersBlockingError ? (
                  <TabRowsSkeleton />
                ) : chantiersBlockingError ? (
                  <ErrorRetry
                    message={t('fiche.dataError', { personality })}
                    onRetry={() => {
                      void chantiers.refetch();
                      void profile.refetch();
                    }}
                    retrying={chantiers.isRefetching || profile.isRefetching}
                  />
                ) : !chantiersReady ? null : !chantiersModuleActive ? (
                  <View style={{ gap: 10 }}>
                    {chantiersStaleError ? (
                      <ErrorRetry
                        message={t('fiche.dataError', { personality })}
                        onRetry={() => {
                          void chantiers.refetch();
                          void profile.refetch();
                        }}
                        retrying={chantiers.isRefetching || profile.isRefetching}
                      />
                    ) : null}
                    <Card>
                      <EmptyState
                        title={t('chantiers.moduleTitle', { personality, params: worksiteParams })}
                        body={t('chantiers.moduleBody', { personality, params: worksiteParams })}
                        cta={
                          chantiersFresh
                            ? {
                                label: t('chantiers.seePlans', { personality }),
                                onPress: () => router.push('/compte'),
                              }
                            : undefined
                        }
                      />
                    </Card>
                  </View>
                ) : (
                  <View style={{ gap: 10 }}>
                    {chantiersStaleError ? (
                      <ErrorRetry
                        message={t('fiche.dataError', { personality })}
                        onRetry={() => {
                          void chantiers.refetch();
                          void profile.refetch();
                        }}
                        retrying={chantiers.isRefetching || profile.isRefetching}
                      />
                    ) : null}
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 10,
                      }}
                    >
                      <Text style={[font('label', 700), { fontSize: 13, color: colors.slate500 }]}>
                        {t('fiche.chantierSectionTitle', { personality, params: worksiteParams })}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('fiche.chantierAddLabel', { personality, params: worksiteParams })}
                        accessibilityState={{ disabled: !chantiersFresh || !customerFresh }}
                        disabled={!chantiersFresh || !customerFresh}
                        onPress={openChantierCreate}
                        hitSlop={8}
                        style={({ pressed }) => [
                          {
                            width: 44,
                            height: 44,
                            borderRadius: 22,
                            backgroundColor: theme.ink,
                            alignItems: 'center',
                            justifyContent: 'center',
                            ...shadowNative.e1,
                          },
                          !chantiersFresh || !customerFresh ? { opacity: 0.45 } : null,
                          pressed && chantiersFresh && customerFresh ? { transform: [{ scale: 0.94 }] } : null,
                        ]}
                      >
                        <PlusIcon color={colors.surface} size={18} />
                      </Pressable>
                    </View>
                    {custChantiers.length === 0 ? (
                      <Card>
                        <EmptyState
                          body={t('fiche.chantiersEmpty', { personality, params: worksiteParams })}
                          cta={
                            chantiersFresh && customerFresh
                              ? {
                                  label: t('fiche.chantiersEmptyCta', { personality, params: worksiteParams }),
                                  onPress: openChantierCreate,
                                }
                              : undefined
                          }
                        />
                      </Card>
                    ) : (
                  <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
                    {custChantiers.map((chantier, index) => (
                      <Pressable
                        key={chantier.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${chantier.name}, ${t(
                          chantier.status === 'open' ? 'fiche.chantierOpen' : 'fiche.chantierClosed',
                          { personality },
                        )}`}
                        onPress={() => router.push(`/chantier/${chantier.id}`)}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 11,
                          minHeight: 44,
                          paddingVertical: 12,
                          borderBottomWidth: index < custChantiers.length - 1 ? 1 : 0,
                          borderBottomColor: colors.lineSoft,
                        }}
                      >
                        <IconTile
                          tone={chantier.status === 'open' ? 'b2b' : 'success'}
                          size={34}
                          radius={10}
                        >
                          <FolderSmallIcon
                            color={chantier.status === 'open' ? semantic.b2b : semantic.success}
                          />
                        </IconTile>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}
                            numberOfLines={1}
                          >
                            {chantier.name}
                          </Text>
                          <Text
                            style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}
                            numberOfLines={1}
                          >
                            {[
                              chantier.address,
                              t('fiche.chantierOpenedOn', {
                                personality,
                                params: { date: dateLabel(chantier.openedAt) },
                              }),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </Text>
                          <ChantierRowCountBadges
                            counts={{ noteCount: chantier.noteCount, photoCount: chantier.photoCount }}
                            personality={personality}
                          />
                        </View>
                        <StatusBadge
                          label={t(
                            chantier.status === 'open'
                              ? 'fiche.chantierOpen'
                              : 'fiche.chantierClosed',
                            {
                              personality,
                            },
                          )}
                          variant={chantier.status === 'open' ? 'b2b' : 'success'}
                        />
                        <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                      </Pressable>
                    ))}
                  </Card>
                    )}
                  </View>
                )
              ) : tab === 'docs' ? (
                !relatedDocumentsReady && !relatedDocumentsBlockingError ? (
                  <TabRowsSkeleton />
                ) : relatedDocumentsBlockingError ? (
                  <ErrorRetry
                    message={t('fiche.dataError', { personality })}
                    onRetry={refreshAll}
                    retrying={refreshing}
                  />
                ) : !relatedDocumentsReady ? null : (
                  <View style={{ gap: 10 }}>
                    {relatedDocumentsStaleError ? (
                      <ErrorRetry
                        message={t('fiche.dataError', { personality })}
                        onRetry={refreshAll}
                        retrying={refreshing}
                      />
                    ) : null}
                    {custDocs.length === 0 ? (
                      <Card>
                        <EmptyState body={t(TAB_EMPTY.docs, { personality })} />
                      </Card>
                    ) : (
                      <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
                    {custDocs.map((docItem, index) => (
                      <Pressable
                        key={docItem.id}
                        accessibilityRole="button"
                        accessibilityLabel={docItem.filename}
                        onPress={() => void openDocument(docItem.id)}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 11,
                          paddingVertical: 12,
                          borderBottomWidth: index < custDocs.length - 1 ? 1 : 0,
                          borderBottomColor: colors.lineSoft,
                        }}
                      >
                        <IconTile tone="b2b" size={34} radius={10}>
                          <FileIcon color={semantic.b2b} />
                        </IconTile>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}
                            numberOfLines={1}
                          >
                            {docItem.filename}
                          </Text>
                          <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                            {dateLabel((docItem.documentDate ?? docItem.createdAt).slice(0, 10))}
                          </Text>
                        </View>
                        <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                      </Pressable>
                    ))}
                      </Card>
                    )}
                  </View>
                )
              ) : (
                <View style={{ gap: 16 }}>
                  {infoRows.length === 0 ? (
                    <Card>
                      <EmptyState body={t(TAB_EMPTY.infos, { personality })} />
                    </Card>
                  ) : (
                    <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
                      {infoRows.map((row, index) => (
                        <View
                          key={row.key}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            paddingVertical: 12,
                            borderBottomWidth: index < infoRows.length - 1 ? 1 : 0,
                            borderBottomColor: colors.lineSoft,
                          }}
                        >
                          <Text style={[font('meta'), { color: colors.slate400 }]}>
                            {t(row.key, { personality })}
                          </Text>
                          <Text
                            style={{ ...font('sub', 600), color: colors.ink800, flexShrink: 1 }}
                            numberOfLines={1}
                          >
                            {row.value}
                          </Text>
                        </View>
                      ))}
                    </Card>
                  )}
                  {/* PR-09 — contacts multiples (demandeur, valideur, compta…) : le choix du
                      destinataire à l'envoi d'une pièce vit dans la feuille d'envoi. */}
                  {customer !== null && customerFresh ? (
                    <CustomerContactsCard customerId={customer.id} />
                  ) : null}
                  {/* PR-12c — contrats de maintenance du client (écrans §6.3) : badges DÉRIVÉS,
                      montant/an = Σ lignes vivante ; b2c sans CTA (périmètre V1, Chatel). */}
                  {customer !== null && customerFresh ? (
                    <View ref={contractsSectionRef} collapsable={false}>
                      <CustomerContractsCard
                        customerId={customer.id}
                        customerType={customer.type}
                        ensureVisible={contractsRequested}
                        headerRef={contractsHeaderRef}
                        onStateChange={setContractsSectionState}
                      />
                    </View>
                  ) : null}
                  {/* B4 + canal : conditions de paiement (LegalHint L441-10) et « comment ce
                      client reçoit ses factures » — visibles uniquement sur données fraîches
                      (une édition sur snapshot périmé perdrait des faits). */}
                  {customer !== null && customerFresh ? (
                    <CustomerBillingSections customer={customer} />
                  ) : null}
                </View>
              )}
              </FadeIn>
            </>
          )}
        </View>
      </ScrollView>

      {/* ── CTA sticky contextuelle par standing — StickyActionBar 'floating' (Lot 4) :
           aplat ink + liseré accent de la MÊME teinte que le standing (fil rouge
           « couleur de l'argent » au niveau du geste), apparition FadeIn fail-closed. ── */}
      {!booting && customerFresh && piecesFresh && customer !== null && cta !== null
      && standing !== null ? (
        <StickyActionBar
          variant="floating"
          label={cta.label}
          onPress={cta.onPress}
          accentColor={standingAccentColor(standing.kind, standingPalette)}
          trailingIcon={<ChevronRightIcon color={colors.surface} size={14} strokeWidth={2.4} />}
        />
      ) : null}

      {/* ── Sheet création chantier/projet — rattaché à CE client, adresse préremplie ── */}
      <Sheet
        visible={chantierCreateOpen && customerFresh && chantiersFresh}
        onClose={closeChantierCreate}
      >
        <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
          <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
            {t('fiche.chantierCreateTitle', { personality, params: worksiteParams })}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
            {t('fiche.chantierCreateHint', { personality })}
          </Text>

          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 16 }]}>
            {t('fiche.chantierNameLabel', { personality, params: worksiteParams }).toUpperCase()}
          </Text>
          <TextInput
            value={chantierName}
            onChangeText={setChantierName}
            placeholder={t('fiche.chantierNamePlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('fiche.chantierNameLabel', { personality, params: worksiteParams })}
            style={[
              font('body'),
              {
                minHeight: 44,
                marginTop: 7,
                borderWidth: 1,
                borderColor: colors.lineSoft,
                borderRadius: 12,
                paddingHorizontal: 13,
                paddingVertical: 11,
                color: colors.ink800,
              },
            ]}
          />

          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
            {t('chantiers.addressLabel', { personality }).toUpperCase()}
          </Text>
          <TextInput
            value={chantierAddressQuery}
            onChangeText={(v) => {
              setChantierAddressQuery(v);
              setChantierAddressLocked(false);
            }}
            placeholder={t('chantiers.addressPlaceholder', { personality, params: worksiteParams })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('chantiers.addressLabel', { personality })}
            style={[
              font('body'),
              {
                minHeight: 44,
                marginTop: 7,
                borderWidth: 1,
                borderColor: colors.lineSoft,
                borderRadius: 12,
                paddingHorizontal: 13,
                paddingVertical: 11,
                color: colors.ink800,
              },
            ]}
          />
          {chantierAddressSearch.isPending && chantierAddressSearch.variables === chantierAddressQuery.trim() ? (
            <View style={{ marginTop: 9, gap: 6 }}>
              <Skeleton height={13} width="88%" radius={6} />
            </View>
          ) : !chantierAddressLocked
            && chantierAddressQuery.trim().length >= 3
            && chantierAddressSearch.variables === chantierAddressQuery.trim()
            && chantierAddressSearch.isSuccess
            && chantierAddressSearch.data !== undefined ? (
            chantierAddressSearch.data.length > 0 ? (
              <View accessibilityLiveRegion="polite" style={{ marginTop: 7, gap: 2 }}>
                {chantierAddressSearch.data.map((suggestion, index) => (
                  <Pressable
                    key={`${suggestion.label}-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={suggestion.label}
                    onPress={() => {
                      setChantierAddressQuery(suggestion.label);
                      setChantierAddressLocked(true);
                      chantierAddressSearch.reset();
                    }}
                    style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 7 }}
                  >
                    <Text style={[font('sub'), { color: colors.ink800 }]}>{suggestion.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text style={[font('sub'), { color: colors.slate500, marginTop: 9 }]}>
                {t('chantiers.addressNoResult', { personality })}
              </Text>
            )
          ) : null}

          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
            {t('fiche.chantierNotesLabel', { personality }).toUpperCase()}
          </Text>
          <TextInput
            value={chantierNotes}
            onChangeText={setChantierNotes}
            placeholder={t('fiche.chantierNotesPlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('fiche.chantierNotesLabel', { personality })}
            multiline
            numberOfLines={3}
            style={[
              font('body'),
              {
                minHeight: 72,
                marginTop: 7,
                borderWidth: 1,
                borderColor: colors.lineSoft,
                borderRadius: 12,
                paddingHorizontal: 13,
                paddingVertical: 11,
                color: colors.ink800,
                textAlignVertical: 'top',
              },
            ]}
          />

          {chantierError ? (
            /* Lot 4 — grammaire d'erreur : l'échec de mutation devient un ErrorNotice
               2 faces (code + corrélation, partage sans PII) — un ticket support aveugle
               n'a plus sa place dans une feuille de création. */
            <View style={{ marginTop: 12 }}>
              <ErrorNotice
                message={t('fiche.chantierCreateError', { personality, params: worksiteParams })}
                {...(() => {
                  const facts = firstQueryErrorFacts([createChantier]);
                  return facts
                    ? { code: facts.code, correlationId: facts.correlationId, kind: facts.kind }
                    : { code: 'BOB-API-500' };
                })()}
              />
            </View>
          ) : null}

          <Button
            title={t('fiche.chantierCreateSubmit', { personality, params: worksiteParams })}
            disabled={!chantierName.trim()}
            loading={createChantier.isPending}
            onPress={submitChantierCreate}
            style={{ marginTop: 16 }}
          />
        </KeyboardAvoidingView>
      </Sheet>

      {/* ── Sheet édition fiche client (C13/C40 TODO partagé) — mêmes champs que la création ── */}
      <Sheet visible={editOpen && customerFresh} onClose={() => setEditOpen(false)}>
        <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
          <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
            {t('fiche.editTitle', { personality })}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
            {t('fiche.editHint', { personality })}
          </Text>
          {customerFormInitial ? (
            <CustomerForm
              key={editOpen ? 'edit-open' : 'edit-closed'}
              personality={personality}
              initial={customerFormInitial}
              submitLabel={t('fiche.editSubmit', { personality })}
              submitting={updateCustomer.isPending}
              errorMessage={editError ? t('fiche.editError', { personality }) : null}
              onSubmit={submitEdit}
            />
          ) : null}
        </KeyboardAvoidingView>
      </Sheet>

      <Toast
        message={ficheToast ?? ''}
        visible={ficheToast !== null}
        onHide={() => {
          setFicheToast(null);
          setFicheToastKind('success');
        }}
        icon={ficheToastKind === 'success' ? <CheckIcon color={colors.surface} /> : undefined}
      />
    </View>
  );
}
