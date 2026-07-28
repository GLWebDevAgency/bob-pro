/**
 * ProfileMenuSheet — modale menu profil (design_handoff_bob_pro/Bob Pro.dc.html §PROFILE SHEET,
 * LE flow du handoff). Tap sur l'avatar/initiales du Home → bottom sheet (jamais une navigation
 * directe) : en-tête identité + 4 cartes de destination. Parité stricte avec le proto :
 *  ① Mon compte & abonnement → /compte (profil, entreprise, offre)
 *  ② Revoir l'onboarding → /onboarding (route réelle, ré-ouvrable à tout moment — aucun flag
 *     « déjà fait » ne bloque la relecture, vérifié : /onboarding n'est gardé par rien)
 *  ③ Revoir les astuces → reset des flags first-run persistés (SecureStore, `useFirstTimeTip`) —
 *     réaffiche les coach-marks des écrans qui en ont ; feedback via toast (fourni par l'appelant,
 *     le Home, qui a déjà son propre `<Toast>`)
 *  ④ Diagnostic conformité 2026 → /diagnostic (même route que Bob/notifications, parité d'actions)
 */
import { Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { tradeProfile, type CompanyProps } from '@bob/core';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import { Avatar, IconTile, Sheet, font, useTheme } from '@bob/ui';
import type { StatusBadgeVariant } from '@bob/ui';
import { resetAllTips } from '../data/tips';
import { PressableRow } from './pressable-row';

export interface ProfileMenuSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly fullName: string | null;
  readonly company: CompanyProps | null;
  readonly personality: Personality;
  readonly onOpenAccount: () => void;
  readonly onOpenOnboarding: () => void;
  readonly onOpenDiagnostic: () => void;
  /** Feedback après reset des astuces — le Home gère son propre `<Toast>`. */
  readonly onTipsReset: () => void;
}

interface MenuItem {
  readonly key: string;
  readonly icon: keyof typeof Feather.glyphMap;
  /** Teintes pastel sémantiques (IconTile) — `neutral` (P1) n'a pas de pastel semantic.* :
   * on reste sur le sous-ensemble historique, inchangé. */
  readonly tone: Exclude<StatusBadgeVariant, 'neutral'>;
  readonly title: string;
  readonly subtitle: string;
  readonly onPress: () => void;
}

export function ProfileMenuSheet({
  visible,
  onClose,
  fullName,
  company,
  personality,
  onOpenAccount,
  onOpenOnboarding,
  onOpenDiagnostic,
  onTipsReset,
}: ProfileMenuSheetProps) {
  const { colors, semantic } = useTheme();
  const say = (key: I18nKey) => t(key, { personality });

  const companyLine = company
    ? [company.name, company.legalForm, tradeProfile(company.trade).label].filter(Boolean).join(' · ')
    : null;

  const handle = (action: () => void) => {
    onClose();
    action();
  };

  const items: readonly MenuItem[] = [
    {
      key: 'account',
      icon: 'user',
      tone: 'success',
      title: say('menu.account'),
      subtitle: say('menu.accountSub'),
      onPress: () => handle(onOpenAccount),
    },
    {
      key: 'onboarding',
      icon: 'rotate-ccw',
      tone: 'b2b',
      title: say('menu.onboarding'),
      subtitle: say('menu.onboardingSub'),
      onPress: () => handle(onOpenOnboarding),
    },
    {
      key: 'tips',
      icon: 'star',
      tone: 'b2g',
      title: say('menu.tips'),
      subtitle: say('menu.tipsSub'),
      onPress: () =>
        handle(() => {
          void resetAllTips().then(onTipsReset);
        }),
    },
    {
      key: 'diagnostic',
      icon: 'shield',
      tone: 'b2g',
      title: say('menu.diagnostic'),
      subtitle: say('menu.diagnosticSub'),
      onPress: () => handle(onOpenDiagnostic),
    },
  ];

  return (
    <Sheet visible={visible} onClose={onClose} accessibilityLabel={say('menu.title')} closeAccessibilityLabel={say('menu.closeLabel')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: 18 }}>
        <Avatar name={fullName ?? say('menu.title')} size={50} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[font('cardTitle'), { fontSize: 17, color: colors.ink900 }]}>
            {fullName ?? say('menu.title')}
          </Text>
          {companyLine ? (
            <Text numberOfLines={1} style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>
              {companyLine}
            </Text>
          ) : null}
        </View>
      </View>

      {items.map((item, index) => (
        <PressableRow
          key={item.key}
          onPress={item.onPress}
          style={{ marginBottom: index === items.length - 1 ? 0 : 10 }}
          icon={
            <IconTile tone={item.tone} size={36} radius={11}>
              <Feather name={item.icon} size={18} color={semantic[item.tone]} />
            </IconTile>
          }
          title={item.title}
          subtitle={item.subtitle}
        />
      ))}
    </Sheet>
  );
}
