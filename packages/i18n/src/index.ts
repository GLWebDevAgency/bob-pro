/**
 * @bob/i18n — la copy de Bob, indexée par personnalité (VOICE_AND_TONE.md).
 * Toute chaîne visible dans l'app vient d'ici : une clé = une entrée par humeur
 * (Pote par défaut, Pro, Direct). Les claims d'écran ajoutent leurs clés (C10+).
 */

export type Personality = 'pote' | 'pro' | 'direct';

export const DEFAULT_PERSONALITY: Personality = 'pote';

const PERSONALITIES: readonly Personality[] = ['pote', 'pro', 'direct'];

/** Libellés d'affichage (réglages, proto, @bob/core.buildRelance) — les ids runtime restent minuscules. */
export const PERSONALITY_LABELS: Readonly<Record<Personality, 'Pote' | 'Pro' | 'Direct'>> = {
  pote: 'Pote',
  pro: 'Pro',
  direct: 'Direct',
};

/** Normalise une valeur persistée ou legacy ('Pote'/'Pro'/'Direct') vers l'id canonique. */
export function normalizePersonality(value: unknown): Personality {
  if (typeof value !== 'string') return DEFAULT_PERSONALITY;
  const lower = value.toLowerCase();
  return (PERSONALITIES as readonly string[]).includes(lower)
    ? (lower as Personality)
    : DEFAULT_PERSONALITY;
}

type Copy = Readonly<Record<Personality, string>>;

const fr = {
  'bob.greeting': {
    pote: 'Salut {name} 👋',
    pro: 'Bonjour {name}',
    direct: '{name} —',
  },
  'bob.tagline': {
    pote: 'Ton bureau pro dans la poche.',
    pro: 'Votre bureau pro dans la poche.',
    direct: 'Ton bureau pro dans la poche.',
  },

  // ── C10 — écran « Aujourd'hui » ────────────────────────────────────────────
  'today.subtitle': {
    pote: '{count} trucs à régler, et après tu factures tranquille.',
    pro: 'Vous avez {count} priorités à traiter aujourd’hui.',
    direct: '{count} priorités. Go.',
  },
  'today.subtitleOne': {
    pote: 'Un truc à régler, et après tu factures tranquille.',
    pro: 'Vous avez une priorité à traiter aujourd’hui.',
    direct: '1 priorité. Go.',
  },
  'today.subtitleNone': {
    pote: 'Rien d’urgent. Profites-en.',
    pro: 'Aucune priorité aujourd’hui.',
    direct: 'RAS.',
  },
  'today.footer': {
    pote: 'C’est tout pour aujourd’hui. Va bosser 🔧',
    pro: 'Vous êtes à jour pour aujourd’hui.',
    direct: 'Fini pour aujourd’hui.',
  },
  'today.payoutHint': {
    pote: 'Tu peux te verser ~{amount} sans te mettre dans le rouge',
    pro: 'Versement possible : {amount}, TVA et charges provisionnées.',
    direct: 'Te verser : ~{amount}.',
  },
  'today.balanceLabel': {
    pote: 'Dispo réel aujourd’hui',
    pro: 'Disponible réel aujourd’hui',
    direct: 'Dispo réel',
  },
  'today.sectionToday': {
    pote: 'À régler aujourd’hui',
    pro: 'À traiter aujourd’hui',
    direct: 'À régler',
  },
  'today.remaining': {
    pote: '{count} restants',
    pro: '{count} restantes',
    direct: 'reste {count}',
  },
  'today.remainingOne': {
    pote: '1 restant',
    pro: '1 restante',
    direct: 'reste 1',
  },
  'today.sectionGlance': {
    pote: 'En un coup d’œil',
    pro: 'Vue d’ensemble',
    direct: 'Les chiffres',
  },
  'today.sectionQuick': {
    pote: 'Vite fait',
    pro: 'Actions rapides',
    direct: 'Raccourcis',
  },
  'today.kpiOwed': {
    pote: 'On te doit',
    pro: 'On vous doit',
    direct: 'Dû',
  },
  'today.kpiLate': {
    pote: 'En retard',
    pro: 'En retard',
    direct: 'Retard',
  },
  'today.kpiVat': {
    pote: 'TVA à garder',
    pro: 'TVA à provisionner',
    direct: 'TVA',
  },
  'today.kpiEom': {
    pote: 'Fin de mois',
    pro: 'Solde fin de mois',
    direct: 'Fin de mois',
  },
  'today.quickVoice': {
    pote: 'À la voix',
    pro: 'À la voix',
    direct: 'Voix',
  },
  'today.quickQuote': {
    pote: 'Devis',
    pro: 'Devis',
    direct: 'Devis',
  },
  'today.quickScan': {
    pote: 'Scanner',
    pro: 'Scanner',
    direct: 'Scan',
  },
  'today.quickCollect': {
    pote: 'Encaisser',
    pro: 'Encaisser',
    direct: 'Encaisser',
  },
  // Voix des priorités du briefing (titres + badges + sous-titres + CTA — VOICE_AND_TONE § Retard).
  // Les priorités sont DÉRIVÉES des données réelles (@bob/core deriveTodayPriorities, A1-C10).
  'today.prioRelanceTitle': {
    pote: 'Relancer {name}',
    pro: 'Relancer {name}',
    direct: 'Relance {name}',
  },
  'today.prioLateBadge': {
    pote: 'En retard {days} j',
    pro: 'En retard {days} jours',
    direct: 'Retard {days} j',
  },
  'today.prioLateHint': {
    pote: 'Toujours pas payé. On le relance gentiment ?',
    pro: 'Facture échue. Souhaitez-vous envoyer une relance ?',
    direct: '{days} j de retard. On relance ?',
  },
  'today.ctaRelance': {
    pote: 'Relancer',
    pro: 'Envoyer une relance',
    direct: 'Relancer',
  },
  'today.prioAcceptedBadge': {
    pote: 'Devis accepté',
    pro: 'Devis accepté',
    direct: 'Accepté',
  },
  'today.prioFinalTitle': {
    pote: 'Créer la facture finale — {name}',
    pro: 'Créer la facture finale — {name}',
    direct: 'Facture finale — {name}',
  },
  'today.prioFinalHint': {
    pote: 'Acompte déjà encaissé. Reste {amount}. Y’a plus qu’à.',
    pro: 'Acompte encaissé. Il reste {amount} à facturer.',
    direct: 'Reste {amount}. On facture ?',
  },
  'today.ctaFinalInvoice': {
    pote: 'Créer la facture',
    pro: 'Créer la facture',
    direct: 'Facturer',
  },
  'today.prioConformiteTitle': {
    pote: 'Ta réception de factures n’est pas prête',
    pro: 'Votre réception de factures n’est pas prête',
    direct: 'Réception de factures : pas prête',
  },
  'today.prioConformiteBadge': {
    pote: 'Facturation élec. 2026',
    pro: 'Facturation électronique 2026',
    direct: 'Fact. élec. 2026',
  },
  'today.prioConformiteHint': {
    pote: 'À configurer avant le 1er sept. 2026. Je t’explique en 2 min.',
    pro: 'À configurer avant le 1er septembre 2026. Nous vous guidons en 2 minutes.',
    direct: 'À faire avant sept. 2026. 2 min.',
  },
  'today.ctaDiagnostic': {
    pote: 'Faire le diagnostic',
    pro: 'Lancer le diagnostic',
    direct: 'Diagnostic',
  },
  // Erreur de chargement — la voix de Bob, jamais un code d'erreur ni un chiffre inventé (A1-C10).
  'today.dataError': {
    pote: 'Je n’arrive pas à joindre le serveur. On réessaie dans un instant ?',
    pro: 'Connexion impossible pour le moment. Veuillez réessayer dans un instant.',
    direct: 'Hors ligne. Réessaie.',
  },

  // ── C11 — écran « Argent » (copy pote = exacte du proto) ─────────────────────
  'argent.eyebrow': {
    pote: 'Ta tréso',
    pro: 'Votre trésorerie',
    direct: 'Tréso',
  },
  'argent.title': {
    pote: 'Argent',
    pro: 'Argent',
    direct: 'Argent',
  },
  'argent.subtitle': {
    pote: 'Le vrai état des comptes, sans te mentir.',
    pro: 'L’état réel de vos comptes, en toute transparence.',
    direct: 'Les comptes, sans mentir.',
  },
  'argent.heroLabel': {
    pote: 'Ce mois-ci, tu peux te verser',
    pro: 'Ce mois-ci, vous pouvez vous verser',
    direct: 'À te verser ce mois-ci',
  },
  'argent.heroPill': {
    pote: 'sans risque',
    pro: 'sans risque',
    direct: 'sans risque',
  },
  // Phrase conditionnelle du héros : le « monter à » vient du scénario optimiste réel.
  'argent.heroUpside': {
    pote: 'Tu peux monter à {upTo} si {name} règle ses {amount}. Je te préviens dès qu’il paie.',
    pro: 'Vous pouvez atteindre {upTo} si {name} règle ses {amount}. Nous vous préviendrons dès réception.',
    direct: 'Jusqu’à {upTo} si {name} paie ses {amount}.',
  },
  'argent.heroCaption': {
    pote: 'TVA et charges déjà mises de côté. Le reste est à toi.',
    pro: 'TVA et charges provisionnées. Le solde est disponible.',
    direct: 'TVA et charges déjà de côté.',
  },
  // Grand-livre « Argent disponible réel » — badge + labels des rangées.
  'argent.ledgerTitle': {
    pote: 'Argent disponible réel',
    pro: 'Argent disponible réel',
    direct: 'Dispo réel',
  },
  'argent.soldeMent': {
    pote: 'Le solde ment',
    pro: 'Solde incomplet',
    direct: 'Le solde ment',
  },
  'argent.rowBank': {
    pote: 'Solde bancaire',
    pro: 'Solde bancaire',
    direct: 'Solde bancaire',
  },
  'argent.rowReceivables': {
    pote: 'Factures clients attendues',
    pro: 'Factures clients attendues',
    direct: 'Factures attendues',
  },
  'argent.rowCharges': {
    pote: 'Charges & achats prévus',
    pro: 'Charges et achats prévus',
    direct: 'Charges prévues',
  },
  'argent.rowVat': {
    pote: 'TVA à reverser',
    pro: 'TVA à reverser',
    direct: 'TVA à reverser',
  },
  'argent.rowCotisations': {
    pote: 'Cotisations & abonnements',
    pro: 'Cotisations et abonnements',
    direct: 'Cotisations & abos',
  },
  'argent.rowTotal': {
    pote: 'Disponible prudent',
    pro: 'Disponible prudent',
    direct: 'Disponible prudent',
  },
  // Prévision de tréso — titre, segments et notes de tranche (dérivées de cashflowBand).
  'argent.forecastTitle': {
    pote: 'Prévision de tréso',
    pro: 'Prévision de trésorerie',
    direct: 'Prévision',
  },
  'argent.horizonLabel': {
    pote: '{days} j',
    pro: '{days} j',
    direct: '{days} j',
  },
  'argent.scenarioOptimiste': {
    pote: 'Optimiste',
    pro: 'Optimiste',
    direct: 'Optimiste',
  },
  'argent.scenarioRealiste': {
    pote: 'Réaliste',
    pro: 'Réaliste',
    direct: 'Réaliste',
  },
  'argent.scenarioPrudent': {
    pote: 'Prudent',
    pro: 'Prudent',
    direct: 'Prudent',
  },
  'argent.bandTranquille': {
    pote: 'Tranquille',
    pro: 'Confortable',
    direct: 'Large',
  },
  'argent.bandPasse': {
    pote: 'Ça passe',
    pro: 'Correct',
    direct: 'Ça passe',
  },
  'argent.bandCreux': {
    pote: 'Creux, surveille',
    pro: 'Creux à surveiller',
    direct: 'Creux',
  },
  'argent.bandRepart': {
    pote: 'Ça repart',
    pro: 'En reprise',
    direct: 'Ça repart',
  },
  // « À surveiller » — mauvais payeurs réels (scoring @bob/core) + relais assistant.
  'argent.watchTitle': {
    pote: 'À surveiller',
    pro: 'À surveiller',
    direct: 'À surveiller',
  },
  'argent.watchLateBadge': {
    pote: 'Paie en retard',
    pro: 'Paie en retard',
    direct: 'Retard',
  },
  'argent.watchOutstanding': {
    pote: '{amount} en cours',
    pro: '{amount} en cours',
    direct: '{amount} en cours',
  },
  'argent.ctaRelanceOne': {
    pote: 'Laisse l’assistant relancer ce client',
    pro: 'Confier la relance à l’assistant',
    direct: 'Relancer ce client',
  },
  'argent.ctaRelanceMany': {
    pote: 'Laisse l’assistant relancer {count} clients',
    pro: 'Confier {count} relances à l’assistant',
    direct: 'Relancer {count} clients',
  },
  // « À mettre de côté » — réserve TVA + charges dérivée (buildLedgerView.reserve).
  'argent.reserveTitle': {
    pote: 'Mise de côté auto',
    pro: 'Mise de côté automatique',
    direct: 'Mise de côté',
  },
  'argent.reserveBody': {
    pote: 'Je réserve la TVA et les charges à chaque encaissement. Tu ne touches qu’à ton vrai dispo.',
    pro: 'La TVA et les charges sont réservées à chaque encaissement. Vous ne touchez qu’au disponible réel.',
    direct: 'TVA et charges réservées à chaque encaissement.',
  },
  'argent.reserveVat': {
    pote: 'TVA réservée',
    pro: 'TVA réservée',
    direct: 'TVA réservée',
  },
  'argent.reserveCharges': {
    pote: 'Charges',
    pro: 'Charges',
    direct: 'Charges',
  },
  // Astuce « première fois » (coach-mark, dismiss persisté).
  'argent.tipEyebrow': {
    pote: 'Astuce · première fois',
    pro: 'Astuce · première fois',
    direct: 'Astuce',
  },
  'argent.tipAuthor': {
    pote: 'Bob',
    pro: 'Bob',
    direct: 'Bob',
  },
  'argent.tipTitle': {
    pote: 'Ton vrai dispo, pas le solde',
    pro: 'Votre vrai disponible, pas le solde',
    direct: 'Le vrai dispo, pas le solde',
  },
  'argent.tipBody': {
    pote: 'Le solde bancaire, lui, il ment. Ici tu vois ce qu’il te reste vraiment une fois les charges et la TVA mises de côté — glisse les scénarios et l’horizon 7 → 90 j.',
    pro: 'Le solde bancaire est trompeur. Ici, vous voyez ce qu’il vous reste réellement une fois les charges et la TVA provisionnées — parcourez les scénarios et l’horizon 7 → 90 j.',
    direct: 'Le solde ment. Ici : le vrai reste après charges et TVA. Scénarios + horizon 7 → 90 j.',
  },
  'argent.tipCta': {
    pote: 'Compris, c’est parti',
    pro: 'Compris',
    direct: 'Compris',
  },
  'argent.tipSkip': {
    pote: 'Tout passer',
    pro: 'Tout passer',
    direct: 'Passer',
  },
  // Erreur de chargement — la voix de Bob, jamais un chiffre inventé (A1-C10).
  'argent.dataError': {
    pote: 'Je n’arrive pas à lire tes comptes, là. On réessaie dans un instant ?',
    pro: 'Impossible de consulter vos comptes pour le moment. Veuillez réessayer dans un instant.',
    direct: 'Comptes injoignables. Réessaie.',
  },

  // ── C12 — écran « Clients » (copy pote = exacte du proto) ────────────────────
  'clients.eyebrow': {
    pote: 'Ton carnet',
    pro: 'Votre carnet',
    direct: 'Carnet',
  },
  'clients.title': {
    pote: 'Clients',
    pro: 'Clients',
    direct: 'Clients',
  },
  // {total} = montant déjà formaté (formatEUR) — l'écran teinte le montant en danger.
  'clients.subtitle': {
    pote: '{count} clients · {total} en attente',
    pro: '{count} clients · {total} en attente',
    direct: '{count} clients · {total} dus',
  },
  'clients.subtitleOne': {
    pote: '1 client · {total} en attente',
    pro: '1 client · {total} en attente',
    direct: '1 client · {total} dus',
  },
  'clients.searchPlaceholder': {
    pote: 'Rechercher un client…',
    pro: 'Rechercher un client…',
    direct: 'Chercher un client…',
  },
  // Chips filtres par type (Tous / Particuliers / Entreprises / Public).
  'clients.filterAll': {
    pote: 'Tous',
    pro: 'Tous',
    direct: 'Tous',
  },
  'clients.filterB2c': {
    pote: 'Particuliers',
    pro: 'Particuliers',
    direct: 'Particuliers',
  },
  'clients.filterB2b': {
    pote: 'Entreprises',
    pro: 'Entreprises',
    direct: 'Entreprises',
  },
  'clients.filterB2g': {
    pote: 'Public',
    pro: 'Public',
    direct: 'Public',
  },
  // Badges type sur la rangée (le badge uppercase la valeur : « PART. », « B2B », « B2G »).
  'clients.badgeB2c': {
    pote: 'Part.',
    pro: 'Part.',
    direct: 'Part.',
  },
  'clients.badgeB2b': {
    pote: 'B2B',
    pro: 'B2B',
    direct: 'B2B',
  },
  'clients.badgeB2g': {
    pote: 'B2G',
    pro: 'B2G',
    direct: 'B2G',
  },
  // Montant + mot de statut à droite de la rangée (statuts dérivés — deriveCustomerStandings).
  'clients.upToDate': {
    pote: 'À jour',
    pro: 'À jour',
    direct: 'À jour',
  },
  'clients.statusPaid': {
    pote: 'payé',
    pro: 'payé',
    direct: 'payé',
  },
  'clients.statusLate': {
    pote: 'en retard',
    pro: 'en retard',
    direct: 'retard',
  },
  'clients.statusPending': {
    pote: 'en attente',
    pro: 'en attente',
    direct: 'attente',
  },
  'clients.statusQuote': {
    pote: 'devis',
    pro: 'devis',
    direct: 'devis',
  },
  'clients.statusNew': {
    pote: 'nouveau',
    pro: 'nouveau',
    direct: 'nouveau',
  },
  // Sous-titres contextuels par statut (dérivés des pièces réelles — jamais du remplissage).
  'clients.subUpToDate': {
    pote: 'Rien en attente — nickel',
    pro: 'Aucun règlement en attente',
    direct: 'Rien en attente',
  },
  'clients.subLateDays': {
    pote: 'Paie avec {days} j de retard',
    pro: 'Règlement en retard de {days} jours',
    direct: 'Retard : {days} j',
  },
  'clients.subLate': {
    pote: 'Un règlement traîne — on relance ?',
    pro: 'Un règlement est en retard',
    direct: 'Règlement en retard',
  },
  'clients.subPending': {
    pote: 'Facture envoyée, en attente de règlement',
    pro: 'Facture émise, règlement attendu',
    direct: 'Facture en attente',
  },
  'clients.subPendingB2g': {
    pote: 'Suivi via Chorus Pro',
    pro: 'Transmission et suivi via Chorus Pro',
    direct: 'Chorus Pro',
  },
  'clients.subQuote': {
    pote: 'Devis envoyé, en attente de réponse',
    pro: 'Devis transmis, en attente de réponse',
    direct: 'Devis en attente',
  },
  'clients.subNew': {
    pote: 'Tout nouveau — rien de facturé',
    pro: 'Nouveau client — aucune facturation',
    direct: 'Nouveau. Rien facturé.',
  },
  // Création client (bouton + du header et FAB) — même point d'entrée humain ↔ Bob.
  'clients.addClient': {
    pote: 'Nouveau client',
    pro: 'Nouveau client',
    direct: 'Nouveau client',
  },
  // 0 client — invitation à créer (l'état vide est un état de premier rang, A1-C10).
  'clients.emptyTitle': {
    pote: 'Ton carnet est vide',
    pro: 'Votre carnet est vide',
    direct: 'Carnet vide',
  },
  'clients.emptyBody': {
    pote: 'Ajoute ton premier client et je m’occupe du reste : devis, factures, relances.',
    pro: 'Ajoutez votre premier client : devis, factures et relances suivront.',
    direct: 'Ajoute un client. Le reste suit.',
  },
  'clients.emptyCta': {
    pote: 'Ajouter mon premier client',
    pro: 'Ajouter un client',
    direct: 'Ajouter un client',
  },
  // 0 résultat de recherche/filtre — on n'affiche jamais une liste inventée.
  'clients.noResults': {
    pote: 'Personne ne correspond. Essaie un autre nom ou un autre filtre.',
    pro: 'Aucun client ne correspond à votre recherche.',
    direct: 'Aucun résultat.',
  },
  // Erreur de chargement — la voix de Bob, jamais un chiffre inventé (A1-C10).
  'clients.dataError': {
    pote: 'Je n’arrive pas à ouvrir ton carnet, là. On réessaie dans un instant ?',
    pro: 'Impossible de charger vos clients pour le moment. Veuillez réessayer dans un instant.',
    direct: 'Carnet injoignable. Réessaie.',
  },

  // ── C13 — écran « Fiche client » ─────────────────────────────────────────────
  // Barre retour + menu « … » (no-op accessible, menu TODO).
  'fiche.back': {
    pote: 'Clients',
    pro: 'Clients',
    direct: 'Clients',
  },
  'fiche.more': {
    pote: 'Options',
    pro: 'Options',
    direct: 'Options',
  },
  // partyLine adaptatif : badge type + SIREN seulement b2b/b2g (RIEN pour un particulier).
  'fiche.badgeB2b': {
    pote: 'Entreprise',
    pro: 'Entreprise',
    direct: 'Entreprise',
  },
  'fiche.badgeB2g': {
    pote: 'Public',
    pro: 'Secteur public',
    direct: 'Public',
  },
  'fiche.sirenLabel': {
    pote: 'SIREN {siren}',
    pro: 'SIREN {siren}',
    direct: 'SIREN {siren}',
  },
  // 4 actions rapides (tuiles blanches icône+label) — parité d'actions humain ↔ Bob.
  'fiche.actionQuote': {
    pote: 'Devis',
    pro: 'Devis',
    direct: 'Devis',
  },
  'fiche.actionRelance': {
    pote: 'Relancer',
    pro: 'Relancer',
    direct: 'Relancer',
  },
  'fiche.actionCall': {
    pote: 'Appeler',
    pro: 'Appeler',
    direct: 'Appeler',
  },
  'fiche.actionEmail': {
    pote: 'Email',
    pro: 'Email',
    direct: 'Email',
  },
  // 3 KPI (Encours teinté par statut · Délai moyen · CA 12 mois).
  'fiche.kpiOutstanding': {
    pote: 'Encours',
    pro: 'Encours',
    direct: 'Encours',
  },
  'fiche.kpiAvgDelay': {
    pote: 'Délai moyen',
    pro: 'Délai moyen',
    direct: 'Délai moyen',
  },
  'fiche.kpiRevenue12m': {
    pote: 'CA 12 mois',
    pro: 'CA 12 mois',
    direct: 'CA 12 mois',
  },
  'fiche.kpiDays': {
    pote: '{days} j',
    pro: '{days} j',
    direct: '{days} j',
  },
  // Score de paiement (ScoreBar §13) + légende par tranche (<50 · 50–75 · >75).
  'fiche.scoreTitle': {
    pote: 'Score de paiement',
    pro: 'Score de paiement',
    direct: 'Score de paiement',
  },
  'fiche.scoreBad': {
    pote: 'Paiements difficiles — reste vigilant',
    pro: 'Paiements difficiles — vigilance recommandée',
    direct: 'Mauvais payeur. Vigilance.',
  },
  'fiche.scoreMid': {
    pote: 'À surveiller · délai moyen {days} j',
    pro: 'À surveiller · délai moyen de {days} jours',
    direct: 'À surveiller · {days} j de délai',
  },
  'fiche.scoreMidBare': {
    pote: 'À surveiller',
    pro: 'À surveiller',
    direct: 'À surveiller',
  },
  'fiche.scoreGood': {
    pote: 'Bon payeur — nickel',
    pro: 'Bon payeur — aucun souci constaté',
    direct: 'Bon payeur.',
  },
  // Conformité e-invoicing par canal (einvoiceChannelFor @bob/core) : PA b2b · e-reporting b2c · Chorus Pro b2g.
  'fiche.compliTitlePa': {
    pote: 'Facturation électronique requise',
    pro: 'Facturation électronique requise',
    direct: 'Facturation électronique requise',
  },
  'fiche.compliBodyPa': {
    pote: 'Plateforme détectée · SIREN vérifié ✓ Tout est prêt.',
    pro: 'Plateforme agréée détectée · SIREN vérifié ✓ Dossier prêt.',
    direct: 'Plateforme détectée · SIREN vérifié ✓ Prêt.',
  },
  'fiche.compliTitleB2c': {
    pote: 'Vente aux particuliers',
    pro: 'Vente aux particuliers',
    direct: 'Vente aux particuliers',
  },
  'fiche.compliBodyB2c': {
    pote: 'Pas de plateforme pour un particulier : je déclare la vente en e-reporting. Rien à faire de ton côté.',
    pro: 'Aucune plateforme requise pour un particulier : la vente est déclarée en e-reporting automatiquement.',
    direct: 'Particulier : e-reporting auto. Rien à faire.',
  },
  'fiche.compliTitleB2g': {
    pote: 'Client public · Chorus Pro',
    pro: 'Client public · Chorus Pro',
    direct: 'Client public · Chorus Pro',
  },
  'fiche.compliBodyB2g': {
    pote: 'Les factures partent sur Chorus Pro · je suis le mandat administratif pour toi.',
    pro: 'Les factures sont déposées sur Chorus Pro · le mandat administratif est suivi automatiquement.',
    direct: 'Dépôt Chorus Pro · mandat suivi.',
  },
  'fiche.compliSirenMissing': {
    pote: 'SIREN manquant — complète la fiche et tout est prêt.',
    pro: 'SIREN manquant — complétez la fiche pour finaliser la préparation.',
    direct: 'SIREN manquant. Complète la fiche.',
  },
  // Onglets (SegmentedControl) — Activité fonctionnelle, le reste en état vide propre (claims à venir).
  'fiche.tabActivity': {
    pote: 'Activité',
    pro: 'Activité',
    direct: 'Activité',
  },
  'fiche.tabChantiers': {
    pote: 'Chantiers',
    pro: 'Chantiers',
    direct: 'Chantiers',
  },
  'fiche.tabDocs': {
    pote: 'Docs',
    pro: 'Docs',
    direct: 'Docs',
  },
  'fiche.tabInfos': {
    pote: 'Infos',
    pro: 'Infos',
    direct: 'Infos',
  },
  // Types de pièces (BillingDoc réels) — titre de rangée d'activité.
  'fiche.docInvoice': {
    pote: 'Facture',
    pro: 'Facture',
    direct: 'Facture',
  },
  'fiche.docDeposit': {
    pote: 'Acompte',
    pro: 'Facture d’acompte',
    direct: 'Acompte',
  },
  'fiche.docSituation': {
    pote: 'Situation',
    pro: 'Facture de situation',
    direct: 'Situation',
  },
  'fiche.docCreditNote': {
    pote: 'Avoir',
    pro: 'Avoir',
    direct: 'Avoir',
  },
  'fiche.docQuote': {
    pote: 'Devis',
    pro: 'Devis',
    direct: 'Devis',
  },
  // Notes de statut des pièces (dérivées des statuts réels — jamais du remplissage).
  'fiche.statusLate': {
    pote: 'En retard {days} j',
    pro: 'En retard de {days} jours',
    direct: 'Retard {days} j',
  },
  'fiche.statusLateBare': {
    pote: 'En retard',
    pro: 'En retard',
    direct: 'Retard',
  },
  'fiche.statusPaid': {
    pote: 'Réglée',
    pro: 'Réglée',
    direct: 'Réglée',
  },
  'fiche.statusPartial': {
    pote: 'Réglée en partie',
    pro: 'Partiellement réglée',
    direct: 'Partiel',
  },
  'fiche.statusIssued': {
    pote: 'En attente',
    pro: 'En attente de règlement',
    direct: 'En attente',
  },
  'fiche.statusQuotePending': {
    pote: 'En attente de réponse',
    pro: 'En attente de réponse',
    direct: 'Attente réponse',
  },
  'fiche.statusQuoteSigned': {
    pote: 'Signé',
    pro: 'Signé',
    direct: 'Signé',
  },
  'fiche.statusQuoteRefused': {
    pote: 'Refusé',
    pro: 'Refusé',
    direct: 'Refusé',
  },
  'fiche.statusQuoteExpired': {
    pote: 'Expiré',
    pro: 'Expiré',
    direct: 'Expiré',
  },
  // États vides (états de premier rang, A1-C10) — la voix de Bob, jamais une liste inventée.
  'fiche.activityEmpty': {
    pote: 'Aucune pièce pour l’instant — le premier devis lancera l’historique.',
    pro: 'Aucune pièce pour le moment. Le premier devis initiera l’historique.',
    direct: 'Aucune pièce. Fais un devis.',
  },
  'fiche.chantiersEmpty': {
    pote: 'Aucun chantier relié pour l’instant — j’y rangerai tes interventions.',
    pro: 'Aucun chantier associé pour le moment.',
    direct: 'Aucun chantier.',
  },
  'fiche.docsEmpty': {
    pote: 'Aucun document classé ici pour l’instant.',
    pro: 'Aucun document classé pour le moment.',
    direct: 'Aucun document.',
  },
  'fiche.infosEmpty': {
    pote: 'Les infos détaillées arrivent bientôt — adresse, contacts, conditions.',
    pro: 'Les informations détaillées arrivent prochainement — adresse, contacts, conditions.',
    direct: 'Infos détaillées : bientôt.',
  },
  // CTA sticky contextuelle par standing (deriveCustomerStandings + moteur relance C10).
  'fiche.ctaRelanceDoc': {
    pote: 'Relancer {doc} · {amount}',
    pro: 'Relancer {doc} · {amount}',
    direct: 'Relancer {doc} · {amount}',
  },
  'fiche.ctaRelanceAmount': {
    pote: 'Relancer · {amount}',
    pro: 'Relancer · {amount}',
    direct: 'Relancer · {amount}',
  },
  'fiche.ctaRelanceQuote': {
    pote: 'Relancer le devis',
    pro: 'Relancer le devis',
    direct: 'Relancer le devis',
  },
  'fiche.ctaNewQuote': {
    pote: 'Nouveau devis',
    pro: 'Nouveau devis',
    direct: 'Nouveau devis',
  },
  // Client introuvable (id inconnu / supprimé) — message + retour.
  'fiche.notFound': {
    pote: 'Je ne trouve pas ce client — il a peut-être été supprimé.',
    pro: 'Client introuvable — il a peut-être été supprimé.',
    direct: 'Client introuvable.',
  },
  'fiche.backToClients': {
    pote: 'Retour aux clients',
    pro: 'Retour aux clients',
    direct: 'Retour aux clients',
  },
  // Lien device (tel:/mailto:) impossible à ouvrir.
  'fiche.linkError': {
    pote: 'Impossible d’ouvrir l’app sur ton téléphone. Réessaie ?',
    pro: 'Impossible d’ouvrir l’application associée.',
    direct: 'Ouverture impossible.',
  },
  // Erreur de chargement — la voix de Bob, jamais un chiffre inventé (A1-C10).
  'fiche.dataError': {
    pote: 'Je n’arrive pas à ouvrir cette fiche, là. On réessaie dans un instant ?',
    pro: 'Impossible de charger cette fiche pour le moment. Veuillez réessayer dans un instant.',
    direct: 'Fiche injoignable. Réessaie.',
  },

  // ── C14 — écran « Documents » (coffre-fort) ─────────────────────────────────
  'docs.eyebrow': {
    pote: 'Ton coffre-fort',
    pro: 'Votre coffre-fort',
    direct: 'Coffre-fort',
  },
  'docs.title': {
    pote: 'Documents',
    pro: 'Documents',
    direct: 'Documents',
  },
  'docs.subtitle': {
    pote: 'Je classe, tu retrouves. Même 3 ans après.',
    pro: 'Classement automatique, retrouvable des années après.',
    direct: 'Je classe. Tu retrouves.',
  },
  'docs.searchPlaceholder': {
    pote: '« la facture du radiateur de mars »',
    pro: 'Rechercher un document…',
    direct: 'Chercher…',
  },
  'docs.scanTitle': {
    pote: 'Scanner un document',
    pro: 'Scanner un document',
    direct: 'Scanner',
  },
  'docs.scanSub': {
    pote: 'Je lis, j’extrais la TVA, je classe.',
    pro: 'Lecture, extraction de TVA et classement automatiques.',
    direct: 'Je lis, j’extrais, je classe.',
  },
  'docs.sectionToValidate': {
    pote: 'À valider',
    pro: 'À valider',
    direct: 'À valider',
  },
  'docs.badgeSupplierInvoice': {
    pote: 'Facture fournisseur',
    pro: 'Facture fournisseur',
    direct: 'Fournisseur',
  },
  'docs.agoMinutes': {
    pote: 'il y a {n} min',
    pro: 'il y a {n} min',
    direct: '{n} min',
  },
  'docs.agoHours': {
    pote: 'il y a {n} h',
    pro: 'il y a {n} h',
    direct: '{n} h',
  },
  'docs.metricAmount': {
    pote: 'Montant ',
    pro: 'Montant ',
    direct: 'Montant ',
  },
  'docs.metricVat': {
    pote: 'TVA récup. ',
    pro: 'TVA récupérable ',
    direct: 'TVA ',
  },
  'docs.metricDate': {
    pote: 'Date ',
    pro: 'Date ',
    direct: 'Date ',
  },
  // Rapprochement réel (deriveVaultView.matchedExpense) — jamais une invention.
  'docs.aiGuessExpense': {
    pote: 'Je pense : dépense {supplier}',
    pro: 'Rapprochement probable : dépense {supplier}',
    direct: 'Sûrement : {supplier}',
  },
  'docs.classify': {
    pote: 'Classer là',
    pro: 'Classer',
    direct: 'Classer',
  },
  'docs.open': {
    pote: 'Ouvrir',
    pro: 'Ouvrir',
    direct: 'Ouvrir',
  },
  'docs.classifiedToast': {
    pote: '{supplier} classé · Achats ✓',
    pro: 'Document classé : {supplier} → Achats.',
    direct: '{supplier} → Achats.',
  },
  'docs.classifyError': {
    pote: 'Le classement a raté, là. On réessaie ?',
    pro: 'Le classement a échoué. Veuillez réessayer.',
    direct: 'Classement raté. Réessaie.',
  },
  'docs.otherFolder': {
    pote: 'Autre dossier',
    pro: 'Autre dossier',
    direct: 'Autre',
  },
  'docs.sectionFolders': {
    pote: 'Tes dossiers',
    pro: 'Vos dossiers',
    direct: 'Dossiers',
  },
  'docs.folderChantiers': {
    pote: 'Chantiers',
    pro: 'Chantiers',
    direct: 'Chantiers',
  },
  'docs.folderAchats': {
    pote: 'Achats',
    pro: 'Achats',
    direct: 'Achats',
  },
  'docs.folderAssurances': {
    pote: 'Assurances',
    pro: 'Assurances',
    direct: 'Assurances',
  },
  'docs.folderFiscal': {
    pote: 'Fiscal & social',
    pro: 'Fiscal & social',
    direct: 'Fiscal & social',
  },
  'docs.folderBanque': {
    pote: 'Banque',
    pro: 'Banque',
    direct: 'Banque',
  },
  'docs.folderComptable': {
    pote: 'Comptable',
    pro: 'Comptable',
    direct: 'Comptable',
  },
  'docs.folderCount': {
    pote: '{count} documents',
    pro: '{count} documents',
    direct: '{count} docs',
  },
  'docs.folderCountOne': {
    pote: '1 document',
    pro: '1 document',
    direct: '1 doc',
  },
  'docs.folderCountNone': {
    pote: 'Vide',
    pro: 'Aucun document',
    direct: '0',
  },
  'docs.sectionCompta': {
    pote: 'Compta & conformité',
    pro: 'Comptabilité & conformité',
    direct: 'Compta',
  },
  'docs.monthReadyTitle': {
    pote: '{month} est prêt pour le comptable',
    pro: '{month} est prêt pour votre comptable',
    direct: '{month} : prêt comptable',
  },
  'docs.monthSales': {
    pote: '{count} ventes',
    pro: '{count} ventes',
    direct: '{count} ventes',
  },
  'docs.monthSalesOne': {
    pote: '1 vente',
    pro: '1 vente',
    direct: '1 vente',
  },
  'docs.monthPurchases': {
    pote: '{count} achats',
    pro: '{count} achats',
    direct: '{count} achats',
  },
  'docs.monthPurchasesOne': {
    pote: '1 achat',
    pro: '1 achat',
    direct: '1 achat',
  },
  'docs.monthVat': {
    pote: 'TVA récup. {amount}',
    pro: 'TVA récupérable {amount}',
    direct: 'TVA {amount}',
  },
  'docs.monthMissing': {
    pote: '{count} justificatifs manquants',
    pro: '{count} justificatifs manquants',
    direct: '{count} justifs manquants',
  },
  'docs.monthMissingOne': {
    pote: '1 justificatif manquant',
    pro: '1 justificatif manquant',
    direct: '1 justif manquant',
  },
  'docs.exportCta': {
    pote: 'Exporter (FEC / comptable)',
    pro: 'Exporter (FEC / comptable)',
    direct: 'Exporter FEC',
  },
  'docs.exportDone': {
    pote: 'C’est prêt : {filename} est généré pour ton comptable.',
    pro: 'Export généré : {filename}.',
    direct: '{filename} généré.',
  },
  'docs.exportError': {
    pote: 'L’export a raté, là. On réessaie dans un instant ?',
    pro: 'L’export a échoué. Veuillez réessayer.',
    direct: 'Export raté. Réessaie.',
  },
  'docs.sectionRecent': {
    pote: 'Factures récentes',
    pro: 'Factures récentes',
    direct: 'Factures récentes',
  },
  'docs.kindDeposit': {
    pote: 'Acompte',
    pro: 'Acompte',
    direct: 'Acompte',
  },
  'docs.kindFinal': {
    pote: 'Facture',
    pro: 'Facture',
    direct: 'Facture',
  },
  'docs.kindCreditNote': {
    pote: 'Avoir',
    pro: 'Avoir',
    direct: 'Avoir',
  },
  'docs.kindSituation': {
    pote: 'Situation',
    pro: 'Situation',
    direct: 'Situation',
  },
  // Canal e-facture (copy proto : PDP reste le mot que tout le monde connaît).
  'docs.recentSubB2b': {
    pote: '{kind} · B2B → PDP',
    pro: '{kind} · B2B → plateforme agréée',
    direct: '{kind} · B2B → PDP',
  },
  'docs.recentSubB2c': {
    pote: 'Particulier · B2C → e-reporting',
    pro: 'Particulier · B2C → e-reporting',
    direct: 'B2C → e-reporting',
  },
  'docs.recentSubB2g': {
    pote: 'Public · B2G → Chorus Pro',
    pro: 'Client public · B2G → Chorus Pro',
    direct: 'B2G → Chorus',
  },
  'docs.memoryTitle': {
    pote: 'Mémoire fournisseurs',
    pro: 'Mémoire fournisseurs',
    direct: 'Fournisseurs connus',
  },
  'docs.memoryBody': {
    pote: 'J’ai reconnu {examples}… {count} fournisseurs mémorisés pour classer plus vite.',
    pro: 'Fournisseurs reconnus : {examples}… {count} mémorisés pour accélérer le classement.',
    direct: '{examples}… {count} fournisseurs en mémoire.',
  },
  'docs.memoryBodyOne': {
    pote: 'J’ai reconnu {examples} — 1 fournisseur mémorisé pour classer plus vite.',
    pro: 'Fournisseur reconnu : {examples} — 1 mémorisé.',
    direct: '{examples} — 1 fournisseur en mémoire.',
  },
  'docs.footer': {
    pote: '{count} documents · chiffré et sauvegardé',
    pro: '{count} documents · chiffrés et sauvegardés',
    direct: '{count} docs · chiffrés',
  },
  'docs.footerOne': {
    pote: '1 document · chiffré et sauvegardé',
    pro: '1 document · chiffré et sauvegardé',
    direct: '1 doc · chiffré',
  },
  'docs.emptyTitle': {
    pote: 'Rien encore',
    pro: 'Aucun document pour le moment',
    direct: 'Vide',
  },
  'docs.emptyBody': {
    pote: 'Tes factures, devis signés et reçus scannés se rangent ici tout seuls — et je les garde bien au chaud.',
    pro: 'Vos factures, devis signés et reçus scannés seront classés ici automatiquement et conservés.',
    direct: 'Scanne ou facture : ça se range ici.',
  },
  'docs.noResults': {
    pote: 'Rien trouvé pour « {query} ». Essaie un autre mot ?',
    pro: 'Aucun document ne correspond à « {query} ».',
    direct: 'Rien pour « {query} ».',
  },
  'docs.dataError': {
    pote: 'Je n’arrive pas à ouvrir ton coffre-fort, là. On réessaie dans un instant ?',
    pro: 'Impossible de charger vos documents pour le moment. Veuillez réessayer dans un instant.',
    direct: 'Coffre injoignable. Réessaie.',
  },

  // ── C15 — écran « Assistant (Bob) » ──────────────────────────────────────────
  // En-tête « Bob · en ligne » (copy pote = exacte du proto §isAssistant).
  'assistant.title': {
    pote: 'Bob',
    pro: 'Bob',
    direct: 'Bob',
  },
  'assistant.online': {
    pote: 'en ligne',
    pro: 'en ligne',
    direct: 'en ligne',
  },
  'assistant.offlinePill': {
    pote: 'hors ligne',
    pro: 'hors ligne',
    direct: 'hors ligne',
  },
  'assistant.subtitle': {
    pote: 'Demande. Je fais — pas juste je réponds.',
    pro: 'Demandez. J’agis — je ne me contente pas de répondre.',
    direct: 'Demande. J’exécute.',
  },
  // Bulle d'accueil (historique vide) — la promesse de Bob, voix du proto.
  'assistant.welcome': {
    pote: 'Salut, moi c’est Bob 👋 Dis-moi quoi faire — créer, relancer, classer, t’expliquer ta tréso. Je m’en occupe pour de vrai.',
    pro: 'Bonjour, je suis Bob. Indiquez-moi quoi faire — créer, relancer, classer, analyser votre trésorerie. Je m’en occupe réellement.',
    direct: 'Bob. Dis quoi faire — créer, relancer, classer, ta tréso. Je gère.',
  },
  // Chips de suggestion (proto) — chaque libellé déclenche une VRAIE requête agent
  // (les verbes matchent detectIntent @bob/ai : relance / payout / cloture).
  'assistant.chipRelance': {
    pote: 'Relance les retards',
    pro: 'Relancer les retards',
    direct: 'Relance les retards',
  },
  'assistant.chipPayout': {
    pote: 'Je peux me payer combien ?',
    pro: 'Combien puis-je me verser ?',
    direct: 'Je me paie combien ?',
  },
  'assistant.chipMonth': {
    pote: 'Prépare le mois',
    pro: 'Préparer le mois',
    direct: 'Prépare le mois',
  },
  'assistant.chipDiag': {
    pote: 'Prêt pour 2026 ?',
    pro: 'Prêt pour 2026 ?',
    direct: 'Prêt 2026 ?',
  },
  // Commandes canoniques : ?prompt=relance_devis (edge C13) + chips de désambiguïsation
  // ({ref} = numéro de pièce). Formulées pour matcher les intents @bob/ai à coup sûr.
  'assistant.cmdSendQuote': {
    pote: 'Renvoie le devis {ref} au client',
    pro: 'Renvoyer le devis {ref} au client',
    direct: 'Renvoie le devis {ref}',
  },
  // Variante sans référence (edge ?prompt=relance_devis) : l'agent résout le devis,
  // ou propose le choix s'il y en a plusieurs — jamais d'exécution sur ambiguïté.
  'assistant.cmdRelanceQuote': {
    pote: 'Renvoie le devis au client',
    pro: 'Renvoyer le devis au client',
    direct: 'Renvoie le devis',
  },
  'assistant.cmdIssue': {
    pote: 'Émets la facture {ref}',
    pro: 'Émettre la facture {ref}',
    direct: 'Émets la facture {ref}',
  },
  'assistant.cmdCollect': {
    pote: 'Encaisse la facture {ref}',
    pro: 'Encaisser la facture {ref}',
    direct: 'Encaisse la facture {ref}',
  },
  'assistant.placeholder': {
    pote: 'Demande-moi un truc…',
    pro: 'Demandez-moi une tâche…',
    direct: 'Demande…',
  },
  // Indicateur de saisie (3 points animés) + phases RÉELLES émises par l'agent (onPhase).
  'assistant.thinking': {
    pote: 'Bob réfléchit',
    pro: 'Bob réfléchit',
    direct: 'Réflexion',
  },
  'assistant.phaseUnderstand': {
    pote: 'Bob comprend',
    pro: 'Bob analyse',
    direct: 'Analyse',
  },
  'assistant.phaseAct': {
    pote: 'Bob agit',
    pro: 'Bob exécute',
    direct: 'Exécution',
  },
  // Cartes d'action : confirmation explicite (préparer ≠ envoyer) + garde-fou affiché.
  'assistant.confirm': {
    pote: 'Valider',
    pro: 'Valider',
    direct: 'Valider',
  },
  'assistant.cancel': {
    pote: 'Annuler',
    pro: 'Annuler',
    direct: 'Annuler',
  },
  'assistant.guardrail': {
    pote: 'Rien ne part sans ton OK.',
    pro: 'Aucune action n’est exécutée sans votre validation.',
    direct: 'Rien sans ton OK.',
  },
  'assistant.canceled': {
    pote: 'Ok, j’annule — rien n’a été fait.',
    pro: 'Action annulée — aucune modification effectuée.',
    direct: 'Annulé. Rien fait.',
  },
  // États d'échec — la voix de Bob, jamais un code d'erreur (A1-C10).
  'assistant.error': {
    pote: 'Je n’ai pas réussi à traiter ça, là. On réessaie ?',
    pro: 'Le traitement a échoué. Veuillez réessayer.',
    direct: 'Raté. Réessaie.',
  },
  'assistant.actionError': {
    pote: 'L’action a échoué — on vérifie et on réessaie ?',
    pro: 'L’action a échoué. Veuillez vérifier puis réessayer.',
    direct: 'Action ratée. Réessaie.',
  },
  'assistant.offline': {
    pote: 'Je n’arrive pas à joindre le serveur, là. Rien n’est perdu — on réessaie dans un instant ?',
    pro: 'Connexion au serveur impossible pour le moment. Vos données sont intactes — veuillez réessayer dans un instant.',
    direct: 'Serveur injoignable. Réessaie.',
  },
  // Micro de l'input — dictée branchée au claim C20 (Facture à la voix).
  'assistant.micSoon': {
    pote: 'Parler à Bob — bientôt',
    pro: 'Dictée vocale — bientôt disponible',
    direct: 'Micro : bientôt',
  },
  'assistant.send': {
    pote: 'Envoyer',
    pro: 'Envoyer',
    direct: 'Envoyer',
  },
  // Garde d'abonnement (feature ai_assistant) — l'app reste 100 % utilisable à la main.
  'assistant.lockedTitle': {
    pote: 'Bob, ton copilote',
    pro: 'Bob, votre copilote',
    direct: 'Bob, ton copilote',
  },
  'assistant.lockedBody': {
    pote: 'Bob exécute pour toi — encaisser, relancer, suivre ta tréso — en langage naturel. Inclus dès l’offre Pro. Sans lui, tout reste faisable à la main.',
    pro: 'Bob exécute vos tâches — encaissements, relances, trésorerie — en langage naturel. Inclus à partir de l’offre Pro. Sans lui, l’application reste entièrement fonctionnelle.',
    direct: 'Bob exécute : encaisser, relancer, tréso. Dès l’offre Pro.',
  },
  'assistant.lockedCta': {
    pote: 'Voir les offres',
    pro: 'Voir les offres',
    direct: 'Les offres',
  },
} as const satisfies Record<string, Copy>;

export type I18nKey = keyof typeof fr;

export interface TranslateOptions {
  readonly personality?: Personality;
  readonly params?: Readonly<Record<string, string | number>>;
}

export function t(key: I18nKey, options: TranslateOptions = {}): string {
  const personality = options.personality ?? DEFAULT_PERSONALITY;
  const template = fr[key][personality];
  const params = options.params;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}
