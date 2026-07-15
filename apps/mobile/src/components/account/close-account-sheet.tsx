/**
 * CloseAccountSheet — confirmation À FROID de la suppression de compte (audit stores 20260716,
 * bloquant #1, Apple 5.1.1(v)). Explique en clair (papa-vocal, MAIS jamais à la voix — voir plus
 * bas) ce qui disparaît (accès + infos personnelles) et ce qui reste (factures/devis déjà émis,
 * 10 ans, obligation légale), puis exige de retaper le nom exact de l'entreprise avant d'activer
 * le bouton destructif — anti-tap accidentel, revalidé de toute façon côté serveur
 * (CloseAccount @bob/core).
 *
 * AUCUNE PARITÉ VOCALE — CHOIX DÉLIBÉRÉ : toutes les autres actions de Bob Pro visent la réussite
 * à la voix (philosophie « papa vocal »). Celle-ci fait EXCEPTION explicitement : la destruction
 * définitive d'un compte ne doit jamais pouvoir être déclenchée par une reconnaissance vocale
 * imparfaite, un enfant qui joue avec le micro, ou un bruit de fond mal interprété. Ce composant
 * n'est donc JAMAIS publié dans un AgentContext (usePublishAgentContext) et ne définit aucune
 * affordance vocale — un tap déterministe + une saisie exacte du nom de l'entreprise, point.
 */
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import { Button, Sheet, font, useTheme } from '@bob/ui';
import { useAuth } from '../../data/auth';
import { useCloseAccount } from '../../data/hooks';

export interface CloseAccountSheetProps {
  readonly visible: boolean;
  readonly companyName: string;
  readonly personality: Personality;
  readonly onClose: () => void;
}

export function CloseAccountSheet({ visible, companyName, personality, onClose }: CloseAccountSheetProps) {
  const { colors, semantic } = useTheme();
  const { signOut } = useAuth();
  const closeAccount = useCloseAccount();
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [serverMismatch, setServerMismatch] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setConfirmation('');
    setReason('');
    setServerMismatch(false);
    setSigningOut(false);
    closeAccount.reset();
  }, [visible]);

  const say = (key: I18nKey, params?: Record<string, string | number>) =>
    t(key, params ? { personality, params } : { personality });

  const matches = confirmation.trim().length > 0 && confirmation.trim() === companyName;
  const busy = closeAccount.isPending || signingOut;
  const handleClose = (): void => {
    if (!busy) onClose();
  };

  const handleSubmit = async (): Promise<void> => {
    if (!matches || busy) return;
    setServerMismatch(false);
    try {
      await closeAccount.mutateAsync({
        confirmationText: confirmation.trim(),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      // Clôture actée côté serveur : signOut réel + retour login automatique (gate de session
      // dans _layout.tsx). AUCUNE navigation manuelle nécessaire ici.
      setSigningOut(true);
      await signOut();
    } catch (e) {
      setSigningOut(false);
      if (e && typeof e === 'object' && 'kind' in e && (e as { kind: string }).kind === 'validation') {
        setServerMismatch(true);
      }
    }
  };

  const errorMessage = serverMismatch
    ? say('account.deleteSheetConfirmMismatch')
    : closeAccount.isError
      ? say('account.deleteSheetError')
      : null;

  return (
    <Sheet
      visible={visible}
      onClose={handleClose}
      accessibilityLabel={say('account.deleteSheetTitle')}
      closeAccessibilityLabel={say('account.deleteSheetCancel')}
    >
      <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 10 }]}>
        {say('account.deleteSheetTitle')}
      </Text>
      <Text style={[font('body'), { color: colors.ink800, lineHeight: 21, marginBottom: 16 }]}>
        {say('account.deleteSheetIntro')}
      </Text>

      <View
        style={{
          borderRadius: 14,
          padding: 13,
          marginBottom: 12,
          backgroundColor: semantic.dangerBg,
        }}
      >
        <Text style={[font('sub', 700), { fontSize: 13.5, color: semantic.danger, marginBottom: 4 }]}>
          {say('account.deleteSheetGoesTitle')}
        </Text>
        <Text style={[font('label', 500), { color: colors.ink800, lineHeight: 19 }]}>
          {say('account.deleteSheetGoesBody')}
        </Text>
      </View>

      <View
        style={{
          borderRadius: 14,
          padding: 13,
          marginBottom: 18,
          backgroundColor: semantic.warningBg,
        }}
      >
        <Text style={[font('sub', 700), { fontSize: 13.5, color: semantic.warning, marginBottom: 4 }]}>
          {say('account.deleteSheetStaysTitle')}
        </Text>
        <Text style={[font('label', 500), { color: colors.ink800, lineHeight: 19 }]}>
          {say('account.deleteSheetStaysBody')}
        </Text>
      </View>

      <Text style={[font('sub', 600), { fontSize: 13.5, color: colors.ink800, marginBottom: 4 }]}>
        {say('account.deleteSheetConfirmLabel')}
      </Text>
      <Text style={[font('meta'), { color: colors.slate400, marginBottom: 8 }]}>{companyName}</Text>
      <TextInput
        value={confirmation}
        onChangeText={(value) => {
          setConfirmation(value);
          setServerMismatch(false);
        }}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={say('account.deleteSheetConfirmPlaceholder')}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={say('account.deleteSheetConfirmLabel')}
        style={[
          font('body'),
          {
            minHeight: 44,
            color: colors.ink900,
            borderWidth: 1,
            borderColor: confirmation.length > 0 && !matches ? semantic.danger : colors.line,
            borderRadius: 12,
            paddingHorizontal: 12,
            marginBottom: 14,
          },
        ]}
      />

      <Text style={[font('sub', 600), { fontSize: 13.5, color: colors.ink800, marginBottom: 6 }]}>
        {say('account.deleteSheetReasonLabel')}
      </Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        editable={!busy}
        multiline
        maxLength={300}
        style={[
          font('body'),
          {
            minHeight: 60,
            color: colors.ink900,
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingTop: 10,
            marginBottom: 16,
            textAlignVertical: 'top',
          },
        ]}
      />

      {errorMessage ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginBottom: 12, borderRadius: 12, padding: 10, backgroundColor: semantic.dangerBg }}
        >
          <Text style={[font('meta', 600), { color: semantic.danger }]}>{errorMessage}</Text>
        </View>
      ) : null}

      <Button
        title={say('account.deleteSheetSubmit')}
        variant="danger"
        loading={busy}
        disabled={!matches || busy}
        onPress={() => void handleSubmit()}
      />
      <View style={{ marginTop: 8 }}>
        <Button title={say('account.deleteSheetCancel')} variant="secondary" disabled={busy} onPress={handleClose} />
      </View>
    </Sheet>
  );
}
