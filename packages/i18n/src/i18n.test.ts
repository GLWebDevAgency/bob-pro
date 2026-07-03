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

  it('today.payoutHint interpole {amount} sur les 3 humeurs', () => {
    expect(t('today.payoutHint', { params: { amount: '2 000,00 €' } })).toBe(
      'Tu peux te verser ~2 000,00 € sans te mettre dans le rouge',
    );
    expect(t('today.payoutHint', { personality: 'pro', params: { amount: '2 000,00 €' } })).toBe(
      'Versement possible : 2 000,00 €, TVA et charges provisionnées.',
    );
    expect(t('today.payoutHint', { personality: 'direct', params: { amount: '2 000,00 €' } })).toBe(
      'Te verser : ~2 000,00 €.',
    );
  });

  it('today.footer décline les 3 humeurs (VOICE_AND_TONE § Pied de page)', () => {
    expect(t('today.footer')).toBe('C’est tout pour aujourd’hui. Va bosser 🔧');
    expect(t('today.footer', { personality: 'pro' })).toBe('Vous êtes à jour pour aujourd’hui.');
    expect(t('today.footer', { personality: 'direct' })).toBe('Fini pour aujourd’hui.');
  });

  it('argent.* : copy pote exacte du proto (C11 — « LE SOLDE MENT »)', () => {
    expect(t('argent.subtitle')).toBe('Le vrai état des comptes, sans te mentir.');
    expect(t('argent.heroLabel')).toBe('Ce mois-ci, tu peux te verser');
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

  it('sous-titres factures récentes par canal (proto : PDP / e-reporting / Chorus)', () => {
    expect(t('docs.recentSubB2b', { params: { kind: 'Acompte' } })).toBe('Acompte · B2B → PDP');
    expect(t('docs.recentSubB2c')).toBe('Particulier · B2C → e-reporting');
    expect(t('docs.recentSubB2g', { personality: 'direct' })).toBe('B2G → Chorus');
  });
});
