import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Keyboard, Platform, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname, useRouter, useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { patterns, shadowNative, themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { font, useTheme } from '@bob/ui';
import { useAgentAccessLayout, useAgentContext, useAgentSession } from '../agent';
import { useSubscription } from '../data/hooks';
import { CloseIcon, MicIcon, SparkIcon } from './icons';

const SIZE = 56;

function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => subscription.remove();
  }, []);
  return reduced;
}

export function GlobalBobAccess() {
  const { colors, controls, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  const pathname = usePathname();
  const context = useAgentContext();
  const layout = useAgentAccessLayout();
  const session = useAgentSession();
  const router = useRouter();
  const subscription = useSubscription();
  const reduceMotion = useReduceMotion();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const pulse = useRef(new Animated.Value(0)).current;

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

  useEffect(() => {
    // iOS anime le clavier : Will* évite que le bouton saute APRÈS coup ; Android n'émet que Did*.
    const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (event) =>
      setKeyboardHeight(event.endCoordinates.height),
    );
    const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setKeyboardHeight(0),
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  // Le wizard facture possede sa propre oreille. L'Assistant rend le meme etat global
  // directement dans son composer : aucun bouton superpose, aucun deuxieme listener.
  const ownsItsVoiceChrome = pathname === '/assistant' || pathname === '/voix';
  const { active: sessionActive, stop: stopSession } = session;
  useEffect(() => {
    if (pathname === '/voix' && sessionActive) stopSession();
  }, [pathname, sessionActive, stopSession]);

  const entitled = subscription.data?.features.includes('ai_assistant') ?? false;
  if (!entitled || layout.hidden || pathname === '/gallery' || ownsItsVoiceChrome) return null;

  const inTabs = segments[0] === '(tabs)';
  const tabClearance =
    patterns.bottomTabBar.padding[0] +
    62 +
    Math.max(insets.bottom, patterns.bottomTabBar.padding[2]) +
    8;
  const bottom =
    (inTabs ? tabClearance : insets.bottom + 18) + (layout.bottomAvoidance ?? 0) + keyboardHeight;
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
  // Seule une ENTITÉ identifiée mérite « Je vois : … » — le slug d'écran est technique.
  const contextLabel = context.entities[0]?.label ?? null;
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 18,
        bottom,
        zIndex: 50,
        alignItems: 'flex-start',
        gap: 8,
      }}
    >
      {session.response !== null || session.active ? (
        <View
          accessibilityLiveRegion={session.phase === 'error' ? 'assertive' : 'polite'}
          style={{
            width: 290,
            maxWidth: '86%',
            borderRadius: 16,
            borderWidth: 1,
            borderColor: controls.cardBorder,
            backgroundColor: colors.surface,
            padding: 12,
            ...shadowNative.e2,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[font('meta', 700), { color: semantic.ai, flex: 1 }]} numberOfLines={1}>
              {contextLabel !== null
                ? t('agent.global.context', { personality, params: { context: contextLabel } })
                : stateLabel}
            </Text>
            {session.response !== null && !session.active ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('agent.global.dismiss', { personality })}
                hitSlop={8}
                onPress={session.dismissResponse}
                style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
              >
                <CloseIcon color={colors.slate500} size={14} />
              </Pressable>
            ) : null}
          </View>
          <Text style={[font('sub'), { color: colors.ink800, lineHeight: 19 }]} numberOfLines={4}>
            {session.response ?? stateLabel}
          </Text>
          {session.reviewRequired ? (
            <>
              <Text style={[font('meta'), { color: semantic.warning, marginTop: 6 }]}>
                {t('agent.global.reviewRequired', { personality })}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('agent.global.continueInAssistant', { personality })}
                hitSlop={8}
                onPress={() => {
                  // La demande est REJOUÉE dans le fil complet de l'Assistant (?prompt= la
                  // soumet une fois) : boutons Valider/Annuler, diff et questions structurées
                  // y existent — l'overlay S1 reste lecture seule.
                  const message = session.transcript;
                  session.dismissResponse();
                  router.push(
                    message
                      ? { pathname: '/(tabs)/assistant', params: { prompt: message } }
                      : '/(tabs)/assistant',
                  );
                }}
                style={{ marginTop: 8, alignSelf: 'flex-start' }}
              >
                <Text style={[font('meta', 700), { color: semantic.ai }]}>
                  {t('agent.global.continueInAssistant', { personality })} →
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}

      <Animated.View style={{ transform: [{ scale }] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={stateLabel}
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
            borderRadius: 19,
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
            {session.phase === 'thinking' || session.phase === 'speaking' ? (
              <SparkIcon color={colors.surface} size={22} strokeWidth={2} />
            ) : (
              <MicIcon color={colors.surface} size={22} />
            )}
          </LinearGradient>
        </Pressable>
      </Animated.View>
    </View>
  );
}
