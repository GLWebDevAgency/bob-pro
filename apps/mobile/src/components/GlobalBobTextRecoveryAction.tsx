import { View } from 'react-native';
import { t, type Personality } from '@bob/i18n';
import { Button } from '@bob/ui';
import {
  GLOBAL_BOB_TEXT_RECOVERY_ROUTE,
  navigateGlobalBobTextRecovery,
} from './global-bob-access-session-policy';

export function GlobalBobTextRecoveryAction({
  visible,
  personality,
  navigate,
}: {
  readonly visible: boolean;
  readonly personality: Personality;
  readonly navigate: (route: typeof GLOBAL_BOB_TEXT_RECOVERY_ROUTE) => void;
}) {
  if (!visible) return null;
  return (
    <View style={{ marginTop: 8, alignSelf: 'stretch' }}>
      <Button
        title={t('agent.global.writeInAssistant', { personality })}
        accessibilityHint={t('agent.global.writeInAssistantHint', { personality })}
        variant="secondary"
        radius={12}
        onPress={() => navigateGlobalBobTextRecovery(navigate)}
      />
    </View>
  );
}
