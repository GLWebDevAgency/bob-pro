/**
 * Provisioning du tenant (C24b) — session Supabase SANS app_metadata.company_id : l'app
 * n'entre PAS sur les tabs (tout endpoint tenant répondrait 403 PROVISIONING_REQUIRED).
 *
 * FLUX :
 * · snapshot d'inscription complet (user_metadata.company_snapshot, posé au signUp C24) et
 *   forme juridique connue → confirmation du régime TVA, jamais deviné depuis l'annuaire ;
 * · snapshot sans forme juridique mappée (code INSEE hors périmètre) → récap fiche +
 *   choix EXPLICITE de la forme (jamais devinée) ;
 * · aucun brouillon (SIRET passé à l'inscription) → mini-formulaire SIRET → lookup →
 *   confirmation → registerCompany ;
 * · succès → supabase.auth.refreshSession() : le JWT frais porte company_id, l'AuthGate
 *   rebascule naturellement sur l'app ;
 * · échec → message voix Bob + retry (JAMAIS de spinner infini, JAMAIS de repli démo).
 *
 * L'id de company n'est JAMAIS choisi ici : le serveur dérive company-<userId> (idempotent).
 *
 * Vague hors-lots (audit 03/08) : AuthCta/AuthField partagés, chips forme/TVA à cible 44 +
 * rôle radio annoncé, messages d'erreur DÉDIÉS (les libellés ne servent plus de messages),
 * erreurs en encre danger on-dark certifiée, H1 au cran screenH1, corps white80, fade-through
 * fail-closed entre les phases.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Siret,
  type CompanyLookupResult,
  type LegalForm,
  type VatRegime,
} from '@bob/core';
import { surfaceTint, themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { FadeIn, font, useTheme } from '@bob/ui';
import { useAuth } from '../data/auth';
import { useBobClient } from '../data/client';
import { clearNoCompanyQueries } from '../data/no-company-state';
import { supabase } from '../data/supabase';
import {
  LEGAL_FORM_LABELS,
  LEGAL_FORM_OPTIONS,
  readCompanySnapshot,
  readDraftSiret,
  registerInputFromLookup,
} from '../data/company-draft';
import { CompanyFicheCard, formatSiret } from '../components/CompanyFicheCard';
import { SparkIcon } from '../components/icons';
import { AuthCta } from '../components/auth/AuthCta';
import { AuthField } from '../components/auth/AuthField';
import {
  discriminateSiretLookupError,
  type SiretLookupFailureReason,
} from '../lib/siret-lookup-error';

type Phase = 'auto' | 'siret' | 'confirm';

const VAT_OPTIONS: readonly { id: VatRegime; label: I18nKey }[] = [
  { id: 'franchise', label: 'onboard.vatFranchise' },
  { id: 'reel_simpl', label: 'onboard.vatReelSimpl' },
  { id: 'reel_normal', label: 'onboard.vatReelNormal' },
];

/**
 * Motif du discriminateur PARTAGÉ (`lib/siret-lookup-error`) → copy auth — même table que
 * LoginScreen : l'îlot dupliqué est remplacé par le module commun (spec §8).
 */
const AUTH_SIRET_ERROR_KEY: Record<SiretLookupFailureReason, I18nKey> = {
  invalid: 'auth.errSiretInvalid',
  not_found: 'auth.errSiretNotFound',
  rate_limited: 'auth.errRateLimited',
  contract: 'auth.errLookupDown',
  lookup_down: 'auth.errLookupDown',
  unknown: 'auth.errUnknown',
};

const lookupErrorKey = (error: unknown): I18nKey =>
  AUTH_SIRET_ERROR_KEY[discriminateSiretLookupError(error).reason];

/** Chip de choix (forme juridique / régime TVA) — cible ≥ 44 pt, rôle radio annoncé. */
function ChoicePill({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors, overlays } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={{
        // Cible 44 réelle : les chips ≈36 px arrivaient au geste fondateur du premier
        // lancement, gants aux mains — la hauteur monte, la géométrie visuelle reste.
        minHeight: 44,
        justifyContent: 'center',
        backgroundColor: selected ? colors.surface : overlays.white07,
        borderWidth: 1,
        borderColor: selected ? colors.surface : overlays.white16,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 9,
      }}
    >
      <Text
        style={[
          font('label', 600),
          { color: selected ? colors.ink900 : overlays.white70 },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ProvisioningScreen() {
  const { session, signOut } = useAuth();
  const client = useBobClient();
  const queryClient = useQueryClient();
  const { colors, overlays, personality } = useTheme();
  const insets = useSafeAreaInsets();

  const say = (key: I18nKey): string => t(key, { personality });

  // Snapshot/brouillon relus UNE fois au montage : la session change à chaque refresh de token.
  const draft = useRef({
    snapshot: readCompanySnapshot(session),
    siret: readDraftSiret(session),
  }).current;

  const [phase, setPhase] = useState<Phase>(draft.snapshot || draft.siret ? 'auto' : 'siret');
  const [company, setCompany] = useState<CompanyLookupResult | null>(draft.snapshot);
  const [legalForm, setLegalForm] = useState<LegalForm | null>(draft.snapshot?.legalForm ?? null);
  const [vatRegime, setVatRegime] = useState<VatRegime | null>(null);
  const [siret, setSiret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function register(
    lookup: CompanyLookupResult,
    form: LegalForm,
    confirmedVatRegime: VatRegime,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    const r = await client.registerCompany(
      registerInputFromLookup(lookup, form, confirmedVatRegime),
    );
    if (!r.ok) {
      setBusy(false);
      setError(say('auth.provisioningError'));
      setPhase('confirm'); // état honnête : fiche visible + retry, pas de spinner infini
      return;
    }
    // Le JWT courant ne porte pas encore company_id : on force un refresh — le nouveau token
    // est minté depuis le user à jour (app_metadata écrit par le serveur) et l'AuthGate rebascule.
    const refreshed = await supabase?.auth.refreshSession();
    setBusy(false);
    if (!refreshed || refreshed.error) {
      setError(say('auth.provisioningError'));
      setPhase('confirm'); // registerCompany est idempotent : le retry rejoue tout sans risque
      return;
    }
    // Cas NO_COMPANY (JWT avec company_id mais base sans ligne — cet écran affiché par le signal
    // serveur) : la company vient d'être recréée → purge des queries marquées, le signal retombe
    // et l'AuthGate rend les tabs qui refetchent sur un cache propre.
    clearNoCompanyQueries(queryClient);
  }

  async function lookupThenContinue(rawSiret: string): Promise<void> {
    setBusy(true);
    setError(null);
    const r = await client.lookupCompany(rawSiret);
    if (!r.ok) {
      setBusy(false);
      setError(say(lookupErrorKey(r.error)));
      setPhase('siret');
      return;
    }
    setCompany(r.value);
    setLegalForm(r.value.legalForm);
    setBusy(false);
    setPhase('confirm'); // forme éventuellement connue, régime TVA toujours confirmé par l'utilisateur
  }

  // Chemin automatique au montage : brouillon d'inscription → espace créé sans re-saisie.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    if (draft.snapshot) {
      setPhase('confirm');
    } else if (draft.siret) {
      void lookupThenContinue(draft.siret);
    }
  }, []);

  async function submitSiret(): Promise<void> {
    if (busy) return;
    const v = Siret.of(siret);
    if (!v.ok) {
      setError(say('auth.errSiretInvalid'));
      return;
    }
    await lookupThenContinue(v.value.value);
  }

  async function submitConfirm(): Promise<void> {
    if (busy || !company) return;
    if (!legalForm) {
      // Message d'erreur DÉDIÉ — le libellé du champ ne sert plus de message.
      setError(say('auth.errLegalFormRequired'));
      return;
    }
    if (!vatRegime) {
      setError(say('auth.errVatRequired'));
      return;
    }
    await register(company, legalForm, vatRegime);
  }

  const header = (
    <View style={{ gap: 14, marginBottom: 6 }}>
      <View
        style={{
          width: 60,
          height: 60,
          borderRadius: 19,
          backgroundColor: colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SparkIcon color={colors.ink900} size={32} strokeWidth={1.9} />
      </View>
      <Text style={[font('screenH1'), { lineHeight: 30, color: colors.surface }]}>
        {say('auth.provisioningTitle')}
      </Text>
    </View>
  );

  const errorLine = error ? (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      // Encre danger on-dark CERTIFIÉE du kit matière — dangerVivid ≈4,3:1 échouait l'AA.
      style={[font('sub'), { color: surfaceTint.dark.danger.ink }]}
    >
      {error}
    </Text>
  ) : null;

  const content =
    phase === 'auto' ? (
      <View style={{ gap: 14 }}>
        {header}
        <Text style={[font('body'), { lineHeight: 22, color: overlays.white80 }]}>
          {say('auth.provisioningBody')}
        </Text>
        {/* Tout échec quitte cette phase (confirm/siret + retry) : jamais de spinner infini. */}
        {busy ? <ActivityIndicator color={colors.surface} style={{ alignSelf: 'flex-start' }} /> : null}
      </View>
    ) : phase === 'siret' ? (
      <View style={{ gap: 14 }}>
        {header}
        <Text style={[font('body'), { lineHeight: 22, color: overlays.white80 }]}>
          {say('auth.provisioningSiretIntro')}
        </Text>
        <AuthField
          label={say('auth.stepSiret')}
          value={formatSiret(siret)}
          onChangeText={(raw) => setSiret(raw.replace(/\D/g, '').slice(0, 14))}
          placeholder={say('auth.siretPlaceholder')}
          keyboardType="number-pad"
          returnKeyType="done"
          onSubmitEditing={() => void submitSiret()}
          error={error !== null}
        />
        {errorLine}
        <AuthCta label={say('auth.siretCta')} busy={busy} onPress={() => void submitSiret()} />
      </View>
    ) : (
      <View style={{ gap: 14 }}>
        {header}
        {company ? <CompanyFicheCard company={company} /> : null}
        {company && !company.legalForm ? (
          <View style={{ gap: 8 }}>
            <Text style={[font('label', 600), { color: overlays.white70 }]}>
              {say('auth.provisioningLegalFormLabel')}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {LEGAL_FORM_OPTIONS.map((form) => (
                <ChoicePill
                  key={form}
                  label={LEGAL_FORM_LABELS[form]}
                  selected={legalForm === form}
                  onPress={() => {
                    setLegalForm(form);
                    setError(null);
                  }}
                />
              ))}
            </View>
          </View>
        ) : null}
        <View style={{ gap: 8 }}>
          <Text style={[font('label', 600), { color: overlays.white70 }]}>
            {say('onboard.vatTitle')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {VAT_OPTIONS.map((option) => (
              <ChoicePill
                key={option.id}
                label={say(option.label)}
                selected={vatRegime === option.id}
                onPress={() => {
                  setVatRegime(option.id);
                  setError(null);
                }}
              />
            ))}
          </View>
        </View>
        {errorLine}
        <AuthCta
          label={error ? say('auth.provisioningRetry') : say('auth.provisioningConfirmCta')}
          busy={busy}
          onPress={() => void submitConfirm()}
        />
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: themes.marine.d1 }}>
      {/* Même rampe navy→nuit que l'auth C24 (tokens, zéro hex local). */}
      <LinearGradient
        pointerEvents="none"
        colors={[themes.marine.d1, themes.graphite.d1]}
        start={{ x: 0.45, y: 0 }}
        end={{ x: 0.55, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingTop: insets.top + 10,
          paddingHorizontal: 24,
          paddingBottom: insets.bottom + 20,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Fade-through fail-closed entre les phases (auto → siret → confirm). */}
        <FadeIn key={phase}>{content}</FadeIn>
        {/* Échappatoire honnête : jamais bloqué sur cet écran. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={say('auth.provisioningSignOut')}
          onPress={() => void signOut()}
          hitSlop={8}
          style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center', marginTop: 16 }}
        >
          <Text style={[font('label', 600), { color: overlays.white70 }]}>
            {say('auth.provisioningSignOut')}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
