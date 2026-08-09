import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  Animated,
  AccessibilityInfo,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { shadowNative, themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { Button, font, useReduceMotion, useTheme } from '@bob/ui';
import { useAgentAccessLayout, useAgentContext, useAgentSession } from '../agent';
import { useSubscription } from '../data/hooks';
import { CloseIcon, MicIcon, SparkIcon } from './icons';
import {
  composeGlobalBobSilentIssueAlert,
  deriveGlobalBobAccessibilityAnnouncement,
  deriveGlobalBobAccessibilityLiveRegion,
} from './global-bob-access-a11y';
import {
  deriveGlobalBobAccessHorizontalLayout,
  GLOBAL_BOB_ACCESS_SIZE,
} from './global-bob-access-layout';
import {
  advanceGlobalBobSessionStopFence,
  deriveGlobalBobRecoveryPresentation,
  deriveGlobalBobSessionStopReason,
  isBobEntryRoute,
  isGlobalBobSubscriptionVerified,
} from './global-bob-access-session-policy';
import { GlobalBobTextRecoveryAction } from './GlobalBobTextRecoveryAction';
import { ConversationTimeZoneSheet } from './ConversationTimeZoneSheet';
import { RealtimeDiagnosticTraceSheet } from './RealtimeDiagnosticTraceSheet';
import { useBobOverlayMetrics } from './use-bob-aware-scroll-insets';

const SIZE = GLOBAL_BOB_ACCESS_SIZE;

export function GlobalBobAccess() {
  const { colors, controls, semantic, personality } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const context = useAgentContext();
  const layout = useAgentAccessLayout();
  const session = useAgentSession();
  const router = useRouter();
  const subscription = useSubscription();
  const reduceMotion = useReduceMotion();
  const { bottom } = useBobOverlayMetrics();
  const pulse = useRef(new Animated.Value(0)).current;
  const lastIosAnnouncement = useRef<string | null>(null);
  const sessionStopLatched = useRef(false);

  const activeMotion =
    session.active && (session.phase === 'listening' || session.phase === 'speaking');
  useEffect(() => {
    if (!activeMotion || reduceMotion) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 850, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 850, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [activeMotion, pulse, reduceMotion]);

  // Le wizard facture possede sa propre oreille. L'Assistant rend le meme etat global
  // directement dans son composer : aucun bouton superpose, aucun deuxieme listener.
  const ownsItsVoiceChrome = pathname === '/assistant' || pathname === '/voix';
  const { active: sessionActive, stopForPolicy } = session;

  // Une réponse en cache + un refetch en erreur ne confirme plus un droit potentiellement révoqué.
  // Les deux surfaces Live partagent exactement la capacité `voice_live`.
  const subscriptionVerified = isGlobalBobSubscriptionVerified({
    hasPayload: subscription.data !== undefined,
    failed: subscription.isError,
  });
  const entitled = subscriptionVerified
    && (subscription.data?.features.includes('voice_live') ?? false);
  const entitlementUnavailable = subscription.isError;
  const sessionStopReason = deriveGlobalBobSessionStopReason({
    subscriptionVerified,
    entitled,
    pathname,
  });
  useLayoutEffect(() => {
    const transition = advanceGlobalBobSessionStopFence({
      latched: sessionStopLatched.current,
      sessionActive,
      stopReason: sessionStopReason,
    });
    sessionStopLatched.current = transition.latched;
    if (transition.shouldStop && sessionStopReason !== null) {
      stopForPolicy(sessionStopReason);
    }
  }, [sessionActive, sessionStopReason, stopForPolicy]);
  const stateKey: I18nKey =
    session.phase === 'listening'
      ? 'agent.global.listening'
      : session.phase === 'thinking'
        ? 'agent.global.thinking'
        : session.phase === 'speaking'
          ? 'agent.global.speaking'
          : session.phase === 'error'
            ? 'agent.global.error'
            : 'agent.global.idle';
  const stateLabel = t(stateKey, { personality });
  // `entitlementUnavailable` laisse Bob visible quand l'abonnement n'a pas pu être lu — un filet
  // qui, sur les parcours d'entrée, se retournait contre nous : l'appel échoue par construction
  // (pas encore de tenant), donc le bouton s'affichait précisément là où Bob ne sert à rien.
  const visible = !(
    (!entitled && !entitlementUnavailable) ||
    layout.hidden ||
    ownsItsVoiceChrome ||
    isBobEntryRoute(pathname)
  );
  const recoveryPresentation = deriveGlobalBobRecoveryPresentation({
    response: session.response,
    active: session.active,
    reviewRequired: session.reviewRequired,
    hasHandoff: session.handoff !== null,
    issue: session.issue,
  });
  const recoveryAction = recoveryPresentation.action;
  const silentIssueAlert = recoveryPresentation.cardVisible && session.phase === 'error'
    ? composeGlobalBobSilentIssueAlert({
        response: session.response,
        fallbackStateLabel: stateLabel,
        recoveryActionLabel: recoveryAction === 'write_in_assistant'
          ? t('agent.global.writeInAssistant', { personality })
          : null,
      })
    : null;
  const accessibilityAnnouncementInput = {
    visible,
    announceActiveState: session.active
      && (session.phase === 'listening' || session.phase === 'thinking'),
    stateLabel,
    silentAlert: entitlementUnavailable
      ? t('agent.global.entitlementError', { personality })
      : silentIssueAlert,
  } as const;
  const iosAnnouncement = deriveGlobalBobAccessibilityAnnouncement(
    accessibilityAnnouncementInput,
  );
  const androidLiveRegion = deriveGlobalBobAccessibilityLiveRegion(
    accessibilityAnnouncementInput,
  );
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    if (iosAnnouncement === null) {
      lastIosAnnouncement.current = null;
      return undefined;
    }
    if (lastIosAnnouncement.current === iosAnnouncement) return undefined;
    lastIosAnnouncement.current = iosAnnouncement;
    const timer = setTimeout(() => AccessibilityInfo.announceForAccessibility(iosAnnouncement), 0);
    return () => clearTimeout(timer);
  }, [iosAnnouncement]);

  const sessionDecisionSheets = (
    <>
      <RealtimeDiagnosticTraceSheet
        disclosure={session.diagnosticTrace}
        confirmationPending={session.diagnosticTraceConfirmationPending}
        onConfirm={session.confirmDiagnosticTrace}
        onCancel={session.cancelDiagnosticTrace}
      />
      <ConversationTimeZoneSheet
        state={session.diagnosticTraceConfirmationPending ? null : session.timeZoneConfirmation}
        onConfirm={(timeZone) => void session.confirmConversationTimeZone(timeZone)}
        onRedetect={session.redetectConversationTimeZone}
        onCancel={session.cancelTimeZoneConfirmation}
      />
    </>
  );

  if (!visible) return sessionDecisionSheets;

  // Bob possède un ancrage spatial stable : toujours à gauche, après la safe-area. Une session
  // qui démarre ne déplace donc plus l'orbe d'un bord à l'autre et la carte s'ouvre sur le même axe.
  const horizontal = deriveGlobalBobAccessHorizontalLayout({
    windowWidth,
    safeAreaLeft: insets.left,
    safeAreaRight: insets.right,
  });
  // Seule une ENTITÉ identifiée mérite « Je vois : … » — le slug d'écran est technique.
  const contextLabel = context.entities[0]?.label ?? null;
  const cardHeaderLabel = contextLabel !== null
    ? t('agent.global.context', { personality, params: { context: contextLabel } })
    : stateLabel;
  const accessibleCardHeaderLabel = cardHeaderLabel === stateLabel
    ? stateLabel
    : `${cardHeaderLabel}. ${stateLabel}`;
  const accessibleLiveCardLabel = androidLiveRegion === 'assertive' && silentIssueAlert !== null
    ? silentIssueAlert
    : accessibleCardHeaderLabel;
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });

  if (entitlementUnavailable) {
    return (
      <>
        {sessionDecisionSheets}
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: horizontal.left,
            bottom,
            zIndex: 50,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('agent.global.entitlementError', { personality })}
            accessibilityHint={t('agent.global.entitlementRetry', { personality })}
            accessibilityLiveRegion="polite"
            onPress={() => void subscription.refetch()}
            style={({ pressed }) => ({
              width: SIZE,
              height: SIZE,
              borderRadius: 17,
              backgroundColor: semantic.dangerBg,
              borderWidth: 1,
              borderColor: semantic.danger,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ scale: pressed ? 0.95 : 1 }],
              ...shadowNative.e2,
            })}
          >
            <SparkIcon color={semantic.danger} size={21} strokeWidth={2} />
          </Pressable>
        </View>
      </>
    );
  }

  return (
    <>
      {sessionDecisionSheets}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: horizontal.left,
          bottom,
          zIndex: 50,
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        {recoveryPresentation.cardVisible ? (
          <View
            accessibilityLiveRegion="none"
            style={{
              width: horizontal.maxCardWidth,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: controls.cardBorder,
              backgroundColor: colors.surface,
              padding: 12,
              ...shadowNative.e2,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text
                accessibilityLabel={accessibleLiveCardLabel}
                accessibilityLiveRegion={androidLiveRegion}
                style={[font('meta', 700), { color: semantic.ai, flex: 1 }]}
                numberOfLines={1}
              >
                {cardHeaderLabel}
              </Text>
              {session.response !== null && !session.active ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('agent.global.dismiss', { personality })}
                  hitSlop={8}
                  onPress={session.dismissResponse}
                  style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                >
                  <CloseIcon color={colors.slate500} size={14} />
                </Pressable>
              ) : null}
            </View>
            <Text style={[font('sub'), { color: colors.ink800, lineHeight: 19 }]} numberOfLines={4}>
              {session.response ?? stateLabel}
            </Text>
            {session.active ? (
              <View style={{ marginTop: 8, alignSelf: 'stretch' }}>
                <Button
                  title={t('agent.global.stop', { personality })}
                  variant="secondary"
                  radius={12}
                  onPress={session.stop}
                />
              </View>
            ) : null}
            {recoveryAction === 'continue_in_assistant' ? (
              <>
                <Text style={[font('meta'), { color: semantic.warning, marginTop: 6 }]}>
                  {t('agent.global.reviewRequired', { personality })}
                </Text>
                {/* S4 — CONTINUITÉ MAINS-LIBRES : un VRAI bouton (affordance pleine, cible 44+),
                    pas un lien texte — la suite du geste vocal mérite le CTA le plus lisible. */}
                <View style={{ marginTop: 8, alignSelf: 'stretch' }}>
                  <Button
                    title={t('agent.global.continueInAssistant', { personality })}
                    variant="ai"
                    radius={12}
                    onPress={() => {
                      // Le run, sa proposition opaque, son contexte et son historique restent dans
                      // le provider mémoire. Rien de sensible n'entre dans l'URL et la commande
                      // anaphorique n'est jamais rejouée depuis zéro.
                      const handoff = session.handoff;
                      if (handoff === null) return;
                      session.requestHandoff(handoff.id);
                      router.push('/(tabs)/assistant');
                    }}
                  />
                </View>
              </>
            ) : null}
            <GlobalBobTextRecoveryAction
              visible={recoveryAction === 'write_in_assistant'}
              personality={personality}
              navigate={(route) => router.push(route)}
            />
          </View>
        ) : null}

        <Animated.View style={{ transform: [{ scale }] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(
              session.active ? 'agent.global.stop' : 'agent.global.idle',
              { personality },
            )}
            accessibilityHint={t(session.active ? 'agent.global.stop' : 'agent.global.idle', {
              personality,
            })}
            accessibilityState={{ selected: session.active, busy: session.phase === 'thinking' }}
            hitSlop={8}
            onPress={session.toggle}
            style={({ pressed }) => ({
              width: SIZE,
              height: SIZE,
              minWidth: 44,
              minHeight: 44,
              borderRadius: 17,
              overflow: 'hidden',
              transform: [{ scale: pressed ? 0.95 : 1 }],
              ...shadowNative.e3,
            })}
          >
            <LinearGradient
              colors={[semantic.ai, themes.indigo.d2]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
            >
              {session.active ? (
                <View
                  style={{
                    width: 15,
                    height: 15,
                    borderRadius: 3,
                    backgroundColor: colors.surface,
                  }}
                />
              ) : session.phase === 'thinking' || session.phase === 'speaking' ? (
                <SparkIcon color={colors.surface} size={22} strokeWidth={2} />
              ) : (
                <MicIcon color={colors.surface} size={22} />
              )}
            </LinearGradient>
          </Pressable>
        </Animated.View>
      </View>
    </>
  );
}
