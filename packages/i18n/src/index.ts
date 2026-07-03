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
  // Feuille « créer un client » (C40, TODO partagé C12) — création MINIMALE : nom + type,
  // le reste se complète sur la fiche. Même use case createCustomer que l'outil agent creer_client.
  'clients.createTitle': {
    pote: 'Nouveau client',
    pro: 'Nouveau client',
    direct: 'Nouveau client',
  },
  'clients.createHint': {
    pote: 'Juste le nom et le type — le reste, on complétera sur sa fiche.',
    pro: 'Renseignez le nom et le type ; les autres informations pourront être complétées sur la fiche.',
    direct: 'Nom + type. Le reste après.',
  },
  'clients.createNameLabel': {
    pote: 'Nom',
    pro: 'Nom',
    direct: 'Nom',
  },
  'clients.createNamePlaceholder': {
    pote: 'Mme Durand, SARL Martin…',
    pro: 'Nom du client ou de l’entreprise',
    direct: 'Nom du client',
  },
  'clients.createTypeLabel': {
    pote: 'C’est qui ?',
    pro: 'Type de client',
    direct: 'Type',
  },
  'clients.createSubmit': {
    pote: 'Ajouter au carnet',
    pro: 'Créer le client',
    direct: 'Créer',
  },
  'clients.createSuccess': {
    pote: '{name} est dans ton carnet ✓',
    pro: '{name} a été ajouté à votre carnet.',
    direct: '{name} créé.',
  },
  'clients.createError': {
    pote: 'Je n’ai pas réussi à créer la fiche. On réessaie ?',
    pro: 'La création du client a échoué. Veuillez réessayer.',
    direct: 'Création impossible. Réessaie.',
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

  // ── C20 — flux « Facture à la voix » ─────────────────────────────────────────
  // Étape 1 — écoute (fond navy, orbe micro, onde animée, transcription).
  'voix.title': {
    pote: 'Facture à la voix',
    pro: 'Facture à la voix',
    direct: 'Facture à la voix',
  },
  'voix.listening': {
    pote: 'Je t’écoute…',
    pro: 'Je vous écoute…',
    direct: 'J’écoute.',
  },
  'voix.idle': {
    pote: 'Appuie sur le micro et raconte-moi le chantier.',
    pro: 'Touchez le micro et décrivez la prestation.',
    direct: 'Micro, puis parle.',
  },
  'voix.listenHint': {
    pote: 'Parle normalement — adresse, prestation, prix, paiement.',
    pro: 'Parlez normalement — adresse, prestation, prix, paiement.',
    direct: 'Adresse, prestation, prix, paiement.',
  },
  'voix.done': {
    pote: 'C’est tout bon',
    pro: 'Terminer la dictée',
    direct: 'Tout bon',
  },
  'voix.close': {
    pote: 'Fermer',
    pro: 'Fermer',
    direct: 'Fermer',
  },
  // Micro refusé / indisponible — état honnête, la saisie texte garde le flux utilisable.
  'voix.micDenied': {
    pote: 'Le micro est coupé pour Bob — autorise-le dans les réglages, ou écris ta facture juste en dessous.',
    pro: 'L’accès au micro est refusé. Autorisez-le dans les réglages, ou saisissez la facture ci-dessous.',
    direct: 'Micro refusé. Réglages, ou écris.',
  },
  'voix.micUnavailable': {
    pote: 'Pas de dictée dispo ici — écris ta facture juste en dessous, ça marche pareil.',
    pro: 'La dictée vocale est indisponible sur cet appareil. Saisissez la facture ci-dessous.',
    direct: 'Pas de micro ici. Écris.',
  },
  'voix.micFailed': {
    pote: 'J’ai raté la transcription — on réessaie, ou tu me l’écris ?',
    pro: 'La transcription a échoué. Réessayez, ou saisissez le texte.',
    direct: 'Transcription ratée. Réessaie ou écris.',
  },
  'voix.typePlaceholder': {
    pote: 'Écris ta facture ici…',
    pro: 'Saisissez la facture…',
    direct: 'Écris ici…',
  },
  // Étape 2 — revue (facture pré-remplie, corrections).
  'voix.reviewLead': {
    pote: 'Voilà ce que j’ai compris',
    pro: 'Voici ce que j’ai compris',
    direct: 'Compris :',
  },
  'voix.reviewTitle': {
    pote: 'Facture prête',
    pro: 'Facture prête',
    direct: 'Prête.',
  },
  'voix.reviewSub': {
    pote: 'Relis vite fait, et hop.',
    pro: 'Relisez rapidement avant de valider.',
    direct: 'Relis. Go.',
  },
  'voix.retry': {
    pote: 'Reprendre',
    pro: 'Reprendre',
    direct: 'Reprendre',
  },
  'voix.pickCustomer': {
    pote: 'C’est pour qui ? Choisis le client :',
    pro: 'Sélectionnez le client :',
    direct: 'Le client ?',
  },
  'voix.catLabor': {
    pote: 'Main d’œuvre',
    pro: 'Main d’œuvre',
    direct: 'Main d’œuvre',
  },
  'voix.catSupply': {
    pote: 'Fourniture',
    pro: 'Fourniture',
    direct: 'Fourniture',
  },
  'voix.catTravel': {
    pote: 'Déplacement',
    pro: 'Déplacement',
    direct: 'Déplacement',
  },
  'voix.totalHt': {
    pote: 'Total HT',
    pro: 'Total HT',
    direct: 'Total HT',
  },
  'voix.vatRate': {
    pote: 'TVA {rate} %',
    pro: 'TVA {rate} %',
    direct: 'TVA {rate} %',
  },
  'voix.totalTtc': {
    pote: 'Total TTC',
    pro: 'Total TTC',
    direct: 'Total TTC',
  },
  // Étape 3 — issue : Encaisser vs Envoyer (préparer ≠ envoyer, confirmation explicite).
  'voix.collectCta': {
    pote: 'Encaisser maintenant · {amount}',
    pro: 'Encaisser {amount}',
    direct: 'Encaisser · {amount}',
  },
  'voix.sendCta': {
    pote: 'Envoyer la facture',
    pro: 'Envoyer la facture',
    direct: 'Envoyer',
  },
  'voix.confirmCollectTitle': {
    pote: 'Encaissement à confirmer',
    pro: 'Encaissement à confirmer',
    direct: 'Encaissement à confirmer',
  },
  'voix.confirmCollectBody': {
    pote: 'J’émets la facture de {name} et j’encaisse {amount} — rien ne part sans ton OK.',
    pro: 'La facture de {name} sera émise (numéro légal) puis encaissée : {amount}.',
    direct: 'Émission + encaissement {amount} pour {name}.',
  },
  'voix.confirmSendTitle': {
    pote: 'Envoi à confirmer',
    pro: 'Envoi à confirmer',
    direct: 'Envoi à confirmer',
  },
  'voix.confirmSendBody': {
    pote: 'J’émets la facture de {name} ({amount}) avec son numéro légal, prête à partir.',
    pro: 'La facture de {name} ({amount}) sera émise avec son numéro légal.',
    direct: 'Émission facture {name} · {amount}.',
  },
  // Succès (écran vert) + toast au retour Aujourd'hui.
  'voix.doneTitlePaid': {
    pote: 'Payé ! 💸',
    pro: 'Paiement reçu',
    direct: 'Payé.',
  },
  'voix.donePaidText': {
    pote: '{amount} encaissés. La facture {number} est émise, classée, et ta tréso est à jour.',
    pro: '{amount} encaissés. Facture {number} émise, classée, trésorerie mise à jour.',
    direct: '{amount} encaissés. {number} émise, classée.',
  },
  'voix.doneTitleSent': {
    pote: 'C’est parti !',
    pro: 'Facture envoyée',
    direct: 'Envoyée.',
  },
  'voix.doneSentText': {
    pote: 'La facture {number} de {name} est émise et prête à partir. Je surveille et je relance si besoin.',
    pro: 'La facture {number} de {name} est émise. Suivi et relances automatiques.',
    direct: '{number} émise pour {name}. Relance auto si besoin.',
  },
  'voix.doneInvoiceLabel': {
    pote: 'Facture',
    pro: 'Facture',
    direct: 'Facture',
  },
  'voix.doneComptaLabel': {
    pote: 'Compta',
    pro: 'Comptabilité',
    direct: 'Compta',
  },
  'voix.doneComptaValue': {
    pote: 'À jour ✓',
    pro: 'À jour ✓',
    direct: 'À jour ✓',
  },
  'voix.finish': {
    pote: 'Nickel, on continue',
    pro: 'Continuer',
    direct: 'Suite.',
  },
  'voix.toastPaid': {
    pote: '{amount} encaissés ✓',
    pro: '{amount} encaissés ✓',
    direct: '{amount} ✓',
  },
  'voix.toastSent': {
    pote: 'Facture {number} émise ✓',
    pro: 'Facture {number} émise ✓',
    direct: '{number} émise ✓',
  },
  // Erreurs — la voix de Bob, jamais un code (A1-C10).
  'voix.errNoLines': {
    pote: 'Je n’ai pas entendu de prestation ni de montant — on réessaie ?',
    pro: 'Aucune prestation ou montant reconnu. Veuillez réessayer.',
    direct: 'Pas de montant. Réessaie.',
  },
  'voix.errNoCustomer': {
    pote: 'Il me faut le client avant de facturer — choisis-le ci-dessus.',
    pro: 'Sélectionnez le client avant de facturer.',
    direct: 'Choisis le client.',
  },
  'voix.errAction': {
    pote: 'L’action a échoué — rien n’est perdu, on réessaie ?',
    pro: 'L’action a échoué. Veuillez réessayer.',
    direct: 'Raté. Réessaie.',
  },

  // ── C21 — flux « Devis → signature → facture » ───────────────────────────────
  // Chrome du flux (modal 6 étapes piloté par @bob/core flows/devis).
  'devis.title': {
    pote: 'Nouveau devis',
    pro: 'Nouveau devis',
    direct: 'Nouveau devis',
  },
  'devis.close': {
    pote: 'Fermer',
    pro: 'Fermer',
    direct: 'Fermer',
  },
  'devis.back': {
    pote: 'Retour',
    pro: 'Retour',
    direct: 'Retour',
  },
  'devis.next': {
    pote: 'Continuer',
    pro: 'Continuer',
    direct: 'Suite',
  },
  // Titres des 6 étapes de la machine (client → lignes → TVA/mentions → signature → acompte → facture).
  'devis.stepClient': {
    pote: 'Le client',
    pro: 'Le client',
    direct: 'Client',
  },
  'devis.stepLines': {
    pote: 'Les prestations',
    pro: 'Les prestations',
    direct: 'Prestations',
  },
  'devis.stepVat': {
    pote: 'TVA & mentions',
    pro: 'TVA & mentions',
    direct: 'TVA & mentions',
  },
  'devis.stepSignature': {
    pote: 'Signature',
    pro: 'Signature',
    direct: 'Signature',
  },
  'devis.stepDeposit': {
    pote: 'Acompte',
    pro: 'Acompte',
    direct: 'Acompte',
  },
  'devis.stepInvoice': {
    pote: 'La facture',
    pro: 'La facture',
    direct: 'Facture',
  },
  // Étape 1 — client (liste réelle, sélection).
  'devis.clientTitle': {
    pote: 'C’est pour qui ?',
    pro: 'Pour quel client ?',
    direct: 'Le client ?',
  },
  'devis.clientSub': {
    pote: 'Choisis le client — je remplis le reste du devis.',
    pro: 'Sélectionnez le client : le devis se complète ensuite.',
    direct: 'Choisis. Je remplis.',
  },
  'devis.noCustomers': {
    pote: 'Ton carnet est vide — ajoute d’abord un client depuis l’onglet Clients.',
    pro: 'Votre carnet est vide. Créez d’abord un client depuis l’onglet Clients.',
    direct: 'Carnet vide. Ajoute un client d’abord.',
  },
  // Étape 2 — lignes (saisie libre : libellé, qté, PU HT, catégorie ; TVA suggérée).
  'devis.linesTitle': {
    pote: 'Qu’est-ce qu’on facture ?',
    pro: 'Détaillez les prestations',
    direct: 'Les lignes.',
  },
  'devis.linesSub': {
    pote: 'Ajoute tes prestations — les totaux se calculent tout seuls.',
    pro: 'Ajoutez vos prestations : les totaux se calculent automatiquement.',
    direct: 'Ajoute. Je calcule.',
  },
  'devis.lineLabelPlaceholder': {
    pote: 'Prestation (ex. chauffe-eau 200 L posé)',
    pro: 'Prestation (ex. chauffe-eau 200 L posé)',
    direct: 'Prestation…',
  },
  'devis.qtyLabel': {
    pote: 'Qté',
    pro: 'Qté',
    direct: 'Qté',
  },
  'devis.unitPriceLabel': {
    pote: 'PU HT (€)',
    pro: 'PU HT (€)',
    direct: 'PU HT (€)',
  },
  'devis.addLine': {
    pote: 'Ajouter la ligne',
    pro: 'Ajouter la ligne',
    direct: 'Ajouter',
  },
  'devis.removeLine': {
    pote: 'Retirer {label}',
    pro: 'Retirer {label}',
    direct: 'Retirer {label}',
  },
  'devis.linesEmpty': {
    pote: 'Aucune ligne pour l’instant — ajoute ta première prestation juste au-dessus.',
    pro: 'Aucune ligne pour le moment. Ajoutez votre première prestation ci-dessus.',
    direct: 'Zéro ligne. Ajoute.',
  },
  'devis.vatSuggested': {
    pote: 'TVA suggérée : {rate} %',
    pro: 'TVA suggérée : {rate} %',
    direct: 'TVA suggérée : {rate} %',
  },
  'devis.totalHt': {
    pote: 'Total HT',
    pro: 'Total HT',
    direct: 'Total HT',
  },
  'devis.vatRate': {
    pote: 'TVA {rate} %',
    pro: 'TVA {rate} %',
    direct: 'TVA {rate} %',
  },
  'devis.totalTtc': {
    pote: 'Total TTC',
    pro: 'Total TTC',
    direct: 'Total TTC',
  },
  // Étape 3 — TVA & mentions (contexte logement → taux, mentions ajoutées à la génération).
  'devis.vatTitle': {
    pote: 'La bonne TVA, sans te tromper',
    pro: 'Le taux de TVA adapté',
    direct: 'La TVA.',
  },
  'devis.vatSub': {
    pote: 'Dis-moi le contexte du chantier — j’applique le bon taux partout.',
    pro: 'Indiquez le contexte du chantier : le taux s’applique à tout le devis.',
    direct: 'Le contexte. J’applique.',
  },
  'devis.vatStandard': {
    pote: 'Taux normal — 20 %',
    pro: 'Taux normal — 20 %',
    direct: 'Normal — 20 %',
  },
  'devis.vatHousing': {
    pote: 'Logement de plus de 2 ans — 10 %',
    pro: 'Logement de plus de 2 ans — 10 %',
    direct: 'Logement > 2 ans — 10 %',
  },
  'devis.vatEnergy': {
    pote: 'Rénovation énergétique — 5,5 %',
    pro: 'Rénovation énergétique — 5,5 %',
    direct: 'Réno énergétique — 5,5 %',
  },
  'devis.vatHint': {
    pote: 'Je mets tout le devis à {rate} % — et je revérifie le taux au moment de générer (franchise, autoliquidation).',
    pro: 'Le devis passe à {rate} %. Le taux est revérifié à la génération (franchise, autoliquidation).',
    direct: 'Tout à {rate} %. Revérifié à la génération.',
  },
  'devis.mentionsTitle': {
    pote: 'Mentions légales ajoutées',
    pro: 'Mentions légales ajoutées',
    direct: 'Mentions légales',
  },
  'devis.mentionsBody': {
    pote: 'Devis gratuit · validité · pénalités de retard (L441-10) · décennale si BTP · bon pour accord. J’ajoute tout à la génération.',
    pro: 'Devis gratuit · validité · pénalités de retard (art. L441-10) · assurance décennale le cas échéant · bon pour accord. Ajoutées automatiquement à la génération.',
    direct: 'Gratuit · validité · L441-10 · décennale · bon pour accord. Ajoutées auto.',
  },
  // Étape 4 — signature au doigt (SignaturePad) + nom du signataire.
  'devis.signTitle': {
    pote: 'Fais signer ton client ici',
    pro: 'Faites signer votre client ici',
    direct: 'Signature client.',
  },
  'devis.signSub': {
    pote: 'Bon pour accord — il signe du doigt, direct sur ton téléphone.',
    pro: 'Bon pour accord — signature au doigt, directement sur votre téléphone.',
    direct: 'Bon pour accord. Au doigt.',
  },
  'devis.signPlaceholder': {
    pote: 'Signe ici du doigt',
    pro: 'Signez ici du doigt',
    direct: 'Signe ici.',
  },
  'devis.signClear': {
    pote: 'Effacer',
    pro: 'Effacer',
    direct: 'Effacer',
  },
  'devis.signerLabel': {
    pote: 'Nom du signataire',
    pro: 'Nom du signataire',
    direct: 'Signataire',
  },
  'devis.signerPlaceholder': {
    pote: 'Ex. M. Bernard',
    pro: 'Ex. M. Bernard',
    direct: 'Nom…',
  },
  // Étape 5 — acompte (30 % défaut, éditable ; net réel calculé par le core).
  'devis.depositTitle': {
    pote: 'Un acompte pour lancer le chantier ?',
    pro: 'Souhaitez-vous demander un acompte ?',
    direct: 'Acompte ?',
  },
  'devis.depositSub': {
    pote: '30 % c’est l’usage — le solde partira en facture finale.',
    pro: '30 % est l’usage. Le solde fera l’objet de la facture finale.',
    direct: '30 % = l’usage. Solde en facture finale.',
  },
  'devis.depositPct': {
    pote: '{pct} %',
    pro: '{pct} %',
    direct: '{pct} %',
  },
  'devis.depositNone': {
    pote: 'Sans acompte',
    pro: 'Sans acompte',
    direct: 'Sans',
  },
  'devis.depositSummary': {
    pote: 'Acompte {pct} % — net à encaisser {amount}.',
    pro: 'Acompte de {pct} % — net à encaisser : {amount}.',
    direct: 'Acompte {pct} % · net {amount}.',
  },
  'devis.depositNetLabel': {
    pote: 'À encaisser à la signature',
    pro: 'Net à encaisser à la signature',
    direct: 'À encaisser',
  },
  'devis.depositFullLabel': {
    pote: 'Facture unique — net à payer',
    pro: 'Facture unique — net à payer',
    direct: 'Facture unique — net',
  },
  // Étape 6 — génération (chaîne réelle createQuote → sendQuote → signQuote → generateInvoice → issueInvoice).
  'devis.generateCta': {
    pote: 'Générer la facture',
    pro: 'Générer la facture',
    direct: 'Facturer',
  },
  'devis.confirmTitle': {
    pote: 'Facture à générer',
    pro: 'Facture à générer',
    direct: 'Facture à générer',
  },
  'devis.confirmBody': {
    pote: 'J’envoie le devis, j’enregistre la signature de {name} et j’émets la facture ({amount}) avec son numéro légal.',
    pro: 'Le devis est envoyé, la signature de {name} est enregistrée, puis la facture ({amount}) est émise avec son numéro légal.',
    direct: 'Envoi + signature {name} + émission {amount}.',
  },
  'devis.generating': {
    pote: 'Je génère ta facture…',
    pro: 'Génération de la facture…',
    direct: 'Génération…',
  },
  'devis.successTitle': {
    pote: 'Facture générée !',
    pro: 'Facture générée',
    direct: 'Générée.',
  },
  'devis.successBody': {
    pote: 'La facture {number} de {name} est émise — net à encaisser {amount}. Je surveille et je relance si besoin.',
    pro: 'La facture {number} de {name} est émise — net à encaisser : {amount}. Suivi et relances automatiques.',
    direct: '{number} émise pour {name}. Net {amount}.',
  },
  'devis.seeInvoice': {
    pote: 'Voir la facture',
    pro: 'Voir la facture',
    direct: 'Voir la facture',
  },
  'devis.toastDone': {
    pote: 'Facture {number} émise ✓',
    pro: 'Facture {number} émise ✓',
    direct: '{number} émise ✓',
  },
  'devis.retry': {
    pote: 'Réessayer',
    pro: 'Réessayer',
    direct: 'Réessayer',
  },
  // Gardes de la machine (devisNext bloqué) — la voix de Bob, jamais un code d'erreur.
  'devis.guardClient': {
    pote: 'Choisis d’abord le client — je ne fais pas de devis fantôme.',
    pro: 'Sélectionnez un client avant de continuer.',
    direct: 'Le client d’abord.',
  },
  'devis.guardLines': {
    pote: 'Ajoute au moins une prestation avant de continuer.',
    pro: 'Ajoutez au moins une prestation avant de continuer.',
    direct: 'Une ligne minimum.',
  },
  'devis.guardSignature': {
    pote: 'Il me faut la signature et le nom du client pour continuer.',
    pro: 'La signature et le nom du client sont requis pour continuer.',
    direct: 'Signature + nom requis.',
  },
  'devis.guardDeposit': {
    pote: 'L’acompte doit rester entre 0 et 100 %.',
    pro: 'L’acompte doit être compris entre 0 et 100 %.',
    direct: 'Acompte : 0 à 100 %.',
  },
  // Erreurs use cases / transitions — la voix de Bob (A1-C10).
  'devis.errAction': {
    pote: 'La génération a raté — rien n’est perdu, on réessaie ?',
    pro: 'La génération a échoué. Vos saisies sont conservées — veuillez réessayer.',
    direct: 'Raté. Rien perdu. Réessaie.',
  },
  'devis.dataError': {
    pote: 'Je n’arrive pas à ouvrir ton carnet, là. On réessaie dans un instant ?',
    pro: 'Impossible de charger vos clients pour le moment. Veuillez réessayer dans un instant.',
    direct: 'Carnet injoignable. Réessaie.',
  },

  // ── C16 — écran « Détail pièce » ─────────────────────────────────────────────
  'piece.kindDevis': { pote: 'Devis', pro: 'Devis', direct: 'Devis' },
  'piece.kindFacture': { pote: 'Facture', pro: 'Facture', direct: 'Facture' },
  'piece.kindAcompte': { pote: 'Facture d’acompte', pro: 'Facture d’acompte', direct: 'Acompte' },
  'piece.kindAvoir': { pote: 'Avoir', pro: 'Avoir', direct: 'Avoir' },
  'piece.kindSituation': { pote: 'Situation de travaux', pro: 'Situation de travaux', direct: 'Situation' },
  'piece.draftNumber': {
    pote: 'Brouillon — numérotée à l’émission',
    pro: 'Brouillon — le numéro sera attribué à l’émission',
    direct: 'Brouillon',
  },
  // Statuts (badge header)
  'piece.statusDraft': { pote: 'Brouillon', pro: 'Brouillon', direct: 'Brouillon' },
  'piece.statusIssued': { pote: 'Émise', pro: 'Émise', direct: 'Émise' },
  'piece.statusPartiallyPaid': { pote: 'Encaissée en partie', pro: 'Partiellement payée', direct: 'Partielle' },
  'piece.statusPaid': { pote: 'Payée ✓', pro: 'Payée', direct: 'Payée' },
  'piece.statusLate': { pote: 'En retard', pro: 'En retard', direct: 'Retard' },
  'piece.statusCancelled': { pote: 'Annulée', pro: 'Annulée', direct: 'Annulée' },
  'piece.statusSent': { pote: 'Envoyé', pro: 'Envoyé', direct: 'Envoyé' },
  'piece.statusViewed': { pote: 'Vu par le client', pro: 'Consulté', direct: 'Vu' },
  'piece.statusSigned': { pote: 'Signé ✓', pro: 'Signé', direct: 'Signé' },
  'piece.statusRefused': { pote: 'Refusé', pro: 'Refusé', direct: 'Refusé' },
  'piece.statusExpired': { pote: 'Expiré', pro: 'Expiré', direct: 'Expiré' },
  // Nav croisée
  'piece.linkedQuote': { pote: 'Devis d’origine', pro: 'Devis d’origine', direct: 'Devis' },
  'piece.linkedInvoice': { pote: 'Facture liée', pro: 'Facture liée', direct: 'Facture' },
  'piece.linkedAvoir': {
    pote: 'Avoir émis sur cette facture',
    pro: 'Avoir émis sur cette facture',
    direct: 'Avoir émis',
  },
  'piece.linkedSituation': { pote: 'Situation de travaux', pro: 'Situation de travaux', direct: 'Situation' },
  'piece.progress': { pote: 'avancement {pct} %', pro: 'avancement {pct} %', direct: '{pct} %' },
  // Parties
  'piece.issuer': { pote: 'Émetteur', pro: 'Émetteur', direct: 'Émetteur' },
  'piece.customer': { pote: 'Client', pro: 'Client', direct: 'Client' },
  'piece.typeB2b': { pote: 'Entreprise', pro: 'Entreprise', direct: 'B2B' },
  'piece.typeB2c': { pote: 'Particulier', pro: 'Particulier', direct: 'B2C' },
  'piece.typeB2g': { pote: 'Public', pro: 'Secteur public', direct: 'B2G' },
  // Lignes & totaux
  'piece.catLabor': { pote: 'Main-d’œuvre', pro: 'Main-d’œuvre', direct: 'MO' },
  'piece.catSupply': { pote: 'Fourniture', pro: 'Fourniture', direct: 'Fourn.' },
  'piece.catTravel': { pote: 'Déplacement', pro: 'Déplacement', direct: 'Dépl.' },
  'piece.catDisbursement': { pote: 'Débours', pro: 'Débours', direct: 'Débours' },
  'piece.catSubscription': { pote: 'Abonnement', pro: 'Abonnement', direct: 'Abo' },
  'piece.vatPerLine': { pote: 'TVA {rate} %', pro: 'TVA {rate} %', direct: '{rate} %' },
  'piece.totalHt': { pote: 'Total HT', pro: 'Total HT', direct: 'HT' },
  'piece.totalVat': { pote: 'TVA', pro: 'TVA', direct: 'TVA' },
  'piece.totalTtc': { pote: 'Total TTC', pro: 'Total TTC', direct: 'TTC' },
  'piece.deposit': {
    pote: 'Acompte {pct} % à la commande : {amount}',
    pro: 'Acompte de {pct} % à la commande : {amount}',
    direct: 'Acompte {pct} % : {amount}',
  },
  // Suivi de paiement
  'piece.paymentTitle': { pote: 'Suivi de paiement', pro: 'Suivi de paiement', direct: 'Paiement' },
  'piece.paidLabel': { pote: 'Encaissé', pro: 'Encaissé', direct: 'Encaissé' },
  'piece.remainingLabel': { pote: 'Reste à encaisser', pro: 'Reste à encaisser', direct: 'Reste' },
  'piece.paidDone': {
    pote: 'Tout est encaissé — beau boulot 💪',
    pro: 'Facture intégralement encaissée.',
    direct: 'Soldée.',
  },
  // e-facture
  'piece.ereportingTitle': { pote: 'Vente à un particulier', pro: 'Vente à un particulier', direct: 'B2C' },
  'piece.ereportingBody': {
    pote: 'Pas de transmission PDP — la donnée part en e-reporting (déclaration à l’administration).',
    pro: 'Aucune transmission PDP requise : les données partent en e-reporting auprès de l’administration.',
    direct: 'Pas de PDP : e-reporting.',
  },
  'piece.transmissionPa': { pote: 'Facture électronique · PDP', pro: 'Facture électronique · plateforme agréée', direct: 'e-facture · PDP' },
  'piece.transmissionChorus': { pote: 'Facture électronique · Chorus Pro', pro: 'Facture électronique · Chorus Pro', direct: 'Chorus Pro' },
  'piece.stepEmise': { pote: 'Émise', pro: 'Émise', direct: 'Émise' },
  'piece.stepTransmise': { pote: 'Transmise', pro: 'Transmise', direct: 'Transmise' },
  'piece.stepRecue': { pote: 'Reçue', pro: 'Reçue', direct: 'Reçue' },
  'piece.stepAcceptee': { pote: 'Acceptée', pro: 'Acceptée', direct: 'Acceptée' },
  'piece.stepPayee': { pote: 'Payée', pro: 'Payée', direct: 'Payée' },
  // Mentions
  'piece.mentionsTitle': { pote: 'Mentions légales', pro: 'Mentions légales', direct: 'Mentions' },
  'piece.frozenBadge': { pote: 'Figé à l’émission', pro: 'Figé à l’émission', direct: 'Figé' },
  // Actions
  'piece.actionPdf': { pote: 'PDF', pro: 'PDF', direct: 'PDF' },
  'piece.actionEncaisser': { pote: 'Encaisser', pro: 'Encaisser', direct: 'Encaisser' },
  'piece.actionEnvoyer': { pote: 'Envoyer au client', pro: 'Envoyer au client', direct: 'Envoyer' },
  'piece.actionRelancer': { pote: 'Relancer', pro: 'Relancer', direct: 'Relancer' },
  'piece.actionFacturer': { pote: 'Créer la facture', pro: 'Générer la facture', direct: 'Facturer' },
  'piece.actionEmettre': { pote: 'Émettre', pro: 'Émettre la facture', direct: 'Émettre' },
  // États
  'piece.notFound': {
    pote: 'Je ne retrouve pas cette pièce. Elle a peut-être été supprimée ?',
    pro: 'Pièce introuvable.',
    direct: 'Introuvable.',
  },
  'piece.dataError': {
    pote: 'Je n’arrive pas à ouvrir cette pièce, là. On réessaie dans un instant ?',
    pro: 'Impossible de charger cette pièce pour le moment. Veuillez réessayer.',
    direct: 'Pièce injoignable. Réessaie.',
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
