import { type ReactNode } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  type ViewStyle,
  type TextStyle,
  type StyleProp,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as tokens from '@bob/tokens';
import { formatEUR } from '@bob/core';
import { useTheme, parseGradient } from '../../theme';

const typeScale = tokens.type;
const shadowNative = tokens.shadowNative;

type ScaleKey = keyof typeof typeScale;

/** Convertit une entrée de l'échelle typographique des tokens en TextStyle RN. */
export function font(key: ScaleKey): TextStyle {
  const t = typeScale[key];
  const style: TextStyle = { fontSize: t.size, fontWeight: String(t.weight) as TextStyle['fontWeight'] };
  if ('tracking' in t && typeof t.tracking === 'number') style.letterSpacing = t.tracking;
  if ('uppercase' in t && t.uppercase) style.textTransform = 'uppercase';
  return style;
}

// ── Eyebrow (sur-titre) ───────────────────────────────────────────────
export function Eyebrow({ children, color }: { children: ReactNode; color?: string }) {
  const { colors } = useTheme();
  return <Text style={[font('eyebrow'), { color: color ?? colors.slate400 }]}>{children}</Text>;
}

// ── SectionHeader ─────────────────────────────────────────────────────
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <Text style={[font('section'), { color: colors.ink800 }]}>{title}</Text>
      {action}
    </View>
  );
}

// ── MoneyText (tabular-nums) ──────────────────────────────────────────
export function MoneyText({
  cents,
  variant = 'body',
  color,
}: {
  cents: number;
  variant?: 'hero' | 'big' | 'body';
  color?: string;
}) {
  const { colors } = useTheme();
  const key: ScaleKey = variant === 'hero' ? 'heroNum' : variant === 'big' ? 'bigNum' : 'body';
  return (
    <Text style={[font(key), { color: color ?? colors.ink900, fontVariant: ['tabular-nums'] }]}>{formatEUR(cents)}</Text>
  );
}

// ── Card ──────────────────────────────────────────────────────────────
export function Card({
  children,
  elevation = 'e1',
  style,
}: {
  children: ReactNode;
  elevation?: 'e1' | 'e2';
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, radius } = useTheme();
  return (
    <View
      style={[
        { backgroundColor: colors.surface, borderRadius: radius.card, padding: 16, borderWidth: 1, borderColor: colors.line },
        shadowNative[elevation],
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ── Button ────────────────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'secondary' | 'ai' | 'danger';
export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { grad, colors, semantic, radius } = useTheme();
  const base: ViewStyle = {
    height: 52,
    borderRadius: radius.cardLg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    opacity: disabled ? 0.5 : 1,
  };
  const label = (c: string) => <Text style={[font('button'), { color: c }]}>{loading ? '…' : title}</Text>;

  if (variant === 'primary') {
    const g = parseGradient(grad.cta);
    return (
      <Pressable onPress={disabled ? undefined : onPress} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }}>
        <LinearGradient colors={g.colors} start={g.start} end={g.end} style={base}>
          {loading ? <ActivityIndicator color="#fff" /> : label('#fff')}
        </LinearGradient>
      </Pressable>
    );
  }
  const bg = variant === 'ai' ? semantic.aiBg : variant === 'danger' ? semantic.dangerBg : colors.lineSoft;
  const fg = variant === 'ai' ? semantic.ai : variant === 'danger' ? semantic.danger : colors.ink800;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={[base, { backgroundColor: bg }]}
    >
      {label(fg)}
    </Pressable>
  );
}

// ── Chip (filtre) ─────────────────────────────────────────────────────
export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  const { colors, theme, radius } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        paddingHorizontal: 14,
        height: 34,
        borderRadius: radius.chip,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? theme.ink : colors.surface,
        borderWidth: 1,
        borderColor: active ? theme.ink : colors.line,
      }}
    >
      <Text style={[font('label'), { color: active ? '#fff' : colors.slate500 }]}>{label}</Text>
    </Pressable>
  );
}

// ── Badge (statut / type) ─────────────────────────────────────────────
type BadgeTone = 'b2b' | 'b2g' | 'particulier' | 'success' | 'warning' | 'danger' | 'ai';
export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  const { semantic, radius } = useTheme();
  const map: Record<BadgeTone, { bg: string; fg: string }> = {
    b2b: { bg: semantic.b2bBg, fg: semantic.b2b },
    b2g: { bg: semantic.b2gBg, fg: semantic.b2g },
    particulier: { bg: semantic.particulierBg, fg: semantic.particulier },
    success: { bg: semantic.successBg, fg: semantic.success },
    warning: { bg: semantic.warningBg, fg: semantic.warning },
    danger: { bg: semantic.dangerBg, fg: semantic.danger },
    ai: { bg: semantic.aiBg, fg: semantic.ai },
  };
  const c = map[tone];
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: radius.chip, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}>
      <Text style={[font('meta'), { color: c.fg }]}>{label}</Text>
    </View>
  );
}

// ── Avatar squircle (initiales) ───────────────────────────────────────
export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const { theme, radius } = useTheme();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <View style={{ width: size, height: size, borderRadius: radius.squircle, backgroundColor: theme.ink2, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={[font('cardTitle'), { color: '#fff' }]}>{initials}</Text>
    </View>
  );
}

// ── ScoreBar ──────────────────────────────────────────────────────────
export function ScoreBar({ value }: { value: number }) {
  const { semantic, colors } = useTheme();
  const band = value >= 85 ? semantic.success : value >= 65 ? semantic.warning : semantic.danger;
  return (
    <View style={{ height: 8, borderRadius: 999, backgroundColor: colors.lineSoft, overflow: 'hidden' }}>
      <View style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: '100%', backgroundColor: band, borderRadius: 999 }} />
    </View>
  );
}

// ── ListRow ───────────────────────────────────────────────────────────
export function ListRow({
  title,
  subtitle,
  amount,
  amountColor,
  onPress,
}: {
  title: string;
  subtitle?: string;
  amount?: ReactNode;
  amountColor?: string;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 }}
    >
      <Avatar name={title} />
      <View style={{ flex: 1 }}>
        <Text style={[font('cardTitle'), { color: colors.ink800 }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[font('sub'), { color: colors.slate400 }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {amount ? <View style={{ alignItems: 'flex-end' }}>{amount}</View> : null}
    </Pressable>
  );
}

// ── GradientHeader ────────────────────────────────────────────────────
export function GradientHeader({ children }: { children: ReactNode }) {
  const { grad } = useTheme();
  const insets = useSafeAreaInsets();
  const g = parseGradient(grad.header);
  return (
    <LinearGradient
      colors={g.colors}
      start={g.start}
      end={g.end}
      style={{ paddingTop: insets.top + 12, paddingHorizontal: 20, paddingBottom: 22, borderBottomLeftRadius: 22, borderBottomRightRadius: 22 }}
    >
      {children}
    </LinearGradient>
  );
}

// ── StatTile (grille « en un coup d'œil ») ────────────────────────────
export function StatTile({ label, children, onPress }: { label: string; children: ReactNode; onPress?: () => void }) {
  const { colors, radius } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        { flex: 1, backgroundColor: colors.surface, borderRadius: radius.card, padding: 14, borderWidth: 1, borderColor: colors.line },
        shadowNative.e1,
      ]}
    >
      <Text style={[font('meta'), { color: colors.slate400, marginBottom: 6 }]}>{label}</Text>
      {children}
    </Pressable>
  );
}

// ── FAB ───────────────────────────────────────────────────────────────
export function FAB({ onPress }: { onPress?: () => void }) {
  const { grad } = useTheme();
  const g = parseGradient(grad.fab);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Créer" style={{ position: 'absolute', bottom: 90, right: 20 }}>
      <LinearGradient colors={g.colors} start={g.start} end={g.end} style={[{ width: 60, height: 60, borderRadius: 999, alignItems: 'center', justifyContent: 'center' }, shadowNative.e3]}>
        <Text style={{ color: '#fff', fontSize: 30, marginTop: -2 }}>+</Text>
      </LinearGradient>
    </Pressable>
  );
}
