/**
 * AppHeaderNavy — en-tête dégradé de l'accueil (COMPONENT_SPECS.md §2).
 * Seul en-tête dégradé de l'app : LinearGradient 168deg du thème actif,
 * 2 halos radiaux décoratifs, topbar (avatar / date+société / cloche), titre + sous-titre.
 * Zéro hex/rgba : tout vient de useTheme() (overlays, colors, theme) et de @bob/tokens (frame).
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { frame } from '@bob/tokens';
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

/** Halo radial décoratif (pointerEvents none) — couleurs = overlays.halo*. */
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
  const half = size / 2;
  return (
    <Svg
      width={size}
      height={size}
      pointerEvents="none"
      style={[{ position: 'absolute' }, style]}
    >
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor={stops[0]} />
          <Stop offset="100%" stopColor={stops[1]} />
        </RadialGradient>
      </Defs>
      <Circle cx={half} cy={half} r={half} fill={`url(#${id})`} />
    </Svg>
  );
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
  const avatar = parseGradient(grad.cta);

  return (
    <LinearGradient
      colors={header.colors}
      start={header.start}
      end={header.end}
      style={{
        paddingTop: safeTop,
        paddingHorizontal: 20,
        paddingBottom: 46,
        borderBottomLeftRadius: 30,
        borderBottomRightRadius: 30,
        overflow: 'hidden',
      }}
    >
      <Halo
        id="bob-header-halo-indigo"
        stops={overlays.haloIndigo}
        size={280}
        style={{ top: -110, right: -70 }}
      />
      <Halo
        id="bob-header-halo-green"
        stops={overlays.haloGreen}
        size={240}
        style={{ bottom: -100, left: -70 }}
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
          <Text style={[font('eyebrow'), { color: overlays.white60 }]}>{dateLabel}</Text>
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
                right: 8,
                width: 9,
                height: 9,
                borderRadius: 5,
                backgroundColor: overlays.unreadDot,
                borderWidth: 1.5,
                borderColor: theme.d1,
              }}
            />
          ) : null}
        </Pressable>
      </View>

      <Text style={[font('pageTitle'), { color: colors.surface, marginTop: 22 }]}>{title}</Text>
      <Text style={{ ...font('body'), fontSize: 15, color: overlays.white66, marginTop: 6 }}>
        {subtitle}
      </Text>
    </LinearGradient>
  );
}
