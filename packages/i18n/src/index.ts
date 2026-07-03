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
    pote: 'Aucune coordonnée renseignée pour l’instant — email, téléphone, SIREN.',
    pro: 'Aucune coordonnée renseignée pour le moment (email, téléphone, SIREN).',
    direct: 'Aucune coordonnée.',
  },
  // A1-C13 — onglets remplis (chantiers réels, docs liés aux pièces, coordonnées).
  'fiche.chantierOpen': { pote: 'En cours', pro: 'En cours', direct: 'En cours' },
  'fiche.chantierClosed': { pote: 'Terminé', pro: 'Terminé', direct: 'Terminé' },
  'fiche.chantierOpenedOn': {
    pote: 'Ouvert le {date}',
    pro: 'Ouvert le {date}',
    direct: '{date}',
  },
  'fiche.infoType': { pote: 'Type', pro: 'Type', direct: 'Type' },
  'fiche.infoSiren': { pote: 'SIREN', pro: 'SIREN', direct: 'SIREN' },
  'fiche.infoEmail': { pote: 'Email', pro: 'Email', direct: 'Email' },
  'fiche.infoPhone': { pote: 'Téléphone', pro: 'Téléphone', direct: 'Tél.' },
  'fiche.infoScore': { pote: 'Score de paiement', pro: 'Score de paiement', direct: 'Score' },
  'fiche.infoDelay': { pote: 'Délai moyen constaté', pro: 'Délai moyen constaté', direct: 'Délai moyen' },
  'fiche.infoDelayDays': { pote: '{days} jours', pro: '{days} jours', direct: '{days} j' },
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
  'piece.chantierTtc': {
    pote: 'Total chantier TTC',
    pro: 'Total du chantier TTC',
    direct: 'Chantier TTC',
  },
  'piece.depositDeducted': {
    pote: 'Acompte déjà facturé{number}',
    pro: 'Acompte déjà facturé{number}',
    direct: 'Acompte facturé{number}',
  },
  'piece.linkedDeposit': {
    pote: 'Facture d’acompte',
    pro: 'Facture d’acompte',
    direct: 'Acompte',
  },
  'piece.amountDuePartial': {
    pote: 'Net à payer (cette facture)',
    pro: 'Net à payer — cette facture',
    direct: 'Net à payer',
  },
  'piece.nextStepBody': {
    pote: 'Acompte encaissé ✓ Reste à facturer sur le chantier : {amount}.',
    pro: 'Acompte encaissé. Reste à facturer sur ce chantier : {amount}.',
    direct: 'Reste à facturer : {amount}.',
  },
  'piece.actionFacturerSolde': {
    pote: 'Créer la facture finale',
    pro: 'Générer la facture finale',
    direct: 'Facture finale',
  },
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

  // ── C23 — flux « Diagnostic 2026 » (copy pote = exacte du proto §diag*) ───────
  'diag.title': { pote: 'Diagnostic 2026', pro: 'Diagnostic 2026', direct: 'Diagnostic 2026' },
  'diag.close': { pote: 'Fermer', pro: 'Fermer', direct: 'Fermer' },
  'diag.back': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },
  'diag.introTitle': {
    pote: 'Prêt pour la facture électronique 2026 ?',
    pro: 'Prêt pour la facturation électronique 2026 ?',
    direct: 'Prêt pour 2026 ?',
  },
  // {count} = nombre de questions du parcours (adaptatif) — avec 3, la phrase = proto exact.
  'diag.introBody': {
    pote: 'À partir du 1ᵉʳ sept. 2026, ton entreprise devra recevoir ses factures en électronique. {count} questions, je te dis où t’en es.',
    pro: 'Au 1ᵉʳ septembre 2026, votre entreprise devra recevoir ses factures au format électronique. {count} questions pour faire le point.',
    direct: 'Sept. 2026 : réception e-facture obligatoire. {count} questions.',
  },
  'diag.introCta': {
    pote: 'C’est parti — 2 min',
    pro: 'Commencer — 2 minutes',
    direct: 'Go — 2 min',
  },
  // Étape audit — constats automatiques du dossier (v2 : zéro question inutile).
  'diag.auditEyebrow': { pote: 'Ton dossier', pro: 'Votre dossier', direct: 'Dossier' },
  'diag.auditTitle': {
    pote: 'J’ai déjà regardé ton dossier',
    pro: 'Bob a déjà analysé votre dossier',
    direct: 'Dossier déjà audité',
  },
  'diag.auditMix': {
    pote: 'Tes clients : {b2c} particuliers · {b2b} pros · {b2g} public',
    pro: 'Vos clients : {b2c} particuliers · {b2b} professionnels · {b2g} secteur public',
    direct: '{b2c} B2C · {b2b} B2B · {b2g} B2G',
  },
  'diag.auditContinue': { pote: 'OK, la suite', pro: 'Continuer', direct: 'Suite' },
  // Questions (max 3, adaptatives) — Q plateforme = copy proto exacte.
  'diag.questionTag': {
    pote: 'Question {n} / {total}',
    pro: 'Question {n} / {total}',
    direct: 'Q{n} / {total}',
  },
  'diag.qPlatform': {
    pote: 'T’as déjà choisi ta plateforme agréée ?',
    pro: 'Avez-vous choisi votre plateforme agréée ?',
    direct: 'Plateforme agréée choisie ?',
  },
  'diag.qPlatformYes': { pote: 'Oui, c’est fait', pro: 'Oui, c’est fait', direct: 'Oui' },
  'diag.qPlatformNo': { pote: 'Pas encore', pro: 'Pas encore', direct: 'Non' },
  'diag.qPlatformUnknown': {
    pote: 'C’est quoi, une plateforme ?',
    pro: 'Je ne sais pas encore',
    direct: 'Aucune idée',
  },
  'diag.qOffApp': {
    pote: 'Il t’arrive d’encaisser en dehors de l’app ?',
    pro: 'Encaissez-vous parfois hors de l’application (caisse, espèces) ?',
    direct: 'Encaissements hors app ?',
  },
  'diag.qOffAppYes': { pote: 'Oui, ça arrive', pro: 'Oui, parfois', direct: 'Oui' },
  'diag.qOffAppNo': { pote: 'Non, tout passe ici', pro: 'Non, tout passe par l’application', direct: 'Non' },
  'diag.qOffAppUnknown': { pote: 'Je sais pas trop', pro: 'Je ne sais pas', direct: 'Sais pas' },
  'diag.qAccountant': {
    pote: 'T’es accompagné par un comptable ?',
    pro: 'Êtes-vous accompagné par un expert-comptable ?',
    direct: 'Un comptable t’accompagne ?',
  },
  'diag.qAccountantYes': { pote: 'Oui, j’ai un comptable', pro: 'Oui, un expert-comptable', direct: 'Oui' },
  'diag.qAccountantOga': { pote: 'Oui, un OGA / CGA', pro: 'Oui, un OGA / CGA', direct: 'OGA / CGA' },
  'diag.qAccountantNo': { pote: 'Non, je gère seul', pro: 'Non, je gère seul', direct: 'Non' },
  // Résultat — titre par tranche de score (mêmes seuils que l'anneau : >75 · 50–75 · <50).
  'diag.resultTitleHigh': { pote: 'Prêt pour 2026 🎉', pro: 'Vous êtes prêt pour 2026', direct: 'Prêt.' },
  'diag.resultTitleMid': { pote: 'Presque prêt 💪', pro: 'Presque prêt', direct: 'Presque.' },
  'diag.resultTitleLow': { pote: 'Faut s’y mettre 🔧', pro: 'Des actions sont nécessaires', direct: 'Pas prêt.' },
  // {count} = points à régler — avec 2, la phrase pote = proto exact.
  'diag.resultBody': {
    pote: '{count} trucs à régler et tu seras tranquille pour septembre 2026.',
    pro: '{count} points à traiter avant septembre 2026.',
    direct: '{count} points à régler.',
  },
  'diag.resultBodyOne': {
    pote: '1 truc à régler et tu seras tranquille pour septembre 2026.',
    pro: '1 point à traiter avant septembre 2026.',
    direct: '1 point à régler.',
  },
  'diag.resultBodyNone': {
    pote: 'Tout est en place pour septembre 2026. Beau boulot.',
    pro: 'Tout est en place pour l’échéance de septembre 2026.',
    direct: 'Tout est prêt.',
  },
  'diag.axisReception': { pote: 'Réception 2026', pro: 'Réception 2026', direct: 'Réception' },
  'diag.axisEmission': { pote: 'Émission 2027', pro: 'Émission 2027', direct: 'Émission' },
  'diag.axisDonnees': { pote: 'Qualité des données', pro: 'Qualité des données', direct: 'Données' },
  'diag.planTitle': { pote: 'Ton plan d’action', pro: 'Votre plan d’action', direct: 'Plan d’action' },
  'diag.deadline': { pote: 'avant le {date}', pro: 'échéance {date}', direct: '{date}' },
  'diag.resultCta': { pote: 'Configurer ma réception', pro: 'Configurer la réception', direct: 'Configurer' },
  'diag.resultLater': { pote: 'Plus tard', pro: 'Plus tard', direct: 'Plus tard' },
  'diag.dataError': {
    pote: 'J’arrive pas à lire ton dossier, là. On réessaie ?',
    pro: 'Impossible de charger le diagnostic pour le moment.',
    direct: 'Chargement KO. Réessaie.',
  },
  'diag.retry': { pote: 'Réessayer', pro: 'Réessayer', direct: 'Réessayer' },
  // Items du plan d'action (labels + détails) — libellés proto exacts quand ils existent.
  'diag.itemReception': {
    pote: 'Plateforme de réception',
    pro: 'Plateforme de réception',
    direct: 'Plateforme réception',
  },
  'diag.itemReceptionTodo': {
    pote: 'À configurer — le plus urgent',
    pro: 'À configurer — priorité n° 1',
    direct: 'À configurer. Urgent.',
  },
  'diag.itemReceptionDone': {
    pote: 'Choisie et inscrite à l’annuaire ✓',
    pro: 'Choisie et inscrite à l’annuaire ✓',
    direct: 'OK ✓',
  },
  'diag.itemFranchise': {
    pote: 'Franchise en base (293 B)',
    pro: 'Franchise en base (art. 293 B)',
    direct: 'Franchise 293 B',
  },
  'diag.itemFranchiseNote': {
    pote: 'Pas de TVA facturée, mais la réforme s’applique quand même',
    pro: 'La franchise ne dispense pas de la facturation électronique',
    direct: 'Concerné quand même.',
  },
  'diag.itemArchive': { pote: 'Archivage 10 ans', pro: 'Archivage 10 ans', direct: 'Archivage 10 ans' },
  'diag.itemArchiveDone': {
    pote: 'Coffre-fort automatique ✓',
    pro: 'Assuré par le coffre-fort ✓',
    direct: 'OK ✓',
  },
  'diag.itemEmission': {
    pote: 'Factures B2B en électronique',
    pro: 'Émission B2B électronique',
    direct: 'Émission B2B',
  },
  'diag.itemEmissionTodo': {
    pote: 'À prévoir via ta plateforme — sept. 2027',
    pro: 'À prévoir via votre plateforme agréée',
    direct: 'Via la plateforme. 2027.',
  },
  'diag.itemEmissionDone': {
    pote: 'Prête via ta plateforme ✓',
    pro: 'Prête via votre plateforme ✓',
    direct: 'OK ✓',
  },
  'diag.itemChorus': {
    pote: 'Clients publics · Chorus Pro',
    pro: 'Clients publics · Chorus Pro',
    direct: 'B2G · Chorus Pro',
  },
  'diag.itemChorusDone': { pote: 'Déjà en place ✓', pro: 'Déjà en vigueur ✓', direct: 'OK ✓' },
  'diag.itemEreporting': {
    pote: 'e-reporting de tes ventes aux particuliers',
    pro: 'e-reporting des ventes aux particuliers',
    direct: 'e-reporting B2C',
  },
  'diag.itemEreportingTodo': {
    pote: 'Tes ventes B2C remonteront via la plateforme',
    pro: 'Les ventes B2C remonteront via la plateforme',
    direct: 'Via la plateforme.',
  },
  'diag.itemEreportingDone': {
    pote: 'Couvert par ta plateforme ✓',
    pro: 'Couvert par votre plateforme ✓',
    direct: 'OK ✓',
  },
  'diag.itemOffApp': {
    pote: 'Encaissements hors app',
    pro: 'Encaissements hors application',
    direct: 'Encaissements hors app',
  },
  'diag.itemOffAppTodo': {
    pote: 'À centraliser ici, sinon ton e-reporting sera incomplet',
    pro: 'À centraliser pour un e-reporting complet',
    direct: 'À centraliser.',
  },
  'diag.itemPayments': {
    pote: 'e-reporting des encaissements',
    pro: 'e-reporting des paiements',
    direct: 'e-reporting paiements',
  },
  'diag.itemPaymentsDone': {
    pote: 'L’app suit déjà tes paiements ✓',
    pro: 'Suivi des paiements assuré ✓',
    direct: 'OK ✓',
  },
  'diag.itemFacturx': { pote: 'Format Factur-X', pro: 'Format Factur-X', direct: 'Factur-X' },
  'diag.itemFacturxDone': {
    pote: 'Géré automatiquement ✓',
    pro: 'Géré automatiquement ✓',
    direct: 'OK ✓',
  },
  'diag.itemSiren': {
    pote: 'SIREN de tes clients pros',
    pro: 'SIREN de vos clients professionnels',
    direct: 'SIREN clients pros',
  },
  'diag.itemSirenTodo': {
    pote: '{count} fiches à compléter',
    pro: '{count} fiches à compléter',
    direct: '{count} fiches.',
  },
  'diag.itemSirenTodoOne': {
    pote: '1 fiche à compléter',
    pro: '1 fiche à compléter',
    direct: '1 fiche.',
  },
  'diag.itemSirenDone': {
    pote: 'Toutes tes fiches sont complètes ✓',
    pro: 'Toutes les fiches sont complètes ✓',
    direct: 'OK ✓',
  },
  'diag.itemMentions': {
    pote: 'Mentions sur tes factures',
    pro: 'Mentions sur vos factures',
    direct: 'Mentions factures',
  },
  'diag.itemMentionsDone': { pote: 'Conformes ✓', pro: 'Conformes ✓', direct: 'OK ✓' },
  'diag.itemNumbering': {
    pote: 'Numérotation sans trou',
    pro: 'Numérotation séquentielle',
    direct: 'Numérotation',
  },
  'diag.itemNumberingDone': {
    pote: 'Garantie par l’app ✓',
    pro: 'Garantie par l’application ✓',
    direct: 'OK ✓',
  },
  'diag.itemVat': { pote: 'TVA par ligne', pro: 'TVA par ligne', direct: 'TVA par ligne' },
  'diag.itemVatDone': {
    pote: 'Calculée automatiquement ✓',
    pro: 'Calculée automatiquement ✓',
    direct: 'OK ✓',
  },
  'diag.itemDecennale': {
    pote: 'Assurance décennale (bâtiment)',
    pro: 'Assurance décennale (bâtiment)',
    direct: 'Décennale',
  },
  'diag.itemDecennaleDone': {
    pote: 'À jour ✓ — propre à ton métier',
    pro: 'À jour ✓ — spécifique à votre métier',
    direct: 'À jour ✓',
  },
  'diag.itemDecennaleTodo': {
    pote: 'À souscrire — obligatoire pour ton métier',
    pro: 'À souscrire — obligatoire pour votre métier',
    direct: 'À souscrire.',
  },
  'diag.itemAccountant': {
    pote: 'Ton comptable dans la boucle',
    pro: 'Votre comptable informé',
    direct: 'Comptable',
  },
  'diag.itemAccountantTodo': {
    pote: 'Préviens-le pour la bascule 2026',
    pro: 'À informer pour la bascule 2026',
    direct: 'À prévenir.',
  },
  'diag.itemAccountantDone': { pote: 'Il est au courant ✓', pro: 'Informé ✓', direct: 'OK ✓' },

  // ── C22 — flux « Onboarding adaptatif » (copy pote = exacte du proto §onb*) ──
  'onboard.back': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },
  'onboard.later': { pote: 'Plus tard', pro: 'Plus tard', direct: 'Plus tard' },
  'onboard.welcomeTitle': {
    pote: 'Ton bureau pro,\ndans ta poche.',
    pro: 'Votre bureau professionnel,\ndans votre poche.',
    direct: 'Ton bureau pro.\nDans ta poche.',
  },
  'onboard.welcomeBody': {
    pote: 'Devis, factures, paiements, tréso, docs et conformité 2026. Bob s’occupe de la paperasse — toi, tu bosses.',
    pro: 'Devis, factures, paiements, trésorerie, documents et conformité 2026. Bob s’occupe de l’administratif.',
    direct: 'Devis, factures, paiements, tréso, conformité 2026. Bob gère la paperasse.',
  },
  'onboard.welcomeCta': { pote: 'Commencer', pro: 'Commencer', direct: 'Commencer' },
  'onboard.stepTrade': { pote: 'Ton métier', pro: 'Votre métier', direct: 'Métier' },
  'onboard.stepClient': { pote: 'Ta clientèle', pro: 'Votre clientèle', direct: 'Clientèle' },
  'onboard.stepVat': { pote: 'Ta TVA', pro: 'Votre TVA', direct: 'TVA' },
  'onboard.stepPreview': { pote: 'Ton espace', pro: 'Votre espace', direct: 'Espace' },
  'onboard.tradeTitle': {
    pote: 'Tu fais quoi, au juste ?',
    pro: 'Quel est votre métier ?',
    direct: 'Ton métier ?',
  },
  'onboard.tradeSub': {
    pote: 'L’app va parler ton langage.',
    pro: 'L’application adoptera votre vocabulaire.',
    direct: 'L’app parlera ton langage.',
  },
  'onboard.tradeIncludes': {
    pote: 'Ton espace inclura',
    pro: 'Votre espace inclura',
    direct: 'Ton espace :',
  },
  'onboard.profileError': {
    pote: 'J’ai pas réussi à lire ton profil — choisis ton métier ci-dessous.',
    pro: 'Impossible de lire votre profil — sélectionnez votre métier ci-dessous.',
    direct: 'Profil illisible. Choisis ton métier.',
  },
  'onboard.continue': { pote: 'Continuer', pro: 'Continuer', direct: 'Continuer' },
  'onboard.clientTitle': {
    pote: 'Tu bosses surtout pour qui ?',
    pro: 'Pour qui travaillez-vous principalement ?',
    direct: 'Tes clients ?',
  },
  'onboard.clientSub': {
    pote: 'Ça décide de tes obligations de facturation élec.',
    pro: 'Cela détermine vos obligations de facturation électronique.',
    direct: 'Ça fixe tes obligations 2026.',
  },
  'onboard.clientB2c': { pote: 'Particuliers', pro: 'Particuliers', direct: 'Particuliers' },
  'onboard.clientB2cSub': {
    pote: 'Tes ventes remonteront en e-reporting.',
    pro: 'Ventes déclarées via e-reporting.',
    direct: 'e-reporting.',
  },
  'onboard.clientB2b': { pote: 'Entreprises', pro: 'Entreprises', direct: 'Entreprises' },
  'onboard.clientB2bSub': {
    pote: 'Factures élec. via plateforme dès 2026.',
    pro: 'Factures électroniques via plateforme dès 2026.',
    direct: 'e-invoicing 2026.',
  },
  'onboard.clientB2g': { pote: 'Le public', pro: 'Le secteur public', direct: 'Public' },
  'onboard.clientB2gSub': {
    pote: 'Chorus Pro — c’est déjà la règle.',
    pro: 'Chorus Pro, déjà en vigueur.',
    direct: 'Chorus Pro.',
  },
  'onboard.clientMixte': { pote: 'Un peu de tout', pro: 'Clientèle mixte', direct: 'Mixte' },
  'onboard.clientMixteSub': {
    pote: 'Je jongle entre les régimes pour toi.',
    pro: 'Les différents régimes sont gérés.',
    direct: 'Tous les régimes.',
  },
  'onboard.vatTitle': {
    pote: 'Et la TVA, t’es sur quel régime ?',
    pro: 'Quel est votre régime de TVA ?',
    direct: 'Ton régime TVA ?',
  },
  'onboard.vatSub': {
    pote: 'Je règle tes factures et tes déclarations dessus.',
    pro: 'Vos factures et déclarations s’y adapteront.',
    direct: 'Ça règle tes factures.',
  },
  'onboard.vatFranchise': {
    pote: 'Franchise en base',
    pro: 'Franchise en base',
    direct: 'Franchise en base',
  },
  'onboard.vatFranchiseSub': {
    pote: 'Art. 293 B — tu factures sans TVA, mention obligatoire.',
    pro: 'Art. 293 B du CGI — facturation sans TVA, mention obligatoire.',
    direct: '293 B — sans TVA, mention obligatoire.',
  },
  'onboard.vatReelSimpl': { pote: 'Réel simplifié', pro: 'Réel simplifié', direct: 'Réel simplifié' },
  'onboard.vatReelSimplSub': {
    pote: 'TVA déclarée une fois par an (CA12), avec des acomptes.',
    pro: 'Déclaration annuelle (CA12) avec acomptes semestriels.',
    direct: 'CA12 annuelle + acomptes.',
  },
  'onboard.vatReelNormal': { pote: 'Réel normal', pro: 'Réel normal', direct: 'Réel normal' },
  'onboard.vatReelNormalSub': {
    pote: 'TVA déclarée chaque mois ou trimestre (CA3).',
    pro: 'Déclaration mensuelle ou trimestrielle (CA3).',
    direct: 'CA3 mensuelle ou trimestrielle.',
  },
  'onboard.vatFranchiseNote': {
    pote: 'Tu ne factures pas la TVA, mais la facture élec. te concerne quand même : dès septembre 2026, tu devras recevoir les factures de tes fournisseurs en électronique.',
    pro: 'Vous ne facturez pas la TVA, mais la facturation électronique vous concerne quand même : dès septembre 2026, la réception des factures électroniques s’impose à tous les assujettis.',
    direct: 'Pas de TVA facturée, mais la facture élec. te concerne quand même : réception obligatoire dès septembre 2026.',
  },
  'onboard.vatReelNote': {
    pote: 'Je mets ta TVA de côté au fil des encaissements — zéro mauvaise surprise à la déclaration.',
    pro: 'La TVA est provisionnée au fil des encaissements — aucune surprise à la déclaration.',
    direct: 'TVA provisionnée au fil de l’eau.',
  },
  'onboard.previewTitle': {
    pote: 'Ton espace {trade} est prêt',
    pro: 'Votre espace {trade} est prêt',
    direct: 'Espace {trade} : prêt.',
  },
  'onboard.previewBody': {
    pote: 'Dernier truc : vérifions que t’es paré pour 2026.',
    pro: 'Dernière étape : vérifions votre préparation pour 2026.',
    direct: 'Dernier truc : le check 2026.',
  },
  'onboard.previewCta': { pote: 'C’est parti', pro: 'C’est parti', direct: 'C’est parti' },
  'onboard.hlDecennale': {
    pote: 'Ta décennale suivie et rappelée',
    pro: 'Assurance décennale suivie',
    direct: 'Décennale suivie',
  },
  'onboard.hlConsuel': {
    pote: 'Consuel et attestations à portée de main',
    pro: 'Consuel et attestations centralisés',
    direct: 'Consuel centralisé',
  },
  'onboard.hlRetenue': {
    pote: 'Retenue de garantie gérée sur tes factures',
    pro: 'Retenue de garantie gérée',
    direct: 'Retenue de garantie gérée',
  },
  'onboard.hlTvaTravaux': {
    pote: 'TVA travaux 10 % par défaut',
    pro: 'TVA travaux 10 % par défaut',
    direct: 'TVA travaux 10 %',
  },
  'onboard.hlCession': {
    pote: 'Cession de droits sur tes factures',
    pro: 'Cession de droits intégrée',
    direct: 'Cession de droits',
  },
  'onboard.hlCra': {
    pote: 'CRA et frais refacturés intégrés',
    pro: 'CRA et frais refacturés intégrés',
    direct: 'CRA + frais refacturés',
  },

  // ── C24 — Auth (login refondu, inscription SIRET→lookup, biométrie) ─────────
  // Copy pote = exacte du proto §auth quand elle existe (titres, champs, CTA).
  // Écart assumé : le footer proto « Chiffré de bout en bout · 2FA · conforme RGPD »
  // perd « 2FA » (non implémenté — on n'affiche pas une promesse fantôme).
  'auth.loginTitle': {
    pote: 'Bon retour 👋',
    pro: 'Bon retour.',
    direct: 'Reconnecte-toi.',
  },
  'auth.loginSub': {
    pote: 'Connecte-toi pour reprendre où tu en étais.',
    pro: 'Connectez-vous pour reprendre où vous en étiez.',
    direct: 'Reprends où t’en étais.',
  },
  'auth.emailLabel': {
    pote: 'Email professionnel',
    pro: 'Email professionnel',
    direct: 'Email pro',
  },
  'auth.emailPlaceholder': {
    pote: 'julien@mercier-plomberie.fr',
    pro: 'julien@mercier-plomberie.fr',
    direct: 'julien@mercier-plomberie.fr',
  },
  'auth.passwordLabel': {
    pote: 'Mot de passe',
    pro: 'Mot de passe',
    direct: 'Mot de passe',
  },
  'auth.loginCta': { pote: 'Se connecter', pro: 'Se connecter', direct: 'Se connecter' },
  'auth.forgot': {
    pote: 'Mot de passe oublié ?',
    pro: 'Mot de passe oublié ?',
    direct: 'Mdp oublié ?',
  },
  'auth.switchToSignup': {
    pote: 'Pas encore de compte ? Créer',
    pro: 'Pas encore de compte ? Créer',
    direct: 'Pas de compte ? Créer',
  },
  'auth.switchToLogin': {
    pote: 'Déjà un compte ? Se connecter',
    pro: 'Déjà un compte ? Se connecter',
    direct: 'Un compte ? Connexion',
  },
  'auth.footerSecure': {
    pote: 'Chiffré de bout en bout · conforme RGPD',
    pro: 'Chiffré de bout en bout · conforme RGPD',
    direct: 'Chiffré · RGPD',
  },
  'auth.resetSent': {
    pote: 'Si un compte existe pour {email}, le lien de réinitialisation est parti 📬',
    pro: 'Si un compte existe pour {email}, le lien de réinitialisation a été envoyé.',
    direct: '{email} : lien envoyé si le compte existe.',
  },
  'auth.resetNeedEmail': {
    pote: 'Mets ton email d’abord — je saurai où envoyer le lien.',
    pro: 'Renseignez votre email : le lien y sera envoyé.',
    direct: 'Email d’abord.',
  },
  'auth.errFields': {
    pote: 'Il me faut ton email et ton mot de passe.',
    pro: 'Email et mot de passe sont requis.',
    direct: 'Email + mdp requis.',
  },
  'auth.errCredentials': {
    pote: 'Email ou mot de passe pas bon — réessaie.',
    pro: 'Email ou mot de passe incorrect.',
    direct: 'Identifiants KO.',
  },
  'auth.errEmailNotConfirmed': {
    pote: 'Ton mail n’est pas encore confirmé — clique sur le lien que je t’ai envoyé.',
    pro: 'Votre email n’est pas confirmé : cliquez sur le lien reçu.',
    direct: 'Mail non confirmé. Va voir tes mails.',
  },
  'auth.errUserExists': {
    pote: 'Un compte existe déjà avec cet email — connecte-toi plutôt.',
    pro: 'Un compte existe déjà pour cet email. Connectez-vous.',
    direct: 'Compte déjà là. Connecte-toi.',
  },
  'auth.errWeakPassword': {
    pote: 'Trop court, ton mot de passe — vise 8 caractères minimum.',
    pro: 'Mot de passe trop faible : 8 caractères minimum.',
    direct: 'Mdp trop faible. 8 mini.',
  },
  'auth.errEmailInvalid': {
    pote: 'Cet email a l’air bancal — vérifie-le ?',
    pro: 'Le format de l’email est invalide.',
    direct: 'Email invalide.',
  },
  'auth.errRateLimited': {
    pote: 'Doucement — trop d’essais d’un coup. Réessaie dans une minute.',
    pro: 'Trop de tentatives. Veuillez patienter une minute.',
    direct: 'Trop d’essais. Attends 1 min.',
  },
  'auth.errNetwork': {
    pote: 'Pas de réseau, là. Réessaie dès que ça capte.',
    pro: 'Connexion impossible. Vérifiez votre réseau.',
    direct: 'Réseau KO. Réessaie.',
  },
  'auth.errUnknown': {
    pote: 'Ça a raté, et c’est pas toi. Réessaie ?',
    pro: 'Une erreur est survenue. Veuillez réessayer.',
    direct: 'Erreur. Réessaie.',
  },
  'auth.signupTitle': {
    pote: 'Crée ton compte',
    pro: 'Créez votre compte',
    direct: 'Ton compte.',
  },
  'auth.signupSub': {
    pote: 'Ton bureau pro, prêt en 2 minutes.',
    pro: 'Votre bureau professionnel, prêt en 2 minutes.',
    direct: 'Prêt en 2 minutes.',
  },
  'auth.stepSiret': { pote: 'Ton SIRET', pro: 'Votre SIRET', direct: 'SIRET' },
  'auth.stepCompany': { pote: 'Ton entreprise', pro: 'Votre entreprise', direct: 'Entreprise' },
  'auth.stepAccount': { pote: 'Ton compte', pro: 'Votre compte', direct: 'Compte' },
  'auth.siretTitle': {
    pote: 'C’est quoi, ton SIRET ?',
    pro: 'Quel est votre SIRET ?',
    direct: 'Ton SIRET ?',
  },
  'auth.siretSub': {
    pote: 'On récupère tes infos officielles — zéro paperasse à retaper.',
    pro: 'Vos informations officielles seront récupérées automatiquement.',
    direct: 'Je récupère tes infos officielles.',
  },
  'auth.siretPlaceholder': {
    pote: '123 456 789 00012',
    pro: '123 456 789 00012',
    direct: '123 456 789 00012',
  },
  'auth.siretCta': {
    pote: 'Récupérer mes infos',
    pro: 'Récupérer mes informations',
    direct: 'Chercher',
  },
  'auth.siretSkip': {
    pote: 'Continuer sans SIRET',
    pro: 'Continuer sans SIRET',
    direct: 'Sans SIRET',
  },
  'auth.errSiretInvalid': {
    pote: 'Ce SIRET a l’air bancal — 14 chiffres, vérifie-le ?',
    pro: 'SIRET invalide : 14 chiffres attendus.',
    direct: 'SIRET invalide. 14 chiffres.',
  },
  'auth.errSiretNotFound': {
    pote: 'Introuvable à l’annuaire — vérifie le numéro ?',
    pro: 'SIRET introuvable à l’annuaire des entreprises.',
    direct: 'Introuvable. Vérifie.',
  },
  'auth.errLookupDown': {
    pote: 'L’annuaire ne répond pas, là. Réessaie, ou passe l’étape.',
    pro: 'L’annuaire des entreprises ne répond pas. Réessayez ou passez l’étape.',
    direct: 'Annuaire KO. Réessaie ou passe.',
  },
  'auth.companyTitle': {
    pote: 'Voilà ce que j’ai trouvé',
    pro: 'Voici ce que nous avons trouvé',
    direct: 'Trouvé.',
  },
  'auth.companySub': {
    pote: 'Vérifie que c’est bien toi — tout vient de l’annuaire officiel.',
    pro: 'Vérifiez ces informations : elles proviennent de l’annuaire officiel.',
    direct: 'Vérifie. Source : annuaire officiel.',
  },
  'auth.companySiretLabel': { pote: 'SIRET', pro: 'SIRET', direct: 'SIRET' },
  'auth.companyNafLabel': {
    pote: 'Activité (NAF)',
    pro: 'Activité (code NAF)',
    direct: 'NAF',
  },
  'auth.companyAddressLabel': { pote: 'Adresse', pro: 'Adresse', direct: 'Adresse' },
  'auth.companyTvaLabel': {
    pote: 'TVA intracom',
    pro: 'TVA intracommunautaire',
    direct: 'TVA intracom',
  },
  'auth.companyRge': { pote: 'Certifié RGE ✓', pro: 'Certification RGE ✓', direct: 'RGE ✓' },
  'auth.companyConfirm': {
    pote: 'C’est bien moi',
    pro: 'C’est bien mon entreprise',
    direct: 'C’est moi',
  },
  'auth.companyEdit': {
    pote: 'Ce n’est pas moi — corriger le SIRET',
    pro: 'Ce n’est pas mon entreprise — corriger le SIRET',
    direct: 'Pas moi. Corriger.',
  },
  'auth.accountTitle': {
    pote: 'Dernière étape : ton compte',
    pro: 'Dernière étape : votre compte',
    direct: 'Ton compte.',
  },
  'auth.accountSub': {
    pote: 'Prénom, email, mot de passe — et c’est parti.',
    pro: 'Prénom, email et mot de passe suffisent.',
    direct: 'Prénom + email + mdp.',
  },
  'auth.firstNameLabel': { pote: 'Prénom', pro: 'Prénom', direct: 'Prénom' },
  'auth.firstNamePlaceholder': { pote: 'Julien', pro: 'Julien', direct: 'Julien' },
  'auth.passwordHint': {
    pote: '8 caractères minimum',
    pro: '8 caractères minimum',
    direct: '8 caractères mini',
  },
  'auth.errFirstName': {
    pote: 'Dis-moi ton prénom — c’est comme ça que je t’appellerai.',
    pro: 'Renseignez votre prénom.',
    direct: 'Prénom requis.',
  },
  'auth.signupCta': {
    pote: 'Créer mon compte',
    pro: 'Créer mon compte',
    direct: 'Créer',
  },
  'auth.verifyTitle': {
    pote: 'Vérifie tes mails 📬',
    pro: 'Vérifiez vos emails',
    direct: 'Va voir tes mails.',
  },
  'auth.verifyBody': {
    pote: 'Je t’ai envoyé un lien de confirmation à {email}. Clique dessus, puis reviens te connecter.',
    pro: 'Un lien de confirmation a été envoyé à {email}. Cliquez dessus, puis revenez vous connecter.',
    direct: 'Lien envoyé à {email}. Clique, puis reviens.',
  },
  'auth.verifyCta': {
    pote: 'Retour à la connexion',
    pro: 'Retour à la connexion',
    direct: 'Connexion',
  },
  'auth.bioTitle': {
    pote: 'Déverrouille avec {method}',
    pro: 'Déverrouillage par {method}',
    direct: '{method} ?',
  },
  'auth.bioBody': {
    pote: 'Ta session reste chiffrée sur l’appareil — tu rentres d’un regard, sans mot de passe.',
    pro: 'Votre session reste chiffrée sur l’appareil : l’accès se fait sans mot de passe.',
    direct: 'Session chiffrée. Accès sans mdp.',
  },
  'auth.bioAccept': {
    pote: 'Activer {method}',
    pro: 'Activer {method}',
    direct: 'Activer',
  },
  'auth.bioLater': { pote: 'Plus tard', pro: 'Plus tard', direct: 'Plus tard' },
  'auth.bioEnabled': {
    pote: '{method} activé ✓',
    pro: '{method} activé.',
    direct: '{method} : ON.',
  },
  'auth.bioPrompt': {
    pote: 'Déverrouille Bob Pro',
    pro: 'Déverrouillez Bob Pro',
    direct: 'Déverrouille Bob Pro',
  },
  'auth.bioFailed': {
    pote: 'Pas reconnu — réessaie ?',
    pro: 'Authentification non reconnue. Réessayez.',
    direct: 'Raté. Réessaie.',
  },
  'auth.lockTitle': {
    pote: 'Bob Pro est verrouillé',
    pro: 'Bob Pro est verrouillé',
    direct: 'Verrouillé.',
  },
  'auth.lockBody': {
    pote: 'Ta session est bien au chaud — déverrouille avec {method}.',
    pro: 'Votre session est protégée : déverrouillez avec {method}.',
    direct: '{method} pour entrer.',
  },
  'auth.lockCta': {
    pote: 'Déverrouiller',
    pro: 'Déverrouiller',
    direct: 'Déverrouiller',
  },
  'auth.lockFallback': {
    pote: 'Utiliser mon mot de passe',
    pro: 'Utiliser mon mot de passe',
    direct: 'Mot de passe',
  },

  // ── C25 — écran Notifications (cloche C10) ─────────────────────────────────
  'notif.back': { pote: 'Fermer', pro: 'Fermer', direct: 'Fermer' },
  'notif.eyebrow': { pote: 'Quoi de neuf', pro: 'Votre activité', direct: 'Notifs' },
  'notif.title': { pote: 'Notifications', pro: 'Notifications', direct: 'Notifications' },
  'notif.subtitle': {
    pote: 'Je te préviens quand ça compte — pas pour rien.',
    pro: 'L’essentiel de votre activité, au bon moment.',
    direct: 'L’essentiel. Rien d’autre.',
  },
  'notif.sectionDue': {
    pote: 'À relancer maintenant',
    pro: 'Relances à traiter',
    direct: 'À relancer',
  },
  'notif.sectionUpcoming': {
    pote: 'Échéances proches',
    pro: 'Échéances à venir',
    direct: 'Échéances',
  },
  'notif.sectionScheduled': {
    pote: 'Prochaines relances',
    pro: 'Prochaines relances',
    direct: 'Prochaines relances',
  },
  'notif.itemRelanceTitle': {
    pote: 'Relance {name}',
    pro: 'Relance à envoyer à {name}',
    direct: '{name} — relance',
  },
  'notif.itemRelanceSub': {
    pote: '{doc} · {amount} · {days} j de retard',
    pro: '{doc} · {amount} · {days} jours de retard',
    direct: '{doc} · {amount} · {days} j',
  },
  'notif.itemRelanceSubOne': {
    pote: '{doc} · {amount} · 1 j de retard',
    pro: '{doc} · {amount} · 1 jour de retard',
    direct: '{doc} · {amount} · 1 j',
  },
  'notif.actionView': { pote: 'Voir la pièce', pro: 'Voir la facture', direct: 'Voir' },
  'notif.actionRelance': { pote: 'Relancer', pro: 'Relancer', direct: 'Relancer' },
  'notif.itemDueTitle': {
    pote: 'Échéance {name}',
    pro: 'Échéance de {name}',
    direct: '{name} — échéance',
  },
  'notif.itemDueSub': {
    pote: '{doc} · {amount} · échéance dans {days} j',
    pro: '{doc} · {amount} · échéance dans {days} jours',
    direct: '{doc} · {amount} · J-{days}',
  },
  'notif.itemDueToday': {
    pote: '{doc} · {amount} · échéance aujourd’hui',
    pro: '{doc} · {amount} · échéance ce jour',
    direct: '{doc} · {amount} · aujourd’hui',
  },
  'notif.conformiteTitle': { pote: 'Conformité 2026', pro: 'Conformité 2026', direct: 'Conformité 2026' },
  'notif.conformiteSub': {
    pote: 'Réception des e-factures à configurer avant le 1ᵉʳ sept. 2026.',
    pro: 'La réception des factures électroniques est à configurer avant le 1ᵉʳ septembre 2026.',
    direct: 'Réception e-factures : avant sept. 2026.',
  },
  'notif.empty': {
    pote: 'Rien à signaler — tout roule.',
    pro: 'Rien à signaler — tout est en ordre.',
    direct: 'RAS.',
  },
  'notif.dataError': {
    pote: 'J’arrive pas à charger tes notifs. On réessaie ?',
    pro: 'Impossible de charger les notifications. Veuillez réessayer.',
    direct: 'Chargement KO. Réessaie.',
  },
  'notif.retry': { pote: 'Réessayer', pro: 'Réessayer', direct: 'Réessayer' },

  // ── C25 v2 — fil serveur (GET /notifications) + envoi réel ─────────────────
  'notif.sectionFeed': {
    pote: 'Activité',
    pro: 'Activité récente',
    direct: 'Activité',
  },
  'notif.feedDone': { pote: 'Envoyée', pro: 'Envoyée', direct: 'Envoyée' },
  'notif.feedPending': {
    pote: 'En cours d’envoi…',
    pro: 'Envoi en cours…',
    direct: 'En cours…',
  },
  'notif.feedFailed': {
    pote: 'Échec d’envoi — je réessaie tout seul',
    pro: 'Échec d’envoi — nouvelle tentative planifiée',
    direct: 'Échec. Je retente.',
  },

  // ── C25 — relances automatiques (plan @bob/core, tons buildRelance) ────────
  'relance.autoTitle': {
    pote: 'Relances automatiques',
    pro: 'Relances automatiques',
    direct: 'Relances auto',
  },
  'relance.autoSub': {
    pote: 'Bob relance les retards tout seul, au bon moment.',
    pro: 'Les retards sont relancés automatiquement, au bon moment.',
    direct: 'Relances auto. Au bon moment.',
  },
  'relance.queue': {
    pote: 'Actives · {count} clients en file',
    pro: 'Actives · {count} clients en file d’attente',
    direct: 'Actives · {count} en file',
  },
  'relance.queueOne': {
    pote: 'Actives · 1 client en file',
    pro: 'Actives · 1 client en file d’attente',
    direct: 'Actives · 1 en file',
  },
  'relance.medWarning': {
    pote: 'La mise en demeure (L441-10 + indemnité 40 €) n’est jamais envoyée sans ta validation.',
    pro: 'La mise en demeure (art. L441-10 + indemnité de 40 €) n’est jamais envoyée sans votre validation.',
    direct: 'Mise en demeure (L441-10 + 40 €) : jamais sans ta validation.',
  },
  'relance.toneCordial': { pote: 'Cordial', pro: 'Cordial', direct: 'Cordial' },
  'relance.toneNeutre': { pote: 'Neutre', pro: 'Neutre', direct: 'Neutre' },
  'relance.toneFerme': { pote: 'Ferme', pro: 'Ferme', direct: 'Ferme' },
  'relance.toneMed': {
    pote: 'Mise en demeure',
    pro: 'Mise en demeure',
    direct: 'Mise en demeure',
  },
  'relance.scheduledLine': {
    pote: '{tone} · le {date}',
    pro: '{tone} · prévue le {date}',
    direct: '{tone} · {date}',
  },
  'relance.confirmTitle': {
    pote: 'On envoie la relance ?',
    pro: 'Confirmer l’envoi de la relance',
    direct: 'Envoyer la relance ?',
  },
  'relance.confirmBody': {
    pote: 'J’envoie la relance de {amount} à {name}, au ton du plan. Tu valides ?',
    pro: 'La relance de {amount} sera envoyée à {name}, au ton prévu par le plan.',
    direct: '{name} · {amount}. J’envoie ?',
  },
  'relance.confirmMedNote': {
    pote: 'Ton mise en demeure (L441-10 + indemnité 40 €) — c’est du sérieux.',
    pro: 'Mise en demeure (art. L441-10, indemnité forfaitaire de 40 €).',
    direct: 'Mise en demeure L441-10 + 40 €.',
  },
  'relance.sentToast': {
    pote: 'Relance envoyée à {name} ✓',
    pro: 'Relance envoyée à {name}.',
    direct: '{name} : relancé.',
  },
  'relance.sendError': {
    pote: 'L’envoi a raté — réessaie dans un instant.',
    pro: 'L’envoi de la relance a échoué. Veuillez réessayer.',
    direct: 'Envoi KO. Réessaie.',
  },

  // ── A2-C10 — encaisser depuis le briefing ───────────────────────────────────
  'today.ctaCollect': { pote: 'Encaisser', pro: 'Encaisser', direct: 'Encaisser' },
  'today.collectDone': {
    pote: '{amount} au chaud — joli.',
    pro: 'Paiement de {amount} enregistré.',
    direct: '{amount} encaissé.',
  },

  // ── C17 — écran « Comptabilité » (grand-livre) ──────────────────────────────
  'compta.back': { pote: 'Documents', pro: 'Documents', direct: 'Documents' },
  'compta.eyebrow': { pote: 'Ta compta', pro: 'Votre comptabilité', direct: 'Compta' },
  'compta.title': { pote: 'Comptabilité', pro: 'Comptabilité', direct: 'Comptabilité' },
  'compta.subtitle': {
    pote: 'Chaque pièce passe son écriture toute seule — vérifiable, exportable.',
    pro: 'Journal des écritures en partie double — vérifiable, exportable.',
    direct: 'Le journal. Vérifiable.',
  },
  'compta.paywallTitle': {
    pote: 'Comptabilité incluse dès l’offre Solo',
    pro: 'Comptabilité incluse à partir de l’offre Solo',
    direct: 'Dès l’offre Solo',
  },
  'compta.paywallBody': {
    pote: 'Le grand livre (écritures en partie double, export cabinet) fait partie des offres avec comptabilité.',
    pro: 'Le grand livre (partie double, export cabinet) est disponible dans les offres avec comptabilité.',
    direct: 'Grand livre + export FEC : offres avec compta.',
  },
  'compta.paywallCta': { pote: 'Voir les offres', pro: 'Voir les offres', direct: 'Offres' },
  'compta.summaryTitle': {
    pote: 'Prêt pour le comptable',
    pro: 'Prêt pour votre comptable',
    direct: 'Prêt comptable',
  },
  'compta.entriesMonth': {
    pote: '{count} écritures ce mois-ci · passées toutes seules',
    pro: '{count} écritures sur le mois en cours · générées automatiquement',
    direct: '{count} écritures ce mois · auto',
  },
  'compta.entriesMonthOne': {
    pote: '1 écriture ce mois-ci · passée toute seule',
    pro: '1 écriture sur le mois en cours · générée automatiquement',
    direct: '1 écriture ce mois · auto',
  },
  'compta.balanced': { pote: 'Équilibré ✓', pro: 'Équilibré', direct: 'Équilibré' },
  'compta.unbalanced': { pote: 'Déséquilibré !', pro: 'Déséquilibre détecté', direct: 'Déséquilibré' },
  'compta.totalsLine': {
    pote: 'Débit {debit} · Crédit {credit}',
    pro: 'Débit {debit} · Crédit {credit}',
    direct: 'D {debit} · C {credit}',
  },
  'compta.entriesCount': { pote: '{count} écritures', pro: '{count} écritures', direct: '{count}' },
  'compta.entriesCountOne': { pote: '1 écriture', pro: '1 écriture', direct: '1' },
  'compta.sectionJournal': { pote: 'Le journal', pro: 'Le journal', direct: 'Journal' },
  'compta.debitLabel': { pote: 'Débit', pro: 'Débit', direct: 'Débit' },
  'compta.creditLabel': { pote: 'Crédit', pro: 'Crédit', direct: 'Crédit' },
  'compta.closeSub': {
    pote: 'Verrouille les écritures et fige le mois — plus rien ne bouge.',
    pro: 'Verrouille les écritures du mois : plus aucune modification possible.',
    direct: 'Fige le mois.',
  },
  'compta.footer': {
    pote: 'Chaque écriture est passée toute seule — vérifiable ligne à ligne.',
    pro: 'Chaque écriture est générée automatiquement — vérifiable ligne à ligne.',
    direct: 'Automatique. Vérifiable.',
  },
  'compta.chipAll': { pote: 'Tous', pro: 'Tous', direct: 'Tous' },
  'compta.journalSales': { pote: 'Ventes', pro: 'Ventes', direct: 'VE' },
  'compta.journalPurchases': { pote: 'Achats', pro: 'Achats', direct: 'AC' },
  'compta.journalBank': { pote: 'Banque', pro: 'Banque', direct: 'BQ' },
  'compta.journalMisc': { pote: 'OD', pro: 'Opérations diverses', direct: 'OD' },
  'compta.empty': {
    pote: 'Aucune écriture pour l’instant. Émets une facture — je passe l’écriture tout seul.',
    pro: 'Aucune écriture pour le moment. Émettez une facture : l’écriture est passée automatiquement.',
    direct: 'Vide. Émets une facture.',
  },
  'compta.dataError': {
    pote: 'Je n’arrive pas à ouvrir le journal, là. On réessaie ?',
    pro: 'Impossible de charger le journal. Veuillez réessayer.',
    direct: 'Journal injoignable. Réessaie.',
  },
  'compta.retry': { pote: 'Réessayer', pro: 'Réessayer', direct: 'Réessayer' },
  'compta.closeCta': {
    pote: 'Clôturer le mois',
    pro: 'Clôturer le mois',
    direct: 'Clôture',
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
