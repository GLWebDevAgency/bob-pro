import { describe, it, expect } from 'vitest';
import { detectIntent, extractReference } from './intent';

describe('detectIntent — clôture (préparer le mois)', () => {
  it('reconnaît les commandes de clôture / préparation du mois', () => {
    for (const m of [
      'Prépare mon mois pour le comptable',
      'Clôture le mois',
      'Prépare le mois',
      'Boucle mon mois',
      'Prépare tout pour le comptable',
      'Fais le bilan du mois',
    ]) {
      expect(detectIntent(m)).toBe('cloture');
    }
  });

  it('ne capte pas les intentions voisines par erreur', () => {
    expect(detectIntent('Prépare une relance')).toBe('relance');
    expect(detectIntent('Encaisse la facture 2026-014')).toBe('encaisser');
    expect(detectIntent('Fais-moi un devis')).toBe('nouveau_devis');
    expect(detectIntent('Ouvre mes chantiers')).toBe('voir_chantiers');
    expect(detectIntent('Quel temps fait-il ?')).toBe('unknown');
  });
});

describe('detectIntent — contexte Notifications', () => {
  it('reconnaît une demande ciblée avant les intents document/relance génériques', () => {
    expect(detectIntent('Résume cette notification')).toBe('contexte_ecran');
    expect(detectIntent('Parle-moi de cette notification')).toBe('contexte_ecran');
    expect(detectIntent('Lis-moi les notifications en attente')).toBe('contexte_ecran');
  });

  it('distingue le batch mutatif « tout marquer comme lu » du briefing en lecture', () => {
    for (const message of [
      'Marque toutes les notifications comme lues',
      'Passe mes notifications en lues',
      'Marque-les toutes comme lues',
      'Marquer tout comme lu',
    ]) {
      expect(detectIntent(message)).toBe('marquer_notifications_lues');
    }
    expect(detectIntent('Lis-moi toutes les notifications')).toBe('contexte_ecran');
  });

  it('reconnaît l’ouverture contextuelle et extrait un rang relatif', () => {
    expect(detectIntent('Ouvre la deuxième notification')).toBe('contexte_ecran');
    expect(detectIntent('Amène-moi sur la 3e')).toBe('contexte_ecran');
    expect(extractReference('Ouvre la deuxième notification')).toBe('ordinal:2');
    expect(extractReference('Amène-moi sur la 3e')).toBe('ordinal:3');
    expect(extractReference('Ouvre E4')).toBe('E4');
  });

  it('préserve les navigations statiques qui ne ciblent aucune entité affichée', () => {
    expect(detectIntent('Ouvre la clôture')).toBe('cloture');
    expect(detectIntent('Ouvre mes chantiers')).toBe('voir_chantiers');
    expect(detectIntent('Ouvre le diagnostic')).toBe('diagnostic');
    expect(detectIntent('Ouvre mon catalogue')).toBe('voir_catalogue');
  });
});

describe('detectIntent — catalogue de prestations (C27)', () => {
  it('reconnaît « ouvre mon catalogue » et ses variantes', () => {
    expect(detectIntent('Ouvre mon catalogue')).toBe('voir_catalogue');
    expect(detectIntent('Affiche le catalogue')).toBe('voir_catalogue');
    expect(detectIntent('Montre-moi mes prestations')).toBe('voir_catalogue');
  });

  it('ne capte pas les intentions voisines (documents/pièces) par erreur', () => {
    expect(detectIntent('Liste mes documents')).toBe('documents');
    expect(detectIntent('Scanne ce reçu')).toBe('scan');
  });
});

describe('detectIntent — contexte Comptabilité', () => {
  it('reconnaît les demandes sur les écritures affichées', () => {
    expect(detectIntent('Explique cette écriture')).toBe('contexte_ecran');
    expect(detectIntent('Liste les écritures affichées')).toBe('contexte_ecran');
  });
});

describe('detectIntent — ligne de pièce affichée', () => {
  it('reconnaît une demande de lecture de ligne sans la confondre avec la pièce', () => {
    expect(detectIntent('Explique cette ligne')).toBe('contexte_ecran');
    expect(detectIntent('Résume la ligne du devis')).toBe('contexte_ecran');
  });
});

describe('detectIntent — diagnostic 2026 (C40 TODO ⑦)', () => {
  it('reconnaît la chip « Prêt pour 2026 ? » et les demandes de diagnostic', () => {
    for (const m of [
      'Prêt pour 2026 ?',
      'prête pour 2026',
      'On est prêts pour 2026 ?',
      'Fais mon diagnostic',
      'Lance le diagnostic de conformité',
      'Je suis en règle sur la conformité 2026 ?',
      'conformité facturation électronique, ça donne quoi ?',
    ]) {
      expect(detectIntent(m)).toBe('diagnostic');
    }
  });

  it('ne détourne pas les intentions existantes', () => {
    expect(detectIntent('Prépare le mois')).toBe('cloture');
    expect(detectIntent('Combien je peux me verser ?')).toBe('payout');
    expect(detectIntent('Un devis pour 2026')).toBe('nouveau_devis');
  });

  it('generer_facture (ASK-2) : facturer un devis signé ≠ créer un devis ≠ émettre un brouillon', () => {
    expect(detectIntent('Fais la facture du devis D-2026-0005')).toBe('generer_facture');
    expect(detectIntent('Génère la facture du devis')).toBe('generer_facture');
    expect(detectIntent('Fais la facture d’acompte du devis D-2026-0005')).toBe('generer_facture');
    expect(detectIntent('Fais la facture finale du devis D-2026-0005')).toBe('generer_facture');
    // Anti-collision : les intentions voisines ne sont pas détournées.
    expect(detectIntent('Fais un devis pour Martin')).toBe('nouveau_devis');
    expect(detectIntent('Émets la facture 2026-014')).toBe('emettre_facture');
  });

  it('revue de clôture (DOSSIER-2) : la QUESTION du verdict ≠ ouvrir l’écran', () => {
    expect(detectIntent('Mon dossier est-il prêt pour le comptable ?')).toBe('revue_cloture');
    expect(detectIntent('C’est prêt à signer ?')).toBe('revue_cloture');
    expect(detectIntent('Des anomalies dans mon dossier ?')).toBe('revue_cloture');
    expect(detectIntent('Passe en revue mes diligences')).toBe('revue_cloture');
    // …mais la demande d'action ouvre toujours l'écran de clôture.
    expect(detectIntent('Clôture le mois')).toBe('cloture');
    expect(detectIntent('Prépare le mois pour le comptable')).toBe('cloture');
  });
});

describe('detectIntent — BOB-1 (expert-comptable de poche)', () => {
  it('position de TVA : « combien de TVA » ne part ni en payout ni en échéances', () => {
    for (const m of [
      'Combien de TVA je dois ?',
      'ma tva ce mois',
      'quelle est ma position de TVA',
      'j’ai un crédit de TVA ?',
    ]) {
      expect(detectIntent(m)).toBe('tva');
    }
    // La DÉCLARATION reste une échéance (calendrier), pas une position.
    expect(detectIntent('quand déclarer la tva ?')).toBe('echeances');
  });

  it('balance âgée : « qui me doit » ne part pas en relance', () => {
    for (const m of ['Qui me doit de l’argent ?', 'balance âgée', 'mes encours clients', 'ils me doivent combien ?']) {
      expect(detectIntent(m)).toBe('balance');
    }
    expect(detectIntent('relance Martin')).toBe('relance');
  });

  it('payer une dépense : « règle/paie le fournisseur » ne part pas en encaissement', () => {
    for (const m of ['règle la dépense Leroy Merlin', 'paie le fournisseur Cedeo', 'ma dépense est payée ?']) {
      expect(detectIntent(m)).toBe('payer_depense');
    }
    // L'encaissement client reste l'encaissement.
    expect(detectIntent('encaisse la facture F-2026-0001')).toBe('encaisser');
  });
});

describe('detectIntent — BOB-2 (résultat provisoire)', () => {
  it('« combien je gagne / bénéfice / résultat » ne part pas en payout', () => {
    for (const m of ['combien je gagne ?', 'je suis en bénéfice ?', 'mon résultat du mois', 'balance générale']) {
      expect(detectIntent(m)).toBe('resultat');
    }
    expect(detectIntent('Combien je peux me verser ?')).toBe('payout');
  });
});

describe('detectIntent — BOB-4 (bilan)', () => {
  it('« mon bilan / actif passif / capitaux propres » → bilan, sans casser clôture ni résultat', () => {
    for (const m of ['montre-moi mon bilan', 'mon actif et mon passif', 'mes capitaux propres']) {
      expect(detectIntent(m)).toBe('bilan');
    }
    // « bilan du mois » reste la clôture (préparation du mois pour le comptable).
    expect(detectIntent('fais le bilan du mois')).toBe('cloture');
    // « combien je gagne » reste le résultat.
    expect(detectIntent('combien je gagne ?')).toBe('resultat');
  });
});

describe('detectIntent — pilier 2 (abonnement/essai, lecture seule)', () => {
  it('« où en est mon abonnement / mon essai » → abonnement, sans casser pilotage ni payout', () => {
    for (const m of [
      'où en est mon abonnement ?',
      'il me reste combien de jours d’essai ?',
      'mon essai se termine quand ?',
      'quelle est mon offre actuelle ?',
      'comment va mon essai ?',
    ]) {
      expect(detectIntent(m)).toBe('abonnement');
    }
    // Les voisins ne sont pas cannibalisés : pilotage et payout restent eux-mêmes.
    expect(detectIntent('comment va mon activité ?')).toBe('pilotage');
    expect(detectIntent('Combien je peux me verser ?')).toBe('payout');
  });
});

describe('detectIntent — valider_document (« c\'est bon, valide le ticket »)', () => {
  it('reconnaît la validation vocale d\'un document scanné AVANT scan/documents', () => {
    for (const m of [
      'Valide le ticket Aldi',
      'C’est bon, valide le ticket',
      'Confirme le reçu Leroy Merlin',
      'Tu peux valider le justificatif',
      'Valide le document du scan d’hier',
      'Marque le ticket comme vu',
    ]) {
      expect(detectIntent(m)).toBe('valider_document');
    }
  });

  it('ne cannibalise ni la facturation, ni le scan, ni la négation', () => {
    // « valide la facture » reste AMBIGU avec l'émission légale : jamais de mutation dessus.
    expect(detectIntent('Valide la facture 2026-014')).not.toBe('valider_document');
    // Scanner reste scanner.
    expect(detectIntent('Scanne ce ticket')).toBe('scan');
    expect(detectIntent('Prends une photo du ticket')).toBe('scan');
    // Négation : aucune action proposée.
    expect(detectIntent('Ne valide pas le ticket')).not.toBe('valider_document');
    expect(detectIntent('Ne confirme surtout pas ce document')).not.toBe('valider_document');
    // Les listes de pièces restent une lecture.
    expect(detectIntent('Montre mes documents archivés')).toBe('documents');
  });
});

describe('detectIntent — classer_document (« range le ticket Aldi dans le chantier Durand »)', () => {
  it('reconnaît le classement vocal AVANT scan, documents et voir_chantiers', () => {
    for (const m of [
      'Range le ticket Aldi dans le chantier Durand',
      'Classe la facture Leroy Merlin dans frais généraux',
      'Tu peux ranger le justificatif dans Achats',
      'Déplace ce document vers le dossier Admin',
      'Classe-le dans le chantier Maison Bernard',
    ]) {
      expect(detectIntent(m)).toBe('classer_document');
    }
  });

  it('ne cannibalise ni le scan, ni les chantiers, ni la négation', () => {
    expect(detectIntent('Scanne ce ticket')).toBe('scan');
    expect(detectIntent('Ouvre mes chantiers')).toBe('voir_chantiers');
    expect(detectIntent('Mes plus gros clients, un classement')).toBe('top_clients');
    expect(detectIntent('Ne range pas le ticket')).not.toBe('classer_document');
    expect(detectIntent('Ne classe surtout pas ce document')).not.toBe('classer_document');
  });
});

describe('detectIntent — renommer_document (« renomme-le facture matériaux salle de bain »)', () => {
  it('reconnaît le renommage vocal d’une pièce du coffre', () => {
    for (const m of [
      'Renomme-le facture matériaux salle de bain',
      'Renomme le ticket Aldi en facture Aldi',
      'Rebaptise le justificatif en attestation décennale',
    ]) {
      expect(detectIntent(m)).toBe('renommer_document');
    }
  });

  it('exclut clients/dossiers/chantiers (autres gestes) et la négation', () => {
    expect(detectIntent('Renomme le client Durand')).not.toBe('renommer_document');
    expect(detectIntent('Renomme le dossier Achats')).not.toBe('renommer_document');
    expect(detectIntent('Ne renomme pas le ticket')).not.toBe('renommer_document');
  });
});

describe('detectIntent — chercher_document (« retrouve la facture du radiateur de mars »)', () => {
  it('reconnaît la recherche de pièces AVANT scan/documents/nouveau_devis', () => {
    for (const m of [
      'Retrouve la facture du radiateur de mars',
      'Cherche le devis chauffe-eau',
      'Trouve-moi la facture Martin',
      'Recherche un devis pour le camping',
    ]) {
      expect(detectIntent(m)).toBe('chercher_document');
    }
  });

  it('ne cannibalise ni les listes, ni la création de devis', () => {
    expect(detectIntent('Montre mes documents archivés')).toBe('documents');
    expect(detectIntent('Liste mes factures impayées')).toBe('factures');
    expect(detectIntent('Fais-moi un devis')).toBe('nouveau_devis');
  });
});

describe('detectIntent — lier_bon_commande (B8 : « la RATP m’a envoyé un bon de commande »)', () => {
  it('reconnaît le lien bon de commande AVANT scan/documents/envoyer_devis/nouveau_devis', () => {
    for (const m of [
      'La RATP m’a répondu pour le dernier devis avec un bon de commande',
      'La RATP m’a envoyé un bon de commande n° 4500123',
      'Ajoute le bon de commande BC-2207 au devis de Durand',
      'J’ai reçu un bon de commande de la mairie, je l’ai scanné',
      'Note le numéro d’engagement 4500123 sur le devis Durand',
    ]) {
      expect(detectIntent(m)).toBe('lier_bon_commande');
    }
  });

  it('ne cannibalise ni les gestes documentaires, ni les voisins, ni la négation', () => {
    // Un geste documentaire EXPLICITE sur le bon de commande scanné reste un geste documentaire.
    expect(detectIntent('Classe le bon de commande dans le dossier Achats')).toBe('classer_document');
    expect(detectIntent('Range le bon de commande scanné dans Achats')).toBe('classer_document');
    expect(detectIntent('Cherche le bon de commande de mars')).not.toBe('lier_bon_commande');
    // Négation : aucune action proposée.
    expect(detectIntent('N’ajoute pas le bon de commande au devis')).not.toBe('lier_bon_commande');
    // Les voisins restent eux-mêmes.
    expect(detectIntent('Envoie le devis à la RATP')).toBe('envoyer_devis');
    expect(detectIntent('Fais la facture du devis D2026-030')).toBe('generer_facture');
  });
});

describe('detectIntent — depense_dictee (M4 : « j’ai dépensé 89 € chez Leroy Merlin en carte »)', () => {
  it('reconnaît la dépense dictée, chantier compris', () => {
    for (const m of [
      'J’ai dépensé 89 € chez Leroy Merlin en carte',
      '45 € de gasoil ce matin',
      'Note une dépense de 32 € chez Aldi',
      'J’ai dépensé 120 euros chez Point P pour le chantier Durand',
      'J’ai dépensé 89 € chez Leroy Merlin par carte (catégorie matériel)', // commande canonique des followUps
    ]) {
      expect(detectIntent(m)).toBe('depense_dictee');
    }
  });

  it('ne cannibalise ni le scanner, ni le règlement d’une dépense existante, ni la négation', () => {
    // Le scanner reste le scanner (« papa vocal » : deux gestes distincts).
    expect(detectIntent('Scanne ce ticket')).toBe('scan');
    expect(detectIntent('Prends le reçu en photo')).toBe('scan');
    // Le règlement d'une dépense DÉJÀ enregistrée reste payer_depense — et la phrase
    // historique du catalogue (routée par le LLM en prod) n'est JAMAIS captée par M4.
    expect(detectIntent('J’ai payé la dépense EDF')).toBe('payer_depense');
    expect(detectIntent('Règle la dépense Leroy Merlin')).toBe('payer_depense');
    expect(detectIntent('J’ai payé Leroy Merlin hier par carte')).not.toBe('depense_dictee');
    // Négation : aucune action.
    expect(detectIntent('N’enregistre pas de dépense')).not.toBe('depense_dictee');
  });
});

describe('detectIntent — lier_depense_chantier (M3 : « mets la dépense Aldi sur le chantier Durand »)', () => {
  it('reconnaît l’imputation dépense→chantier AVANT classer_document/voir_chantiers', () => {
    for (const m of [
      'Mets la dépense Aldi sur le chantier Durand',
      'Impute la dépense gasoil au chantier Sèvres',
      'Rattache la dépense Leroy Merlin au chantier Durand',
      'Range la dépense Aldi dans le chantier Durand',
      'Mets la dépense exp-12 sur le chantier chantier-3', // commande canonique des followUps
    ]) {
      expect(detectIntent(m)).toBe('lier_depense_chantier');
    }
  });

  it('ne cannibalise ni le classement de documents, ni les chantiers, ni la négation', () => {
    expect(detectIntent('Range le ticket Aldi dans le chantier Durand')).toBe('classer_document');
    expect(detectIntent('Ouvre mes chantiers')).toBe('voir_chantiers');
    expect(detectIntent('Ne mets pas la dépense Aldi sur le chantier Durand')).not.toBe('lier_depense_chantier');
  });
});

describe('detectIntent — aide (découvrabilité S9 : catalogue des capacités)', () => {
  it('reconnaît les questions sur les capacités de Bob', () => {
    for (const m of [
      'Aide',
      'aide-moi',
      'Help',
      'Tu sais faire quoi ?',
      'Tu peux faire quoi ?',
      'Que sais-tu faire ?',
      'Que peux-tu faire ?',
      'Que savez-vous faire ?',
      'Qu’est-ce que tu sais faire ?',
      "Qu'est-ce que tu peux faire ?",
      'Montre-moi ce que tu sais faire',
      'À quoi tu sers ?',
      'Comment tu peux m’aider ?',
      'Tu fais quoi ?',
      'J’ai besoin d’aide',
    ]) {
      expect(detectIntent(m)).toBe('aide');
    }
  });

  it('ne capte JAMAIS une vraie commande qui contient « aide » ou « faire »', () => {
    expect(detectIntent('Aide-moi à faire un devis')).toBe('nouveau_devis');
    expect(detectIntent('Besoin d’aide pour ma relance')).toBe('relance');
    expect(detectIntent('Tu peux faire un devis pour Martin ?')).toBe('nouveau_devis');
    expect(detectIntent('Tu peux faire la facture du devis ?')).toBe('generer_facture');
    expect(detectIntent('J’ai besoin d’aide sur ma TVA')).toBe('tva');
  });

  it('le hors-périmètre reste unknown (jamais requalifié en aide)', () => {
    expect(detectIntent('Quel temps fait-il ?')).toBe('unknown');
    expect(detectIntent('Raconte-moi une blague')).toBe('unknown');
  });
});

describe('detectIntent — B1/B2/B4 (facturation terrain vocale)', () => {
  it('facture_directe : « facture X € à … » (B1) — avant les intents facture/dépense génériques', () => {
    for (const m of [
      'Facture 380 € à Mme Girard pour le dépannage',
      'Facture 380 € TTC à Mme Girard pour dépannage de la chaudière (TVA 10 %, logement de plus de 2 ans)',
      'Fais une facture de 500 € à Durand pour la maintenance',
      'Facture 45 € de dépannage à Girard',
      'Fais une facture directe pour Mme Girard',
    ]) {
      expect(detectIntent(m)).toBe('facture_directe');
    }
  });

  it('facture_directe ne détourne NI la chaîne devis, NI les gestes documentaires, NI la dépense dictée', () => {
    expect(detectIntent('Fais la facture du devis D2026-030')).toBe('generer_facture');
    expect(detectIntent("Facture l'acompte du devis Martin")).toBe('generer_facture');
    expect(detectIntent('Range la facture de 45 € dans frais généraux')).toBe('classer_document');
    expect(detectIntent('Retrouve la facture du radiateur de mars')).toBe('chercher_document');
    expect(detectIntent('J’ai dépensé 89 € chez Leroy Merlin en carte')).toBe('depense_dictee');
    expect(detectIntent('Encaisse la facture 2026-014')).toBe('encaisser');
    expect(detectIntent('Ne facture pas 300 € à Durand')).not.toBe('facture_directe');
  });

  it('facturer_situation : « situation de X % » (B2) — avant chantiers/devis/facture_directe', () => {
    for (const m of [
      'Facture une situation de 40 % sur le chantier Durand',
      'Facture une situation de 4500 € HT sur le devis D-2026-0031',
      'Fais une situation de 30 % sur le devis Martin',
      'Génère une situation d’avancement pour le chantier Sèvres',
      'Facture une situation sur le devis D-2026-0031',
    ]) {
      expect(detectIntent(m)).toBe('facturer_situation');
    }
  });

  it('le mot « situation » seul ne suffit jamais (trésorerie, point d’étape…)', () => {
    expect(detectIntent('Quelle est la situation de ma trésorerie ?')).not.toBe('facturer_situation');
    expect(detectIntent('Fais le point sur la situation')).not.toBe('facturer_situation');
    expect(detectIntent('Ouvre mes chantiers')).toBe('voir_chantiers');
  });

  it('conditions_paiement : « X paie à N jours (fin de mois) » (B4) — avant DSO/encaisser', () => {
    for (const m of [
      'Durand paie à 45 jours fin de mois',
      'Le client Durand SARL paie à 60 jours',
      'Mets la RATP à 60 jours',
      'Conditions de paiement de Durand : 30 jours',
    ]) {
      expect(detectIntent(m)).toBe('conditions_paiement');
    }
  });

  it('conditions_paiement ne détourne ni le DSO (constat) ni le règlement fournisseur', () => {
    expect(detectIntent('On me paie en combien de temps ?')).toBe('dso');
    expect(detectIntent('Quel est mon délai de paiement moyen ?')).toBe('dso');
    expect(detectIntent('J’ai payé la dépense EDF hier')).toBe('payer_depense');
  });
});

describe('detectIntent — envoyer_facture (PR-01 : « envoie la facture 2026-014 »)', () => {
  it('reconnaît l’envoi email d’une facture émise', () => {
    for (const m of [
      'Envoie la facture 2026-014',
      'Envoie la facture 2026-014 à Durand',
      'Renvoie la facture de la RATP',
      'Transmets la facture 2026-002 au client',
      'Expédie la facture Durand par e-mail',
    ]) {
      expect(detectIntent(m)).toBe('envoyer_facture');
    }
  });

  it('ne détourne ni les devis, ni les relances, ni l’émission, ni la déclaration de transmission', () => {
    expect(detectIntent('Envoie le devis à Martin pour signature')).toBe('envoyer_devis');
    expect(detectIntent('Envoie la relance de la facture 2026-014')).toBe('relance');
    expect(detectIntent('Émets la facture Durand')).toBe('emettre_facture');
    expect(detectIntent('Marque la facture 2026-014 comme envoyée')).toBe('declarer_transmission');
    expect(detectIntent('N’envoie pas la facture 2026-014')).not.toBe('envoyer_facture');
  });
});

describe('detectIntent — declarer_transmission (PR-02 : « j’ai déposé la facture sur Chorus hier »)', () => {
  it('reconnaît le fait déclaré (dépôt, envoi constaté, acceptation)', () => {
    for (const m of [
      'J’ai déposé la facture 2026-002 sur Chorus hier',
      'Marque la facture 2026-014 comme envoyée',
      'La facture RATP a été acceptée sur Chorus',
      'Note la facture 2026-002 comme transmise',
      'J’ai déposé la facture sur le portail fournisseur',
    ]) {
      expect(detectIntent(m)).toBe('declarer_transmission');
    }
  });

  it('ne capture ni l’envoi réel, ni l’encaissement, ni la dépense dictée', () => {
    expect(detectIntent('Envoie la facture 2026-014')).toBe('envoyer_facture');
    expect(detectIntent('La facture 2026-014 est payée')).toBe('encaisser');
    expect(detectIntent('J’ai dépensé 89 € chez Leroy Merlin en carte')).toBe('depense_dictee');
    expect(detectIntent('Ne marque pas la facture comme envoyée')).not.toBe('declarer_transmission');
  });
});

describe('detectIntent — relance_devis (PR-05 : « relance le devis Durand »)', () => {
  it('reconnaît la relance d’un devis sans réponse', () => {
    for (const m of [
      'Relance le devis Durand',
      'Relance le devis D2026-050',
      'Tu peux relancer le devis du client Martin ?',
    ]) {
      expect(detectIntent(m)).toBe('relance_devis');
    }
  });

  it('les relances de factures restent des relances de factures', () => {
    expect(detectIntent('Relance Durand')).toBe('relance');
    expect(detectIntent('Relance la facture 2026-014')).toBe('relance');
    expect(detectIntent('Envoie le devis Durand')).toBe('envoyer_devis');
    expect(detectIntent('Ne relance pas le devis Durand')).not.toBe('relance_devis');
  });
});

describe('detectIntent — cadence_relances (PR-06 : réglage des relances)', () => {
  it('reconnaît la lecture et la bascule de la politique de relances', () => {
    for (const m of [
      'Coupe les relances automatiques',
      'Active les relances auto',
      'Quelle est ma politique de relance ?',
      'Montre-moi la cadence de relances',
      'Relance mes clients tous les 10 jours',
    ]) {
      expect(detectIntent(m)).toBe('cadence_relances');
    }
  });

  it('ne détourne ni la relance ciblée ni les conditions de paiement client', () => {
    expect(detectIntent('Relance Durand')).toBe('relance');
    expect(detectIntent('Durand paie à 45 jours fin de mois')).toBe('conditions_paiement');
  });
});

describe('detectIntent — lecture de l’encaissement (PR-07 : pilotage, jamais le flux mutatif)', () => {
  it('« où en est mon encaissement ? » est une LECTURE de pilotage', () => {
    for (const m of [
      'Où en est mon encaissement ?',
      'Quel est mon taux d’encaissement ?',
      'Comment va mon encaissement ce trimestre ?',
    ]) {
      expect(detectIntent(m)).toBe('pilotage');
    }
  });

  it('encaisser une facture précise reste le flux encaisser ; le délai reste le DSO', () => {
    expect(detectIntent('Encaisse la facture 2026-014')).toBe('encaisser');
    expect(detectIntent('J’ai encaissé la facture Durand')).toBe('encaisser');
    expect(detectIntent('Quel est mon délai d’encaissement ?')).toBe('dso');
  });
});


describe('detectIntent — parc d’équipements (PR-11) : intents dédiés SANS détourner l’existant', () => {
  it('ajout au parc : verbe d’ajout + marqueur site/parc (kind LIBRE, aucun lexique matériel)', () => {
    for (const m of [
      'Ajoute la clim du local serveur chez Carrefour',
      'Ajoute un équipement au site Bastille',
      'Ajoute la fontaine de l’accueil au parc',
      'Installe la PAC gainable sur le site Docks Rouen',
    ]) {
      expect(detectIntent(m)).toBe('ajouter_equipement');
    }
  });

  it('lecture du parc et historique d’une machine', () => {
    expect(detectIntent('Montre-moi le parc du site RATP Bastille')).toBe('parc_equipements');
    expect(detectIntent('Les équipements de Carrefour Vitry')).toBe('parc_equipements');
    expect(detectIntent("L'historique de la fontaine de l'accueil")).toBe('historique_equipement');
  });

  it('retrait : le mot parc/équipement est REQUIS — « retire » seul ne suffit jamais', () => {
    expect(detectIntent('La vitrine froide est déposée, retire-la du parc')).toBe('retirer_equipement');
    expect(detectIntent('Retire l’équipement Fontaine quai A')).toBe('retirer_equipement');
  });

  it('ne détourne AUCUN flux existant (notes, dépenses, documents, chantiers, pièces)', () => {
    expect(detectIntent('Ajoute une note au chantier Lefèvre : fuite réparée')).not.toBe('ajouter_equipement');
    expect(detectIntent('Mets la dépense Aldi sur le chantier Durand')).toBe('lier_depense_chantier');
    expect(detectIntent('Range le ticket Aldi dans le chantier Durand')).toBe('classer_document');
    expect(detectIntent('Mes chantiers')).toBe('voir_chantiers');
    expect(detectIntent("L'historique des factures de Durand")).not.toBe('historique_equipement');
    expect(detectIntent('Fais un devis pour Martin')).toBe('nouveau_devis');
    expect(detectIntent('Facture 380 € à Mme Girard pour le dépannage')).toBe('facture_directe');
  });

  it('négation ⇒ rien (jamais une mutation sur une intention niée)', () => {
    expect(detectIntent('Ne retire pas la fontaine du parc')).not.toBe('retirer_equipement');
    expect(detectIntent("N'ajoute pas d'équipement chez Carrefour")).not.toBe('ajouter_equipement');
  });
});
