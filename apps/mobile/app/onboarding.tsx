/**
 * Onboarding adaptatif — flux plein écran navy 5 étapes (claim C22, proto dc.html §onb*).
 *
 * FLUX (contrat C22, machine locale simple : useState étape + gardes par CTA) :
 *   0 bienvenue → 1 métier (grille proto, le choix ADAPTE le vocabulaire) → 2 clientèle
 *   (b2c/b2b/b2g/mixte) → 3 régime TVA (franchise 293 B / réel simplifié / réel normal,
 *   copy pédagogique voix Bob) → 4 preview « ton espace {métier} » → handoff « C'est parti »
 *   → /diagnostic (C23) · « Plus tard » → /(tabs) (C10).
 *
 * ADAPTATION : use case PUR @bob/core deriveTradeProfile (testé) — chips du preview
 * (libellés proto EXACTS §onbPreview), repères métier (décennale, Consuel, retenue de
 * garantie, TVA travaux, cession de droits, CRA) et « ton espace {métier} ». L'écran ne
 * porte AUCUNE règle métier ; la grille affiche les libellés TRADE_PROFILES (= proto).
 *
 * PERSISTANCE : métier et régime TVA sont relus depuis la société du tenant puis
 * enregistrés par PATCH /company/profile avant toute navigation vers le diagnostic.
 * Une panne serveur laisse l'utilisateur sur le preview avec une erreur explicite :
 * aucune confirmation locale ne peut être présentée comme une donnée sauvegardée.
 * La clientèle est persistée avec le métier et le régime TVA sur la société du tenant.
 * Une valeur absente reste explicitement non confirmée : aucun canal n'est choisi par défaut.
 *
 * Écarts assumés vs proto (tokens only, zéro hex/rgba) :
 * · le fond 172° navy→nuit du proto n'existe pas en rampe → themes.marine.d1 vers
 *   themes.graphite.d1 (même départ que le proto, fin sombre la plus proche des tokens) ;
 * · l'étape SIRET du proto est remplacée par le régime TVA (contrat C22 — le SIRET
 *   vit déjà dans le profil réel) et la clientèle passe de multi-choix (dont
 *   « L'étranger ») à un choix simple b2c/b2b/b2g/mixte (contrat) ;
 * · « n / 4 » du proto → Stepper @bob/ui (C21) sur carte surface (lisible sur navy),
 *   a11y progressbar ; retour arrière possible jusqu'au preview (le proto le masquait
 *   sur l'écran final — ici le preview n'applique rien, revenir doit rester possible).
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  TRADE_PROFILES,
  deriveTradeProfile,
  type Trade,
  type TradeHighlightId,
  type VatRegime,
  type CustomerPortfolio,
} from '@bob/core';
import { themes, vault } from '@bob/tokens';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import { Card, ErrorRetry, IconTile, Stepper, font, useTheme } from '@bob/ui';
import { useCompanyMe, useProfile, useUpdateCompanyProfile } from '../src/data/hooks';
import { CheckIcon, ChevronLeftIcon, ShieldIcon, SparkIcon, SparkSmallIcon } from '../src/components/icons';
import { hasBlockingAuthoritativeDataError } from '../src/data/authoritative-query-state';

// ── Grille de métiers — icônes du proto (§METIERS), libellés = TRADE_PROFILES (exacts) ──
const TRADE_EMOJI: Record<Trade, string> = {
  plombier: '🔧',
  electricien: '⚡',
  macon: '🧱',
  peintre: '🎨',
  paysagiste: '🌿',
  consultant: '💼',
  freelance_it: '💻',
  photographe: '📷',
  coach: '🎯',
  autre: '➕',
};
const TRADES = Object.values(TRADE_PROFILES); // ordre du proto (plombier → autre)

// ── Clientèle — b2c/b2b/b2g/mixte (contrat C22), copy pédagogique par canal 2026 ──
const CLIENTELES: readonly { id: CustomerPortfolio; emoji: string; label: I18nKey; sub: I18nKey }[] = [
  { id: 'b2c', emoji: '🏠', label: 'onboard.clientB2c', sub: 'onboard.clientB2cSub' },
  { id: 'b2b', emoji: '🏢', label: 'onboard.clientB2b', sub: 'onboard.clientB2bSub' },
  { id: 'b2g', emoji: '🏛️', label: 'onboard.clientB2g', sub: 'onboard.clientB2gSub' },
  { id: 'mixte', emoji: '🔀', label: 'onboard.clientMixte', sub: 'onboard.clientMixteSub' },
];

// ── Régime TVA — 3 options réelles du domaine (VatRegime) + explication ──
const VAT_OPTIONS: readonly { id: VatRegime; label: I18nKey; sub: I18nKey }[] = [
  { id: 'franchise', label: 'onboard.vatFranchise', sub: 'onboard.vatFranchiseSub' },
  { id: 'reel_simpl', label: 'onboard.vatReelSimpl', sub: 'onboard.vatReelSimplSub' },
  { id: 'reel_normal', label: 'onboard.vatReelNormal', sub: 'onboard.vatReelNormalSub' },
];

/** Copy des repères métier dérivés (ids @bob/core → clés @bob/i18n ×3 humeurs). */
const HIGHLIGHT_KEY: Record<TradeHighlightId, I18nKey> = {
  decennale: 'onboard.hlDecennale',
  consuel: 'onboard.hlConsuel',
  retenue_garantie: 'onboard.hlRetenue',
  tva_travaux: 'onboard.hlTvaTravaux',
  cession_droits: 'onboard.hlCession',
  cra: 'onboard.hlCra',
};

/** Encadré violet « Ton espace inclura » (proto §onb2) — chips libellés proto exacts. */
function SpacePreviewBox({ items, personality }: { items: readonly string[]; personality: Personality }) {
  const { colors, overlays } = useTheme();
  return (
    <View
      style={{
        backgroundColor: vault.scanChipBg,
        borderWidth: 1,
        borderColor: vault.scanChipBorder,
        borderRadius: 15,
        padding: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 9 }}>
        <SparkSmallIcon color={vault.scanChipIcon} size={15} strokeWidth={2} />
        <Text style={[font('label', 700), { fontSize: 12.5, color: vault.scanChipIcon }]}>
          {t('onboard.tradeIncludes', { personality })}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        {items.map((label) => (
          <View
            key={label}
            style={{ backgroundColor: overlays.white10, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 5 }}
          >
            <Text style={[font('label', 600), { fontSize: 12.5, color: colors.surface }]}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** CTA blanc plein écran du proto (Commencer / Continuer / C'est bien moi). */
function PrimaryCta({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: colors.surface,
        borderRadius: 16,
        paddingVertical: 16,
        alignItems: 'center',
        opacity: disabled ? 0.65 : 1,
        transform: [{ scale: pressed && !disabled ? 0.97 : 1 }],
      })}
    >
      <Text style={[font('button'), { color: colors.ink900 }]}>{label}</Text>
    </Pressable>
  );
}

export default function Onboarding() {
  const { colors, overlays, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // Pré-remplissage depuis les sources serveur du tenant, puis écriture atomique au CTA final.
  const profileQ = useProfile();
  const companyQ = useCompanyMe();
  const updateCompanyProfile = useUpdateCompanyProfile();
  const [pickedTrade, setPickedTrade] = useState<Trade | null>(null);
  const [pickedCustomerPortfolio, setPickedCustomerPortfolio] = useState<CustomerPortfolio | null>(null);
  const [vatRegime, setVatRegime] = useState<VatRegime | null>(null);
  const [step, setStep] = useState(0); // 0 bienvenue · 1 métier · 2 clientèle · 3 TVA · 4 preview

  const trade = pickedTrade ?? profileQ.data?.trade ?? null;
  const customerPortfolio = pickedCustomerPortfolio ?? companyQ.data?.customerPortfolio ?? null;
  const effectiveVatRegime = vatRegime ?? companyQ.data?.vatRegime ?? null;
  const derived = useMemo(() => (trade === null ? null : deriveTradeProfile(trade)), [trade]);
  const sourcesReady = profileQ.data !== undefined && companyQ.data !== undefined;
  const sourcesBlockingError = hasBlockingAuthoritativeDataError([profileQ, companyQ]);
  const sourcesLoading = !sourcesReady && !sourcesBlockingError;
  const sourcesStaleError = sourcesReady && (profileQ.isError || companyQ.isError);
  const sourcesFresh = sourcesReady && !sourcesStaleError;
  const refetchSources = (): void => {
    void profileQ.refetch();
    void companyQ.refetch();
  };

  const saveAndContinue = async (): Promise<void> => {
    if (
      trade === null
      || customerPortfolio === null
      || effectiveVatRegime === null
      || updateCompanyProfile.isPending
      || !sourcesFresh
    ) return;
    try {
      await updateCompanyProfile.mutateAsync({
        trade,
        customerPortfolio,
        vatRegime: effectiveVatRegime,
      });
      router.replace('/diagnostic');
    } catch {
      // L'erreur reste portée par la mutation et affichée dans le preview. Ne jamais
      // avancer comme si les choix avaient été persistés.
    }
  };

  /** Skip honnête (« Plus tard ») : on rend la main là d'où on vient, sinon l'app. */
  const exit = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const stepLabels = [
    t('onboard.stepTrade', { personality }),
    t('onboard.stepClient', { personality }),
    t('onboard.stepVat', { personality }),
    t('onboard.stepPreview', { personality }),
  ];

  // ── Étape 0 — bienvenue (proto §onb0) ────────────────────────────────────────
  const welcome = (
    <>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            width: 78,
            height: 78,
            borderRadius: 24,
            backgroundColor: colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 26,
          }}
        >
          <SparkIcon color={colors.ink900} size={40} strokeWidth={1.9} />
        </View>
        <Text style={[font('screenH1'), { fontSize: 23, color: colors.surface, marginBottom: 10 }]}>Bob Pro</Text>
        <Text style={[font('screenH1'), { fontSize: 31, lineHeight: 34, color: colors.surface, textAlign: 'center', marginBottom: 14 }]}>
          {t('onboard.welcomeTitle', { personality })}
        </Text>
        <Text style={[font('body'), { fontSize: 15.5, lineHeight: 24, maxWidth: 300, textAlign: 'center', color: overlays.white66 }]}>
          {t('onboard.welcomeBody', { personality })}
        </Text>
      </View>
      <PrimaryCta label={t('onboard.welcomeCta', { personality })} onPress={() => setStep(1)} />
    </>
  );

  // ── Étape 1 — métier (proto §onb2 : grille 3×3, preview dès la sélection) ────
  const tradeStep = (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 18 }} showsVerticalScrollIndicator={false}>
        <Text style={[font('screenH1'), { fontSize: 25, color: colors.surface, marginBottom: 4 }]}>
          {t('onboard.tradeTitle', { personality })}
        </Text>
        <Text style={[font('sub'), { color: overlays.white60, marginBottom: 18 }]}>
          {t('onboard.tradeSub', { personality })}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {TRADES.map((p) => {
            const selected = trade === p.trade;
            return (
              <Pressable
                key={p.trade}
                accessibilityRole="button"
                accessibilityLabel={p.label}
                accessibilityState={{ selected }}
                onPress={() => setPickedTrade(p.trade)}
                style={({ pressed }) => ({ flexBasis: '31%', flexGrow: 1, opacity: pressed ? 0.85 : 1 })}
              >
                <Card
                  padding={12}
                  radius={15}
                  style={{
                    backgroundColor: selected ? overlays.white16 : overlays.white07,
                    borderWidth: 1.5,
                    borderColor: selected ? vault.scanChipIcon : overlays.white14,
                    alignItems: 'center',
                    gap: 7,
                  }}
                >
                  <IconTile tone="b2g" size={34} radius={11}>
                    <Text style={{ fontSize: 17 }}>{TRADE_EMOJI[p.trade]}</Text>
                  </IconTile>
                  <Text style={[font('label', 600), { fontSize: 12.5, color: colors.surface }]}>{p.label}</Text>
                </Card>
              </Pressable>
            );
          })}
        </View>
        {derived ? (
          <View style={{ marginTop: 18 }}>
            <SpacePreviewBox items={derived.preview} personality={personality} />
          </View>
        ) : null}
      </ScrollView>
      {derived ? <PrimaryCta label={t('onboard.continue', { personality })} onPress={() => setStep(2)} /> : null}
    </>
  );

  // ── Étape 2 — clientèle (proto §onb3, choix simple b2c/b2b/b2g/mixte) ────────
  const clienteleStep = (
    <>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text style={[font('screenH1'), { fontSize: 25, color: colors.surface, marginBottom: 4 }]}>
          {t('onboard.clientTitle', { personality })}
        </Text>
        <Text style={[font('sub'), { color: overlays.white60, marginBottom: 20 }]}>
          {t('onboard.clientSub', { personality })}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 11 }}>
          {CLIENTELES.map((c) => {
            const selected = customerPortfolio === c.id;
            return (
              <Pressable
                key={c.id}
                accessibilityRole="button"
                accessibilityLabel={t(c.label, { personality })}
                accessibilityState={{ selected }}
                onPress={() => setPickedCustomerPortfolio(c.id)}
                style={({ pressed }) => ({
                  flexBasis: '47%',
                  flexGrow: 1,
                  backgroundColor: selected || pressed ? overlays.white16 : overlays.white07,
                  borderWidth: 1.5,
                  borderColor: selected ? vault.scanChipIcon : overlays.white14,
                  borderRadius: 15,
                  padding: 16,
                  gap: 6,
                })}
              >
                <Text style={{ fontSize: 20 }}>{c.emoji}</Text>
                <Text style={[font('label', 600), { fontSize: 15, color: colors.surface }]}>
                  {t(c.label, { personality })}
                </Text>
                <Text style={[font('meta'), { fontSize: 12, color: overlays.white50 }]}>
                  {t(c.sub, { personality })}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {customerPortfolio !== null ? (
        <PrimaryCta label={t('onboard.continue', { personality })} onPress={() => setStep(3)} />
      ) : null}
    </>
  );

  // ── Étape 3 — régime TVA (contrat C22 : 3 options + pédagogie voix Bob) ──────
  const vatStep = (
    <>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text style={[font('screenH1'), { fontSize: 25, color: colors.surface, marginBottom: 4 }]}>
          {t('onboard.vatTitle', { personality })}
        </Text>
        <Text style={[font('sub'), { color: overlays.white60, marginBottom: 20 }]}>
          {t('onboard.vatSub', { personality })}
        </Text>
        <View style={{ gap: 11 }}>
          {VAT_OPTIONS.map((option) => {
            const selected = effectiveVatRegime === option.id;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityLabel={t(option.label, { personality })}
                accessibilityState={{ selected }}
                onPress={() => setVatRegime(option.id)}
                style={({ pressed }) => ({
                  backgroundColor: selected || pressed ? overlays.white16 : overlays.white07,
                  borderWidth: 1.5,
                  borderColor: selected ? vault.scanChipIcon : overlays.white14,
                  borderRadius: 15,
                  padding: 16,
                  gap: 3,
                })}
              >
                <Text style={[font('label', 600), { fontSize: 15.5, color: colors.surface }]}>
                  {t(option.label, { personality })}
                </Text>
                <Text style={[font('meta'), { fontSize: 12.5, color: overlays.white50 }]}>
                  {t(option.sub, { personality })}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {effectiveVatRegime !== null ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              marginTop: 18,
              backgroundColor: vault.scanChipBg,
              borderWidth: 1,
              borderColor: vault.scanChipBorder,
              borderRadius: 15,
              padding: 14,
              flexDirection: 'row',
              gap: 9,
            }}
          >
            <SparkSmallIcon color={vault.scanChipIcon} size={15} strokeWidth={2} />
            <Text style={[font('sub'), { flex: 1, fontSize: 13.5, lineHeight: 20, color: colors.surface }]}>
              {t(effectiveVatRegime === 'franchise' ? 'onboard.vatFranchiseNote' : 'onboard.vatReelNote', { personality })}
            </Text>
          </View>
        ) : null}
      </View>
      {effectiveVatRegime !== null ? (
        <PrimaryCta label={t('onboard.continue', { personality })} onPress={() => setStep(4)} />
      ) : null}
    </>
  );

  // ── Étape 4 — preview « ton espace {métier} » + handoff diagnostic (proto §onb4) ──
  const clienteleLabel = CLIENTELES.find((c) => c.id === customerPortfolio)?.label;
  const vatLabel = VAT_OPTIONS.find((o) => o.id === effectiveVatRegime)?.label;
  const previewStep = derived ? (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 18, flexGrow: 1, justifyContent: 'center' }} showsVerticalScrollIndicator={false}>
        <View style={{ alignItems: 'center', marginBottom: 22 }}>
          <View
            style={{
              width: 88,
              height: 88,
              borderRadius: 44,
              backgroundColor: colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 22,
            }}
          >
            <CheckIcon color={semantic.success} size={44} strokeWidth={2.6} />
          </View>
          <Text style={[font('screenH1'), { fontSize: 27, color: colors.surface, textAlign: 'center', marginBottom: 10 }]}>
            {t('onboard.previewTitle', { personality, params: { trade: derived.spaceLabel } })}
          </Text>
          <Text style={[font('body'), { fontSize: 15.5, lineHeight: 23, maxWidth: 300, textAlign: 'center', color: overlays.white66 }]}>
            {t('onboard.previewBody', { personality })}
          </Text>
        </View>
        <SpacePreviewBox items={derived.preview} personality={personality} />
        {derived.highlights.length > 0 ? (
          <View
            style={{
              marginTop: 12,
              backgroundColor: overlays.white07,
              borderWidth: 1,
              borderColor: overlays.white10,
              borderRadius: 15,
              paddingVertical: 4,
              paddingHorizontal: 14,
            }}
          >
            {derived.highlights.slice(0, 3).map((id, i, rows) => (
              <View
                key={id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingVertical: 11,
                  borderBottomWidth: i === rows.length - 1 ? 0 : 1,
                  borderBottomColor: overlays.white08,
                }}
              >
                <CheckIcon color={semantic.successOnDark} size={14} strokeWidth={2.6} />
                <Text style={[font('label', 600), { flex: 1, fontSize: 13.5, color: colors.surface }]}>
                  {t(HIGHLIGHT_KEY[id], { personality })}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {clienteleLabel !== undefined && vatLabel !== undefined ? (
          <Text style={[font('meta'), { fontSize: 12, color: overlays.white50, textAlign: 'center', marginTop: 14 }]}>
            {t(clienteleLabel, { personality })} · {t(vatLabel, { personality })}
          </Text>
        ) : null}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(updateCompanyProfile.isPending ? 'onboard.saving' : 'onboard.previewCta', { personality })}
        accessibilityState={{ disabled: updateCompanyProfile.isPending || !sourcesFresh }}
        disabled={updateCompanyProfile.isPending || !sourcesFresh}
        onPress={() => void saveAndContinue()}
        style={({ pressed }) => ({
          borderRadius: 16,
          overflow: 'hidden',
          opacity: updateCompanyProfile.isPending || !sourcesFresh ? 0.7 : 1,
          transform: [{ scale: pressed && !updateCompanyProfile.isPending && sourcesFresh ? 0.97 : 1 }],
          marginBottom: 10,
        })}
      >
        <LinearGradient
          colors={[themes.indigo.ink2, themes.indigo.ink]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          <ShieldIcon color={colors.surface} size={18} strokeWidth={2} />
          <Text style={[font('button'), { color: colors.surface }]}>
            {t(updateCompanyProfile.isPending ? 'onboard.saving' : 'onboard.previewCta', { personality })}
          </Text>
        </LinearGradient>
      </Pressable>
      {updateCompanyProfile.isError ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={[font('meta'), { color: colors.surface, textAlign: 'center', marginBottom: 8 }]}
        >
          {t('onboard.saveError', { personality })}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('onboard.later', { personality })}
        onPress={() => router.replace('/(tabs)')}
        style={{ paddingVertical: 8, alignItems: 'center' }}
      >
        <Text style={[font('label', 600), { fontSize: 14.5, color: overlays.white60 }]}>
          {t('onboard.later', { personality })}
        </Text>
      </Pressable>
    </>
  ) : (
    // Garde : preview sans métier choisi (impossible via les CTA — retour à la grille).
    tradeStep
  );

  const flowContent = step === 0
    ? welcome
    : step === 1
      ? tradeStep
      : step === 2
        ? clienteleStep
        : step === 3
          ? vatStep
          : previewStep;
  const content = step >= 1 && sourcesLoading ? (
    <View
      accessibilityRole="progressbar"
      accessibilityLiveRegion="polite"
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={[font('body'), { color: overlays.white70 }]}>
        {t('account.profileLoading', { personality })}
      </Text>
    </View>
  ) : step >= 1 && sourcesBlockingError ? (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <ErrorRetry message={t('account.dataError', { personality })} onRetry={refetchSources} />
    </View>
  ) : step >= 1 && sourcesStaleError ? (
    <>
      <View style={{ marginTop: 10 }}>
        <ErrorRetry message={t('account.dataError', { personality })} onRetry={refetchSources} />
      </View>
      {flowContent}
    </>
  ) : flowContent;

  return (
    <View style={{ flex: 1, backgroundColor: themes.marine.d1 }}>
      {/* Fond du proto (172° navy → nuit) — rampe de marque, zéro hex (cf. écarts en tête). */}
      <LinearGradient
        pointerEvents="none"
        colors={[themes.marine.d1, themes.graphite.d1]}
        start={{ x: 0.45, y: 0 }}
        end={{ x: 0.55, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View style={{ flex: 1, paddingTop: insets.top + 10, paddingHorizontal: 22, paddingBottom: insets.bottom + 16 }}>
        {/* En-tête : retour (étapes 1..4) · « Plus tard » (avant le preview, qui a le sien) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 34 }}>
          {step >= 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('onboard.back', { personality })}
              onPress={() => setStep(step - 1)}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
            >
              <ChevronLeftIcon color={overlays.white70} size={17} strokeWidth={2.2} />
              <Text style={[font('label', 600), { fontSize: 14.5, color: overlays.white70 }]}>
                {t('onboard.back', { personality })}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
          {step <= 3 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('onboard.later', { personality })}
              onPress={exit}
              hitSlop={8}
            >
              <Text style={[font('label', 600), { fontSize: 14.5, color: overlays.white60 }]}>
                {t('onboard.later', { personality })}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {/* Progression — Stepper @bob/ui (C21) sur carte surface, lisible sur navy */}
        {step >= 1 ? (
          <Card padding={10} radius={14} style={{ marginTop: 10 }}>
            <Stepper total={4} current={step - 1} labels={stepLabels} />
          </Card>
        ) : null}
        {content}
      </View>
    </View>
  );
}
