type Copy = Readonly<Record<'pote' | 'pro' | 'direct', string>>;

/**
 * Voix des PROTECTIONS LÉGALES (LegalHint — divulgation progressive en 3 niveaux).
 * Doctrine fondateur : la formulation in-line dit le BÉNÉFICE, jamais la contrainte ; la
 * feuille explique en 2 blocs « Ce que dit la loi » (2-3 phrases simples) et « Pourquoi Bob
 * fait ça » (protection concrète), source citée en petit. Les articles cités sont vérifiés
 * sur Légifrance (rédactions en vigueur) — jamais reformulés au point d'en changer le sens.
 * Interpolations : {date} (dates FR jj/mm/aaaa).
 */
export const legalFr = {
  // ── Chrome du composant LegalHint ────────────────────────────────────────────
  'legalHint.lawTitle': {
    pote: 'Ce que dit la loi',
    pro: 'Ce que dit la loi',
    direct: 'La loi',
  },
  'legalHint.whyTitle': {
    pote: 'Pourquoi Bob fait ça',
    pro: 'Pourquoi Bob procède ainsi',
    direct: 'Pourquoi',
  },
  'legalHint.sourceLabel': {
    pote: 'Source : {source}',
    pro: 'Source : {source}',
    direct: 'Source : {source}',
  },
  'legalHint.iconAccessibilityLabel': {
    pote: 'En savoir plus sur cette protection légale',
    pro: 'En savoir plus sur cette protection légale',
    direct: 'Détail de la protection légale',
  },
  'legalHint.iconAccessibilityHint': {
    pote: 'Ouvre l’explication : ce que dit la loi, et pourquoi Bob fait ça.',
    pro: 'Ouvre l’explication : ce que dit la loi, et pourquoi Bob procède ainsi.',
    direct: 'Ouvre l’explication légale.',
  },
  'legalHint.sheetAccessibilityLabel': {
    pote: 'Explication de la protection légale',
    pro: 'Explication de la protection légale',
    direct: 'Explication légale',
  },

  // ── Embargo L221-10 (encaissement après signature à domicile) ────────────────
  // In-line = BÉNÉFICE : la loi te protège d'un contrat annulable, pas « c'est interdit ».
  'legal.embargo.inline': {
    pote: 'Encaissement possible le {date} — la loi anti-démarchage te protège d’un contrat annulable.',
    pro: 'Encaissement possible le {date} — la loi anti-démarchage vous protège d’un contrat annulable.',
    direct: 'Encaissement le {date} : la loi te protège d’un contrat annulable.',
  },
  'legal.embargo.law': {
    pote: 'Quand un client particulier signe chez lui, la loi interdit d’encaisser quoi que ce soit pendant 7 jours après la signature. Si tu encaisses avant, le contrat peut être annulé en justice et le client peut tout se faire rembourser.',
    pro: 'Lorsqu’un client particulier signe à son domicile, la loi interdit de percevoir tout paiement pendant 7 jours après la signature. Un encaissement anticipé rend le contrat annulable et le client peut en exiger le remboursement intégral.',
    direct: 'Client particulier signé à domicile : aucun encaissement pendant 7 jours. Sinon, contrat annulable et remboursement exigible.',
  },
  // HONNÊTETÉ (P0) : ce qui part seul, c'est le MESSAGE au client — le lien de paiement reste
  // envoyé par l'artisan, que Bob prévient le jour même (notification + rappel). Jamais promettre
  // un encaissement automatique qui n'existe pas.
  'legal.embargo.why': {
    pote: 'Bob programme le message à ton client pour le premier jour légal et te prévient ce jour-là pour envoyer le lien de paiement : ton chantier ne risque jamais d’être annulé pour un paiement trop tôt.',
    pro: 'Bob programme le message au client au premier jour autorisé et vous prévient ce jour-là pour transmettre le lien de paiement : votre contrat ne peut pas être annulé pour un paiement prématuré.',
    direct: 'Message client programmé au premier jour légal, rappel pour envoyer le lien. Contrat inattaquable.',
  },

  'legal.embargoSheet.title': {
    pote: 'Encaissement protégé',
    pro: 'Encaissement protégé',
    direct: 'Encaissement protégé',
  },
  'legal.embargoSchedule.button': {
    pote: 'Programmer l’encaissement le {date}',
    pro: 'Programmer l’encaissement le {date}',
    direct: 'Programmer le {date}',
  },

  // ── Override responsabilisé de l'embargo (doctrine fondateur) ────────────────
  'legal.embargoOverride.button': {
    pote: 'Encaisser maintenant quand même',
    pro: 'Encaisser maintenant malgré tout',
    direct: 'Encaisser maintenant',
  },
  'legal.embargoOverride.sheetTitle': {
    pote: 'Tu es sûr de toi ?',
    pro: 'Confirmation requise',
    direct: 'Confirmation',
  },
  'legal.embargoOverride.risk': {
    pote: 'Ton client pourra exiger le remboursement et faire annuler le contrat (art. L242-1 du code de la consommation). Tu confirmes, sous ta responsabilité ?',
    pro: 'Votre client pourra exiger le remboursement intégral et faire annuler le contrat (art. L242-1 du code de la consommation). Confirmez-vous, sous votre responsabilité ?',
    direct: 'Ton client pourra tout se faire rembourser et faire annuler le contrat (art. L242-1 c. conso). Tu confirmes, sous ta responsabilité ?',
  },
  'legal.embargoOverride.confirm': {
    pote: 'Je confirme, j’assume',
    pro: 'Je confirme sous ma responsabilité',
    direct: 'Je confirme',
  },
  'legal.embargoOverride.cancel': {
    pote: 'Non, j’attends le {date}',
    pro: 'Attendre le {date}',
    direct: 'Attendre le {date}',
  },
  'legal.embargoOverride.traced': {
    pote: 'C’est noté et tracé : encaissement pendant le délai légal, confirmé par toi.',
    pro: 'Action enregistrée et tracée : encaissement pendant le délai légal, confirmé par vous.',
    direct: 'Tracé : encaissement pendant le délai légal, confirmé.',
  },
  // HONNÊTETÉ (P0) : le message client part seul ; le lien de paiement, lui, est envoyé par
  // l'artisan — Bob le notifie le jour même (livraison du message = notification + rappel).
  'legal.embargoSchedule.confirmed': {
    pote: 'Nickel — le message part tout seul le {date} pour prévenir ton client, et Bob te préviendra ce jour-là pour lui envoyer le lien de paiement.',
    pro: 'Le message au client partira automatiquement le {date}, et Bob vous préviendra ce jour-là pour transmettre le lien de paiement.',
    direct: 'Message client programmé le {date} — rappel le jour même pour envoyer le lien.',
  },

  // ── Dépannage urgent (L221-10, al. 2 / L221-28, 8°) — question du wizard ─────
  'legal.urgentRepair.question': {
    pote: 'C’est un dépannage urgent que ton client t’a demandé chez lui ?',
    pro: 'S’agit-il d’un dépannage urgent expressément demandé par votre client à son domicile ?',
    direct: 'Dépannage urgent demandé par le client chez lui ?',
  },
  'legal.urgentRepair.inline': {
    pote: 'Dépannage urgent : tu peux encaisser direct — la loi le prévoit pour les urgences demandées par le client.',
    pro: 'Dépannage urgent : l’encaissement est possible immédiatement — la loi le prévoit pour les urgences sollicitées par le client.',
    direct: 'Urgence sollicitée : encaissement immédiat autorisé.',
  },
  'legal.urgentRepair.law': {
    pote: 'Pour des travaux d’entretien ou de réparation urgents que le client te demande lui-même chez lui, l’interdiction d’encaisser pendant 7 jours ne s’applique pas. Et il n’a pas de droit de rétractation — mais uniquement sur les pièces et travaux strictement nécessaires à l’urgence.',
    pro: 'Pour des travaux d’entretien ou de réparation urgents, expressément sollicités par le client à son domicile, l’interdiction d’encaissement de 7 jours ne s’applique pas, et le droit de rétractation est écarté — dans la limite des pièces de rechange et travaux strictement nécessaires pour répondre à l’urgence.',
    direct: 'Urgence sollicitée par le client : pas d’embargo de 7 jours, pas de rétractation — limité au strictement nécessaire.',
  },
  'legal.urgentRepair.why': {
    pote: 'Bob note la demande d’urgence sur le devis avec la date : c’est cette trace qui te donne le droit d’encaisser direct. Sans elle, un juge peut considérer que la protection classique s’appliquait.',
    pro: 'Bob mentionne la demande d’urgence datée sur le devis : cette trace fonde légalement l’encaissement immédiat. Sans elle, le régime protecteur classique s’appliquerait.',
    direct: 'La mention datée sur le devis fonde ton droit d’encaisser direct. Pas de trace, pas d’exception.',
  },
  // Parité « papa vocal » : la question d'urgence du wizard se répond AUSSI à la voix —
  // « c'est un dépannage urgent » / « non, pas urgent » pose le MÊME fait que les radios.
  'legal.urgentRepair.voiceOn': {
    pote: 'C’est noté : dépannage urgent demandé par ton client. La mention datée sera sur le devis — tu pourras encaisser direct, pour le strict nécessaire de l’urgence.',
    pro: 'C’est noté : dépannage urgent expressément demandé par votre client. La mention datée figurera sur le devis — encaissement immédiat possible, dans la limite du strict nécessaire.',
    direct: 'Noté : dépannage urgent. Mention datée sur le devis, encaissement direct — strict nécessaire uniquement.',
  },
  'legal.urgentRepair.voiceOff': {
    pote: 'Ok, pas un dépannage urgent — on reste sur le circuit normal.',
    pro: 'Entendu : pas de dépannage urgent — le régime normal s’applique.',
    direct: 'Ok, pas urgent — régime normal.',
  },
  'legal.urgentRepair.voiceUnavailable': {
    pote: 'La question du dépannage urgent ne concerne que les clients particuliers — là, rien à déclarer.',
    pro: 'La déclaration de dépannage urgent ne concerne que les clients particuliers — rien à déclarer ici.',
    direct: 'Dépannage urgent : clients particuliers uniquement.',
  },
  'legal.urgentRepair.scopeWarning': {
    pote: 'Attention : l’exception ne couvre que le strict nécessaire pour régler l’urgence. Si tu ajoutes des prestations en plus, le client garde son droit de rétractation dessus — le formulaire reste sur le devis.',
    pro: 'Attention : l’exception ne couvre que ce qui est strictement nécessaire pour répondre à l’urgence. Toute prestation supplémentaire reste soumise au droit de rétractation — le formulaire demeure joint au devis.',
    direct: 'Exception limitée au strict nécessaire. Prestations en plus = rétractation maintenue, formulaire conservé.',
  },

  // ── Conseil du canal de signature (à distance vs hors établissement) ─────────
  // EXACTITUDE (P0) : ce conseil s'affiche quand l'artisan est CHEZ le client (« sur place »
  // choisi). Or l'art. L221-1, I, 2°, b) c. conso requalifie HORS ÉTABLISSEMENT le contrat
  // conclu à distance IMMÉDIATEMENT APRÈS une sollicitation en personne au domicile — un lien
  // signé « dans la foulée » de la visite reste donc soumis aux 7 jours (L221-10). Le conseil
  // porte cette condition (« plus tard, pas dans la foulée ») — jamais une exonération
  // inconditionnelle qui serait le contournement déguisé de L221-10.
  'legal.signatureChannel.banner': {
    pote: '💡 Envoie-lui le devis par lien : s’il le signe plus tard, tranquillement de chez lui, c’est un contrat à distance — acompte encaissable dès la signature. S’il signe dans la foulée de ta visite, la loi garde le délai de 7 jours.',
    pro: '💡 Privilégiez l’envoi du devis par lien : signé plus tard, à distance, c’est un contrat à distance — l’acompte est encaissable dès la signature. Signé immédiatement après votre visite, le délai légal de 7 jours s’applique.',
    direct: '💡 Envoie le lien : signé plus tard à distance = acompte immédiat. Signé dans la foulée de ta visite = 7 jours quand même.',
  },
  'legal.signatureChannel.inline': {
    pote: 'Lien signé plus tard = acompte immédiat. Sur place, ou par lien juste après ta visite = 7 jours d’attente.',
    pro: 'Lien signé plus tard : acompte immédiat. Sur place, ou par lien immédiatement après votre visite : 7 jours.',
    direct: 'Lien signé plus tard = direct. Sur place ou juste après ta visite = 7 jours.',
  },
  'legal.signatureChannel.law': {
    pote: 'Un devis signé par lien, c’est un contrat « à distance » : tu peux encaisser l’acompte tout de suite. Mais si le client signe ce lien immédiatement après ta visite chez lui, la loi requalifie le contrat en « hors établissement » — comme une signature sur place : aucun encaissement pendant 7 jours.',
    pro: 'Un devis signé par lien constitue un contrat « à distance » : l’acompte est encaissable immédiatement. Toutefois, si le client signe ce lien immédiatement après votre visite à son domicile, le contrat est requalifié « hors établissement » (art. L221-1, I, 2°, b) : la loi interdit alors tout encaissement pendant 7 jours, comme pour une signature sur place.',
    direct: 'Lien signé plus tard = contrat à distance, acompte immédiat. Lien signé juste après ta visite chez le client = hors établissement (L221-1, I, 2°, b) : 7 jours sans encaissement, comme sur place.',
  },
  // Parité vocale (item 4) : le MÊME conseil, dit simplement par Bob à l'étape signature d'un
  // devis B2C non urgent — jamais une injonction, le choix reste à l'artisan.
  'legal.signatureChannel.voice': {
    pote: 'Petit conseil : envoie-lui le lien et laisse-le signer plus tard, tranquillement de chez lui — tu pourras encaisser l’acompte dès la signature. S’il signe sur place ou dans la foulée de ta visite, la loi te fait attendre 7 jours. C’est toi qui choisis !',
    pro: 'Un conseil : envoyez le lien et laissez le client signer plus tard, depuis chez lui — l’acompte sera encaissable dès la signature. S’il signe sur place ou immédiatement après votre visite, la loi impose d’attendre 7 jours. Le choix vous appartient.',
    direct: 'Conseil : envoie le lien, signature plus tard à distance = acompte direct. Sur place ou juste après ta visite = 7 jours. À toi de voir.',
  },
  'legal.signatureChannel.why': {
    pote: 'Bob te le dit au bon moment pour que tu choisisses en connaissance de cause : le choix reste 100 % le tien.',
    pro: 'Bob présente cette information au moment du choix afin de décider en connaissance de cause : la décision vous appartient entièrement.',
    direct: 'Info au bon moment. Le choix reste le tien.',
  },
} as const satisfies Record<string, Copy>;
