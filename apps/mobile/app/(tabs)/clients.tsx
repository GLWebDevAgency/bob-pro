/**
 * Clients — le carnet (claim C12, réf claims/ref/C12-frame.png, écran sans scroll).
 * Composition @bob/ui : InnerScreenHeader (« TON CARNET » / « Clients » + bouton + navy)
 * → sous-titre « {n} clients · {total} en attente » (montant teinté danger, comme la réf)
 * → recherche live (champ arrondi, loupe) → chips filtres par type (Tous/Particuliers/
 * Entreprises/Public) → liste de rangées client (une Card par client) → Fab.
 *
 * DONNÉES 100 % RÉELLES (A1-C10 généralisé) : useCustomers + useInvoices + useQuotes ;
 * le statut et l'encours PAR CLIENT se dérivent dans @bob/core (deriveCustomerStandings,
 * use case pur testé) depuis les pièces réelles — repli sur outstanding + scoreBand du
 * client (scoring core) quand il n'a aucune pièce. AUCUN repli fixtures : loading →
 * skeletons · erreur → voix de Bob (clients.dataError) · 0 client → invitation à créer ·
 * 0 résultat de recherche/filtre → clients.noResults. Tri par score décroissant
 * (score-customer @bob/core, servi par le hook) — l'ordre de la réf est celui du seed.
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
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
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
  Button,
  Card,
  Chip,
  Fab,
  InnerScreenHeader,
  Sheet,
  StatusBadge,
  Toast,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useCreateCustomer, useCustomers, useInvoices, useQuotes } from '../../src/data/hooks';
import { usePublishAgentContext, type AgentContext } from '../../src/agent';
import { CheckIcon, ChevronRightIcon, PlusIcon, SearchIcon } from '../../src/components/icons';

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
function AddClientButton({ onPress }: { onPress: () => void }) {
  const { personality, theme, colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('clients.addClient', { personality })}
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
        pressed && { transform: [{ scale: 0.94 }] },
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
function SkeletonRow() {
  const { colors, radius } = useTheme();
  return (
    <Card radius={16} padding={0} style={{ paddingHorizontal: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 }}>
        <View style={{ width: 44, height: 44, borderRadius: radius.squircle, backgroundColor: colors.lineSoft }} />
        <View style={{ flex: 1, gap: 7 }}>
          <View style={{ height: 15, width: '55%', borderRadius: 6, backgroundColor: colors.lineSoft }} />
          <View style={{ height: 12, width: '40%', borderRadius: 6, backgroundColor: colors.lineSoft }} />
        </View>
        <View style={{ height: 14, width: 54, borderRadius: 6, backgroundColor: colors.lineSoft }} />
      </View>
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
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, minHeight: 44 }}
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
 * Feuille « nouveau client » (C40) — création MINIMALE : nom + type. Le reste (adresse,
 * SIREN, email…) se complète sur la fiche ; défauts neutres identiques à l'outil agent
 * creer_client (adresse vide, score 100, aucun historique) — MÊME use case createCustomer.
 */
function CreateClientSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const { personality, colors, semantic } = useTheme();
  const createCustomer = useCreateCustomer();
  const [name, setName] = useState('');
  const [type, setType] = useState<CustomerListItem['type']>('b2c');
  const [failed, setFailed] = useState(false);
  const trimmed = name.trim();

  const reset = (): void => {
    setName('');
    setType('b2c');
    setFailed(false);
  };

  const submit = (): void => {
    if (!trimmed || createCustomer.isPending) return;
    setFailed(false);
    createCustomer.mutate(
      {
        name: trimmed,
        type,
        address: { line1: '', zip: '', city: '' },
        score: 100,
        avgDelayDays: 0,
        outstanding: 0,
      },
      {
        onSuccess: () => {
          reset();
          onCreated(trimmed);
        },
        onError: () => setFailed(true),
      },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
        <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
          {t('clients.createTitle', { personality })}
        </Text>
        <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
          {t('clients.createHint', { personality })}
        </Text>

        <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 16 }]}>
          {t('clients.createNameLabel', { personality }).toUpperCase()}
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t('clients.createNamePlaceholder', { personality })}
          placeholderTextColor={colors.slate300}
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={submit}
          accessibilityLabel={t('clients.createNameLabel', { personality })}
          style={[
            font('body'),
            {
              marginTop: 7,
              borderWidth: 1,
              borderColor: colors.lineSoft,
              borderRadius: 12,
              paddingVertical: 11,
              paddingHorizontal: 13,
              color: colors.ink800,
            },
          ]}
        />

        <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
          {t('clients.createTypeLabel', { personality }).toUpperCase()}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          {FILTERS.filter((f): f is { key: CustomerListItem['type']; label: I18nKey } => f.key !== 'tous').map((f) => (
            <Chip key={f.key} label={t(f.label, { personality })} active={type === f.key} onPress={() => setType(f.key)} />
          ))}
        </View>

        {failed ? (
          <Text
            accessibilityRole="alert"
            style={[font('sub'), { color: semantic.danger, lineHeight: 19, marginTop: 12 }]}
          >
            {t('clients.createError', { personality })}
          </Text>
        ) : null}

        <Button
          title={t('clients.createSubmit', { personality })}
          variant="primary"
          disabled={!trimmed}
          loading={createCustomer.isPending}
          style={{ marginTop: 16 }}
          onPress={submit}
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

  const [filter, setFilter] = useState<TypeFilter>('tous');
  const [query, setQuery] = useState('');
  // Création client (C40) : UN SEUL point d'entrée pour le « + », l'empty state et le Fab.
  const [createOpen, setCreateOpen] = useState(false);
  const [createdToast, setCreatedToast] = useState<string | null>(null);
  const openCreate = (): void => setCreateOpen(true);

  // Standing par client — dérivé dans @bob/core depuis les pièces réelles (repli client sans pièce).
  const standings = useMemo(
    () =>
      deriveCustomerStandings({
        customers: customers.data ?? [],
        invoices: invoices.data, // undefined pendant chargement/erreur → repli, jamais un chiffre inventé
        quotes: quotes.data,
        today: localToday(),
      }),
    [customers.data, invoices.data, quotes.data],
  );
  const standingById = useMemo(() => new Map(standings.map((s) => [s.customerId, s])), [standings]);

  // Tri par score décroissant (score-customer @bob/core, servi par le hook) — égalité :
  // encours décroissant puis nom. NB : l'ordre de la réf est celui du seed, pas du score.
  const sorted = useMemo(
    () =>
      [...(customers.data ?? [])].sort(
        (a, b) => b.score - a.score || b.outstanding - a.outstanding || a.name.localeCompare(b.name),
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

  const booting = customers.isLoading || invoices.isLoading || quotes.isLoading;
  const hasError = customers.isError || invoices.isError || quotes.isError;
  const carnet = customers.data;
  const totalCents = pendingTotalCents(standings);

  // Bob voit exactement le carnet filtré dans son ordre d'affichage. La recherche reste une
  // donnée UI non fiable : seuls les ids sont transmis puis rechargés tenant-scoped.
  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'clients', instanceId: 'clients' },
      entities:
        !booting && !hasError
          ? list.slice(0, 20).map((customer) => ({
              type: 'customer' as const,
              id: customer.id,
              label: customer.name,
            }))
          : [],
      capabilities:
        !booting && !hasError ? ['screen.read', 'customer.read'] : ['screen.read'],
    }),
    [booting, hasError, list],
  );
  usePublishAgentContext(agentContext);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 140 }}
        keyboardShouldPersistTaps="handled"
      >
        <InnerScreenHeader
          eyebrow={t('clients.eyebrow', { personality })}
          title={t('clients.title', { personality })}
          action={<AddClientButton onPress={openCreate} />}
        />
        {/* Sous-titre hors InnerScreenHeader : le montant interpolé est teinté (la prop subtitle est un string). */}
        {carnet !== undefined && carnet.length > 0 && !booting ? (
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
          {hasError ? (
            <Card>
              <Text style={[font('sub'), { color: colors.slate500 }]}>
                {t('clients.dataError', { personality })}
              </Text>
            </Card>
          ) : null}

          {booting ? (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          ) : carnet === undefined ? null /* erreur : la carte clients.dataError ci-dessus parle déjà */ : carnet.length ===
            0 ? (
            // 0 client : invitation à créer — même point d'entrée que le « + » et le Fab.
            <Card radius={18} padding={18}>
              <Text style={[font('cardTitle'), { color: colors.ink800 }]}>
                {t('clients.emptyTitle', { personality })}
              </Text>
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 5 }]}>
                {t('clients.emptyBody', { personality })}
              </Text>
              <Button
                title={t('clients.emptyCta', { personality })}
                variant="primary"
                style={{ marginTop: 14 }}
                onPress={openCreate}
              />
            </Card>
          ) : list.length === 0 ? (
            // 0 résultat (recherche/filtre) : état de premier rang, jamais une liste inventée.
            <Card>
              <Text style={[font('sub'), { color: colors.slate500 }]}>
                {t('clients.noResults', { personality })}
              </Text>
            </Card>
          ) : (
            list.map((customer) => {
              const standing = standingById.get(customer.id) ?? {
                customerId: customer.id,
                kind: 'nouveau' as const,
                amountCents: 0,
                daysLate: 0,
              };
              return (
                <CustomerRowCard
                  key={customer.id}
                  customer={customer}
                  standing={standing}
                  onPress={() => router.push({ pathname: '/client/[id]', params: { id: customer.id } })}
                />
              );
            })
          )}
        </View>
      </ScrollView>

      <Fab onPress={openCreate} accessibilityLabel={t('clients.addClient', { personality })} />

      <CreateClientSheet
        visible={createOpen}
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
