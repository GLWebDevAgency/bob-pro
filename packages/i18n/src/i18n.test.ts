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

  it("today.subtitle interpole {count} sur les 3 humeurs (variante n=0 séparée)", () => {
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
    expect(t('clients.subtitle', { personality: 'pro', params: { count: 6, total: '4 330 €' } })).toBe(
      '6 clients · 4 330 € en attente',
    );
    expect(t('clients.subtitle', { personality: 'direct', params: { count: 6, total: '4 330 €' } })).toBe(
      '6 clients · 4 330 € dus',
    );
    expect(t('clients.subtitleOne', { params: { total: '120 €' } })).toBe('1 client · 120 € en attente');
  });

  it('clients : sous-titres contextuels, empty state et erreur déclinent les 3 humeurs', () => {
    expect(t('clients.subLateDays', { params: { days: 9 } })).toBe('Paie avec 9 j de retard');
    expect(t('clients.subLateDays', { personality: 'direct', params: { days: 9 } })).toBe('Retard : 9 j');
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
    expect(t('clients.createSuccess', { params: { name: 'Mme Nguyen' } })).toBe('Mme Nguyen est dans ton carnet ✓');
    expect(t('clients.createSuccess', { personality: 'pro', params: { name: 'Mme Nguyen' } })).toBe(
      'Mme Nguyen a été ajouté à votre carnet.',
    );
    expect(t('clients.createError', { personality: 'direct' })).toBe('Création impossible. Réessaie.');
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
    expect(t('fiche.statusLate', { personality: 'direct', params: { days: 9 } })).toBe('Retard 9 j');
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
    expect(t('docs.classifiedToast', { personality: 'direct', params: { supplier: 'Cedeo' } })).toBe(
      'Cedeo → Achats.',
    );
    expect(t('docs.open')).toBe('Ouvrir');
  });

  it('sous-titres factures récentes par canal (proto : PDP / e-reporting / Chorus)', () => {
    expect(t('docs.recentSubB2b', { params: { kind: 'Acompte' } })).toBe('Acompte · B2B → PDP');
    expect(t('docs.recentSubB2c')).toBe('Particulier · B2C → e-reporting');
    expect(t('docs.recentSubB2g', { personality: 'direct' })).toBe('B2G → Chorus');
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
    expect(t('assistant.offline', { personality: 'direct' })).toBe('Serveur injoignable. Réessaie.');
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
    expect(t('agent.global.context', { personality: 'pro', params: { context: 'facture F-14' } })).toBe(
      'Contexte actif : facture F-14',
    );
    expect(t('agent.global.reviewRequired', { personality: 'direct' })).toBe('À finaliser dans l’Assistant. Rien de fait.');
    expect(t('agent.global.continueInAssistant', { personality: 'direct' })).toBe('Ouvrir l’Assistant');
    expect(t('agent.global.heardNothing', { personality: 'pro' })).toBe('Je n’ai rien entendu. Touchez le bouton pour reprendre.');
    expect(t('agent.global.dismiss', { personality: 'pro' })).toBe('Fermer la réponse de Bob');
    // Plancher vocal : les textes de relance de consentement ne contiennent AUCUN token
    // que parseVoiceConsent accepte (ni confirmation, ni annulation) — l'écho ne décide jamais.
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const retry = t('live.unclearConsent', { personality }).toLowerCase();
      expect(retry).not.toMatch(/annul|je confirme|\bd.accord\b|\boui\b|\bok\b|vas[- ]?y|j.autorise/);
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
    expect(
      t('voix.donePaidText', { params: { amount: '245,00 €', number: 'F-2026-118' } }),
    ).toBe('245,00 € encaissés. La facture F-2026-118 est émise, classée, et ta tréso est à jour.');
    expect(
      t('voix.confirmSendBody', { personality: 'pro', params: { name: 'Mme Durand', amount: '245,00 €' } }),
    ).toBe('La facture de Mme Durand (245,00 €) sera émise avec son numéro légal.');
  });

  it('micro refusé/indisponible et erreurs : voix de Bob sur les 3 humeurs', () => {
    expect(t('voix.micDenied', { personality: 'direct' })).toBe('Micro refusé. Réglages, ou écris.');
    expect(t('voix.micUnavailable').length).toBeGreaterThan(0);
    expect(t('voix.errNoLines')).toBe('Je n’ai pas entendu de prestation ni de montant — on réessaie ?');
    expect(t('voix.errNoCustomer', { personality: 'pro' })).toBe('Sélectionnez le client avant de facturer.');
  });
});

describe('i18n — C21 devis.*', () => {
  it('titres des 6 étapes de la machine + gardes à la voix de Bob (3 humeurs)', () => {
    expect(t('devis.stepClient')).toBe('Le client');
    expect(t('devis.stepVat')).toBe('TVA & mentions');
    expect(t('devis.stepInvoice', { personality: 'direct' })).toBe('Facture');
    expect(t('devis.signTitle')).toBe('Fais signer ton client ici');
    expect(t('devis.signTitle', { personality: 'pro' })).toBe('Faites signer votre client ici');
    expect(t('devis.guardClient', { personality: 'pro' })).toBe('Sélectionnez un client avant de continuer.');
    expect(t('devis.guardLines', { personality: 'direct' })).toBe('Une ligne minimum.');
    expect(t('devis.guardSignature').length).toBeGreaterThan(0);
    expect(t('devis.guardDeposit', { personality: 'direct' })).toBe('Acompte : 0 à 100 %.');
  });

  it('interpole {pct}/{amount}/{number}/{rate} (acompte, succès, toast, TVA suggérée)', () => {
    expect(t('devis.depositSummary', { params: { pct: 30, amount: '488,40 €' } })).toBe(
      'Acompte 30 % — net à encaisser 488,40 €.',
    );
    expect(
      t('devis.successBody', {
        personality: 'pro',
        params: { number: 'F-2026-118', name: 'M. Bernard', amount: '488,40 €' },
      }),
    ).toBe('La facture F-2026-118 de M. Bernard est émise — net à encaisser : 488,40 €. Suivi et relances automatiques.');
    expect(t('devis.toastDone', { params: { number: 'F-2026-118' } })).toBe('Facture F-2026-118 émise ✓');
    expect(t('devis.vatSuggested', { params: { rate: 10 } })).toBe('TVA suggérée : 10 %');
    expect(t('devis.vatHint', { personality: 'direct', params: { rate: 5.5 } })).toBe(
      'Tout à 5.5 %. Revérifié à la génération.',
    );
  });

  it('copy de flux : contexte TVA, signature, génération (3 humeurs)', () => {
    expect(t('devis.vatHousing')).toBe('Logement de plus de 2 ans — 10 %');
    expect(t('devis.vatEnergy', { personality: 'direct' })).toBe('Réno énergétique — 5,5 %');
    expect(t('devis.signClear')).toBe('Effacer');
    expect(t('devis.generateCta', { personality: 'direct' })).toBe('Facturer');
    expect(
      t('devis.confirmBody', { params: { name: 'M. Bernard', amount: '488,40 €' } }),
    ).toBe('J’envoie le devis, j’enregistre la signature de M. Bernard et j’émets la facture (488,40 €) avec son numéro légal.');
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
    expect(t('notif.subtitle', { personality: 'pro' })).toBe('L’essentiel de votre activité, au bon moment.');
    expect(t('notif.subtitle', { personality: 'direct' })).toBe('L’essentiel. Rien d’autre.');
    expect(t('notif.itemRelanceTitle', { params: { name: 'SARL Martin' } })).toBe('Relance SARL Martin');
    expect(
      t('notif.itemRelanceSub', { params: { doc: 'F-2026-088', amount: '1 240 €', days: 9 } }),
    ).toBe('F-2026-088 · 1 240 € · 9 j de retard');
    expect(
      t('notif.itemDueSub', { personality: 'direct', params: { doc: 'F-2026-104', amount: '920 €', days: 3 } }),
    ).toBe('F-2026-104 · 920 € · J-3');
    expect(t('notif.actionView')).toBe('Voir la pièce');
    expect(t('notif.actionRelance')).toBe('Relancer');
    expect(t('notif.conformiteSub')).toBe('Réception des e-factures à configurer avant le 1ᵉʳ sept. 2026.');
    expect(t('notif.empty')).toBe('Rien à signaler — tout roule.');
    expect(t('notif.empty', { personality: 'direct' })).toBe('RAS.');
    expect(t('notif.dataError', { personality: 'pro' }).length).toBeGreaterThan(0);
  });

  it('relance.* : 4 tons du proto, file interpolée {count}, garde-fou L441-10 sur les 3 humeurs', () => {
    expect(t('relance.toneCordial')).toBe('Cordial');
    expect(t('relance.toneNeutre')).toBe('Neutre');
    expect(t('relance.toneFerme')).toBe('Ferme');
    expect(t('relance.toneMed')).toBe('Mise en demeure');
    expect(t('relance.autoTitle')).toBe('Relances automatiques');
    expect(t('relance.autoSub')).toBe('Bob relance les retards tout seul, au bon moment.');
    expect(t('relance.queue', { params: { count: 2 } })).toBe('Actives · 2 clients en file');
    expect(t('relance.queueOne', { personality: 'pro' })).toBe('Actives · 1 client en file d’attente');
    expect(t('relance.medWarning')).toContain('L441-10');
    expect(t('relance.medWarning', { personality: 'pro' })).toContain('40 €');
    expect(t('relance.medWarning', { personality: 'direct' })).toContain('jamais sans ta validation');
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
    expect(t('relance.sentToast', { params: { name: 'SARL Martin' } })).toBe('Relance envoyée à SARL Martin ✓');
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
    expect(t('diag.questionTag', { personality: 'direct', params: { n: 2, total: 2 } })).toBe('Q2 / 2');
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
    expect(t('onboard.previewTitle', { personality: 'pro', params: { trade: 'électricien' } })).toBe(
      'Votre espace électricien est prêt',
    );
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
      'TVA par défaut de ton métier (Plombier)',
    );
    expect(t('reglages.soonBadge', { personality: 'pro' })).toBe('À venir');
    expect(t('reglages.mentionsEmpty', { personality: 'direct' })).toBe('Visible dès ta première facture.');
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
    expect(t('account.invoicesEmpty')).toBe(
      'Tu ne paies rien pendant l’accès anticipé — donc zéro facture. Elles s’afficheront ici le moment venu.',
    );
    expect(t('account.connToConnect')).toBe('À connecter');
    expect(t('account.serviceSoon', { personality: 'pro' })).toBe('À venir');
    expect(t('account.serviceActive')).toBe('Actif');
  });

  it('services, parrainage, équipe et erreurs à la voix de Bob', () => {
    expect(t('account.serviceOnlinePaymentSub')).toBe('Encaisse par carte — 1,2 % par encaissement');
    expect(t('account.serviceInsurance', { personality: 'direct' })).toBe('Décennale & RC Pro');
    expect(t('account.referralSoon', { personality: 'pro' })).toBe(
      'Prochainement : un mois offert pour vous deux.',
    );
    expect(t('account.teamRowSub', { personality: 'direct' })).toBe('Invitations, rôles. Bientôt.');
    expect(t('account.companyEmpty', { personality: 'pro' })).toBe(
      'Les informations de votre entreprise s’afficheront ici une fois votre société reliée à votre compte.',
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
      t('relance.penaltiesLine', { personality: 'pro', params: { daily: '0,62 €', accrued: '27,71 €' } }),
    ).toBe('+0,62 € par jour · 27,71 € courus à ce jour');
    expect(
      t('relance.penaltiesLine', { personality: 'direct', params: { daily: '0,62 €', accrued: '27,71 €' } }),
    ).toBe('+0,62 €/j · 27,71 €');
  });

  it('chrono de prescription : lointaine discrète, urgente « c’est perdu », prescrite grave ×3', () => {
    expect(t('relance.prescriptionFar', { params: { date: '12/03/2029' } })).toBe(
      'Prescription : t’as jusqu’au 12/03/2029.',
    );
    expect(t('relance.prescriptionLost', { params: { date: '15/09/2026' } })).toBe(
      'Après le 15/09/2026, c’est perdu — plus aucun recours.',
    );
    expect(t('relance.prescriptionLost', { personality: 'direct', params: { date: '15/09/2026' } })).toBe(
      'Après le 15/09/2026 : perdu.',
    );
    expect(t('relance.prescriptionDead', { personality: 'pro', params: { date: '02/01/2026' } })).toBe(
      'Créance prescrite depuis le 02/01/2026 — aucun recours judiciaire possible.',
    );
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
    expect(t('argent.urssafTitle', { personality: 'direct', params: { period: 'juillet 2026' } })).toBe(
      'URSSAF · juillet 2026',
    );
    expect(t('argent.urssafSetAside')).toBe('À mettre de côté');
    expect(t('argent.urssafSetAside', { personality: 'pro' })).toBe('Montant à provisionner');
    expect(t('argent.urssafSetAside', { personality: 'direct' })).toBe('À provisionner');
    expect(t('argent.urssafDeclareBy', { params: { date: '31 oct.' } })).toBe(
      'À déclarer au plus tard le 31 oct.',
    );
    expect(t('argent.urssafDeclareBy', { personality: 'direct', params: { date: '31 oct.' } })).toBe(
      'Déclaration : 31 oct. max.',
    );
  });
});
