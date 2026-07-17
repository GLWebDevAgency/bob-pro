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
 * Écarts assumés vs réf (composants @bob/ui figés pour ce claim) :
 * · ClientRow ne porte ni badge type inline ni mot de statut sous le montant (props
 *   figées) → rangée composée localement avec les primitives @bob/ui (Card, Avatar,
 *   StatusBadge) aux métriques ClientRow (gap 12, padding V 13, nom 14.5/700,
 *   sous-titre 12.5, montant tabular-nums) ;
 * · avatars en pastel sémantique par type (Avatar tone — gamme tokens), pas les
 *   dégradés par client du proto (hex hors tokens).
 * Zéro hex/rgba : useTheme()/@bob/tokens. Zéro import de src/components/ui (ancien kit).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
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
import { shadowNative } from '@bob/tokens';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import {
  Avatar,
  Card,
  Chip,
  EmptyState,
  ErrorRetry,
  Fab,
  InnerScreenHeader,
  Sheet,
  SkeletonRow as BaseSkeletonRow,
  StaggeredList,
  StatusBadge,
  Toast,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useCreateCustomer, useCustomers, useInvoices, useQuotes } from '../../src/data/hooks';
import { combineQueryStates } from '../../src/data/query-state';
import { hasBlockingAuthoritativeDataError } from '../../src/data/authoritative-query-state';
import { CustomerForm } from '../../src/components/customer-form';
import { usePublishAgentContext, type AgentContext } from '../../src/agent';
import {
  CheckIcon,
  ChevronRightIcon,
  PeopleIcon,
  PlusIcon,
  SearchIcon,
} from '../../src/components/icons';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';

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

/** Bouton « + » navy du header (réf : 42×42, radius 13, aplat ink du thème). */
function AddClientButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const { personality, theme, colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('clients.addClient', { personality })}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: 42,
          height: 42,
          minWidth: 44,
          minHeight: 44,
          borderRadius: 13,
          backgroundColor: theme.ink,
          alignItems: 'center',
          justifyContent: 'center',
          ...shadowNative.e2,
        },
        disabled ? { opacity: 0.45 } : null,
        pressed && !disabled ? { transform: [{ scale: 0.94 }] } : null,
      ]}
    >
      <PlusIcon color={colors.surface} />
    </Pressable>
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

/** Champ de recherche arrondi (réf : loupe + placeholder slate300, fond surface, ombre douce). */
function SearchField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { personality, colors, radius } = useTheme();
  const placeholder = t('clients.searchPlaceholder', { personality });
  return (
    <View
      style={{
        marginTop: 12,
        marginHorizontal: 18,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        backgroundColor: colors.surface,
        borderRadius: radius.squircle,
        paddingVertical: 11,
        paddingHorizontal: 14,
        ...shadowNative.e1,
      }}
    >
      <SearchIcon color={colors.slate300} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.slate300}
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={placeholder}
        style={[font('body'), { flex: 1, padding: 0, color: colors.ink800 }]}
      />
    </View>
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
 * Rangée client (une Card par client, réf) : Avatar squircle pastel type → nom 14.5/700
 * + badge type → sous-titre contextuel → montant teinté par statut réel + mot de statut
 * → chevron. Métriques ClientRow (@bob/ui) — composée localement, cf. écarts en tête.
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
  const { personality, colors, semantic, controls } = useTheme();
  const badge = BADGE_BY_TYPE[customer.type];
  const amountColor: Record<CustomerStandingKind, string> = {
    a_jour: semantic.success,
    en_retard: semantic.danger,
    en_attente: semantic.warning,
    devis: semantic.warning, // réf C12-frame : le devis en attente est ambré, comme l'attente
    nouveau: colors.slate500,
  };
  const amountLabel =
    standing.kind === 'a_jour' ? t('clients.upToDate', { personality }) : formatEURWhole(standing.amountCents);
  const statusWord = t(STATUS_WORD[standing.kind], { personality });
  const subtitle = rowSubtitle(customer.type, standing, personality);

  return (
    <Card radius={16} padding={0} style={{ paddingHorizontal: 14 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${customer.name}, ${subtitle}, ${amountLabel} ${statusWord}`}
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 13,
          minHeight: 44,
          opacity: pressed ? 0.65 : 1,
        })}
      >
        <Avatar name={customer.name} tone={badge.variant} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text numberOfLines={1} style={[font('body', 700), { color: colors.ink800, flexShrink: 1 }]}>
              {customer.name}
            </Text>
            <StatusBadge label={t(badge.label, { personality }).toUpperCase()} variant={badge.variant} />
          </View>
          <Text numberOfLines={1} style={[font('meta'), { fontSize: 12.5, color: colors.slate400, marginTop: 2 }]}>
            {subtitle}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={[
              font('cardTitle'),
              { fontSize: 14, color: amountColor[standing.kind], fontVariant: ['tabular-nums'] },
            ]}
          >
            {amountLabel}
          </Text>
          <Text style={[font('meta'), { fontSize: 11, color: colors.slate300, marginTop: 1 }]}>{statusWord}</Text>
        </View>
        <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
      </Pressable>
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
      <ScrollView
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

        <SearchField value={query} onChange={setQuery} />

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
      </ScrollView>

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
