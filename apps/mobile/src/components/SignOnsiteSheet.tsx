/**
 * SignOnsiteSheet (R4) — signature au doigt depuis le DÉTAIL d'un devis envoyé/vu (statut
 * sent/viewed), ouverte par le choix « Sur place » de QuoteActions (ou l'affordance vocale
 * « fais signer sur place » — QuoteActionsHandle.openSignOnsite). Réutilise SignaturePad de
 * @bob/ui exactement comme le wizard devis/new.tsx (étape signature) : même pad, mêmes clés
 * i18n devis.sign* (titre/sous-titre/placeholder/effacer/nom du signataire).
 *
 * LIMITATION DOMAINE CONNUE (SPEC_LOT_RETOURS_DEVICE_20260714.md §ARBITRAGE 4) : signQuote
 * (API, packages/api-client) n'accepte que `signerName` — le tracé (SignaturePadValue.strokes
 * / dataUrl) n'est ni transmis ni persisté. Le pad prouve à l'écran que le client a bien tracé
 * quelque chose avant de pouvoir valider (plancher UX honnête), mais ceci ne constitue PAS
 * aujourd'hui une preuve de signature opposable (aucun hash lié à la version du devis, aucun
 * archivage du tracé, aucun horodatage serveur dédié). Conserver le tracé est une évolution de
 * domaine proposée en suite de lot (Signature ne porte pas d'image aujourd'hui) — challenge GPT
 * explicitement invité sur ce point avant de la présenter comme une signature qualifiée eIDAS.
 */
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Button, Sheet, SignaturePad, font, useTheme, type SignaturePadValue } from '@bob/ui';
import { t } from '@bob/i18n';

export interface SignOnsiteSheetProps {
  readonly visible: boolean;
  /** Préremplit le champ signataire — reste éditable (le nom du client sur la fiche peut
   * différer de la personne qui signe réellement, ex. un salarié mandaté). */
  readonly customerName: string;
  readonly quoteNumber: string | null;
  readonly saving?: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (signerName: string) => void;
}

export function SignOnsiteSheet({
  visible,
  customerName,
  quoteNumber,
  saving = false,
  onClose,
  onSubmit,
}: SignOnsiteSheetProps) {
  const { personality, colors } = useTheme();
  const [signerName, setSignerName] = useState(customerName);
  const [signature, setSignature] = useState<SignaturePadValue | null>(null);

  // Réamorce à chaque ouverture : jamais un tracé ou un nom résiduel d'une signature précédente.
  useEffect(() => {
    if (!visible) return;
    setSignerName(customerName);
    setSignature(null);
  }, [visible, customerName]);

  // « Valider la signature » n'est actif QUE si un tracé non vide existe — le nom seul ne suffit
  // pas (c'était précisément le défaut mensonger de l'ancienne ConfirmSheet booléenne).
  const valid = signerName.trim() !== '' && signature !== null && !signature.isEmpty;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={t('devis.signTitle', { personality })}
      closeAccessibilityLabel={t('piece.close', { personality })}
    >
      <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 4 }]}>
        {t('devis.signTitle', { personality })}
      </Text>
      <Text style={[font('sub'), { color: colors.slate500, marginBottom: 12 }]}>
        {quoteNumber ? `Devis ${quoteNumber} — ${t('devis.signSub', { personality })}` : t('devis.signSub', { personality })}
      </Text>
      <SignaturePad
        clearLabel={t('devis.signClear', { personality })}
        placeholder={t('devis.signPlaceholder', { personality })}
        accessibilityLabel={t('devis.signTitle', { personality })}
        onChange={setSignature}
      />
      <View style={{ marginTop: 12 }}>
        <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
          {t('devis.signerLabel', { personality })}
        </Text>
        <TextInput
          value={signerName}
          onChangeText={setSignerName}
          placeholder={t('devis.signerPlaceholder', { personality })}
          placeholderTextColor={colors.slate400}
          accessibilityLabel={t('devis.signerLabel', { personality })}
          style={[
            font('body'),
            {
              minHeight: 44,
              color: colors.ink900,
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: 12,
              paddingHorizontal: 12,
            },
          ]}
        />
      </View>
      <View style={{ marginTop: 16 }}>
        <Button
          title={t('devis.signOnsiteSubmit', { personality })}
          loading={saving}
          disabled={!valid || saving}
          onPress={() => onSubmit(signerName.trim())}
        />
      </View>
    </Sheet>
  );
}
