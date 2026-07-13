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
