/**
 * Galerie @bob/ui — claim C03 (design_handoff_bob_pro).
 * Rend TOUTES les primitives avec des données d'exemple réalistes (fr, centimes),
 * dans les 4 thèmes de marque via un switch live (setThemeName).
 * Standalone : aucune donnée réseau. Zéro hex/rgba : tout vient de useTheme().
 */
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import {
  AppHeaderNavy,
  Avatar,
  BottomTabBar,
  Button,
  Card,
  Chip,
  ClientRow,
  Eyebrow,
  Fab,
  FloatingBalanceCard,
  HeroMoneyCard,
  IconTile,
  InnerScreenHeader,
  KpiTile,
  MoneyRow,
  MoneyText,
  PriorityCard,
  QuickAction,
  ScoreBar,
  ScoreRing,
  SectionHeader,
  SegmentedControl,
  Sheet,
  StatusBadge,
  Toast,
  font,
  useTheme,
  type BottomTabItem,
  type SegmentOption,
  type ThemeContextValue,
} from '@bob/ui';

type ThemeName = ThemeContextValue['themeName'];
type FeatherName = ComponentProps<typeof Feather>['name'];
type RangeKey = '7' | '30' | '60' | '90';

const THEME_OPTIONS: readonly SegmentOption<ThemeName>[] = [
  { key: 'marine', label: 'Marine' },
  { key: 'foret', label: 'Forêt' },
  { key: 'graphite', label: 'Graphite' },
  { key: 'indigo', label: 'Indigo' },
];

const RANGE_OPTIONS: readonly SegmentOption<RangeKey>[] = [
  { key: '7', label: '7 j' },
  { key: '30', label: '30 j' },
  { key: '60', label: '60 j' },
  { key: '90', label: '90 j' },
];

/** Icône d'onglet en render-prop : couleur/taille fournies par le slot BottomTabBar. */
function tabIcon(name: FeatherName): BottomTabItem['icon'] {
  return ({ color, size }) => <Feather name={name} size={size} color={color} />;
}

const TAB_ITEMS: readonly BottomTabItem[] = [
  { key: 'aujourdhui', label: "Aujourd'hui", icon: tabIcon('home') },
  { key: 'argent', label: 'Argent', icon: tabIcon('credit-card') },
  { key: 'clients', label: 'Clients', icon: tabIcon('users') },
  { key: 'documents', label: 'Documents', icon: tabIcon('folder') },
  { key: 'assistant', label: 'Bob', icon: tabIcon('message-circle') },
];

const noop = (): void => undefined;

/** Bloc de galerie : SectionHeader + contenu. `bleed` = contenu pleine largeur (headers). */
function Section({
  title,
  children,
  bleed = false,
}: {
  title: string;
  children: ReactNode;
  bleed?: boolean;
}) {
  return (
    <View style={{ marginTop: 30, paddingHorizontal: bleed ? 0 : 20 }}>
      <View style={bleed ? { paddingHorizontal: 20 } : null}>
        <SectionHeader title={title} />
      </View>
      {children}
    </View>
  );
}

export default function GalleryScreen() {
  const { colors, semantic, themeName, setThemeName } = useTheme();
  // Captures headless : /gallery?theme=foret force le thème à l'ouverture.
  const { theme: themeParam } = useLocalSearchParams<{ theme?: string }>();
  useEffect(() => {
    if (themeParam === 'marine' || themeParam === 'foret' || themeParam === 'graphite' || themeParam === 'indigo') {
      setThemeName(themeParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeParam]);
  const insets = useSafeAreaInsets();

  const [invoiceFilter, setInvoiceFilter] = useState<'retard' | 'attente'>('retard');
  const [range, setRange] = useState<RangeKey>('30');
  const [activeTab, setActiveTab] = useState('aujourdhui');
  const [priorityDone, setPriorityDone] = useState(true);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  const checkIcon = <Feather name="check" size={14} color={semantic.success} />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 48,
        }}
      >
        {/* ── En tête : switch de thème LIVE ─────────────────────────────── */}
        <View style={{ paddingHorizontal: 20 }}>
          <Eyebrow>Design system</Eyebrow>
          <Text style={[font('pageTitle'), { color: colors.ink800, marginTop: 4 }]}>
            Galerie @bob/ui
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>
            Toutes les primitives, dans les 4 thèmes de marque.
          </Text>
          <View style={{ marginTop: 14 }}>
            <SegmentedControl
              options={THEME_OPTIONS}
              value={themeName}
              onChange={setThemeName}
              accessibilityLabel="Thème de marque"
            />
          </View>
        </View>

        {/* ── Button ─────────────────────────────────────────────────────── */}
        <Section title="Button">
          <View style={{ gap: 10 }}>
            <Button
              title="Encaisser 450,00 €"
              variant="primary"
              icon={<Feather name="check-circle" size={16} color={colors.surface} />}
              onPress={noop}
            />
            <Button
              title="Voir le devis"
              variant="secondary"
              icon={<Feather name="file-text" size={16} color={colors.ink600} />}
              onPress={noop}
            />
            <Button
              title="Demander à Bob"
              variant="ai"
              icon={<Feather name="zap" size={16} color={colors.surface} />}
              onPress={noop}
            />
            <Button
              title="Supprimer le brouillon"
              variant="danger"
              icon={<Feather name="trash-2" size={16} color={semantic.danger} />}
              onPress={noop}
            />
            <Button title="Indisponible hors ligne" disabled onPress={noop} />
            <Button title="Envoi de la relance…" loading onPress={noop} />
          </View>
        </Section>

        {/* ── StatusBadge & Chip ─────────────────────────────────────────── */}
        <Section title="StatusBadge & Chip">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <StatusBadge label="Retard 12 j" variant="danger" />
            <StatusBadge label="Entreprise" variant="b2b" />
            <StatusBadge label="Chorus Pro" variant="b2g" />
            <StatusBadge label="Particulier" variant="particulier" />
            <StatusBadge label="Payée" variant="success" />
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            <Chip
              label="En retard"
              active={invoiceFilter === 'retard'}
              onPress={() => setInvoiceFilter('retard')}
            />
            <Chip
              label="En attente"
              active={invoiceFilter === 'attente'}
              onPress={() => setInvoiceFilter('attente')}
            />
            <Chip label="Payées" />
          </View>
        </Section>

        {/* ── Avatar ─────────────────────────────────────────────────────── */}
        <Section title="Avatar">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Avatar name="Lucas Durand" />
            <Avatar name="Lucas Durand" shape="circle" />
            <Avatar name="Martin & Fils" tone="b2b" />
            <Avatar name="Sophie Bernard" size={34} shape="circle" tone="success" />
          </View>
        </Section>

        {/* ── Card ───────────────────────────────────────────────────────── */}
        <Section title="Card">
          <Card>
            <Eyebrow>Devis en attente</Eyebrow>
            <Text style={[font('cardTitle'), { color: colors.ink900, marginTop: 6 }]}>
              Martin & Fils — salle de bain
            </Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>
              Envoyé il y a 5 jours · relance conseillée
            </Text>
          </Card>
          <Card elevation="e2" radius={22} padding={18} style={{ marginTop: 12 }}>
            <Text style={[font('sub'), { color: colors.slate500 }]}>
              Surélevée — elevation e2, radius 22, padding 18.
            </Text>
          </Card>
        </Section>

        {/* ── IconTile ───────────────────────────────────────────────────── */}
        <Section title="IconTile">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <IconTile tone="danger">
              <Feather name="alert-triangle" size={16} color={semantic.danger} />
            </IconTile>
            <IconTile tone="b2b">
              <Feather name="briefcase" size={16} color={semantic.b2b} />
            </IconTile>
            <IconTile tone="b2g">
              <Feather name="shield" size={16} color={semantic.b2g} />
            </IconTile>
            <IconTile tone="particulier">
              <Feather name="user" size={16} color={semantic.particulier} />
            </IconTile>
            <IconTile tone="success" size={34} radius={11}>
              <Feather name="check" size={18} color={semantic.success} />
            </IconTile>
          </View>
        </Section>

        {/* ── Eyebrow ────────────────────────────────────────────────────── */}
        <Section title="Eyebrow">
          <View style={{ gap: 6 }}>
            <Eyebrow>Trésorerie du mois</Eyebrow>
            <Eyebrow color={semantic.ai}>Suggestion de Bob</Eyebrow>
          </View>
        </Section>

        {/* ── MoneyText ──────────────────────────────────────────────────── */}
        <Section title="MoneyText">
          <Card style={{ gap: 8 }}>
            <MoneyText cents={214500} variant="hero" />
            <MoneyText cents={87550} variant="big" color={semantic.success} />
            <MoneyText cents={-12990} variant="big" color={semantic.dangerVivid} />
            <MoneyText cents={12990} />
          </Card>
        </Section>

        {/* ── AppHeaderNavy + FloatingBalanceCard (geste signature) ─────── */}
        <Section title="AppHeaderNavy + FloatingBalanceCard" bleed>
          <AppHeaderNavy
            dateLabel="Jeudi 2 juillet"
            companyName="Durand Rénovation"
            initials="LD"
            title="Salut Lucas"
            subtitle="2 priorités aujourd'hui, rien de grave."
            bellIcon={<Feather name="bell" size={18} color={colors.surface} />}
            hasUnread
            onAvatarPress={noop}
            onBellPress={noop}
          />
          <FloatingBalanceCard
            label="Tu peux te verser"
            amountCents={198000}
            voiceLine="Sans te mettre dans le rouge, même après la TVA."
            chevronIcon={<Feather name="chevron-right" size={16} color={colors.slate500} />}
            voiceIcon={<Feather name="trending-up" size={15} color={semantic.success} />}
            onPress={noop}
          />
        </Section>

        {/* ── PriorityCard ───────────────────────────────────────────────── */}
        <Section title="PriorityCard">
          <View style={{ gap: 12 }}>
            <PriorityCard
              status="retard"
              title="Relancer Martin & Fils — 1 250,00 €"
              subtitle="Facture F-2026-014 · 12 jours de retard"
              badge={<StatusBadge label="Retard 12 j" variant="danger" />}
              cta={<Button title="Relancer maintenant" variant="primary" onPress={noop} />}
              checkIcon={checkIcon}
              onToggle={noop}
            />
            <PriorityCard
              status="marine"
              title="Envoyer le devis piscine à Mme Roche"
              subtitle="Estimé à 8 400,00 € · préparé par Bob"
              badge={<StatusBadge label="Devis prêt" variant="b2b" />}
              checkIcon={checkIcon}
              onToggle={noop}
            />
            <PriorityCard
              status="conformite"
              title="Activer la facturation électronique"
              subtitle="Obligatoire au 1er septembre 2026"
              badge={<StatusBadge label="Chorus Pro" variant="b2g" />}
              leadingIcon={<Feather name="shield" size={15} color={semantic.b2g} />}
            />
            <PriorityCard
              status="marine"
              title="Acompte encaissé — chantier Bernard"
              subtitle="Touche la coche pour basculer l'état"
              done={priorityDone}
              onToggle={() => setPriorityDone((d) => !d)}
              checkIcon={checkIcon}
            />
          </View>
        </Section>

        {/* ── KpiTile (grille 2×2, 4 tones) ─────────────────────────────── */}
        <Section title="KpiTile">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <View style={{ flexBasis: '47%', flexGrow: 1 }}>
              <KpiTile
                label="Encaissé (30 j)"
                amountCents={842000}
                tone="success"
                icon={<Feather name="arrow-down-left" size={14} color={semantic.success} />}
                onPress={noop}
              />
            </View>
            <View style={{ flexBasis: '47%', flexGrow: 1 }}>
              <KpiTile
                label="En retard"
                amountCents={125000}
                tone="danger"
                icon={<Feather name="alert-circle" size={14} color={semantic.dangerVivid} />}
                onPress={noop}
              />
            </View>
            <View style={{ flexBasis: '47%', flexGrow: 1 }}>
              <KpiTile
                label="À échéance (7 j)"
                amountCents={264050}
                tone="warning"
                icon={<Feather name="clock" size={14} color={semantic.warning} />}
                onPress={noop}
              />
            </View>
            <View style={{ flexBasis: '47%', flexGrow: 1 }}>
              <KpiTile
                label="Devis en cours"
                amountCents={1240000}
                tone="ink"
                icon={<Feather name="file-text" size={14} color={colors.slate400} />}
                onPress={noop}
              />
            </View>
          </View>
        </Section>

        {/* ── QuickAction (×4) ──────────────────────────────────────────── */}
        <Section title="QuickAction">
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <QuickAction
                label="Demander à Bob"
                tone="ai"
                icon={<Feather name="mic" size={18} color={semantic.ai} />}
                onPress={noop}
              />
            </View>
            <View style={{ flex: 1 }}>
              <QuickAction
                label="Nouveau devis"
                tone="b2b"
                icon={<Feather name="file-plus" size={18} color={semantic.b2b} />}
                onPress={noop}
              />
            </View>
            <View style={{ flex: 1 }}>
              <QuickAction
                label="Encaisser"
                tone="success"
                icon={<Feather name="credit-card" size={18} color={semantic.success} />}
                onPress={noop}
              />
            </View>
            <View style={{ flex: 1 }}>
              <QuickAction
                label="Scanner un reçu"
                tone="warning"
                icon={<Feather name="camera" size={18} color={semantic.warning} />}
                onPress={noop}
              />
            </View>
          </View>
        </Section>

        {/* ── InnerScreenHeader ──────────────────────────────────────────── */}
        <Section title="InnerScreenHeader" bleed>
          <InnerScreenHeader
            eyebrow="Argent"
            title="Ta trésorerie"
            subtitle="Solde réel, après TVA et charges à venir."
            action={<Button title="Exporter" variant="secondary" onPress={noop} />}
          />
        </Section>

        {/* ── HeroMoneyCard ──────────────────────────────────────────────── */}
        <Section title="HeroMoneyCard">
          <HeroMoneyCard
            label="Tu peux te verser"
            amountCents={214500}
            pill="sans risque"
            caption="Après TVA, URSSAF et les dépenses prévues du mois."
          />
        </Section>

        {/* ── MoneyRow ───────────────────────────────────────────────────── */}
        <Section title="MoneyRow">
          <Card>
            <MoneyRow
              label="Encaissé ce mois"
              amountCents={324500}
              variant="lead"
              icon={<Feather name="arrow-down-left" size={15} color={semantic.success} />}
            />
            <MoneyRow label="Dépenses" amountCents={-128040} />
            <MoneyRow label="TVA à provisionner" amountCents={-45600} />
            <MoneyRow label="Solde réel" amountCents={150860} variant="total" divider={false} />
          </Card>
        </Section>

        {/* ── SegmentedControl (7/30/60/90 j) ───────────────────────────── */}
        <Section title="SegmentedControl">
          <SegmentedControl
            options={RANGE_OPTIONS}
            value={range}
            onChange={setRange}
            accessibilityLabel="Période de projection"
          />
          <Text style={[font('sub'), { color: colors.slate500, marginTop: 10 }]}>
            Projection de trésorerie sur {range} jours.
          </Text>
        </Section>

        {/* ── ClientRow ──────────────────────────────────────────────────── */}
        <Section title="ClientRow">
          <Card>
            <ClientRow
              name="Martin & Fils"
              subtitle="2 factures · 1 en retard"
              amountCents={125000}
              tone="danger"
              avatar={<Avatar name="Martin & Fils" tone="b2b" />}
              onPress={noop}
            />
            <ClientRow
              name="Sophie Bernard"
              subtitle="Chantier en cours · acompte reçu"
              amountCents={264050}
              tone="warning"
              avatar={<Avatar name="Sophie Bernard" tone="particulier" />}
              onPress={noop}
            />
            <ClientRow
              name="Mairie de Vannes"
              subtitle="À jour · e-facture Chorus Pro"
              amountCents={842000}
              tone="success"
              avatar={<Avatar name="Mairie de Vannes" tone="b2g" />}
              onPress={noop}
            />
            <ClientRow name="Atelier Roche" subtitle="Aucun document" onPress={noop} />
          </Card>
        </Section>

        {/* ── ScoreBar & ScoreRing ───────────────────────────────────────── */}
        <Section title="ScoreBar & ScoreRing">
          <Card style={{ gap: 14 }}>
            <View>
              <Text style={[font('label'), { color: colors.slate500, marginBottom: 6 }]}>
                32 / 100 — zone rouge
              </Text>
              <ScoreBar score={32} accessibilityLabel="Score 32 sur 100" />
            </View>
            <View>
              <Text style={[font('label'), { color: colors.slate500, marginBottom: 6 }]}>
                64 / 100 — à surveiller
              </Text>
              <ScoreBar score={64} accessibilityLabel="Score 64 sur 100" />
            </View>
            <View>
              <Text style={[font('label'), { color: colors.slate500, marginBottom: 6 }]}>
                88 / 100 — solide
              </Text>
              <ScoreBar score={88} accessibilityLabel="Score 88 sur 100" />
            </View>
            <View style={{ alignItems: 'center', marginTop: 4 }}>
              <ScoreRing score={78} accessibilityLabel="Score global 78 sur 100" />
            </View>
          </Card>
        </Section>

        {/* ── BottomTabBar ───────────────────────────────────────────────── */}
        <Section title="BottomTabBar">
          <BottomTabBar
            items={TAB_ITEMS}
            activeKey={activeTab}
            onSelect={setActiveTab}
            insetBottom={0}
          />
        </Section>

        {/* ── FAB ────────────────────────────────────────────────────────── */}
        <Section title="FAB">
          <View style={{ height: 96 }}>
            <Fab
              onPress={noop}
              accessibilityLabel="Créer un devis"
              icon={<Feather name="plus" size={24} color={colors.surface} />}
              right={20}
              bottom={19}
            />
          </View>
        </Section>

        {/* ── Sheet & Toast ──────────────────────────────────────────────── */}
        <Section title="Sheet & Toast">
          <View style={{ gap: 10 }}>
            <Button
              title="Ouvrir la feuille d'encaissement"
              variant="secondary"
              onPress={() => setSheetVisible(true)}
            />
            <Button
              title="Afficher le toast"
              variant="secondary"
              onPress={() => setToastVisible(true)}
            />
          </View>
        </Section>
      </ScrollView>

      <Sheet visible={sheetVisible} onClose={() => setSheetVisible(false)}>
        <SectionHeader title="Encaisser l'acompte" />
        <Text style={[font('sub'), { color: colors.slate500 }]}>
          Chantier Bernard — salle de bain
        </Text>
        <View style={{ marginTop: 12 }}>
          <MoneyText cents={84000} variant="big" />
        </View>
        <View style={{ marginTop: 16, gap: 10 }}>
          <Button
            title="Encaisser 840,00 €"
            variant="primary"
            icon={<Feather name="check-circle" size={16} color={colors.surface} />}
            onPress={() => {
              setSheetVisible(false);
              setToastVisible(true);
            }}
          />
          <Button title="Plus tard" variant="secondary" onPress={() => setSheetVisible(false)} />
        </View>
      </Sheet>

      <Toast
        message="Acompte de 840,00 € encaissé"
        visible={toastVisible}
        onHide={() => setToastVisible(false)}
        icon={<Feather name="check" size={14} color={colors.surface} />}
      />
    </View>
  );
}
