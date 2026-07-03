/**
 * AppHeaderNavy — en-tête dégradé de l'accueil (COMPONENT_SPECS.md §2).
 * Seul en-tête dégradé de l'app : LinearGradient 168deg du thème actif,
 * 2 glows radiaux doux fondus dans le navy (indigo top-right pulsé · vert bottom-left),
 * topbar (avatar dégradé bleu→indigo / date+société / cloche), titre + sous-titre.
 * Zéro hex/rgba : tout vient de useTheme() (overlays, colors, theme) et de @bob/tokens.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { avatarGradient, frame } from '@bob/tokens';
import { rgbaStop } from './halo-stops';
import { font, parseGradient, useTheme } from '../theme';

export interface AppHeaderNavyProps {
  /** Inset haut réel du device (défaut : frame.safeTop du proto). */
  safeTop?: number;
  /** Date du jour, affichée en eyebrow (ex. « Mardi 2 juillet »). */
  dateLabel: string;
  /** Nom de la société de l'artisan. */
  companyName: string;
  /** Initiales de l'utilisateur dans l'avatar rond. */
  initials: string;
  /** Titre héros 30 (le briefing du jour). */
  title: string;
  /** Sous-titre 15 sur voile blanc .66. */
  subtitle: string;
  onAvatarPress?: () => void;
  onBellPress?: () => void;
  /** Icône cloche injectée (aucune lib d'icônes dans @bob/ui). */
  bellIcon?: ReactNode;
  /** Affiche le point non-lu sur la cloche. */
  hasUnread?: boolean;
}

/** Glow radial décoratif : couleur→transparent à 70 % (réf dc.html), aucun bord net. */
function Halo({
  id,
  stops,
  size,
  style,
}: {
  id: string;
  stops: readonly [string, string];
  size: number;
  style: StyleProp<ViewStyle>;
}) {
  const inner = rgbaStop(stops[0]);
  const outer = rgbaStop(stops[1]);
  const half = size / 2;
  return (
    <Svg width={size} height={size} pointerEvents="none" style={[{ position: 'absolute' }, style]}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor={inner.color} stopOpacity={inner.opacity} />
          <Stop offset="70%" stopColor={outer.color} stopOpacity={0} />
          <Stop offset="100%" stopColor={outer.color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={half} cy={half} r={half} fill={`url(#${id})`} />
    </Svg>
  );
}

/** Pulse lent du glow indigo — opacité 0.55↔0.9 sur 6 s (cpGlow du proto), thread natif. */
function usePulse(): Animated.Value {
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 3000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: 3000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return pulse;
}

export function AppHeaderNavy({
  safeTop = frame.safeTop,
  dateLabel,
  companyName,
  initials,
  title,
  subtitle,
  onAvatarPress,
  onBellPress,
  bellIcon,
  hasUnread = false,
}: AppHeaderNavyProps) {
  const { grad, theme, colors, overlays } = useTheme();
  const header = parseGradient(grad.header);
  const avatar = parseGradient(avatarGradient);
  const pulse = usePulse();

  return (
    <LinearGradient
      colors={header.colors}
      start={header.start}
      end={header.end}
      {...(header.locations ? { locations: header.locations } : {})}
      style={{
        paddingTop: safeTop,
        paddingHorizontal: 20,
        paddingBottom: 46,
        borderBottomLeftRadius: 30,
        borderBottomRightRadius: 30,
        overflow: 'hidden',
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={{ position: 'absolute', top: -70, right: -40, opacity: pulse }}
      >
        <Halo id="bob-header-halo-indigo" stops={overlays.haloIndigo} size={230} style={{ position: 'relative' }} />
      </Animated.View>
      <Halo
        id="bob-header-halo-green"
        stops={overlays.haloGreenDeep}
        size={200}
        style={{ bottom: -90, left: -50 }}
      />

      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Profil de ${companyName}`}
          hitSlop={6}
          {...(onAvatarPress ? { onPress: onAvatarPress } : {})}
        >
          <LinearGradient
            colors={avatar.colors}
            start={avatar.start}
            end={avatar.end}
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ ...font('cardTitle'), fontSize: 14, color: colors.surface }}>
              {initials}
            </Text>
          </LinearGradient>
        </Pressable>

        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={[font('eyebrow', 600), { fontSize: 11, letterSpacing: 0.3, color: overlays.white60 }]}>
            {dateLabel}
          </Text>
          <Text style={[font('label'), { color: colors.surface, marginTop: 2 }]}>
            {companyName}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Notifications"
          accessibilityState={{ selected: hasUnread }}
          hitSlop={4}
          {...(onBellPress ? { onPress: onBellPress } : {})}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: overlays.white10,
            borderWidth: 1,
            borderColor: overlays.white14,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {bellIcon}
          {hasUnread ? (
            <View
              style={{
                position: 'absolute',
                top: 8,
                right: 9,
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: overlays.unreadDot,
                borderWidth: 2,
                borderColor: theme.d2,
              }}
            />
          ) : null}
        </Pressable>
      </View>

      <Text style={[font('pageTitle'), { color: colors.surface, marginTop: 20 }]}>{title}</Text>
      <Text style={{ ...font('body'), fontSize: 15, color: overlays.white66, marginTop: 6 }}>
        {subtitle}
      </Text>
    </LinearGradient>
  );
}
