/**
 * « Envoyer le lien » hors écran devis (briefing « À régler aujourd'hui ») : LE MÊME chemin que
 * DocumentActions.handleSendLink et devis/new.shareSignatureLink — POST /quotes/:id/signature-link
 * (useCreateQuoteSignatureLink) puis feuille de partage NATIVE. Aucun chemin parallèle, aucun
 * sortant : préparer/roter le lien n'envoie rien, et annuler le partage = rien n'est parti.
 * L'URL vient TOUJOURS du serveur (source unique) — le mobile ne connaît jamais SIGN_WEB_BASE_URL.
 */
import { useRef, useState } from 'react';
import { Share } from 'react-native';
import { Button } from '@bob/ui';
import { appErrorMessage, useCreateQuoteSignatureLink } from '../data/hooks';
import { useErrorSheet } from './ErrorSheet';

export function ShareQuoteLinkButton({
  quoteId,
  quoteNumber,
  title,
  icon,
}: {
  quoteId: string;
  /** Numéro déjà alloué au devis — cité dans le message partagé quand il existe. */
  quoteNumber: string | null;
  title: string;
  icon?: React.ReactNode;
}) {
  const signatureLink = useCreateQuoteSignatureLink();
  // Feuille d'erreur premium locale — aucune modale système dans ce flow.
  const { showError, errorSheet } = useErrorSheet();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Button
        title={title}
        variant="secondary"
        size="compact"
        radius={11}
        loading={busy}
        disabled={busy}
        {...(icon ? { icon } : {})}
        onPress={() =>
          void (async () => {
            if (lock.current) return;
            lock.current = true;
            setBusy(true);
            try {
              const result = await signatureLink.mutateAsync(quoteId);
              await Share.share({
                message: `Bonjour, voici le lien pour signer le devis${quoteNumber ? ` ${quoteNumber}` : ''} : ${result.signatureUrl}`,
              });
            } catch (e) {
              showError('Oups', appErrorMessage(e));
            } finally {
              lock.current = false;
              setBusy(false);
            }
          })()
        }
      />
      {errorSheet}
    </>
  );
}
