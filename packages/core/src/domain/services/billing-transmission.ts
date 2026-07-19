import { type CustomerBillingChannel, type CustomerBillingChannelType } from '../customer/customer';

/**
 * Guide de TRANSMISSION d'une facture émise, dérivé du canal de facturation du client
 * (Customer.billingChannel — validé fondateur). Fonction PURE : aucune promesse de
 * raccordement automatique (le connecteur Plateforme Agréée est l'item B8, hors V1) —
 * le guide dit à l'artisan COMMENT transmettre lui-même, avec l'état honnête de chaque
 * prérequis (`done: null` = non vérifiable par l'app, à contrôler par l'artisan).
 */
export interface TransmissionChecklistItem {
  label: string;
  /** true/false = vérifié par l'app depuis ses données ; null = hors de portée de l'app. */
  done: boolean | null;
}

export interface TransmissionGuide {
  /** Canal EFFECTIF (email si le client n'en déclare aucun — défaut honnête). */
  channel: CustomerBillingChannelType;
  /** Étapes ordonnées, prérequis vérifiés quand l'app le peut. */
  checklist: TransmissionChecklistItem[];
  /** Chorus uniquement : code service du destinataire (null = non renseigné, à vérifier). */
  chorusServiceCode?: string | null;
  /** Portail uniquement : mémo nom/URL déclarés sur la fiche client. */
  portail?: { nom: string | null; url: string | null };
}

export interface TransmissionGuideInput {
  /** Canal déclaré sur la fiche client ; null/undefined = email par défaut. */
  billingChannel: CustomerBillingChannel | null | undefined;
  customer: { siren: string | null; email: string | null };
  invoice: { purchaseOrderNumber: string | null };
}

/** Dérive le guide de transmission d'une facture ÉMISE — jamais appelé sur un brouillon. */
export function deriveTransmissionGuide(input: TransmissionGuideInput): TransmissionGuide {
  const channel = input.billingChannel ?? { type: 'email' as const };
  if (channel.type === 'chorus') {
    // Checklist Chorus Pro : Factur-X (le PDF émis l'embarque toujours), SIRET/SIREN du
    // destinataire public, numéro d'engagement (bon de commande B8) exigé par la plupart des
    // entités, code service éventuel — puis dépôt sur portail.chorus-pro.gouv.fr.
    const serviceCode = channel.chorusServiceCode ?? null;
    return {
      channel: 'chorus',
      chorusServiceCode: serviceCode,
      checklist: [
        { label: 'Télécharger le PDF Factur-X de la facture (XML CII embarqué)', done: true },
        {
          label: 'SIRET/SIREN du destinataire renseigné sur la fiche client',
          done: input.customer.siren !== null,
        },
        {
          label: 'Numéro d’engagement (bon de commande) attaché à la facture',
          done: input.invoice.purchaseOrderNumber !== null,
        },
        {
          label:
            serviceCode === null
              ? 'Code service du destinataire — non renseigné : vérifie auprès de l’entité publique'
              : `Code service du destinataire : ${serviceCode}`,
          done: serviceCode !== null,
        },
        { label: 'Déposer la facture sur portail.chorus-pro.gouv.fr', done: null },
      ],
    };
  }
  if (channel.type === 'portail') {
    const nom = channel.portailNom ?? null;
    const url = channel.portailUrl ?? null;
    const destination = nom ?? 'le portail fournisseur du client';
    return {
      channel: 'portail',
      portail: { nom, url },
      checklist: [
        { label: 'Télécharger le PDF de la facture', done: true },
        {
          label: url === null ? `Déposer la facture sur ${destination}` : `Déposer la facture sur ${destination} (${url})`,
          done: null,
        },
      ],
    };
  }
  return {
    channel: 'email',
    checklist: [
      { label: 'Télécharger le PDF de la facture', done: true },
      {
        label:
          input.customer.email === null
            ? 'E-mail du client — non renseigné : complète sa fiche ou partage le lien public'
            : `Envoyer la facture à ${input.customer.email} (ou partager le lien public)`,
        done: input.customer.email !== null,
      },
    ],
  };
}
