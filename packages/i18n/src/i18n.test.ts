import { describe, it, expect } from 'vitest';
import { DEFAULT_PERSONALITY, PERSONALITY_LABELS, normalizePersonality, t } from './index';

describe('i18n', () => {
  it("t('bob.greeting') retourne une chaîne fr non vide (défaut Pote)", () => {
    expect(DEFAULT_PERSONALITY).toBe('pote');
    expect(t('bob.greeting').length).toBeGreaterThan(0);
    expect(t('bob.greeting', { params: { name: 'Julien' } })).toBe('Salut Julien 👋');
  });

  it('décline la même clé par personnalité (Pote/Pro/Direct)', () => {
    expect(t('bob.greeting', { personality: 'pro', params: { name: 'Julien' } })).toBe(
      'Bonjour Julien',
    );
    expect(t('bob.greeting', { personality: 'direct', params: { name: 'Julien' } })).toBe(
      'Julien —',
    );
  });

  it('laisse le placeholder intact si le paramètre manque', () => {
    expect(t('bob.greeting')).toBe('Salut {name} 👋');
  });

  it("migre les personnalités legacy 'Pote'/'Pro'/'Direct' vers les ids canoniques", () => {
    expect(normalizePersonality('Pote')).toBe('pote');
    expect(normalizePersonality('Direct')).toBe('direct');
    expect(normalizePersonality('pro')).toBe('pro');
    expect(normalizePersonality('Comptable')).toBe(DEFAULT_PERSONALITY);
    expect(normalizePersonality(undefined)).toBe(DEFAULT_PERSONALITY);
  });

  it("expose les libellés d'affichage sans toucher aux ids", () => {
    expect(PERSONALITY_LABELS.pote).toBe('Pote');
    expect(PERSONALITY_LABELS[normalizePersonality('Direct')]).toBe('Direct');
  });

  it('today.subtitle interpole {count} sur les 3 humeurs (variante n=0 séparée)', () => {
    expect(t('today.subtitle', { params: { count: 3 } })).toBe(
      '3 trucs à régler, et après tu factures tranquille.',
    );
    expect(t('today.subtitle', { personality: 'pro', params: { count: 3 } })).toBe(
      'Vous avez 3 priorités à traiter aujourd’hui.',
    );
    expect(t('today.subtitle', { personality: 'direct', params: { count: 3 } })).toBe(
      '3 priorités. Go.',
    );
    expect(t('today.subtitleNone')).toBe('Rien d’urgent. Profites-en.');
    expect(t('today.subtitleNone', { personality: 'direct' })).toBe('RAS.');
  });

  it('today.payoutHint interpole {amount} sur les 3 humeurs (langage prudent — jamais « te verser »)', () => {
    expect(t('today.payoutHint', { params: { amount: '2 000,00 €' } })).toBe(
      '~2 000,00 € de trésorerie mobilisable, réserves gardées. Ta rémunération : à préciser avec ton statut.',
    );
    expect(t('today.payoutHint', { personality: 'pro', params: { amount: '2 000,00 €' } })).toBe(
      'Trésorerie mobilisable : 2 000,00 €, réserves provisionnées. Rémunération à préciser selon votre statut.',
    );
    expect(t('today.payoutHint', { personality: 'direct', params: { amount: '2 000,00 €' } })).toBe(
      '~2 000,00 € mobilisables. Rémunération à préciser.',
    );
  });

  it('today.footer décline les 3 humeurs (VOICE_AND_TONE § Pied de page)', () => {
    expect(t('today.footer')).toBe('C’est tout pour aujourd’hui. Va bosser 🔧');
    expect(t('today.footer', { personality: 'pro' })).toBe('Vous êtes à jour pour aujourd’hui.');
    expect(t('today.footer', { personality: 'direct' })).toBe('Fini pour aujourd’hui.');
  });

  it('today.prioTransmit* : dit CE QUI MANQUE et CE QU’ON PEUT FAIRE, sur les 3 humeurs', () => {
    expect(t('today.prioTransmitTitle', { params: { name: 'Mme Leroy' } })).toBe(
      'Devis pas encore reçu — Mme Leroy',
    );
    expect(
      t('today.prioTransmitTitle', { personality: 'pro', params: { name: 'Mme Leroy' } }),
    ).toBe('Devis non transmis — Mme Leroy');
    expect(
      t('today.prioTransmitTitle', { personality: 'direct', params: { name: 'Mme Leroy' } }),
    ).toBe('Devis non reçu — Mme Leroy');

    // Le manque (« pas d'e-mail ») ET la sortie (ajouter l'adresse / envoyer le lien) sont dits
    // dans les trois tons — jamais un blocage passif, et jamais de jargon technique.
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const hint = t('today.prioTransmitHint', { personality });
      expect(hint.toLowerCase()).toContain('e-mail');
      expect(hint.toLowerCase()).toContain('lien');
      expect(hint).not.toContain('{');
      expect(t('today.prioTransmitBadge', { personality })).toBe('À transmettre');
      expect(t('today.ctaTransmitAddEmail', { personality }).length).toBeGreaterThan(0);
      expect(t('today.ctaTransmitShare', { personality }).length).toBeGreaterThan(0);
    }
    expect(t('today.prioTransmitHint', { personality: 'direct' })).toBe(
      'Pas d’e-mail : rien n’est parti. Ajoute l’adresse, ou envoie le lien.',
    );
  });

  it('raccourcis « Vite fait » : « Facture directe » (B1, jamais un « Facture » ambigu) et « À encaisser » (destination pré-filtrée) sur les 3 humeurs', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      expect(t('today.quickInvoice', { personality })).toBe('Facture directe');
      expect(t('today.quickCollect', { personality })).toBe('À encaisser');
    }
  });

  it('argent.* : copy pote exacte du proto (C11 — « LE SOLDE MENT »)', () => {
    expect(t('argent.subtitle')).toBe('Le vrai état des comptes, sans te mentir.');
    expect(t('argent.heroLabel')).toBe('Trésorerie mobilisable ce mois-ci');
    expect(t('argent.heroPill')).toBe('sans risque');
    expect(t('argent.soldeMent').toUpperCase()).toBe('LE SOLDE MENT');
    expect(t('argent.tipTitle')).toBe('Ton vrai dispo, pas le solde');
  });

  it('argent.bandCreux décline les 3 humeurs (notes de tranche de la prévision)', () => {
    expect(t('argent.bandCreux')).toBe('Creux, surveille');
    expect(t('argent.bandCreux', { personality: 'pro' })).toBe('Creux à surveiller');
    expect(t('argent.bandCreux', { personality: 'direct' })).toBe('Creux');
    expect(t('argent.bandPasse')).toBe('Ça passe');
  });

  it('argent.heroUpside interpole {upTo}/{name}/{amount} et les relances gèrent le singulier/pluriel', () => {
    expect(
      t('argent.heroUpside', { params: { upTo: '3 400 €', name: 'Martin', amount: '1 240 €' } }),
    ).toBe('Tu peux monter à 3 400 € si Martin règle ses 1 240 €. Je te préviens dès qu’il paie.');
    expect(t('argent.ctaRelanceOne')).toBe('Laisse l’assistant relancer ce client');
    expect(t('argent.ctaRelanceMany', { params: { count: 2 } })).toBe(
      'Laisse l’assistant relancer 2 clients',
    );
  });

  it('clients.* : copy pote exacte du proto (C12 — carnet, recherche, filtres, statuts)', () => {
    expect(t('clients.eyebrow')).toBe('Ton carnet');
    expect(t('clients.title')).toBe('Clients');
    expect(t('clients.searchPlaceholder')).toBe('Rechercher un client…');
    expect(t('clients.filterAll')).toBe('Tous');
    expect(t('clients.filterB2c')).toBe('Particuliers');
    expect(t('clients.filterB2b')).toBe('Entreprises');
    expect(t('clients.filterB2g')).toBe('Public');
    expect(t('clients.upToDate')).toBe('À jour');
    expect(t('clients.statusPaid')).toBe('payé');
    expect(t('clients.statusLate')).toBe('en retard');
    expect(t('clients.statusPending')).toBe('en attente');
    expect(t('clients.statusQuote')).toBe('devis');
    expect(t('clients.statusNew')).toBe('nouveau');
    expect(t('clients.badgeB2c').toUpperCase()).toBe('PART.');
  });

  it('clients.subtitle interpole {count}/{total} sur les 3 humeurs (variante 1 client séparée)', () => {
    expect(t('clients.subtitle', { params: { count: 6, total: '4 330 €' } })).toBe(
      '6 clients · 4 330 € en attente',
    );
    expect(
      t('clients.subtitle', { personality: 'pro', params: { count: 6, total: '4 330 €' } }),
    ).toBe('6 clients · 4 330 € en attente');
    expect(
      t('clients.subtitle', { personality: 'direct', params: { count: 6, total: '4 330 €' } }),
    ).toBe('6 clients · 4 330 € dus');
    expect(t('clients.subtitleOne', { params: { total: '120 €' } })).toBe(
      '1 client · 120 € en attente',
    );
  });

  it('clients : sous-titres contextuels, empty state et erreur déclinent les 3 humeurs', () => {
    expect(t('clients.subLateDays', { params: { days: 9 } })).toBe('Paie avec 9 j de retard');
    expect(t('clients.subLateDays', { personality: 'direct', params: { days: 9 } })).toBe(
      'Retard : 9 j',
    );
    expect(t('clients.subPendingB2g')).toBe('Suivi via Chorus Pro');
    expect(t('clients.emptyTitle')).toBe('Ton carnet est vide');
    expect(t('clients.emptyTitle', { personality: 'pro' })).toBe('Votre carnet est vide');
    expect(t('clients.noResults', { personality: 'direct' })).toBe('Aucun résultat.');
    expect(t('clients.dataError').length).toBeGreaterThan(0);
  });

  it('clients.create* (C40) : feuille de création minimale sur les 3 humeurs, succès interpolé', () => {
    expect(t('clients.createTitle')).toBe('Nouveau client');
    expect(t('clients.createHint', { personality: 'direct' })).toBe('Nom + type. Le reste après.');
    expect(t('clients.createNameLabel')).toBe('Nom');
    expect(t('clients.createTypeLabel', { personality: 'pro' })).toBe('Type de client');
    expect(t('clients.createSubmit')).toBe('Ajouter au carnet');
    expect(t('clients.createSuccess', { params: { name: 'Mme Nguyen' } })).toBe(
      'Mme Nguyen est dans ton carnet ✓',
    );
    expect(t('clients.createSuccess', { personality: 'pro', params: { name: 'Mme Nguyen' } })).toBe(
      'Mme Nguyen a été ajouté à votre carnet.',
    );
    expect(t('clients.createError', { personality: 'direct' })).toBe(
      'Création impossible. Réessaie.',
    );
  });

  it('fiche.* : copy du contrat C13 (score par tranche, conformité PA, actions)', () => {
    expect(t('fiche.scoreTitle')).toBe('Score de paiement');
    expect(t('fiche.scoreBad')).toBe('Paiements difficiles — reste vigilant');
    expect(t('fiche.scoreGood')).toBe('Bon payeur — nickel');
    expect(t('fiche.compliBodyPa')).toBe('Plateforme détectée · SIREN vérifié ✓ Tout est prêt.');
    expect(t('fiche.actionQuote')).toBe('Devis');
    expect(t('fiche.actionRelance')).toBe('Relancer');
    expect(t('fiche.actionCall')).toBe('Appeler');
    expect(t('fiche.actionEmail')).toBe('Email');
  });

  it('fiche.scoreMid interpole {days} sur les 3 humeurs (légende 50–75)', () => {
    expect(t('fiche.scoreMid', { params: { days: 22 } })).toBe('À surveiller · délai moyen 22 j');
    expect(t('fiche.scoreMid', { personality: 'pro', params: { days: 22 } })).toBe(
      'À surveiller · délai moyen de 22 jours',
    );
    expect(t('fiche.scoreMid', { personality: 'direct', params: { days: 22 } })).toBe(
      'À surveiller · 22 j de délai',
    );
  });

  it('fiche : CTA sticky par standing ({doc}/{amount}) et partyLine adaptatif b2b/b2g', () => {
    expect(t('fiche.ctaRelanceDoc', { params: { doc: 'F-2026-088', amount: '1 240 €' } })).toBe(
      'Relancer F-2026-088 · 1 240 €',
    );
    expect(t('fiche.ctaRelanceQuote')).toBe('Relancer le devis');
    expect(t('fiche.ctaNewQuote')).toBe('Nouveau devis');
    expect(t('fiche.badgeB2b')).toBe('Entreprise');
    expect(t('fiche.sirenLabel', { params: { siren: '821 503 642' } })).toBe('SIREN 821 503 642');
    expect(t('fiche.statusLate', { personality: 'direct', params: { days: 9 } })).toBe(
      'Retard 9 j',
    );
    expect(t('fiche.notFound').length).toBeGreaterThan(0);
    expect(t('fiche.dataError', { personality: 'pro' }).length).toBeGreaterThan(0);
  });

  it('refuse une clé inconnue à la compilation', () => {
    // @ts-expect-error — 'cle.inconnue' n'est pas une I18nKey : garantie compile-time.
    const invalid: () => string = () => t('cle.inconnue');
    expect(typeof invalid).toBe('function');
  });
});

describe('i18n — C14 docs.*', () => {
  it('décline le coffre-fort sur les 3 humeurs', () => {
    expect(t('docs.subtitle')).toBe('Je classe, tu retrouves. Même 3 ans après.');
    expect(t('docs.subtitle', { personality: 'pro' })).toBe(
      'Classement automatique, retrouvable des années après.',
    );
    expect(t('docs.subtitle', { personality: 'direct' })).toBe('Je classe. Tu retrouves.');
  });

  it('interpole le résumé du mois et la mémoire fournisseurs', () => {
    expect(t('docs.monthReadyTitle', { params: { month: 'Juillet' } })).toBe(
      'Juillet est prêt pour le comptable',
    );
    expect(t('docs.monthVat', { params: { amount: '31 €' } })).toBe('TVA récup. 31 €');
    expect(t('docs.memoryBody', { params: { examples: 'Leroy Merlin, Cedeo', count: 4 } })).toBe(
      'J’ai reconnu Leroy Merlin, Cedeo… 4 fournisseurs mémorisés pour classer plus vite.',
    );
    expect(t('docs.memoryBodyOne', { params: { examples: 'Cedeo' } })).toBe(
      'J’ai reconnu Cedeo — 1 fournisseur mémorisé pour classer plus vite.',
    );
  });

  it('pluralise dossiers, justificatifs et footer (One/None séparés)', () => {
    expect(t('docs.folderCount', { params: { count: 38 } })).toBe('38 documents');
    expect(t('docs.folderCountOne')).toBe('1 document');
    expect(t('docs.folderCountNone')).toBe('Vide');
    expect(t('docs.monthMissingOne')).toBe('1 justificatif manquant');
    expect(t('docs.footer', { params: { count: 141 } })).toBe(
      '141 documents · chiffré et sauvegardé',
    );
    expect(t('docs.footerOne')).toBe('1 document · chiffré et sauvegardé');
  });

  it('confirme le classement OCR (A1-C14) sur les 3 humeurs', () => {
    expect(t('docs.classifiedToast', { params: { supplier: 'Leroy Merlin' } })).toBe(
      'Leroy Merlin classé · Achats ✓',
    );
    expect(
      t('docs.classifiedToast', { personality: 'direct', params: { supplier: 'Cedeo' } }),
    ).toBe('Cedeo → Achats.');
    expect(t('docs.open')).toBe('Ouvrir');
  });

  it('badge type réel, « Je pense : … » et bandeau classé (design handoff, 3 humeurs)', () => {
    expect(t('docs.typeReceipt')).toBe('Ticket de caisse');
    expect(t('docs.typeReceipt', { personality: 'direct' })).toBe('Ticket');
    expect(t('docs.typeInsurance', { personality: 'pro' })).toBe('Attestation d’assurance');
    expect(t('docs.typeUnknown', { personality: 'pro' })).toBe('Analyse en attente');
    expect(t('docs.aiGuess')).toBe('Je pense : ');
    expect(t('docs.aiGuess', { personality: 'pro' })).toBe('Je suggère : ');
    expect(
      t('docs.classifiedBanner', {
        params: { name: 'Facture Leroy Merlin — 184,90 €', destination: 'Chantier Durand' },
      }),
    ).toBe('Facture Leroy Merlin — 184,90 € classé · Chantier Durand');
    expect(
      t('docs.classifiedBanner', {
        personality: 'direct',
        params: { name: 'Kbis', destination: 'Fiscal & social' },
      }),
    ).toBe('Kbis → Fiscal & social.');
    expect(t('docs.pickFolderMeta', { personality: 'direct' })).toBe('Dossier');
  });

  it('overlay scan : lecture, résultat et destination suggérée (3 humeurs)', () => {
    expect(t('scan.reading')).toBe('Je lis ton document…');
    expect(t('scan.reading', { personality: 'pro' })).toBe('Lecture du document en cours…');
    expect(t('scan.readDone')).toBe('Document lu');
    expect(t('scan.classifyInto', { params: { label: 'Chantier Durand' } })).toBe(
      'Classer dans Chantier Durand',
    );
    expect(t('scan.classifyInto', { personality: 'direct', params: { label: 'Achats' } })).toBe(
      '→ Achats',
    );
    expect(t('scan.chooseOtherFolder', { personality: 'direct' })).toBe('Autre dossier');
    expect(t('scan.attachedTo')).toBe('Rattaché à');
    expect(t('scan.destinationError', { personality: 'pro' })).toContain('À classer');
  });

  it('sous-titres factures récentes par canal (proto : PDP / e-reporting / Chorus)', () => {
    expect(t('docs.recentSubB2b', { params: { kind: 'Acompte' } })).toBe('Acompte · B2B → PDP');
    expect(t('docs.recentSubB2c')).toBe('Particulier · B2C → e-reporting');
    expect(t('docs.recentSubB2g', { personality: 'direct' })).toBe('B2G → Chorus');
    expect(t('docs.recentCustomerUnavailable')).toBe('Client indisponible');
    expect(t('docs.recentSubUnavailable', { params: { kind: 'Facture' } })).toBe(
      'Facture · canal à confirmer',
    );
  });
});

describe('i18n — C15 assistant.*', () => {
  it('copy pote exacte du proto (accueil, sous-titre, placeholder, chips)', () => {
    expect(t('assistant.welcome')).toBe(
      'Salut, moi c’est Bob 👋 Dis-moi quoi faire — créer, relancer, classer, t’expliquer ta tréso. Je m’en occupe pour de vrai.',
    );
    expect(t('assistant.subtitle')).toBe('Demande. Je fais — pas juste je réponds.');
    expect(t('assistant.placeholder')).toBe('Demande-moi un truc…');
    expect(t('assistant.chipRelance')).toBe('Relance les retards');
    expect(t('assistant.chipPayout')).toBe('Je peux me payer combien ?');
    expect(t('assistant.chipMonth')).toBe('Prépare le mois');
    expect(t('assistant.chipDiag')).toBe('Prêt pour 2026 ?');
  });

  it('décline les 3 humeurs (Pro vouvoie sans emoji, Direct ultra-court)', () => {
    expect(t('assistant.welcome', { personality: 'pro' })).not.toContain('👋');
    expect(t('assistant.subtitle', { personality: 'pro' })).toBe(
      'Demandez. J’agis — je ne me contente pas de répondre.',
    );
    expect(t('assistant.subtitle', { personality: 'direct' })).toBe('Demande. J’exécute.');
    expect(t('assistant.offline', { personality: 'direct' })).toBe(
      'Serveur injoignable. Réessaie.',
    );
  });

  it('confirmation explicite : libellés Valider/Annuler + garde-fou + commandes {ref}', () => {
    expect(t('assistant.confirm')).toBe('Valider');
    expect(t('assistant.cancel')).toBe('Annuler');
    expect(t('assistant.guardrail', { personality: 'pro' })).toBe(
      'Aucune action n’est exécutée sans votre validation.',
    );
    expect(t('assistant.cmdSendQuote', { params: { ref: 'D-2026-014' } })).toBe(
      'Renvoie le devis D-2026-014 au client',
    );
    expect(t('assistant.cmdCollect', { params: { ref: '2026-014' } })).toBe(
      'Encaisse la facture 2026-014',
    );
  });

  it('accès vocal global : états et contexte existent dans les trois humeurs', () => {
    expect(t('agent.global.idle')).toBe('Parler à Bob');
    expect(t('agent.global.listening', { personality: 'pro' })).toBe('Je vous écoute…');
    expect(t('agent.global.thinking', { personality: 'direct' })).toBe('Analyse…');
    expect(
      t('agent.global.context', { personality: 'pro', params: { context: 'facture F-14' } }),
    ).toBe('Contexte actif : facture F-14');
    expect(t('agent.global.reviewRequired', { personality: 'direct' })).toBe(
      'À finaliser dans l’Assistant. Rien de fait.',
    );
    expect(t('agent.global.continueInAssistant', { personality: 'direct' })).toBe(
      'Ouvrir l’Assistant',
    );
    expect(t('agent.global.heardNothing', { personality: 'pro' })).toBe(
      'Je n’ai rien entendu. Touchez le bouton pour reprendre.',
    );
    expect(t('agent.global.dismiss', { personality: 'pro' })).toBe('Fermer la réponse de Bob');
    // Plancher vocal : les textes de relance de consentement ne contiennent AUCUN token
    // que parseVoiceConsent accepte (ni confirmation, ni annulation) — l'écho ne décide jamais.
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const retry = t('live.unclearConsent', { personality }).toLowerCase();
      expect(retry).not.toMatch(
        /annul|je confirme|\bd.accord\b|\boui\b|\bok\b|vas[- ]?y|j.autorise/,
      );
    }
  });
});

describe('i18n — C20 voix.*', () => {
  it('copy pote exacte du proto (écoute, revue, issue, succès)', () => {
    expect(t('voix.title')).toBe('Facture à la voix');
    expect(t('voix.listening')).toBe('Je t’écoute…');
    expect(t('voix.listenHint')).toBe('Parle normalement — adresse, prestation, prix, paiement.');
    expect(t('voix.done')).toBe('C’est tout bon');
    expect(t('voix.reviewLead')).toBe('Voilà ce que j’ai compris');
    expect(t('voix.reviewSub')).toBe('Relis vite fait, et hop.');
    expect(t('voix.doneTitlePaid')).toBe('Payé ! 💸');
    expect(t('voix.finish')).toBe('Nickel, on continue');
  });

  it('décline les 3 humeurs et interpole {amount}/{name}/{number}/{rate}', () => {
    expect(t('voix.listening', { personality: 'pro' })).toBe('Je vous écoute…');
    expect(t('voix.doneTitlePaid', { personality: 'direct' })).toBe('Payé.');
    expect(t('voix.collectCta', { params: { amount: '245,00 €' } })).toBe(
      'Encaisser maintenant · 245,00 €',
    );
    expect(t('voix.vatRate', { params: { rate: 20 } })).toBe('TVA 20 %');
    expect(t('voix.donePaidText', { params: { amount: '245,00 €', number: 'F-2026-118' } })).toBe(
      '245,00 € encaissés. La facture F-2026-118 est émise, classée, et ta tréso est à jour.',
    );
    expect(
      t('voix.confirmSendBody', {
        personality: 'pro',
        params: { name: 'Mme Durand', amount: '245,00 €' },
      }),
    ).toBe('La facture de Mme Durand (245,00 €) sera émise avec son numéro légal.');
  });

  it('micro refusé/indisponible et erreurs : voix de Bob sur les 3 humeurs', () => {
    expect(t('voix.micDenied', { personality: 'direct' })).toBe(
      'Micro refusé. Réglages, ou écris.',
    );
    expect(t('voix.micUnavailable').length).toBeGreaterThan(0);
    expect(t('voix.errNoLines')).toBe(
      'Je n’ai pas entendu de prestation ni de montant — on réessaie ?',
    );
    expect(t('voix.errNoCustomer', { personality: 'pro' })).toBe(
      'Sélectionnez le client avant de facturer.',
    );
  });
});

describe('i18n — C21 devis.*', () => {
  it('protège la sortie du brouillon et explicite signature, proposition Bob et génération', () => {
    expect(t('devis.draftExit.title')).toBe('Que veux-tu faire de ce devis ?');
    expect(t('devis.draftExit.body', { personality: 'pro' })).toContain('reprendre ici plus tard');
    expect(t('devis.draftExit.signatureBody')).toContain('devra être refaite');
    expect(t('devis.draftExit.proposalBody', { personality: 'direct' })).toContain('non appliquée');
    expect(t('devis.draftExit.generationBody', { personality: 'pro' })).toContain(
      'éviter un doublon',
    );
    expect(t('devis.draftExit.persistenceError', { personality: 'pro' })).toContain('reste ouvert');
    expect(t('devis.draftExit.continue')).toBe('Continuer le devis');
    expect(t('devis.draftExit.save', { personality: 'direct' })).toBe('Garder et fermer');
    expect(t('devis.draftExit.discard')).toBe('Supprimer le brouillon');
  });

  it('titres des 6 étapes de la machine (client → lignes → TVA → acompte → signature → recap) + gardes à la voix de Bob (3 humeurs)', () => {
    expect(t('devis.stepClient')).toBe('Le client');
    expect(t('devis.stepVat')).toBe('TVA & mentions');
    expect(t('devis.stepRecap', { personality: 'direct' })).toBe('Récap');
    expect(t('devis.signTitle')).toBe('Comment il signe ?');
    expect(t('devis.signTitle', { personality: 'pro' })).toBe('Comment le client signe-t-il ?');
    expect(t('devis.guardClient', { personality: 'pro' })).toBe(
      'Sélectionnez un client avant de continuer.',
    );
    expect(t('devis.guardLines', { personality: 'direct' })).toBe('Une ligne minimum.');
    expect(t('devis.guardSignMode', { personality: 'direct' })).toBe('Sur place ou envoyer ?');
    expect(t('devis.guardSignature').length).toBeGreaterThan(0);
    expect(t('devis.guardDeposit', { personality: 'direct' })).toBe('Acompte : 0 à 100 %.');
  });

  it('interpole {pct}/{amount}/{number}/{rate} (acompte, recap, toast, TVA suggérée)', () => {
    expect(t('devis.depositSummary', { params: { pct: 30, amount: '488,40 €' } })).toBe(
      'Acompte 30 % — net à encaisser 488,40 €.',
    );
    expect(
      t('devis.recapSignedBody', {
        personality: 'pro',
        params: { number: 'F-2026-118', name: 'M. Bernard', amount: '488,40 €' },
      }),
    ).toBe('M. Bernard a signé le devis F-2026-118 — 488,40 € TTC.');
    expect(t('devis.toastSigned', { params: { number: 'F-2026-118' } })).toBe(
      'Devis F-2026-118 signé ✓',
    );
    expect(t('devis.toastSent', { params: { number: 'F-2026-118' } })).toBe(
      'Devis F-2026-118 envoyé ✓',
    );
    expect(t('devis.vatSuggested', { params: { rate: 10 } })).toBe('TVA suggérée : 10 %');
    expect(t('devis.vatHint', { personality: 'direct', params: { rate: 5.5 } })).toBe(
      'Tout à 5.5 %. Revérifié à la génération.',
    );
  });

  it('copy de flux : contexte TVA, signature (sur place/envoyer), recap — jamais de facture enchaînée (3 humeurs)', () => {
    expect(t('devis.vatHousing')).toBe('Logement de plus de 2 ans — 10 %');
    expect(t('devis.vatEnergy', { personality: 'direct' })).toBe('Réno énergétique — 5,5 %');
    expect(t('devis.signClear')).toBe('Effacer');
    expect(t('devis.signOnsiteCta', { personality: 'direct' })).toBe('Valider');
    expect(t('devis.sendCta', { personality: 'direct' })).toBe('Envoyer');
    expect(t('devis.confirmSendBody', { params: { name: 'M. Bernard', amount: '488,40 €' } })).toBe(
      'Le devis part chez M. Bernard par e-mail, avec le lien pour signer — 488,40 € TTC.',
    );
    expect(t('devis.confirmSignBody', { params: { name: 'M. Bernard', amount: '488,40 €' } })).toBe(
      'J’envoie le devis à M. Bernard et j’enregistre sa signature sur ton téléphone — 488,40 € TTC.',
    );
    expect(t('devis.errAction', { personality: 'pro' }).length).toBeGreaterThan(0);
  });
});

describe('i18n — C16 piece.*', () => {
  it('interpole l’acompte et l’avancement sur les 3 humeurs', () => {
    expect(t('piece.deposit', { params: { pct: 30, amount: '488,40 €' } })).toBe(
      'Acompte 30 % à la commande : 488,40 €',
    );
    expect(t('piece.progress', { personality: 'direct', params: { pct: 40 } })).toBe('40 %');
    expect(t('piece.vatPerLine', { params: { rate: 20 } })).toBe('TVA 20 %');
  });

  it('décline statuts et badge figé', () => {
    expect(t('piece.statusPartiallyPaid', { personality: 'pro' })).toBe('Partiellement payée');
    expect(t('piece.frozenBadge')).toBe('Figé à l’émission');
  });
});

describe('i18n — C25 notif.* + relance.*', () => {
  it('notif.* : copy de la cloche sur les 3 humeurs, items interpolés {name}/{doc}/{amount}/{days}', () => {
    expect(t('notif.title')).toBe('Notifications');
    expect(t('notif.subtitle')).toBe('Je te préviens quand ça compte — pas pour rien.');
    expect(t('notif.subtitle', { personality: 'pro' })).toBe(
      'L’essentiel de votre activité, au bon moment.',
    );
    expect(t('notif.subtitle', { personality: 'direct' })).toBe('L’essentiel. Rien d’autre.');
    expect(t('notif.itemRelanceTitle', { params: { name: 'SARL Martin' } })).toBe(
      'Relance SARL Martin',
    );
    expect(
      t('notif.itemRelanceSub', { params: { doc: 'F-2026-088', amount: '1 240 €', days: 9 } }),
    ).toBe('F-2026-088 · 1 240 € · 9 j de retard');
    expect(
      t('notif.itemDueSub', {
        personality: 'direct',
        params: { doc: 'F-2026-104', amount: '920 €', days: 3 },
      }),
    ).toBe('F-2026-104 · 920 € · J-3');
    expect(t('notif.actionView')).toBe('Voir la pièce');
    expect(t('notif.actionRelance')).toBe('Relancer');
    expect(t('notif.conformiteSub')).toBe(
      'Réception des e-factures à configurer avant le 1ᵉʳ sept. 2026.',
    );
    expect(t('notif.empty')).toBe('Rien à signaler — tout roule.');
    expect(t('notif.empty', { personality: 'direct' })).toBe('RAS.');
    expect(t('notif.dataError', { personality: 'pro' }).length).toBeGreaterThan(0);
  });

  it('consentement push : explique la valeur, laisse un vrai refus et distingue les états OS', () => {
    expect(t('notif.pushPrimerTitle')).toBe('Bob te prévient au bon moment');
    expect(t('notif.pushPrimerBody', { personality: 'pro' })).toContain(
      'Vous pouvez continuer sans les activer.',
    );
    expect(t('notif.pushPrimerLater')).toBe('Pas maintenant');
    expect(t('notif.pushDismissedBody', { personality: 'direct' })).toContain('Le fil reste ici.');
    expect(t('notif.pushDeniedBody')).toContain('Ton fil reste disponible ici.');
    expect(t('notif.pushSettingsAction', { personality: 'pro' })).toBe('Ouvrir les réglages');
    expect(t('notif.pushProvisionalTitle')).toBe('Alertes discrètes actives');
    expect(t('notif.pushProvisionalAction', { personality: 'direct' })).toBe('Tout autoriser');
    expect(t('notif.pushUnavailableBody', { personality: 'pro' })).toContain(
      'Votre fil reste disponible ici.',
    );
    expect(t('notif.pushEnabledToast')).toContain('Bob pourra te prévenir');
  });

  it('relance.* : 4 tons du proto, file interpolée {count}, garde-fou L441-10 sur les 3 humeurs', () => {
    expect(t('relance.toneCordial')).toBe('Cordial');
    expect(t('relance.toneNeutre')).toBe('Neutre');
    expect(t('relance.toneFerme')).toBe('Ferme');
    expect(t('relance.toneMed')).toBe('Mise en demeure');
    expect(t('relance.autoTitle')).toBe('Relances automatiques');
    expect(t('relance.autoSub')).toBe('Bob relance les retards tout seul, au bon moment.');
    expect(t('relance.queue', { params: { count: 2 } })).toBe('Actives · 2 clients en file');
    expect(t('relance.queueOne', { personality: 'pro' })).toBe(
      'Actives · 1 client en file d’attente',
    );
    expect(t('relance.medWarning')).toContain('L441-10');
    expect(t('relance.medWarning', { personality: 'pro' })).toContain('40 €');
    expect(t('relance.medWarning', { personality: 'direct' })).toContain(
      'jamais sans ta validation',
    );
    expect(t('relance.scheduledLine', { params: { tone: 'Ferme', date: '15/07/2026' } })).toBe(
      'Ferme · le 15/07/2026',
    );
  });

  it('C25 v2 : fil serveur (statuts d’envoi) + confirmation d’envoi réel interpolée', () => {
    expect(t('notif.sectionFeed', { personality: 'pro' })).toBe('Activité récente');
    expect(t('notif.feedDone')).toBe('Envoyée');
    expect(t('notif.feedFailed', { personality: 'direct' })).toBe('Échec. Je retente.');
    expect(t('relance.confirmTitle')).toBe('On envoie la relance ?');
    expect(t('relance.confirmBody', { params: { name: 'SARL Martin', amount: '1 240 €' } })).toBe(
      'J’envoie la relance de 1 240 € à SARL Martin, au ton du plan. Tu valides ?',
    );
    expect(t('relance.confirmMedNote', { personality: 'pro' })).toContain('L441-10');
    expect(t('relance.sentToast', { params: { name: 'SARL Martin' } })).toBe(
      'Relance envoyée à SARL Martin ✓',
    );
    expect(t('relance.queuedToast', { personality: 'pro', params: { name: 'SARL Martin' } })).toBe(
      'Relance programmée pour SARL Martin. L’envoi sera suivi dans l’activité.',
    );
    expect(t('relance.sendError', { personality: 'direct' })).toBe('Envoi KO. Réessaie.');
  });
});

describe('i18n — C23 diag.*', () => {
  it('copy pote exacte du proto §diag* (intro, question plateforme, résultat)', () => {
    expect(t('diag.title')).toBe('Diagnostic 2026');
    expect(t('diag.introTitle')).toBe('Prêt pour la facture électronique 2026 ?');
    // {count}=3 questions → phrase intro du proto à l'identique.
    expect(t('diag.introBody', { params: { count: 3 } })).toBe(
      'À partir du 1ᵉʳ sept. 2026, ton entreprise devra recevoir ses factures en électronique. 3 questions, je te dis où t’en es.',
    );
    expect(t('diag.introCta')).toBe('C’est parti — 2 min');
    expect(t('diag.qPlatform')).toBe('T’as déjà choisi ta plateforme agréée ?');
    expect(t('diag.qPlatformYes')).toBe('Oui, c’est fait');
    expect(t('diag.qPlatformUnknown')).toBe('C’est quoi, une plateforme ?');
    expect(t('diag.resultTitleMid')).toBe('Presque prêt 💪');
    // {count}=2 points → corps résultat du proto à l'identique.
    expect(t('diag.resultBody', { params: { count: 2 } })).toBe(
      '2 trucs à régler et tu seras tranquille pour septembre 2026.',
    );
    expect(t('diag.itemReception')).toBe('Plateforme de réception');
    expect(t('diag.itemReceptionTodo')).toBe('À configurer — le plus urgent');
    expect(t('diag.itemSirenTodo', { params: { count: 2 } })).toBe('2 fiches à compléter');
    expect(t('diag.itemDecennaleDone')).toBe('À jour ✓ — propre à ton métier');
    expect(t('diag.itemFacturxDone')).toBe('Géré automatiquement ✓');
    expect(t('diag.resultCta')).toBe('Configurer ma réception');
    expect(t('diag.resultLater')).toBe('Plus tard');
  });

  it('décline le parcours sur les 3 humeurs (questions adaptatives, axes, plan d’action)', () => {
    expect(t('diag.questionTag', { params: { n: 1, total: 3 } })).toBe('Question 1 / 3');
    expect(t('diag.questionTag', { personality: 'direct', params: { n: 2, total: 2 } })).toBe(
      'Q2 / 2',
    );
    expect(t('diag.auditMix', { personality: 'pro', params: { b2c: 4, b2b: 2, b2g: 1 } })).toBe(
      'Vos clients : 4 particuliers · 2 professionnels · 1 secteur public',
    );
    expect(t('diag.qOffApp', { personality: 'pro' })).toBe(
      'Encaissez-vous parfois hors de l’application (caisse, espèces) ?',
    );
    expect(t('diag.axisReception', { personality: 'direct' })).toBe('Réception');
    expect(t('diag.deadline', { params: { date: '01/09/2026' } })).toBe('avant le 01/09/2026');
    expect(t('diag.itemFranchiseNote', { personality: 'pro' })).toBe(
      'La franchise ne dispense pas de la facturation électronique',
    );
    expect(t('diag.dataError', { personality: 'direct' })).toBe('Chargement KO. Réessaie.');
  });

  it('onboard.* : copy pote exacte du proto (C22 — bienvenue, métier, clientèle, pédagogie 293 B)', () => {
    expect(t('onboard.welcomeTitle')).toBe('Ton bureau pro,\ndans ta poche.');
    expect(t('onboard.welcomeBody')).toBe(
      'Devis, factures, paiements, tréso, docs et conformité 2026. Bob s’occupe de la paperasse — toi, tu bosses.',
    );
    expect(t('onboard.welcomeCta')).toBe('Commencer');
    expect(t('onboard.tradeTitle')).toBe('Tu fais quoi, au juste ?');
    expect(t('onboard.tradeSub')).toBe('L’app va parler ton langage.');
    expect(t('onboard.tradeIncludes')).toBe('Ton espace inclura');
    expect(t('onboard.clientTitle')).toBe('Tu bosses surtout pour qui ?');
    expect(t('onboard.clientSub')).toBe('Ça décide de tes obligations de facturation élec.');
    // Pédagogie voix Bob (contrat C22) : la franchise 293 B ne dispense PAS de la facture élec.
    expect(t('onboard.vatFranchiseNote')).toBe(
      'Tu ne factures pas la TVA, mais la facture élec. te concerne quand même : dès septembre 2026, tu devras recevoir les factures de tes fournisseurs en électronique.',
    );
    expect(t('onboard.previewBody')).toBe('Dernier truc : vérifions que t’es paré pour 2026.');
  });

  it('auth.* : copy proto exacte (login, inscription SIRET, mails) sur les 3 humeurs — C24', () => {
    // Proto §auth (dc.html) : titres/champs/CTA à l'identique en Pote.
    expect(t('auth.loginTitle')).toBe('Bon retour 👋');
    expect(t('auth.loginSub')).toBe('Connecte-toi pour reprendre où tu en étais.');
    expect(t('auth.emailLabel')).toBe('Email professionnel');
    expect(t('auth.loginCta')).toBe('Se connecter');
    expect(t('auth.forgot')).toBe('Mot de passe oublié ?');
    expect(t('auth.switchToSignup')).toBe('Pas encore de compte ? Créer');
    expect(t('auth.switchToLogin')).toBe('Déjà un compte ? Se connecter');
    expect(t('auth.signupTitle')).toBe('Crée ton compte');
    expect(t('auth.signupSub')).toBe('Ton bureau pro, prêt en 2 minutes.');
    // Écart honnête vs proto : « 2FA » retiré du footer (non implémenté).
    expect(t('auth.footerSecure')).not.toContain('2FA');
    expect(t('auth.siretSub')).toContain('On récupère tes infos officielles');
    expect(t('auth.siretSub', { personality: 'pro' })).toBe(
      'Vos informations officielles seront récupérées automatiquement.',
    );
    expect(t('auth.errCredentials', { personality: 'direct' })).toBe('Identifiants KO.');
    expect(t('auth.verifyBody', { params: { email: 'julien@mercier-plomberie.fr' } })).toBe(
      'Je t’ai envoyé un lien de confirmation à julien@mercier-plomberie.fr. Clique dessus, puis reviens te connecter.',
    );
    expect(t('auth.resetSent', { personality: 'pro', params: { email: 'j@m.fr' } })).toBe(
      'Si un compte existe pour j@m.fr, le lien de réinitialisation a été envoyé.',
    );
  });

  it('auth.bio* / lock* : biométrie interpolée {method} sur les 3 humeurs — C24', () => {
    expect(t('auth.bioTitle', { params: { method: 'Face ID' } })).toBe('Déverrouille avec Face ID');
    expect(t('auth.bioTitle', { personality: 'pro', params: { method: 'Touch ID' } })).toBe(
      'Déverrouillage par Touch ID',
    );
    expect(t('auth.bioAccept', { params: { method: 'Face ID' } })).toBe('Activer Face ID');
    expect(t('auth.bioEnabled', { personality: 'direct', params: { method: 'Face ID' } })).toBe(
      'Face ID : ON.',
    );
    expect(t('auth.bioLater')).toBe('Plus tard');
    expect(t('auth.lockTitle')).toBe('Bob Pro est verrouillé');
    expect(t('auth.lockBody', { params: { method: 'Face ID' } })).toBe(
      'Ta session est bien au chaud — déverrouille avec Face ID.',
    );
    expect(t('auth.lockFallback', { personality: 'direct' })).toBe('Mot de passe');
    expect(t('auth.bioFailed', { personality: 'pro' })).toBe(
      'Authentification non reconnue. Réessayez.',
    );
  });

  it('auth.provisioning* + fiche société : provisioning tenant après confirmation (C24b) sur les 3 humeurs', () => {
    expect(t('auth.provisioningTitle')).toBe('On prépare ton espace');
    expect(t('auth.provisioningTitle', { personality: 'pro' })).toBe('Préparation de votre espace');
    expect(t('auth.provisioningTitle', { personality: 'direct' })).toBe('Espace en création.');
    expect(t('auth.provisioningBody')).toContain('infos officielles');
    expect(t('auth.provisioningError', { personality: 'direct' })).toBe('Création KO. Réessaie.');
    expect(t('auth.provisioningRetry')).toBe('Réessayer');
    expect(t('auth.provisioningSiretIntro', { personality: 'pro' })).toContain('SIRET');
    expect(t('auth.provisioningLegalFormLabel')).toBe('Sa forme juridique ?');
    expect(t('auth.provisioningConfirmCta', { personality: 'direct' })).toBe('Créer');
    expect(t('auth.provisioningSignOut')).toBe('Se déconnecter');
    // Fiche société complète au récap : forme juridique + date de création (lignes masquées si null).
    expect(t('auth.companyLegalFormLabel')).toBe('Forme juridique');
    expect(t('auth.companyCreatedLabel', { personality: 'pro' })).toBe('Date de création');
  });

  it('onboard.previewTitle interpole {trade} sur les 3 humeurs, CTA « C’est parti » / « Plus tard »', () => {
    expect(t('onboard.previewTitle', { params: { trade: 'plombier' } })).toBe(
      'Ton espace plombier est prêt',
    );
    expect(
      t('onboard.previewTitle', { personality: 'pro', params: { trade: 'électricien' } }),
    ).toBe('Votre espace électricien est prêt');
    expect(t('onboard.previewTitle', { personality: 'direct', params: { trade: 'pro' } })).toBe(
      'Espace pro : prêt.',
    );
    expect(t('onboard.previewCta')).toBe('C’est parti');
    expect(t('onboard.later', { personality: 'direct' })).toBe('Plus tard');
    expect(t('onboard.vatFranchiseSub', { personality: 'pro' })).toBe(
      'Art. 293 B du CGI — facturation sans TVA, mention obligatoire.',
    );
  });

  it('catalogue.* : titre proto « Mon catalogue », marqueur « prix indicatif » décliné ×3, suggestions devis', () => {
    expect(t('catalogue.title')).toBe('Mon catalogue');
    expect(t('catalogue.searchPlaceholder')).toBe('Chercher une prestation…');
    expect(t('catalogue.indicative')).toBe('prix indicatif');
    expect(t('catalogue.indicative', { personality: 'pro' })).toBe('Prix indicatif');
    expect(t('catalogue.indicative', { personality: 'direct' })).toBe('indicatif');
    expect(t('catalogue.suggestTitle')).toBe('Depuis ton catalogue');
    expect(t('catalogue.suggestTitle', { personality: 'pro' })).toBe('Depuis votre catalogue');
    expect(t('catalogue.vatRatePct', { params: { rate: '5,5' } })).toBe('5,5 %');
    expect(t('catalogue.sheetCustomizeTitle')).toBe('Mets ton prix');
  });

  it('reglages.* : titre proto « Facturation & modèles », numérotation sans trou déclinée ×3, {trade} interpolé', () => {
    expect(t('reglages.title')).toBe('Facturation & modèles');
    expect(t('reglages.title', { personality: 'pro' })).toBe('Facturation & modèles');
    expect(t('reglages.numberingBody')).toBe(
      'Chaque facture prend le numéro suivant, sans trou ni doublon — c’est la loi, et je m’en occupe.',
    );
    expect(t('reglages.numberingBody', { personality: 'pro' })).toBe(
      'Numérotation séquentielle sans rupture, allouée à l’émission — exigence légale gérée automatiquement.',
    );
    expect(t('reglages.numberingBody', { personality: 'direct' })).toBe(
      'Séquence sans trou, allouée à l’émission. Géré.',
    );
    expect(t('reglages.vatDefaultLabel', { params: { trade: 'Plombier' } })).toBe(
      'Règle de saisie TVA',
    );
    expect(t('reglages.soonBadge', { personality: 'pro' })).toBe('À venir');
    expect(t('reglages.mentionsEmpty', { personality: 'direct' })).toBe(
      'Visible dès ta première facture.',
    );
  });
});

describe('i18n — C26 account.*', () => {
  it('en-tête, onglets et sections du compte sur les 3 humeurs', () => {
    expect(t('account.title')).toBe('Mon compte');
    expect(t('account.eyebrow')).toBe('Ton compte');
    expect(t('account.eyebrow', { personality: 'pro' })).toBe('Votre compte');
    expect(t('account.tabProfile')).toBe('Profil');
    expect(t('account.tabSubscription')).toBe('Abonnement');
    expect(t('account.sectionCompany')).toBe('Entreprise');
    expect(t('account.sectionConnections')).toBe('Connexions');
    expect(t('account.sectionPlans')).toBe('Changer d’offre');
    expect(t('account.sectionPlans', { personality: 'direct' })).toBe('Offres');
    expect(t('account.signOut', { personality: 'direct' })).toBe('Déconnexion');
  });

  it('honnêteté : accès anticipé, CTA plans indisponibles, factures d’abo vides, banque à connecter', () => {
    expect(t('account.offerEarlyAccess')).toBe('Accès anticipé');
    expect(t('account.offerEarlyBody', { personality: 'direct' })).toBe(
      'Tout ouvert. 0 €. Prévenu avant tout changement.',
    );
    expect(t('account.planCtaUnavailable', { personality: 'pro' })).toBe(
      'Disponible à l’ouverture de la facturation',
    );
    expect(t('account.planChoose')).toBe('Choisir cette offre');
    expect(t('account.planManage', { personality: 'pro' })).toBe('Gérer l’abonnement');
    expect(t('account.invoicesEmpty')).toBe(
      'Aucune facture d’abonnement pour le moment. Elles apparaîtront ici après ton premier paiement.',
    );
    expect(t('account.invoicesEmptyEarlyAccess', { personality: 'pro' })).toBe(
      'Votre accès anticipé est gratuit : aucune facture d’abonnement n’est due.',
    );
    expect(t('account.invoiceStatusPaid')).toBe('Payée');
    expect(t('account.connToConnect')).toBe('À connecter');
    expect(t('account.serviceSoon', { personality: 'pro' })).toBe('À venir');
    expect(t('account.serviceActive')).toBe('Actif');
  });

  it('services, parrainage, équipe et erreurs à la voix de Bob', () => {
    expect(t('account.serviceOnlinePaymentSub')).toBe(
      'Encaisse par carte — 1,2 % par encaissement',
    );
    expect(t('account.serviceInsurance', { personality: 'direct' })).toBe('Décennale & RC Pro');
    expect(t('account.referralSoon', { personality: 'pro' })).toBe(
      'Prochainement : un mois offert pour vous deux.',
    );
    expect(t('account.teamRowSub', { personality: 'direct' })).toBe('Invitations, rôles. Bientôt.');
    expect(t('account.companyEmptyTitle', { personality: 'pro' })).toBe(
      'Complétez votre fiche entreprise',
    );
    expect(t('account.companyEmptyBody', { personality: 'pro' })).toBe(
      'Votre société ne semble pas reliée à votre compte — contactez-nous, nous nous en occupons avec vous.',
    );
    expect(t('account.dataError', { personality: 'direct' })).toBe('Profil injoignable. Réessaie.');
  });
});

describe('i18n — C-EXP-UI1 argent.upcoming* + relance pénalités/prescription', () => {
  it('échéancier fiscal : section, état vide 90 j honnête, erreur discrète, badge assumed ×3', () => {
    expect(t('argent.upcomingTitle')).toBe('À venir');
    expect(t('argent.upcomingTitle', { personality: 'pro' })).toBe('Échéances à venir');
    expect(t('argent.upcomingEmpty')).toContain('90');
    expect(t('argent.upcomingEmpty', { personality: 'pro' })).toBe(
      'Aucune échéance fiscale dans les 90 prochains jours.',
    );
    expect(t('argent.upcomingEmpty', { personality: 'direct' })).toBe('Rien sous 90 j.');
    expect(t('argent.upcomingError', { personality: 'direct' })).toBe('Échéances injoignables.');
    expect(t('argent.upcomingAssumed').toUpperCase()).toBe('À CONFIRMER');
  });

  it('pénalités courues : {daily}/{accrued} interpolés sur les 3 humeurs (jamais calculés ici)', () => {
    expect(t('relance.penaltiesLine', { params: { daily: '0,62 €', accrued: '27,71 €' } })).toBe(
      '+0,62 €/jour · 27,71 € courus',
    );
    expect(
      t('relance.penaltiesLine', {
        personality: 'pro',
        params: { daily: '0,62 €', accrued: '27,71 €' },
      }),
    ).toBe('+0,62 € par jour · 27,71 € courus à ce jour');
    expect(
      t('relance.penaltiesLine', {
        personality: 'direct',
        params: { daily: '0,62 €', accrued: '27,71 €' },
      }),
    ).toBe('+0,62 €/j · 27,71 €');
  });

  it('chrono de prescription : lointaine discrète, urgente « c’est perdu », prescrite grave ×3', () => {
    expect(t('relance.prescriptionFar', { params: { date: '12/03/2029' } })).toBe(
      'Prescription : t’as jusqu’au 12/03/2029.',
    );
    expect(t('relance.prescriptionLost', { params: { date: '15/09/2026' } })).toBe(
      'Après le 15/09/2026, c’est perdu — plus aucun recours.',
    );
    expect(
      t('relance.prescriptionLost', { personality: 'direct', params: { date: '15/09/2026' } }),
    ).toBe('Après le 15/09/2026 : perdu.');
    expect(
      t('relance.prescriptionDead', { personality: 'pro', params: { date: '02/01/2026' } }),
    ).toBe('Créance prescrite depuis le 02/01/2026 — aucun recours judiciaire possible.');
  });
});

describe('i18n — C-EXP-UI2 argent.urssaf*', () => {
  it('carte déclaration URSSAF : titre {period}, libellé provision, échéance {date} sur les 3 humeurs', () => {
    expect(t('argent.urssafTitle', { params: { period: 'T3 2026' } })).toBe(
      'Ta déclaration URSSAF · T3 2026',
    );
    expect(t('argent.urssafTitle', { personality: 'pro', params: { period: 'T3 2026' } })).toBe(
      'Déclaration URSSAF · T3 2026',
    );
    expect(
      t('argent.urssafTitle', { personality: 'direct', params: { period: 'juillet 2026' } }),
    ).toBe('URSSAF · juillet 2026');
    expect(t('argent.urssafSetAside')).toBe('À mettre de côté');
    expect(t('argent.urssafSetAside', { personality: 'pro' })).toBe('Montant à provisionner');
    expect(t('argent.urssafSetAside', { personality: 'direct' })).toBe('À provisionner');
    expect(t('argent.urssafDeclareBy', { params: { date: '31 oct.' } })).toBe(
      'À déclarer au plus tard le 31 oct.',
    );
    expect(
      t('argent.urssafDeclareBy', { personality: 'direct', params: { date: '31 oct.' } }),
    ).toBe('Déclaration : 31 oct. max.');
  });

  it('B9 — recherche intelligente devis & factures : chips de dates, filtres actifs, confirmation vocale composée', () => {
    expect(t('ventes.dateChip.lastMonth')).toBe('Mois dernier');
    expect(t('ventes.dateChip.customRange', { params: { from: '01/06', to: '30/06' } })).toBe(
      'Du 01/06 au 30/06',
    );
    expect(t('ventes.activeFilter.customer', { params: { name: 'Mairie de Sèvres' } })).toBe(
      'Client : Mairie de Sèvres',
    );
    // Le {period} interpolé est déjà composé côté appelant (ex. via ventes.period.lastMonth) —
    // ce test fige le contrat de forme des 3 variantes de confirmation vocale.
    expect(
      t('ventes.voiceSearchResultWithCustomerAndPeriod', {
        params: {
          kind: 'devis',
          customer: 'Mairie de Sèvres',
          period: 'du mois dernier',
          count: 3,
        },
      }),
    ).toBe('Voilà les devis de Mairie de Sèvres du mois dernier — j’en ai trouvé 3.');
    expect(
      t('ventes.voiceSearchResultWithCustomerAndPeriod', {
        personality: 'pro',
        params: { kind: 'factures', customer: 'SARL Martin', period: 'de ce mois-ci', count: 1 },
      }),
    ).toBe('Voici les factures de SARL Martin de ce mois-ci : 1 résultat(s).');
    expect(t('ventes.voiceSearchNoResults', { personality: 'direct' })).toBe('Aucun résultat.');
    expect(t('ventes.period.lastNMonths', { params: { n: 2 } })).toBe('des 2 derniers mois');
    expect(t('ventes.period.since', { params: { month: 'janvier' } })).toBe('depuis janvier');
  });
});

describe('i18n — modale menu profil (design_handoff_bob_pro/Bob Pro.dc.html §PROFILE SHEET)', () => {
  it('4 destinations ×3 humeurs + libellés de la feuille', () => {
    expect(t('menu.title', { personality: 'direct' })).toBe('Menu');
    expect(t('menu.account')).toBe('Mon compte & abonnement');
    expect(t('menu.accountSub', { personality: 'direct' })).toBe('Profil · entreprise · offre');
    expect(t('menu.onboarding', { personality: 'pro' })).toBe('Revoir l’onboarding');
    expect(t('menu.tips')).toBe('Revoir les astuces');
    expect(t('menu.tipsResetToast', { personality: 'direct' })).toBe('Astuces réaffichées.');
    expect(t('menu.diagnostic', { personality: 'pro' })).toBe('Diagnostic conformité 2026');
    expect(t('menu.diagnosticSub')).toBe('Où tu en es pour la facture élec.');
  });
});

describe('i18n — gate entreprise complète (DocumentActions.tsx, émission devis/facture)', () => {
  it('titre + CTA/annulation + repli générique', () => {
    expect(t('gate.companyIncompleteTitle', { personality: 'pro' })).toBe(
      'Complétez votre fiche entreprise',
    );
    expect(t('gate.companyIncompleteBody', { personality: 'direct' })).toBe(
      'Fiche entreprise incomplète. Réglages → Identité.',
    );
    expect(t('gate.companyIncompleteCta')).toBe('Compléter');
    expect(t('gate.companyIncompleteCancel', { personality: 'pro' })).toBe('Plus tard');
  });

  it('le corps NOMME le champ manquant et cite sa source légale, ×3 humeurs (bug FLY SERVICES)', () => {
    // Le générique « complète ta fiche » a fait chercher au fondateur un champ déjà rempli :
    // chaque exigence d'assertCanIssue a désormais SON corps — nom du champ + loi + où aller.
    const attendus = [
      ['gate.companyIncompleteBodyRcsOrRm', 'RCS', 'R123-237'],
      ['gate.companyIncompleteBodyAddress', 'adresse', 'L441-9'],
      ['gate.companyIncompleteBodyCapitalSocial', 'capital social', 'R123-238'],
      ['gate.companyIncompleteBodyTvaIntracom', 'TVA', '242 nonies A'],
    ] as const;
    for (const [key, champ, source] of attendus) {
      for (const personality of ['pote', 'pro', 'direct'] as const) {
        const body = t(key, { personality });
        expect(body.toLowerCase()).toContain(champ.toLowerCase());
        expect(body).toContain(source);
        expect(body).toContain('Réglages');
      }
    }
    expect(t('gate.companyIncompleteBodyCapitalSocial')).toBe(
      'Il manque ton capital social — c’est obligatoire sur les factures d’une société (art. R123-238 du code de commerce). Prends le montant de tes statuts : deux minutes dans Réglages → Identité.',
    );
  });
});

describe('i18n — Réglages facturation, fusion proto (retours device fondateur)', () => {
  it('back nomme l’écran de destination — plus de « Retour » générique', () => {
    expect(t('account.back')).toBe('Fermer');
    expect(t('reglages.back')).toBe('Compte');
    expect(t('catalogue.back', { personality: 'pro' })).toBe('Facturation');
  });

  it('aperçu en direct + identité (RCS/RM, capital, TVA et adresse ÉDITABLES, raison sociale/SIRET non)', () => {
    expect(t('reglages.previewLive')).toBe('Aperçu en direct');
    expect(t('reglages.sectionIdentity', { personality: 'direct' })).toBe('Identité');
    expect(t('reglages.identityRm')).toBe('N° RM / RCS');
    // Lignes ajoutées avec le correctif FLY SERVICES : le capital (sociétés) et la TVA doivent
    // être VISIBLES dans §Identité — leur invisibilité était la moitié du cul-de-sac.
    expect(t('reglages.identityCapital')).toBe('Capital social');
    expect(t('reglages.identityTva', { personality: 'direct' })).toBe('TVA intracom');
    // La note ne peut plus dire « non modifiable » de TOUT le bloc : depuis le correctif du
    // cul-de-sac d'émission, les QUATRE exigences d'assertCanIssue s'éditent ici. Seuls
    // raison sociale et SIRET restent verrouillés.
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const note = t('reglages.identityNotEditableNote', { personality });
      expect(note).toContain('SIRET');
    }
    expect(t('reglages.identityNotEditableNote', { personality: 'pro' })).toBe(
      'La raison sociale et le SIRET proviennent de votre inscription — contactez-nous pour les corriger. Le n° RCS/RM, le capital social, le n° de TVA et l’adresse sont modifiables ci-dessus.',
    );
    // Le bandeau de blocage nomme désormais AUSSI le capital — il listait tout sauf lui.
    expect(t('reglages.identityBlockingBody', { personality: 'pro' })).toContain('capital social');
  });

  it('logo — ajout/suppression ×3, permission refusée, note PDF à venir', () => {
    expect(t('reglages.logoAdd')).toBe('Ajouter');
    expect(t('reglages.logoChange', { personality: 'pro' })).toBe('Changer');
    expect(t('reglages.logoPermissionDenied', { personality: 'direct' })).toBe(
      'Accès photos requis.',
    );
    expect(t('reglages.logoOnPdfNote', { personality: 'direct' })).toBe(
      'Aperçu seulement pour l’instant. PDF à venir.',
    );
  });

  it('RIB — libellé toggle + feuille d’édition IBAN', () => {
    expect(t('reglages.ribToggleLabel')).toBe('Afficher le RIB sur les factures');
    expect(t('reglages.ribIbanEmpty', { personality: 'direct' })).toBe('Aucun IBAN');
    expect(t('reglages.ibanSheetInvalid', { personality: 'pro' })).toBe(
      'Cet IBAN ne semble pas valide — vérifiez la saisie.',
    );
    expect(t('reglages.ibanSheetSave')).toBe('Enregistrer');
  });

  it('feuille identité légale — capital social (sociétés, art. R123-238) et code postal exigé', () => {
    expect(t('reglages.legalSheetCapitalLabel')).toBe('Capital social');
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      // La pédagogie légale cite sa source au point de décision (doctrine LegalHint).
      expect(t('reglages.legalSheetCapitalHint', { personality })).toContain('R123-238');
      expect(t('reglages.legalSheetCapitalInvalid', { personality }).length).toBeGreaterThan(0);
      expect(t('reglages.legalSheetZipInvalid', { personality }).length).toBeGreaterThan(0);
    }
    expect(t('reglages.legalSheetZipInvalid', { personality: 'pro' })).toBe(
      'Le code postal du siège est requis.',
    );
  });

  it('assurance — adaptatif BTP (décennale) vs hors bâtiment (RC Pro)', () => {
    expect(t('reglages.sectionInsuranceBtp')).toBe('Assurance');
    expect(t('reglages.sectionInsuranceOther', { personality: 'direct' })).toBe('RC Pro');
    expect(t('reglages.insuranceToggleSubBtp')).toBe('Obligatoire pour le bâtiment');
    expect(t('reglages.insuranceEmptyOther', { personality: 'pro' })).toBe(
      'Aucune RC Pro enregistrée — contactez-nous pour l’ajouter.',
    );
  });

  it('valeurs par défaut — jours interpolés, conditions de paiement, note de branchement', () => {
    expect(t('reglages.defaultsValidityDays', { params: { days: 30 } })).toBe('30 jours');
    expect(
      t('reglages.defaultsValidityDays', { personality: 'direct', params: { days: 45 } }),
    ).toBe('45 j');
    expect(t('reglages.paymentTermsReception')).toBe('À réception');
    expect(t('reglages.paymentTermsJ30', { personality: 'pro' })).toBe('30 jours');
    expect(t('reglages.defaultsNote', { personality: 'direct' })).toBe(
      'Appliqué aux nouveaux devis, factures et PDF.',
    );
    expect(t('reglages.paymentTermsRequired', { personality: 'pro' })).toContain(
      'Aucune échéance n’est présumée',
    );
  });
});

describe('i18n — chantiers.* paramétré par métier (tradeToWorksiteTerminology @bob/core)', () => {
  // Reflète exactement worksiteParamsFor (apps/mobile/src/lib/worksite-terminology.ts) pour un
  // nom masculin (BTP, « chantier ») et un nom féminin (freelance IT, « mission ») — zéro texte
  // « chantier » figé ne doit survivre à l'interpolation pour un métier non-BTP.
  const chantierParams = {
    term: 'chantier',
    termCap: 'Chantier',
    plural: 'chantiers',
    pluralCap: 'Chantiers',
    article: 'un',
    de: 'du',
    newAdj: 'Nouveau',
    demonstrative: 'ce',
    articleDefCap: 'Le',
    premierAdj: 'premier',
    createdAdj: 'créé',
    aucunAdj: 'Aucun',
  };
  const missionParams = {
    term: 'mission',
    termCap: 'Mission',
    plural: 'missions',
    pluralCap: 'Missions',
    article: 'une',
    de: 'de la',
    newAdj: 'Nouvelle',
    demonstrative: 'cette',
    articleDefCap: 'La',
    premierAdj: 'première',
    createdAdj: 'créée',
    aucunAdj: 'Aucune',
  };

  it('titre/action : {pluralCap}/{newAdj} {term} sur les 3 humeurs, BTP et non-BTP', () => {
    expect(t('chantiers.title', { params: chantierParams })).toBe('Chantiers');
    expect(t('chantiers.title', { personality: 'pro', params: missionParams })).toBe('Missions');
    expect(t('chantiers.add', { params: chantierParams })).toBe('Nouveau chantier');
    expect(t('chantiers.add', { personality: 'pro', params: chantierParams })).toBe(
      'Créer un chantier',
    );
    expect(t('chantiers.add', { params: missionParams })).toBe('Nouvelle mission');
    expect(t('chantiers.add', { personality: 'pro', params: missionParams })).toBe(
      'Créer une mission',
    );
    expect(t('chantiers.add', { personality: 'direct', params: missionParams })).toBe(
      'Nouvelle mission',
    );
  });

  it('confirmation de création : accord du genre en tête de phrase (Le/La) ET du participe (créé/créée)', () => {
    expect(
      t('chantiers.created', {
        personality: 'pro',
        params: { ...chantierParams, name: 'Villa Durand' },
      }),
    ).toBe('Le chantier Villa Durand a été créé.');
    expect(
      t('chantiers.created', {
        personality: 'pro',
        params: { ...missionParams, name: 'Refonte du site' },
      }),
    ).toBe('La mission Refonte du site a été créée.');
  });

  it('erreur de création : démonstratif accordé (ce/cette) et contraction de/du/de la', () => {
    expect(t('chantiers.createError', { params: chantierParams })).toBe(
      'Je n’ai pas pu créer ce chantier. Rien n’a été perdu, réessaie.',
    );
    expect(t('chantiers.createError', { params: missionParams })).toBe(
      'Je n’ai pas pu créer cette mission. Rien n’a été perdu, réessaie.',
    );
    expect(t('chantiers.createError', { personality: 'pro', params: chantierParams })).toBe(
      'La création du chantier a échoué. Aucune donnée n’a été perdue.',
    );
    expect(t('chantiers.createError', { personality: 'pro', params: missionParams })).toBe(
      'La création de la mission a échoué. Aucune donnée n’a été perdue.',
    );
  });

  it('module non débloqué : {pluralCap} dans le titre ET le corps, jamais « Chantiers » figé pour une mission', () => {
    expect(t('chantiers.moduleTitle', { params: missionParams })).toBe('Module Missions');
    expect(t('chantiers.moduleBody', { personality: 'pro', params: missionParams })).toBe(
      'Activez ce module pour regrouper devis, factures et situations par mission.',
    );
    expect(t('chantiers.profileError', { personality: 'pro', params: missionParams })).toBe(
      'Impossible de vérifier l’activation du module Missions. Veuillez réessayer.',
    );
  });

  it('états vides et libellés de liste : {plural}/{term} accordés', () => {
    expect(t('chantiers.dataError', { personality: 'pro', params: missionParams })).toBe(
      'Impossible de charger les missions. Veuillez réessayer.',
    );
    expect(t('chantiers.emptyTitle', { params: chantierParams })).toBe(
      'Aucun chantier pour l’instant',
    );
    expect(t('chantiers.emptyTitle', { params: missionParams })).toBe(
      'Aucune mission pour l’instant',
    );
    expect(t('chantiers.emptyTitle', { personality: 'direct', params: missionParams })).toBe(
      'Aucune mission',
    );
    expect(t('chantiers.emptyBody', { personality: 'pro', params: chantierParams })).toBe(
      'Créez un premier chantier afin d’y associer les devis, factures et documents concernés.',
    );
    expect(t('chantiers.emptyBody', { personality: 'pro', params: missionParams })).toBe(
      'Créez une première mission afin d’y associer les devis, factures et documents concernés.',
    );
    expect(t('chantiers.emptyBody', { personality: 'direct', params: missionParams })).toBe(
      'Crée une mission pour y rattacher tes pièces.',
    );
    expect(t('chantiers.listTitle', { params: missionParams })).toBe('Tes missions');
    expect(t('chantiers.listTitle', { personality: 'pro', params: missionParams })).toBe(
      'Vos missions',
    );
  });

  it('formulaire de création : contraction « de » (Nom du chantier / Nom de la mission)', () => {
    expect(t('chantiers.nameLabel', { params: chantierParams })).toBe('Nom du chantier');
    expect(t('chantiers.nameLabel', { params: missionParams })).toBe('Nom de la mission');
    expect(t('chantiers.addressPlaceholder', { personality: 'pro', params: chantierParams })).toBe(
      'Adresse du chantier (facultatif)',
    );
    expect(t('chantiers.addressPlaceholder', { personality: 'pro', params: missionParams })).toBe(
      'Adresse de la mission (facultatif)',
    );
    expect(t('chantiers.createSubmit', { params: missionParams })).toBe('Créer une mission');
  });

  it('permission appareil photo (chantierFiche.*) : seule clé qui nommait encore « chantier » en dur', () => {
    expect(t('chantierFiche.photoPermissionCamera', { params: chantierParams })).toBe(
      'Autorise l’appareil photo pour prendre une photo du chantier.',
    );
    expect(t('chantierFiche.photoPermissionCamera', { params: missionParams })).toBe(
      'Autorise l’appareil photo pour prendre une photo de la mission.',
    );
  });
});

describe('i18n — B8 po.* (bon de commande grands comptes)', () => {
  it('état vide devis : copy pote exacte de la mission, déclinée sur les 3 humeurs', () => {
    expect(t('po.sectionTitle')).toBe('Bon de commande');
    expect(t('po.emptyQuoteBody')).toBe(
      'Ton client t’a envoyé un bon de commande ? Ajoute son numéro : il suivra jusqu’à la facture.',
    );
    expect(t('po.emptyQuoteBody', { personality: 'pro' })).toBe(
      'Votre client a émis un bon de commande ? Ajoutez son numéro : il sera repris sur la facture.',
    );
    expect(t('po.emptyQuoteBody', { personality: 'direct' })).toBe(
      'Bon de commande reçu ? Ajoute le numéro — repris sur la facture.',
    );
    expect(t('po.emptyInvoiceBody', { personality: 'direct' })).toBe(
      'Bon de commande ? Ajoute le numéro avant l’émission.',
    );
    expect(t('po.addCta')).toBe('Ajouter le numéro');
  });

  it('formulaire : libellés, erreurs et picker du coffre sur les 3 humeurs', () => {
    expect(t('po.numberLabel', { personality: 'pro' })).toBe('Numéro d’engagement');
    expect(t('po.numberInvalid', { personality: 'direct' })).toBe('Numéro requis (60 car. max).');
    expect(t('po.dateInvalid', { personality: 'pro' })).toBe(
      'Date invalide. Format attendu : JJ/MM/AAAA.',
    );
    expect(t('po.datePlaceholder')).toBe('JJ/MM/AAAA');
    expect(t('po.documentPickCta')).toBe('Lier un document');
    expect(t('po.documentPickerEmpty', { personality: 'direct' })).toBe('Coffre vide.');
    expect(t('po.saveCta')).toBe('Enregistrer');
    expect(t('po.saveError', { personality: 'direct' })).toBe('Enregistrement KO. Réessaie.');
  });

  it('carte remplie : date {date}, retrait {number} et lecture seule (figé/déjà facturé) ×3', () => {
    expect(t('po.receivedOn', { params: { date: '15/07/2026' } })).toBe('Reçu le 15/07/2026');
    expect(t('po.receivedOn', { personality: 'direct', params: { date: '15/07/2026' } })).toBe(
      'Reçu 15/07/2026',
    );
    expect(t('po.removeConfirmBody', { params: { number: 'BC-2026-0458' } })).toBe(
      'Le numéro BC-2026-0458 ne suivra plus jusqu’à la facture.',
    );
    expect(
      t('po.removeConfirmBody', { personality: 'pro', params: { number: 'BC-2026-0458' } }),
    ).toBe('Le numéro BC-2026-0458 ne sera plus repris sur la facture.');
    expect(t('po.frozenNote')).toBe('Figé à l’émission — ce numéro figure sur la facture.');
    expect(t('po.quoteInvoicedNote', { personality: 'direct' })).toBe(
      'Déjà facturé — gère le BC sur la facture.',
    );
  });

  it('réassurance à la génération de facture : « Bon de commande n° X repris sur la facture » ×3', () => {
    expect(t('po.carriedToInvoice', { params: { number: 'BC-2026-0458' } })).toBe(
      'Bon de commande n° BC-2026-0458 repris sur la facture',
    );
    expect(
      t('po.carriedToInvoice', { personality: 'pro', params: { number: 'BC-2026-0458' } }),
    ).toBe('Bon de commande n° BC-2026-0458 repris sur la facture.');
    expect(
      t('po.carriedToInvoice', { personality: 'direct', params: { number: 'BC-2026-0458' } }),
    ).toBe('BC n° BC-2026-0458 repris sur la facture.');
    expect(t('po.voice.sheetOpened', { personality: 'direct' })).toBe(
      'Saisie du bon de commande ouverte.',
    );
  });
});

describe('i18n — seuils micro JAMAIS en dur (référentiel temporel @bob/core, doctrine « jamais un chiffre périmable »)', () => {
  const personalities = ['pote', 'pro', 'direct'] as const;
  const microThresholdKeys = [
    'fiscal.tax_regime_choice.micro.micro',
    'fiscal.tax_regime_choice.EI.micro',
    'fiscal.tax_regime_choice.EURL.micro',
  ] as const;

  it('chaque explication micro porte {ventes} ET {services} — les montants viennent du référentiel, pas du catalogue', () => {
    for (const key of microThresholdKeys) {
      for (const personality of personalities) {
        const template = t(key, { personality });
        expect(template, `${key} (${personality})`).toContain('{ventes}');
        expect(template, `${key} (${personality})`).toContain('{services}');
      }
    }
  });

  it('aucun seuil micro figé dans les templates (ni 188 700/77 700 périmés, ni 203 100/83 600 périmables)', () => {
    for (const key of microThresholdKeys) {
      for (const personality of personalities) {
        const template = t(key, { personality });
        expect(template, `${key} (${personality})`).not.toMatch(/188|77\s|203|83\s/u);
      }
    }
  });

  it('les params interpolent proprement (aucune accolade restante avec {ventes}/{services} fournis)', () => {
    for (const key of microThresholdKeys) {
      for (const personality of personalities) {
        const text = t(key, { personality, params: { ventes: '203 100 €', services: '83 600 €' } });
        expect(text, `${key} (${personality})`).not.toMatch(/\{|\}/u);
        expect(text).toContain('203 100 €');
        expect(text).toContain('83 600 €');
      }
    }
  });

  it("l'EURL au micro est expliquée avec sa double condition (associé unique gérant personne physique)", () => {
    expect(t('fiscal.tax_regime_choice.EURL.micro', { personality: 'pro' })).toContain('associé unique');
    expect(t('fiscal.tax_regime_choice.EURL.micro', { personality: 'pote' })).toContain('gérant');
  });
});

describe('catalogue legal (LegalHint — protections légales ×3 tons)', () => {
  it('formule le BÉNÉFICE in-line de l’embargo avec la date, sur les 3 humeurs', () => {
    expect(t('legal.embargo.inline', { params: { date: '09/06/2026' } })).toBe(
      'Encaissement possible le 09/06/2026 — la loi anti-démarchage te protège d’un contrat annulable.',
    );
    expect(t('legal.embargo.inline', { personality: 'pro', params: { date: '09/06/2026' } })).toContain(
      'vous protège',
    );
    expect(t('legal.embargo.inline', { personality: 'direct', params: { date: '09/06/2026' } })).toContain(
      '09/06/2026',
    );
  });

  it('le bloc « loi » de chaque hint reste simple et sans jargon inutile, décliné ×3', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      for (const key of [
        'legal.embargo.law',
        'legal.urgentRepair.law',
        'legal.signatureChannel.law',
      ] as const) {
        expect(t(key, { personality }).length).toBeGreaterThan(0);
      }
    }
  });

  it('la confirmation d’override reformule le risque CONCRET (remboursement + annulation + responsabilité)', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const risk = t('legal.embargoOverride.risk', { personality });
      expect(risk).toContain('rembours');
      expect(risk).toContain('annuler');
      expect(risk.toLowerCase()).toContain('responsabilité');
      expect(risk).toContain('L242-1');
    }
  });

  it('la question du wizard dépannage urgent existe sur les 3 humeurs', () => {
    expect(t('legal.urgentRepair.question')).toContain('urgent');
    expect(t('legal.urgentRepair.question', { personality: 'pro' })).toContain('expressément');
    expect(t('legal.urgentRepair.question', { personality: 'direct' }).length).toBeGreaterThan(0);
  });

  it('le conseil du canal de signature dit le bénéfice (acompte immédiat), jamais l’injonction', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const banner = t('legal.signatureChannel.banner', { personality });
      expect(banner).toContain('lien');
      expect(banner.toLowerCase()).toContain('acompte');
    }
  });

  // ── Épic B — facturation terrain (catalogue billing-terrain) ────────────────
  it('facture directe : badge, garde b2c et blocage pro étranger existent sur les 3 humeurs', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      for (const key of [
        'fd.title',
        'fd.badge',
        'fd.urgentQuestion',
        'fd.urgentRequiredBody',
        'fd.intlBlockedTitle',
        'fd.intlBlockedBody',
        'legal.fdUrgent.law',
        'legal.intl.law',
      ] as const) {
        expect(t(key, { personality }).length).toBeGreaterThan(0);
      }
    }
    // Le blocage B7 nomme les DEUX régimes réels — jamais un refus inexpliqué.
    expect(t('legal.intl.law', { personality: 'pro' })).toContain('autoliquide');
    expect(t('legal.intl.law', { personality: 'pro' })).toContain('export');
  });

  it('situations : cumul, reste et confirmation interpolent leurs paramètres ×3', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      expect(
        t('situation.alreadyInvoiced', { personality, params: { amount: '500,00 €', pct: 50 } }),
      ).toContain('500,00 €');
      expect(
        t('situation.confirmBody', {
          personality,
          params: { pct: 30, amount: '488,40 €', number: 'D-2026-0001' },
        }),
      ).toContain('D-2026-0001');
      expect(t('situation.remaining', { personality, params: { amount: '100,00 €' } })).toContain(
        '100,00 €',
      );
    }
  });

  it('conditions de paiement : « fin de mois » et l’échéance dérivée interpolent ×3', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      expect(t('terms.daysEom', { personality, params: { days: 45 } })).toContain('45');
      expect(t('terms.daysEom', { personality, params: { days: 45 } }).toLowerCase()).toContain(
        'fin de mois',
      );
      expect(
        t('terms.dueAtIssued', { personality, params: { date: '12/09/2026', label: '45 jours fin de mois' } }),
      ).toContain('12/09/2026');
      // Le LegalHint des plafonds cite les deux bornes légales L441-10.
      const law = t('legal.terms.law', { personality });
      expect(law).toContain('60');
      expect(law).toContain('45');
    }
  });

  it('retenue de garantie : la loi 71-584 est expliquée (5 %, un an après réception) ×3', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const law = t('legal.retenue.law', { personality });
      expect(law).toContain('5 %');
      expect(law.toLowerCase()).toContain('réception');
      expect(t('retenue.toggleHint', { personality, params: { pct: 5 } })).toContain('5');
      expect(t('retenue.suiviTitle', { personality }).length).toBeGreaterThan(0);
    }
  });

  it('n° d’immatriculation : la loi R123-237 est expliquée (RCS/RM, greffe) ×3', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const law = t('legal.rcs.law', { personality });
      expect(law).toContain('RCS');
      expect(law).toContain('RM');
      expect(t('legal.rcs.inline', { personality }).length).toBeGreaterThan(0);
      expect(t('legal.rcs.why', { personality }).length).toBeGreaterThan(0);
    }
  });

  it('identité légale éditable : la feuille et ses erreurs sont déclinées ×3', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      for (const key of [
        'reglages.legalSheetTitle',
        'reglages.legalSheetBody',
        'reglages.legalSheetRcsLabel',
        'reglages.legalSheetRcsInvalid',
        'reglages.legalSheetAddressLabel',
        'reglages.legalSheetLine1Invalid',
        'reglages.legalSheetCityInvalid',
        'reglages.legalSheetError',
        'reglages.legalSheetSave',
        'reglages.legalSheetCancel',
        'reglages.identityEmpty',
        'reglages.identityBlockingTitle',
        'reglages.identityBlockingBody',
        'reglages.identityFixCta',
      ] as const) {
        const copy = t(key, { personality });
        expect(copy.length).toBeGreaterThan(0);
        // Une clé absente serait renvoyée telle quelle : jamais « reglages.xxx » à l'écran.
        expect(copy.startsWith('reglages.')).toBe(false);
      }
    }
  });

  it('hypothèse RCS : la valeur proposée et l’avertissement Kbis s’interpolent ×3', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      expect(
        t('reglages.legalSuggestRcsLabel', {
          personality,
          params: { value: '732 829 320 RCS Paris' },
        }),
      ).toContain('732 829 320 RCS Paris');
      // La confirmation obligatoire est PORTÉE PAR LE TEXTE : le greffe n'est pas toujours
      // la ville du siège — l'utilisateur doit vérifier son Kbis.
      expect(t('reglages.legalSuggestRcsHint', { personality })).toContain('Kbis');
      expect(t('reglages.legalSuggestApply', { personality }).length).toBeGreaterThan(0);
      // Artisan RM : le format est rappelé, aucune valeur n'est proposée.
      expect(
        t('reglages.legalSuggestRmHint', {
          personality,
          params: { placeholder: '812 345 676 RM 75' },
        }),
      ).toContain('812 345 676 RM 75');
    }
  });

  it('canal de facturation : guide et suivi déclaré interpolent leurs dates ×3', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      expect(t('guide.depositedOn', { personality, params: { date: '19/07/2026' } })).toContain(
        '19/07/2026',
      );
      expect(t('guide.acceptedOn', { personality, params: { date: '20/07/2026' } })).toContain(
        '20/07/2026',
      );
      expect(t('guide.actionOpenPortal', { personality, params: { name: 'Coupa' } })).toContain(
        'Coupa',
      );
      expect(t('canal.sectionTitle', { personality }).length).toBeGreaterThan(0);
    }
  });
});

describe('devis — confirmation honnête quand le client n’a pas d’e-mail', () => {
  it('ne promet JAMAIS un envoi e-mail dans la copie « préparé »', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const titre = t('devis.recapPreparedTitle', { personality });
      const corps = t('devis.recapPreparedBody', {
        personality,
        params: { number: 'D-2026-0042', name: 'Jean de la Croix', amount: '1 200,00 €' },
      });
      expect(titre.length).toBeGreaterThan(0);
      // Le mot « e-mail » peut apparaître pour dire qu'il MANQUE, jamais pour dire qu'il est parti.
      expect(corps).not.toMatch(/a reçu|envoyé par e-mail|reçu le devis/iu);
      expect(corps).toContain('D-2026-0042');
      expect(corps).toContain('Jean de la Croix');
    }
  });
});

describe('repli acompte professionnel — situation n°1 (B2B/B2G, décision fondateur 25/07)', () => {
  it('toutes les clés du repli existent sur les 3 tons, jamais une clé brute à l’écran', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      for (const key of [
        'advanceFallback.option',
        'advanceFallback.optionHint',
        'advanceFallback.sheetTitle',
        'advanceFallback.sheetBody',
        'advanceFallback.confirm',
        'advanceFallback.cancel',
        'legal.advanceFallback.inline',
        'legal.advanceFallback.law',
        'legal.advanceFallback.why',
      ] as const) {
        const copy = t(key, { personality, params: { pct: 30 } });
        expect(copy.length).toBeGreaterThan(0);
        // Une clé absente serait renvoyée telle quelle par `t` — jamais à l'écran.
        expect(copy.startsWith('advanceFallback.')).toBe(false);
        expect(copy.startsWith('legal.')).toBe(false);
      }
    }
  });

  it('ne promet JAMAIS une facture d’acompte : l’option et le CTA nomment une SITUATION', () => {
    // La pièce créée par le repli est une situation de travaux. Son libellé de choix et son
    // bouton de confirmation ne doivent jamais s'appeler « acompte » — sinon l'artisan croit
    // émettre la pièce que la garde Factur-X vient précisément de fermer (promesse trompeuse).
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      for (const key of ['advanceFallback.option', 'advanceFallback.confirm'] as const) {
        const copy = t(key, { personality, params: { pct: 30 } });
        expect(copy.toLowerCase()).toContain('situation');
        expect(copy).toContain('30');
        expect(copy.toLowerCase()).not.toContain('acompte');
      }
    }
  });

  it('le % par défaut reste MODIFIABLE d’après la copy — jamais un 30 % imposé', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const body = t('advanceFallback.sheetBody', { personality, params: { pct: 30 } });
      expect(body).toContain('30');
      // Chaque ton dit que le pourcentage se règle avant création.
      expect(body.toLowerCase()).toMatch(/règle|réglable/u);
    }
  });

  it('la loi cite le format en cause (EN 16931/Factur-X) et le refus de donnée fausse ×3', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const law = t('legal.advanceFallback.law', { personality });
      expect(law).toContain('16931');
      expect(law).toContain('Factur-X');
      expect(law.toLowerCase()).toMatch(/fausse|erronée/u);
      const why = t('legal.advanceFallback.why', { personality });
      // Le bénéfice du repli : même encaissement, pièces justes — dit dans « pourquoi ».
      expect(why.toLowerCase()).toMatch(/encaisses pareil|encaissement identique/u);
      expect(why.toLowerCase()).toContain('situation');
    }
  });
});

describe('position de trésorerie — les DEUX nombres, sur les 3 humeurs', () => {
  // Le solde constaté seul faisait croire à un bug (facture encaissée, solde figé). La copy doit
  // TOUJOURS porter le constaté daté À CÔTÉ de l'estimé, et ne jamais présenter l'estimé comme
  // un relevé bancaire.
  it('today.balanceEstimatedVoice interpole le constaté ET sa date sur les 3 humeurs', () => {
    const params = { observed: '1 000,00 €', date: '19/07/2026' };
    expect(t('today.balanceEstimatedVoice', { params })).toBe(
      'Constaté 1 000,00 € le 19/07/2026 — j’ai ajouté ce qui a bougé depuis.',
    );
    expect(t('today.balanceEstimatedVoice', { personality: 'pro', params })).toBe(
      'Solde constaté 1 000,00 € le 19/07/2026, ajusté des mouvements postérieurs.',
    );
    expect(t('today.balanceEstimatedVoice', { personality: 'direct', params })).toBe(
      'Constaté 1 000,00 € le 19/07/2026. Le reste est estimé.',
    );
  });

  it('today.balanceMovementsBadge expose entrées ET sorties sur les 3 humeurs', () => {
    const params = { inflow: '60,00 €', outflow: '184,90 €' };
    expect(t('today.balanceMovementsBadge', { params })).toBe(
      '+60,00 € encaissés · −184,90 € sortis',
    );
    expect(t('today.balanceMovementsBadge', { personality: 'pro', params })).toBe(
      '+60,00 € encaissés · −184,90 € décaissés',
    );
    expect(t('today.balanceMovementsBadge', { personality: 'direct', params })).toBe(
      '+60,00 € · −184,90 €',
    );
  });

  it('argent.positionObservedMention garde le FAIT daté visible sur les 3 humeurs', () => {
    const params = { observed: '2 500,00 €', date: '19/07/2026' };
    expect(t('argent.positionObservedMention', { params })).toBe('Constaté 2 500,00 € le 19/07/2026');
    expect(t('argent.positionObservedMention', { personality: 'pro', params })).toBe(
      'Solde constaté : 2 500,00 € le 19/07/2026',
    );
    expect(t('argent.positionObservedMention', { personality: 'direct', params })).toBe(
      'Constaté 2 500,00 € · 19/07/2026',
    );
  });

  it('argent.positionMovements détaille entrées et sorties sur les 3 humeurs', () => {
    const params = { inflow: '60,00 €', outflow: '184,90 €' };
    expect(t('argent.positionMovements', { params })).toBe(
      'Depuis : +60,00 € encaissés, −184,90 € sortis',
    );
    expect(t('argent.positionMovements', { personality: 'pro', params })).toBe(
      'Depuis l’observation : +60,00 € encaissés, −184,90 € décaissés',
    );
    expect(t('argent.positionMovements', { personality: 'direct', params })).toBe(
      'Depuis : +60,00 € · −184,90 €',
    );
  });

  it('aucune humeur ne présente l’estimation comme un relevé bancaire', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      expect(t('argent.positionEstimateNote', { personality }).toLowerCase()).toContain('estimation');
      expect(t('today.balanceEstimatedLabel', { personality }).length).toBeGreaterThan(0);
      expect(t('argent.positionEstimatedLabel', { personality }).length).toBeGreaterThan(0);
      expect(t('today.balanceMovementsHint', { personality }).length).toBeGreaterThan(0);
    }
  });
});
