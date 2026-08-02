/**
 * Clients — le carnet (claim C12, réf claims/ref/C12-frame.png, écran sans scroll).
 * Composition @bob/ui : InnerScreenHeader (« TON CARNET » / « Clients » + bouton + navy)
 * → sous-titre « {n} clients · {total} en attente » (montant teinté danger, comme la réf)
 * → recherche live (champ arrondi, loupe) → chips filtres par type (Tous/Particuliers/
 * Entreprises/Public) → liste de rangées client (une Card par client) → Fab.
 *
 * DONNÉES 100 % RÉELLES (A1-C10 généralisé) : useCustomers + useInvoices + useQuotes ;
 * le statut et l'encours PAR CLIENT se dérivent dans @bob/core (deriveCustomerStandings,
 * use case pur testé) depuis les pièces réelles — repli sur l'encours serveur dérivé,
 * sans score de risque inventé, quand les pièces ne sont pas disponibles. AUCUN repli fixtures : loading →
 * skeletons · erreur → voix de Bob (clients.dataError) · 0 client → invitation à créer ·
 * 0 résultat de recherche/filtre → clients.noResults. Tri par encours réel décroissant,
 * puis nom.
 *
 * PARITÉ D'ACTIONS humain ↔ Bob (directive 23:52) :
 * · rangée → /client/[id] (fiche client C13 — les CTA relance/facture y vivent) ;
 * · « + » du header, CTA empty state et Fab = LE MÊME point d'entrée création client
 *   (C40) : Sheet @bob/ui « nouveau client » MINIMALE (nom + type, le reste se complète
 *   sur la fiche) → useCreateCustomer → client.createCustomer — le MÊME use case que
 *   l'outil agent creer_client (jamais un chemin parallèle). Succès = Toast + liste
 *   rafraîchie ; erreur = voix de Bob dans la feuille.
 *
 * Lot 4 (plan DA 01/08) — le kit fait autorité sur le seul écran fait pour ClientRow :
 * · CustomerRowCard → ClientRow v2 kit (slots nameAccessory/statusWord, PressableScale) ;
 * · la teinte du montant vient de standingAccentRole — LA dérivation du fil rouge
 *   « couleur de l'argent » (la même de la rangée au héros de fiche au geste sticky) ;
 * · SearchField kit (loupe + clear 44 pt) ; « + » → HeaderIconButton (squircle 44/13,
 *   géométrie unifiée avec chantiers).
 * Écart assumé vs réf : avatars en pastel sémantique par type (Avatar tone — gamme tokens),
 * pas les dégradés par client du proto (hex hors tokens).
 * Zéro hex/rgba : useTheme()/@bob/tokens. Zéro import de src/components/ui (ancien kit).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  deriveCustomerStandings,
  formatEURWhole,
  pendingTotalCents,
  type CustomerListItem,
  type CustomerStanding,
  type CustomerStandingKind,
} from '@bob/core';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import {
  Avatar,
  Card,
  Chip,
  ClientRow,
  EmptyState,
  ErrorRetry,
  Fab,
  HeaderIconButton,
  InnerScreenHeader,
  SearchField,
  Sheet,
  SkeletonRow as BaseSkeletonRow,
  StaggeredList,
  StatusBadge,
  Toast,
  font,
  standingAccentRole,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useCreateCustomer, useCustomers, useInvoices, useQuotes } from '../../src/data/hooks';
import { combineQueryStates } from '../../src/data/query-state';
import { hasBlockingAuthoritativeDataError } from '../../src/data/authoritative-query-state';
import { CustomerForm } from '../../src/components/customer-form';
import { usePublishAgentContext, type AgentContext } from '../../src/agent';
import { CheckIcon, PeopleIcon, PlusIcon } from '../../src/components/icons';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { TabsScrollView } from '../../src/components/bob-tabs-scroll-view';

type TypeFilter = 'tous' | CustomerListItem['type'];

const FILTERS: readonly { key: TypeFilter; label: I18nKey }[] = [
  { key: 'tous', label: 'clients.filterAll' },
  { key: 'b2c', label: 'clients.filterB2c' },
  { key: 'b2b', label: 'clients.filterB2b' },
  { key: 'b2g', label: 'clients.filterB2g' },
];

/** Badge + pastel d'avatar par type de client (tokens sémantiques §7). */
const BADGE_BY_TYPE: Record<CustomerListItem['type'], { label: I18nKey; variant: StatusBadgeVariant }> = {
  b2c: { label: 'clients.badgeB2c', variant: 'particulier' },
  b2b: { label: 'clients.badgeB2b', variant: 'b2b' },
  b2g: { label: 'clients.badgeB2g', variant: 'b2g' },
};

/** Mot de statut sous le montant (réf : payé · en retard · en attente · devis · nouveau). */
const STATUS_WORD: Record<CustomerStandingKind, I18nKey> = {
  a_jour: 'clients.statusPaid',
  en_retard: 'clients.statusLate',
  en_attente: 'clients.statusPending',
  devis: 'clients.statusQuote',
  nouveau: 'clients.statusNew',
};

/** Date locale du jour (DateOnly) — l'échéance d'une facture se juge en calendrier local, pas UTC. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Repli diacritiques pour la recherche live (« sevres » trouve « Sèvres ») — sans Intl. */
function fold(value: string): string {
  const lower = value.toLowerCase();
  return typeof lower.normalize === 'function'
    ? lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    : lower;
}

/** Sous-titre contextuel d'une rangée — dérivé du standing réel, jamais du remplissage. */
function rowSubtitle(type: CustomerListItem['type'], standing: CustomerStanding, personality: Personality): string {
  switch (standing.kind) {
    case 'a_jour':
      return t('clients.subUpToDate', { personality });
    case 'en_retard':
      return standing.daysLate > 0
        ? t('clients.subLateDays', { personality, params: { days: standing.daysLate } })
        : t('clients.subLate', { personality });
    case 'en_attente':
      // Client public : la facture transite par Chorus Pro (fait statutaire B2G, réf proto).
      return type === 'b2g' ? t('clients.subPendingB2g', { personality }) : t('clients.subPending', { personality });
    case 'devis':
      return t('clients.subQuote', { personality });
    case 'nouveau':
      return t('clients.subNew', { personality });
  }
}

/** Bouton « + » du header — HeaderIconButton kit (squircle 44/13, l'arbitrage entre le
 * squircle 42 d'ici et le rond 44 de chantiers : géométrie unifiée, Lot 4). */
function AddClientButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const { personality, colors } = useTheme();
  return (
    <HeaderIconButton
      accessibilityLabel={t('clients.addClient', { personality })}
      onPress={onPress}
      disabled={disabled}
    >
      <PlusIcon color={colors.surface} />
    </HeaderIconButton>
  );
}

/**
 * Sous-titre du carnet : « {n} clients · {total} en attente » — le montant interpolé
 * est re-teinté (danger, gras) dans la phrase i18n, comme la réf.
 */
function CarnetSubtitle({ count, totalCents }: { count: number; totalCents: number }) {
  const { personality, colors, semantic } = useTheme();
  // Agrégat → euros entiers (formatEURWhole), comme la réf « 4 330 € en attente ».
  const total = formatEURWhole(totalCents);
  const line =
    count === 1
      ? t('clients.subtitleOne', { personality, params: { total } })
      : t('clients.subtitle', { personality, params: { count, total } });
  const at = line.indexOf(total);
  return (
    <Text style={[font('body'), { color: colors.slate500, paddingHorizontal: 20, marginTop: 4 }]}>
      {at === -1 ? (
        line
      ) : (
        <>
          {line.slice(0, at)}
          <Text style={[font('body', 700), { color: totalCents > 0 ? semantic.danger : colors.slate500 }]}>
            {total}
          </Text>
          {line.slice(at + total.length)}
        </>
      )}
    </Text>
  );
}

/** Skeleton d'une rangée client (même gabarit : avatar 44, deux lignes, montant). */
function ClientSkeletonRow() {
  return (
    <Card radius={16} padding={0} style={{ paddingHorizontal: 14 }}>
      <BaseSkeletonRow avatar="square" avatarSize={44} trailing="text" style={{ paddingVertical: 13 }} />
    </Card>
  );
}

/**
 * Rangée client (une Card par client, réf) : ClientRow v2 kit (Lot 4) — Avatar squircle
 * pastel type + badge type (slot nameAccessory) + sous-titre contextuel + montant teinté
 * par le standing réel (standingAccentRole — fil rouge « couleur de l'argent ») + mot de
 * statut (slot statusWord, 11.5 slate400) + chevron controls.chevron + PressableScale.
 */
function CustomerRowCard({
  customer,
  standing,
  onPress,
}: {
  customer: CustomerListItem;
  standing: CustomerStanding;
  onPress: () => void;
}) {
  const { personality } = useTheme();
  const badge = BADGE_BY_TYPE[customer.type];
  const amountLabel =
    standing.kind === 'a_jour' ? t('clients.upToDate', { personality }) : formatEURWhole(standing.amountCents);
  const statusWord = t(STATUS_WORD[standing.kind], { personality });
  const subtitle = rowSubtitle(customer.type, standing, personality);

  return (
    <Card radius={16} padding={0} style={{ paddingHorizontal: 14 }}>
      <ClientRow
        name={customer.name}
        subtitle={subtitle}
        amountText={amountLabel}
        tone={standingAccentRole(standing.kind)}
        statusWord={statusWord}
        avatar={<Avatar name={customer.name} tone={badge.variant} />}
        nameAccessory={
          <StatusBadge label={t(badge.label, { personality }).toUpperCase()} variant={badge.variant} />
        }
        accessibilityLabel={`${customer.name}, ${subtitle}, ${amountLabel} ${statusWord}`}
        onPress={onPress}
      />
    </Card>
  );
}

/**
 * Feuille « nouveau client » (C40) — enrichie par type (arbitrage fondateur révisé) :
 * PARTICULIER = prénom + nom SEULS obligatoires ; ENTREPRISE/PUBLIC = raison sociale seule
 * obligatoire (avec recherche SIRET pour préremplir). Email/téléphone/adresse restent TOUJOURS
 * optionnels — aucun moyen de contact n'est exigé : l'envoi de pièces passera par un lien
 * partageable (Share natif), pas par un email forcé qui produirait des adresses bidon.
 * MÊME use case createCustomer que l'outil agent creer_client.
 */
function CreateClientSheet({
  visible,
  canSubmit,
  onClose,
  onCreated,
}: {
  visible: boolean;
  canSubmit: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const { personality, colors } = useTheme();
  const createCustomer = useCreateCustomer();
  const [failed, setFailed] = useState(false);
  // Remonte la Sheet à une nouvelle instance à chaque ouverture : le formulaire repart neutre.
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <Sheet
      visible={visible}
      onClose={() => {
        onClose();
        setInstanceKey((k) => k + 1);
      }}
    >
      <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
        <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
          {t('clients.createTitle', { personality })}
        </Text>
        <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
          {t('clients.createHint', { personality })}
        </Text>
        <CustomerForm
          key={instanceKey}
          personality={personality}
          submitLabel={t('clients.createSubmit', { personality })}
          submitting={createCustomer.isPending}
          errorMessage={failed ? t('clients.createError', { personality }) : null}
          onSubmit={(payload) => {
            if (!canSubmit) return;
            setFailed(false);
            createCustomer.mutate(payload, {
              onSuccess: () => {
                setInstanceKey((k) => k + 1);
                onCreated(payload.name);
              },
              onError: () => setFailed(true),
            });
          }}
        />
      </KeyboardAvoidingView>
    </Sheet>
  );
}

export default function Clients() {
  const { personality, colors } = useTheme();
  const router = useRouter();
  const customers = useCustomers();
  const invoices = useInvoices();
  const quotes = useQuotes();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: 140 });

  const [filter, setFilter] = useState<TypeFilter>('tous');
  const [query, setQuery] = useState('');
  // Création client (C40) : UN SEUL point d'entrée pour le « + », l'empty state et le Fab.
  const [createOpen, setCreateOpen] = useState(false);
  const [createdToast, setCreatedToast] = useState<string | null>(null);
  const sourcesReady =
    customers.data !== undefined && invoices.data !== undefined && quotes.data !== undefined;
  const blockingError = hasBlockingAuthoritativeDataError([customers, invoices, quotes]);
  const staleError =
    sourcesReady && !blockingError && (customers.isError || invoices.isError || quotes.isError);
  const sourcesFresh = sourcesReady && !staleError;
  const openCreate = (): void => {
    if (sourcesFresh) setCreateOpen(true);
  };

  useEffect(() => {
    if (!sourcesFresh) setCreateOpen(false);
  }, [sourcesFresh]);

  // Standing par client — dérivé uniquement lorsque les trois photographies serveur existent.
  // Une source absente ne devient jamais une collection vide ni un encours à zéro.
  const standings = useMemo(
    () => {
      if (customers.data === undefined || invoices.data === undefined || quotes.data === undefined) return [];
      return deriveCustomerStandings({
        customers: customers.data,
        invoices: invoices.data,
        quotes: quotes.data,
        today: localToday(),
      });
    },
    [customers.data, invoices.data, quotes.data],
  );
  const standingById = useMemo(() => new Map(standings.map((s) => [s.customerId, s])), [standings]);

  // Tri par encours réellement dérivé puis nom. Aucun pseudo-score ne décide de l'ordre.
  const sorted = useMemo(
    () => customers.data === undefined
      ? []
      : [...customers.data].sort(
          (a, b) => b.outstandingCents - a.outstandingCents || a.name.localeCompare(b.name),
        ),
    [customers.data],
  );

  // Recherche live (filtre local sur le nom, insensible aux accents) × chips type.
  const list = useMemo(() => {
    const q = fold(query.trim());
    return sorted.filter(
      (c) => (filter === 'tous' || c.type === filter) && (q === '' || fold(c.name).includes(q)),
    );
  }, [sorted, filter, query]);

  const queryState = combineQueryStates(customers, invoices, quotes);
  const booting = !sourcesReady && !blockingError;
  const standingInvariantBroken = sourcesFresh
    && list.some((customer) => !standingById.has(customer.id));
  const displayError = blockingError || standingInvariantBroken;
  const refreshing = customers.isRefetching || invoices.isRefetching || quotes.isRefetching;
  const carnet = customers.data;
  const totalCents = pendingTotalCents(standings);

  // Bob voit exactement le carnet filtré dans son ordre d'affichage. La recherche reste une
  // donnée UI non fiable : seuls les ids sont transmis puis rechargés tenant-scoped.
  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'clients', instanceId: 'clients' },
      entities:
        sourcesFresh && !displayError
          ? list.slice(0, 20).map((customer) => ({
              type: 'customer' as const,
              id: customer.id,
              label: customer.name,
            }))
          : [],
      capabilities:
        sourcesFresh && !displayError ? ['screen.read', 'customer.read'] : [],
    }),
    [displayError, list, sourcesFresh],
  );
  usePublishAgentContext(agentContext);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabsScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={queryState.refetchAll}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        <InnerScreenHeader
          eyebrow={t('clients.eyebrow', { personality })}
          title={t('clients.title', { personality })}
          action={<AddClientButton onPress={openCreate} disabled={!sourcesFresh} />}
        />
        {/* Sous-titre hors InnerScreenHeader : le montant interpolé est teinté (la prop subtitle est un string). */}
        {carnet !== undefined && sourcesReady && carnet.length > 0 && !booting ? (
          <CarnetSubtitle count={carnet.length} totalCents={totalCents} />
        ) : null}

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('clients.searchPlaceholder', { personality })}
          onClear={() => setQuery('')}
          clearAccessibilityLabel={t('clients.searchClear', { personality })}
          style={{ marginTop: 12, marginHorizontal: 18 }}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginTop: 14 }}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 18, paddingBottom: 4 }}
        >
          {FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={t(f.label, { personality })}
              active={filter === f.key}
              onPress={() => setFilter(f.key)}
            />
          ))}
        </ScrollView>

        <View style={{ paddingHorizontal: 18, paddingTop: 8, gap: 10 }}>
          {displayError ? (
            <ErrorRetry
              message={t('clients.dataError', { personality })}
              onRetry={queryState.refetchAll}
              retrying={refreshing}
            />
          ) : booting ? (
            <>
              <ClientSkeletonRow />
              <ClientSkeletonRow />
              <ClientSkeletonRow />
              <ClientSkeletonRow />
            </>
          ) : carnet === undefined ? null : (
            <>
              {staleError ? (
                <ErrorRetry
                  message={t('clients.dataError', { personality })}
                  onRetry={queryState.refetchAll}
                  retrying={refreshing}
                />
              ) : null}
              {carnet.length === 0 ? (
            // 0 client : invitation à créer — même point d'entrée que le « + » et le Fab.
            <Card radius={18} padding={18}>
              <EmptyState
                title={t('clients.emptyTitle', { personality })}
                body={t('clients.emptyBody', { personality })}
                icon={<PeopleIcon size={17} color={colors.ink600} />}
                iconTone="particulier"
                cta={sourcesFresh ? { label: t('clients.emptyCta', { personality }), onPress: openCreate } : undefined}
              />
            </Card>
          ) : list.length === 0 ? (
            // 0 résultat (recherche/filtre) : état de premier rang, jamais une liste inventée.
            <Card>
              <EmptyState body={t('clients.noResults', { personality })} />
            </Card>
          ) : (
            // Cascade sobre au premier rendu du carnet — chaque rangée fond en entrant (cap 8).
            <StaggeredList>
              {list.map((customer) => {
                const standing = standingById.get(customer.id);
                if (standing === undefined) return null;
                return (
                  <CustomerRowCard
                    key={customer.id}
                    customer={customer}
                    standing={standing}
                    onPress={() => router.push({ pathname: '/client/[id]', params: { id: customer.id } })}
                  />
                );
              })}
            </StaggeredList>
          )}
            </>
          )}
        </View>
      </TabsScrollView>

      {sourcesFresh ? (
        <Fab onPress={openCreate} accessibilityLabel={t('clients.addClient', { personality })} />
      ) : null}

      <CreateClientSheet
        visible={createOpen && sourcesFresh}
        canSubmit={sourcesFresh}
        onClose={() => setCreateOpen(false)}
        onCreated={(name) => {
          setCreateOpen(false);
          setCreatedToast(t('clients.createSuccess', { personality, params: { name } }));
        }}
      />
      <Toast
        message={createdToast ?? ''}
        visible={createdToast !== null}
        onHide={() => setCreatedToast(null)}
        icon={<CheckIcon color={colors.surface} />}
      />
    </View>
  );
}
