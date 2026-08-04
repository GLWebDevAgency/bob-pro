import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@bob/i18n';
import { Card, EmptyState, useTheme } from '@bob/ui';
import { SearchIcon } from '../src/components/icons';

/**
 * Attrape toute route inconnue (deep link mort, page déplacée) à la place de
 * l'écran « Unmatched Route » anglais du routeur. Le retour est un replace :
 * une route inconnue n'a pas d'historique fiable derrière elle.
 */
export default function NotFound() {
  const { colors, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        paddingTop: insets.top + 24,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
        justifyContent: 'center',
      }}
    >
      <Card padding={18}>
        <EmptyState
          icon={<SearchIcon size={17} color={colors.ink600} />}
          iconTone="b2b"
          title={t('notFound.title', { personality })}
          body={t('notFound.body', { personality })}
          cta={{ label: t('notFound.cta', { personality }), onPress: () => router.replace('/') }}
        />
      </Card>
    </View>
  );
}
