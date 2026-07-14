/**
 * @bob/i18n — la copy de Bob, indexée par personnalité (VOICE_AND_TONE.md).
 * Toute chaîne visible dans l'app vient d'ici : une clé = une entrée par humeur
 * (Pote par défaut, Pro, Direct). Les claims d'écran ajoutent leurs clés (C10+).
 */

import { cabinetFr } from './catalogs/cabinet';
import { monetizationFr } from './catalogs/monetization';

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

const legacyFr = {
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
  // Langage prudent (SPEC_EXPERT_FISCAL §V2 pt. 8) : trésorerie mobilisable ≠ rémunération —
  // celle-ci dépend du statut/régime, pas encore connu du produit. Jamais « te verser » ici.
  'today.payoutHint': {
    pote: '~{amount} de trésorerie mobilisable, réserves gardées. Ta rémunération : à préciser avec ton statut.',
    pro: 'Trésorerie mobilisable : {amount}, réserves provisionnées. Rémunération à préciser selon votre statut.',
    direct: '~{amount} mobilisables. Rémunération à préciser.',
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
  // Langage prudent (SPEC_EXPERT_FISCAL §V2 pt. 8, cas « profil incomplet ») : trésorerie
  // mobilisable ≠ rémunération — jamais « te verser » tant que forme juridique/régime fiscal
  // ne sont pas connus du produit. Le pill « sans risque » reste vrai (réserves non touchées).
  'argent.heroLabel': {
    pote: 'Trésorerie mobilisable ce mois-ci',
    pro: 'Trésorerie mobilisable ce mois-ci',
    direct: 'Mobilisable ce mois-ci',
  },
  'argent.heroPill': {
    pote: 'sans risque',
    pro: 'sans risque',
    direct: 'sans risque',
  },
  // Phrase conditionnelle du héros : le « monter à » vient du scénario optimiste réel — parle
  // du plafond de trésorerie mobilisable, pas d'une rémunération (cf. heroLabel ci-dessus).
  'argent.heroUpside': {
    pote: 'Tu peux monter à {upTo} si {name} règle ses {amount}. Je te préviens dès qu’il paie.',
    pro: 'Vous pouvez atteindre {upTo} si {name} règle ses {amount}. Nous vous préviendrons dès réception.',
    direct: 'Jusqu’à {upTo} si {name} paie ses {amount}.',
  },
  'argent.heroCaption': {
    pote: 'TVA et charges déjà mises de côté. Ta rémunération exacte dépend de ton statut — on te la précise bientôt.',
    pro: 'TVA et charges provisionnées. Votre rémunération exacte dépend de votre statut — nous vous la préciserons bientôt.',
    direct: 'TVA et charges de côté. Rémunération : à préciser (statut).',
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
  // E5 — balance âgée clients (pilotage du poste clients, tranches de retard).
  'argent.agedTitle': {
    pote: 'Qui te doit quoi',
    pro: 'Balance âgée clients',
    direct: 'Balance âgée',
  },
  'argent.agedOverdue': {
    pote: 'dont {amount} déjà en retard',
    pro: 'dont {amount} échus',
    direct: 'échu : {amount}',
  },
  'argent.agedNotDue': { pote: 'Pas encore échu', pro: 'Non échu', direct: 'Non échu' },
  'argent.aged1_30': { pote: 'Retard 1-30 j', pro: 'Échu 1-30 jours', direct: '1-30 j' },
  'argent.aged31_60': { pote: 'Retard 31-60 j', pro: 'Échu 31-60 jours', direct: '31-60 j' },
  'argent.aged61_90': { pote: 'Retard 61-90 j', pro: 'Échu 61-90 jours', direct: '61-90 j' },
  'argent.aged90': {
    pote: 'Plus de 90 j — on sécurise ?',
    pro: 'Échu +90 jours — risque d’irrécouvrabilité',
    direct: '+90 j — risque',
  },
  'argent.agedUnknown': { pote: 'Sans échéance', pro: 'Sans échéance', direct: 'Sans échéance' },
  'argent.agedDays': { pote: '{days} j', pro: '{days} j', direct: '{days} j' },
  'argent.agedEmpty': {
    pote: 'Personne ne te doit rien — carnet propre.',
    pro: 'Aucun encours client — poste clients à jour.',
    direct: 'Aucun encours.',
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
    direct:
      'Le solde ment. Ici : le vrai reste après charges et TVA. Scénarios + horizon 7 → 90 j.',
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

  // ── Chantiers — états honnêtes, création assistée et suivi terrain ───────────
  'chantiers.back': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },
  'chantiers.eyebrow': { pote: 'SUIVI TERRAIN', pro: 'SUIVI TERRAIN', direct: 'TERRAIN' },
  'chantiers.title': { pote: 'Chantiers', pro: 'Chantiers', direct: 'Chantiers' },
  'chantiers.subtitle': {
    pote: 'Tes interventions, leurs pièces et leur avancement au même endroit.',
    pro: 'Suivi des interventions, des pièces associées et de leur avancement.',
    direct: 'Interventions, pièces, avancement.',
  },
  'chantiers.add': {
    pote: 'Nouveau chantier',
    pro: 'Créer un chantier',
    direct: 'Nouveau chantier',
  },
  'chantiers.created': {
    pote: '{name} est prêt — tu peux y rattacher tes prochaines pièces.',
    pro: 'Le chantier {name} a été créé.',
    direct: '{name} créé.',
  },
  'chantiers.createError': {
    pote: 'Je n’ai pas pu créer ce chantier. Rien n’a été perdu, réessaie.',
    pro: 'La création du chantier a échoué. Aucune donnée n’a été perdue.',
    direct: 'Création impossible. Réessaie.',
  },
  'chantiers.profileError': {
    pote: 'Je n’arrive pas à vérifier si le module Chantiers est actif. Réessaie.',
    pro: 'Impossible de vérifier l’activation du module Chantiers. Veuillez réessayer.',
    direct: 'Activation non vérifiée. Réessaie.',
  },
  'chantiers.moduleTitle': {
    pote: 'Module Chantiers',
    pro: 'Module Chantiers',
    direct: 'Module Chantiers',
  },
  'chantiers.moduleBody': {
    pote: 'Active-le pour regrouper devis, factures et situations par intervention.',
    pro: 'Activez ce module pour regrouper devis, factures et situations par chantier.',
    direct: 'Regroupe devis, factures et situations.',
  },
  'chantiers.seePlans': {
    pote: 'Voir les offres',
    pro: 'Voir les offres',
    direct: 'Voir les offres',
  },
  'chantiers.dataError': {
    pote: 'Je n’arrive pas à charger tes chantiers. Réessaie, je garde le contexte.',
    pro: 'Impossible de charger les chantiers. Veuillez réessayer.',
    direct: 'Chargement impossible. Réessaie.',
  },
  'chantiers.emptyTitle': {
    pote: 'Aucun chantier pour l’instant',
    pro: 'Aucun chantier pour le moment',
    direct: 'Aucun chantier',
  },
  'chantiers.emptyBody': {
    pote: 'Crée le premier : Bob pourra ensuite y ranger les devis, factures et documents liés.',
    pro: 'Créez un premier chantier afin d’y associer les devis, factures et documents concernés.',
    direct: 'Crée un chantier pour y rattacher tes pièces.',
  },
  'chantiers.listTitle': { pote: 'Tes chantiers', pro: 'Vos chantiers', direct: 'Chantiers' },
  'chantiers.openedOn': {
    pote: 'Ouvert le {date}',
    pro: 'Ouvert le {date}',
    direct: 'Ouvert · {date}',
  },
  'chantiers.open': { pote: 'En cours', pro: 'En cours', direct: 'En cours' },
  'chantiers.closed': { pote: 'Terminé', pro: 'Terminé', direct: 'Terminé' },
  'chantiers.createTitle': {
    pote: 'Nouveau chantier',
    pro: 'Créer un chantier',
    direct: 'Nouveau chantier',
  },
  'chantiers.createHint': {
    pote: 'Donne-lui un nom clair. L’adresse est optionnelle et je peux t’aider à la retrouver.',
    pro: 'Renseignez un nom explicite. L’adresse est facultative et peut être recherchée automatiquement.',
    direct: 'Nom requis. Adresse facultative.',
  },
  'chantiers.nameLabel': { pote: 'Nom du chantier', pro: 'Nom du chantier', direct: 'Nom' },
  'chantiers.namePlaceholder': {
    pote: 'Villa Durand, rénovation cuisine…',
    pro: 'Ex. Villa Durand',
    direct: 'Ex. Villa Durand',
  },
  'chantiers.addressLabel': { pote: 'Adresse', pro: 'Adresse', direct: 'Adresse' },
  'chantiers.addressPlaceholder': {
    pote: 'Commence à taper une adresse',
    pro: 'Adresse du chantier (facultatif)',
    direct: 'Adresse facultative',
  },
  'chantiers.addressError': {
    pote: 'La recherche d’adresse ne répond pas. Tu peux garder ta saisie ou réessayer.',
    pro: 'La recherche d’adresse est indisponible. Conservez la saisie ou réessayez.',
    direct: 'Recherche indisponible. Saisie conservée.',
  },
  'chantiers.addressNoResult': {
    pote: 'Je n’ai pas trouvé de correspondance. Tu peux conserver cette adresse telle quelle.',
    pro: 'Aucune correspondance trouvée. La saisie peut être conservée telle quelle.',
    direct: 'Aucun résultat. Saisie conservée.',
  },
  'chantiers.retry': { pote: 'Réessayer', pro: 'Réessayer', direct: 'Réessayer' },
  'chantiers.createSubmit': {
    pote: 'Créer le chantier',
    pro: 'Créer le chantier',
    direct: 'Créer',
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
  'fiche.infoDelay': {
    pote: 'Délai moyen constaté',
    pro: 'Délai moyen constaté',
    direct: 'Délai moyen',
  },
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
  // A8 — choisir la cible du classement (la proposition IA reste le 1-tap par défaut)
  'docs.pickOther': {
    pote: 'Choisir un autre dossier…',
    pro: 'Choisir une autre destination…',
    direct: 'Autre dossier…',
  },
  'docs.pickTitle': {
    pote: 'Où je le range ?',
    pro: 'Où classer ce document ?',
    direct: 'Classer où ?',
  },
  'docs.pickProposalMeta': {
    pote: 'Ma proposition — dépense rapprochée',
    pro: 'Proposition de Bob — dépense rapprochée',
    direct: 'Proposition IA',
  },
  'docs.pickChantierMeta': {
    pote: 'Chantier en cours',
    pro: 'Chantier en cours',
    direct: 'Chantier',
  },
  'docs.classifiedIntoToast': {
    pote: 'Classé dans « {name} » ✓',
    pro: 'Document classé dans « {name} ».',
    direct: '→ {name}.',
  },
  'docs.pickEmpty': {
    pote: 'Pas d’autre destination pour l’instant — crée un chantier et je saurai y ranger tes documents.',
    pro: 'Aucune autre destination disponible. Créez un chantier pour y classer des documents.',
    direct: 'Aucune autre destination.',
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
  'docs.folderCreateCta': {
    pote: 'Nouveau',
    pro: 'Nouveau',
    direct: 'Créer',
  },
  'docs.folderCreateTitle': {
    pote: 'Nouveau dossier',
    pro: 'Créer un dossier',
    direct: 'Nouveau dossier',
  },
  'docs.folderCreateBody': {
    pote: 'Crée un rangement à la racine du coffre. Tu pourras ensuite y ajouter des sous-dossiers.',
    pro: 'Créez un dossier à la racine du coffre. Il pourra ensuite contenir des sous-dossiers.',
    direct: 'Dossier racine, sous-dossiers possibles.',
  },
  'docs.folderCreateName': {
    pote: 'Nom du dossier',
    pro: 'Nom du dossier',
    direct: 'Nom',
  },
  'docs.folderCreateHint': {
    pote: '80 caractères maximum. Les barres obliques sont interdites.',
    pro: '80 caractères maximum. Les barres obliques sont interdites.',
    direct: '80 caractères maximum, sans barre oblique.',
  },
  'docs.folderCreatePlaceholder': {
    pote: 'Ex. Contrats clients',
    pro: 'Ex. Contrats clients',
    direct: 'Contrats clients',
  },
  'docs.folderCreateCancel': {
    pote: 'Annuler',
    pro: 'Annuler',
    direct: 'Annuler',
  },
  'docs.folderCreateSubmit': {
    pote: 'Créer',
    pro: 'Créer',
    direct: 'Créer',
  },
  'docs.folderCreateInvalid': {
    pote: 'Choisis un nom de 1 à 80 caractères, sans barre oblique.',
    pro: 'Saisissez un nom de 1 à 80 caractères, sans barre oblique.',
    direct: 'Nom invalide.',
  },
  'docs.folderCreateError': {
    pote: 'Je n’ai pas pu créer ce dossier. Vérifie le nom ou réessaie.',
    pro: 'Création impossible. Vérifiez le nom du dossier ou réessayez.',
    direct: 'Création impossible.',
  },
  'docs.folderCreateSuccess': {
    pote: 'Dossier « {name} » créé ✓',
    pro: 'Dossier « {name} » créé.',
    direct: '« {name} » créé.',
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
  'assistant.cmdInvoiceQuote': {
    pote: 'Fais la facture du devis',
    pro: 'Générer la facture du devis',
    direct: 'Facture le devis.',
  },
  'assistant.cmdCollectOpen': {
    pote: 'J’ai encaissé une facture',
    pro: 'J’ai encaissé une facture',
    direct: 'Facture encaissée.',
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
  'assistant.proposalLoading': {
    pote: 'Je vérifie les vrais chiffres avant de te laisser valider.',
    pro: 'Vérification des données de la pièce avant validation.',
    direct: 'Vérification des chiffres.',
  },
  'assistant.proposalUnavailable': {
    pote: 'Je n’arrive pas à vérifier les chiffres. Je bloque la validation pour éviter une erreur.',
    pro: 'Les données de contrôle sont indisponibles. La validation reste bloquée par sécurité.',
    direct: 'Contrôle indisponible. Validation bloquée.',
  },
  'assistant.proposalMissing': {
    pote: 'Je ne retrouve plus cette pièce. Actualise avant de décider.',
    pro: 'La pièce concernée est introuvable. Veuillez actualiser avant de valider.',
    direct: 'Pièce introuvable. Actualise.',
  },
  'assistant.retry': {
    pote: 'Réessayer',
    pro: 'Réessayer',
    direct: 'Réessayer',
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
  // LIVE — le mode vocal mains-libres (« parler à un pote expert-comptable »)
  'live.on': {
    pote: 'Mode vocal activé — je t’écoute.',
    pro: 'Mode vocal activé. Je vous écoute.',
    direct: 'Vocal on.',
  },
  'live.listening': { pote: 'Je t’écoute…', pro: 'Je vous écoute…', direct: 'J’écoute…' },
  'live.thinking': { pote: 'Je réfléchis…', pro: 'Je traite votre demande…', direct: 'Je traite…' },
  'live.speaking': {
    pote: 'Je te réponds — parle ou touche pour m’interrompre',
    pro: 'Réponse en cours — parlez ou touchez pour interrompre',
    direct: 'Je parle — coupe-moi si besoin',
  },
  'live.idle': {
    pote: 'Touche l’onde pour me parler',
    pro: 'Touchez l’onde pour parler',
    direct: 'Touche pour parler',
  },
  'live.tapWhenDone': {
    pote: 'Parle, puis touche quand tu as fini',
    pro: 'Parlez, puis touchez une fois terminé',
    direct: 'Parle, touche à la fin',
  },
  'live.error': {
    pote: 'Oups, j’ai buté — redis-moi ça ?',
    pro: 'Une erreur est survenue. Pouvez-vous reformuler ?',
    direct: 'Raté. Répète ?',
  },
  'live.unclearChoice': {
    pote: 'J’ai pas bien saisi lequel — dis le numéro ou le nom ?',
    pro: 'Je n’ai pas identifié votre choix — le numéro ou le nom ?',
    direct: 'Pas compris. Numéro ou nom ?',
  },
  // AUCUN token de consentement NI d'annulation dans ces textes : leur écho TTS ne doit
  // jamais pouvoir annuler (ni a fortiori confirmer) la proposition — au pire « unclear ».
  'live.unclearConsent': {
    pote: 'J’ai pas bien compris. Je le fais, ou je laisse ? Tu peux aussi trancher à l’écran.',
    pro: 'Je n’ai pas bien compris. Dois-je exécuter cette action, ou la laisser de côté ? Vous pouvez aussi décider à l’écran.',
    direct: 'Pas compris. Je le fais, ou pas ? L’écran marche aussi.',
  },
  'live.useScreen': {
    pote: 'Pas de souci — choisis à l’écran, je reste à l’écoute.',
    pro: 'Vous pouvez choisir à l’écran ; je reste à l’écoute.',
    direct: 'Choisis à l’écran. J’écoute.',
  },
  // AUDIT-VOCAL S1 — accès Bob global, même session et même contexte sur toutes les routes.
  'agent.global.idle': {
    pote: 'Parler à Bob',
    pro: 'Parler à Bob',
    direct: 'Bob',
  },
  'agent.global.listening': {
    pote: 'Je t’écoute…',
    pro: 'Je vous écoute…',
    direct: 'J’écoute…',
  },
  'agent.global.thinking': {
    pote: 'Je regarde ça…',
    pro: 'J’analyse votre demande…',
    direct: 'Analyse…',
  },
  'agent.global.speaking': {
    pote: 'Je te réponds…',
    pro: 'Réponse de Bob…',
    direct: 'Je réponds…',
  },
  'agent.global.error': {
    pote: 'Je n’ai pas réussi. Rien n’a été modifié.',
    pro: 'La demande a échoué. Aucune donnée n’a été modifiée.',
    direct: 'Échec. Rien modifié.',
  },
  'agent.global.unavailable': {
    pote: 'Le micro n’est pas disponible ici. Tu peux écrire à Bob.',
    pro: 'Le micro n’est pas disponible. Vous pouvez écrire votre demande.',
    direct: 'Micro indisponible. Écris.',
  },
  'agent.global.entitlementError': {
    pote: 'Je n’arrive pas à vérifier l’accès à Bob. Touche pour réessayer.',
    pro: 'Impossible de vérifier l’accès à Bob. Touchez pour réessayer.',
    direct: 'Accès Bob non vérifié. Réessaie.',
  },
  'agent.global.entitlementRetry': {
    pote: 'Relancer la vérification sans quitter cet écran.',
    pro: 'Relancer la vérification sans quitter cet écran.',
    direct: 'Relancer la vérification.',
  },
  'agent.global.context': {
    pote: 'Je vois : {context}',
    pro: 'Contexte actif : {context}',
    direct: 'Sur {context}',
  },
  'agent.global.reviewRequired': {
    pote: 'Cette action se termine dans l’Assistant — rien n’a été fait pour l’instant.',
    pro: 'Cette action se finalise dans l’Assistant ; rien n’a été exécuté.',
    direct: 'À finaliser dans l’Assistant. Rien de fait.',
  },
  'agent.global.continueInAssistant': {
    pote: 'Continuer dans l’Assistant',
    pro: 'Continuer dans l’Assistant',
    direct: 'Ouvrir l’Assistant',
  },
  'agent.global.issueDenied': {
    pote: 'Bob n’a pas l’autorisation micro — active-la dans les réglages du téléphone.',
    pro: 'L’autorisation micro est refusée. Activez-la dans les réglages du téléphone.',
    direct: 'Micro refusé. Réglages téléphone → autoriser.',
  },
  'agent.global.issueUnavailable': {
    pote: 'Le micro n’est pas dispo (absent ou déjà occupé par un autre flux Bob).',
    pro: 'Le micro n’est pas disponible : absent de cet appareil ou déjà utilisé.',
    direct: 'Micro indispo (absent ou occupé).',
  },
  'agent.global.issueFailed': {
    pote: 'La dictée a raté — réessaie.',
    pro: 'La dictée a échoué. Veuillez réessayer.',
    direct: 'Dictée ratée. Réessaie.',
  },
  'agent.global.liveFallback': {
    pote: 'Le temps réel décroche — on continue en mode classique, rien n’est perdu.',
    pro: 'Le mode temps réel est indisponible ; poursuite en mode classique.',
    direct: 'Temps réel KO. Mode classique.',
  },
  'agent.global.heardNothing': {
    pote: 'Je n’ai rien entendu — touche le bouton pour reprendre.',
    pro: 'Je n’ai rien entendu. Touchez le bouton pour reprendre.',
    direct: 'Rien entendu. Retouche le bouton.',
  },
  'agent.global.stop': {
    pote: 'Arrêter l’écoute',
    pro: 'Arrêter l’écoute',
    direct: 'Arrêter',
  },
  'agent.global.dismiss': {
    pote: 'Fermer la réponse de Bob',
    pro: 'Fermer la réponse de Bob',
    direct: 'Fermer',
  },
  // S2-GUIDÉ — pilotage vocal du wizard devis (guidage par étape + retours d'affordances)
  'devis.voice.greetClient': {
    pote: 'Nouveau devis ! Dis-moi pour quel client, ou choisis à l’écran.',
    pro: 'Nouveau devis. Indiquez le client, ou choisissez à l’écran.',
    direct: 'Client ? Dis-le ou touche.',
  },
  'devis.voice.greetLines': {
    pote: 'On facture quoi ? Dis par exemple « ajoute deux heures de main-d’œuvre à 55 euros », puis « étape suivante ».',
    pro: 'Décrivez les prestations — par exemple « ajoutez deux heures de main-d’œuvre à 55 euros », puis « étape suivante ».',
    direct:
      'Dicte les lignes (« ajoute 2 h de main-d’œuvre à 55 euros »). Puis « étape suivante ».',
  },
  'devis.voice.greetVat': {
    pote: 'On vérifie la TVA et les mentions — dis « étape suivante » quand c’est bon.',
    pro: 'Vérifiez la TVA et les mentions, puis dites « étape suivante ».',
    direct: 'TVA/mentions. « Étape suivante » pour valider.',
  },
  'devis.voice.greetSignature': {
    pote: 'La signature se fait à l’écran, avec le client. Je reste là si besoin.',
    pro: 'La signature s’effectue à l’écran, avec le client.',
    direct: 'Signature : à l’écran.',
  },
  'devis.voice.greetDeposit': {
    pote: 'Dernier réglage : l’acompte. Cette étape se valide à l’écran — je reste là si besoin.',
    pro: 'Dernière étape : l’acompte. La validation se fait à l’écran.',
    direct: 'Acompte : à valider à l’écran.',
  },
  'devis.voice.clientSet': {
    pote: 'C’est noté pour {name}.',
    pro: 'Client sélectionné : {name}.',
    direct: '{name}. OK.',
  },
  'devis.voice.clientUnknown': {
    pote: 'Je ne trouve pas ce client — redis son nom, ou touche l’écran.',
    pro: 'Client introuvable. Répétez le nom, ou choisissez à l’écran.',
    direct: 'Client inconnu. Redis ou touche.',
  },
  'devis.voice.lineAdded': {
    pote: 'Ajouté : {label} — {qty} × {price} HT, TVA {rate} %. Une autre ligne, ou « étape suivante » ?',
    pro: 'Ligne ajoutée : {label} — {qty} × {price} HT, TVA {rate} %. Autre ligne, ou « étape suivante » ?',
    direct: '{label} : {qty} × {price} HT, TVA {rate} %. Autre ? Ou « étape suivante ».',
  },
  'devis.voice.lineAddedCatalogue': {
    pote: 'Trouvé dans ton catalogue : {label} — {qty} × {price} HT, TVA {rate} %. C’est ajouté. Une autre ?',
    pro: 'Repris de votre catalogue : {label} — {qty} × {price} HT, TVA {rate} %. Ligne ajoutée.',
    direct: 'Catalogue : {label}, {qty} × {price} HT, TVA {rate} %. Ajouté.',
  },
  'devis.voice.lineAmbiguous': {
    pote: 'Dans ton catalogue, plusieurs collent : {options}. Laquelle ?',
    pro: 'Plusieurs prestations du catalogue correspondent : {options}. Laquelle ?',
    direct: 'Catalogue ambigu : {options}. Laquelle ?',
  },
  'devis.voice.missingPrice': {
    pote: 'D’accord pour « {label} » — à quel prix HT ? Redis-la avec le prix.',
    pro: 'Prestation « {label} » notée — indiquez le prix HT en la redisant avec le montant.',
    direct: '« {label} » : prix HT ? Redis avec le montant.',
  },
  'devis.voice.lineRemoved': {
    pote: 'Retiré : {label}.',
    pro: 'Ligne retirée : {label}.',
    direct: 'Retiré : {label}.',
  },
  'devis.voice.proposalReady': {
    pote: '{field} : {before} → {after}. Je l’applique ?',
    pro: '{field} : {before} → {after}. Faut-il l’appliquer ?',
    direct: '{field} : {before} → {after}. J’applique ?',
  },
  'devis.voice.proposalApplied': {
    pote: 'C’est corrigé : {field} passe à {after}.',
    pro: 'Correction appliquée : {field} → {after}.',
    direct: 'Corrigé : {field} → {after}.',
  },
  'devis.voice.proposalRejected': {
    pote: 'OK, je ne touche à rien.',
    pro: 'Très bien, aucune modification.',
    direct: 'Rien touché.',
  },
  'devis.voice.proposalUnknownLine': {
    pote: 'Je ne trouve pas cette ligne — dis son numéro, il est affiché à l’écran.',
    pro: 'Ligne introuvable. Indiquez son numéro tel qu’affiché.',
    direct: 'Ligne inconnue. Donne son numéro.',
  },
  'devis.proposalApply': { pote: 'Appliquer', pro: 'Appliquer', direct: 'Appliquer' },
  'devis.proposalReject': { pote: 'Annuler', pro: 'Annuler', direct: 'Annuler' },
  'devis.voice.lineRejected': {
    pote: 'OK, j’oublie cette ligne — dis-m’en une autre.',
    pro: 'Préparation annulée. Dictez une autre ligne.',
    direct: 'Annulé. Une autre ?',
  },
  'devis.voice.vatNotice': {
    pote: 'La TVA du devis est réglée à {rate} % — elle se change à l’étape TVA.',
    pro: 'La TVA du devis est de {rate} % ; elle se modifie à l’étape TVA.',
    direct: 'TVA du devis : {rate} % (étape TVA pour changer).',
  },
  'devis.voice.nothingToRemove': {
    pote: 'Il n’y a pas encore de ligne à retirer.',
    pro: 'Aucune ligne à retirer.',
    direct: 'Rien à retirer.',
  },
  'devis.voice.needClientFirst': {
    pote: 'On choisit d’abord le client, puis on dicte les lignes.',
    pro: 'Sélectionnez d’abord le client ; les lignes viennent ensuite.',
    direct: 'Client d’abord, lignes ensuite.',
  },
  'ventes.searchPlaceholder': {
    pote: 'N°, client, prestation (« chauffe-eau »)…',
    pro: 'Numéro, client ou prestation…',
    direct: 'N°, client, presta…',
  },
  'ventes.filterAll': { pote: 'Tout', pro: 'Tout', direct: 'Tout' },
  'ventes.filterQuotes': { pote: 'Devis', pro: 'Devis', direct: 'Devis' },
  'ventes.filterInvoices': { pote: 'Factures', pro: 'Factures', direct: 'Factures' },
  'ventes.noResults': {
    pote: 'Rien ne colle à ta recherche — essaie un autre mot.',
    pro: 'Aucun résultat pour cette recherche.',
    direct: 'Aucun résultat.',
  },
  'ventes.validUntil': {
    pote: 'Valide jusqu’au {date}',
    pro: 'Valide jusqu’au {date}',
    direct: 'Valide → {date}',
  },
  'ventes.issuedOn': { pote: 'Émise le {date}', pro: 'Émise le {date}', direct: 'Émise {date}' },
  'ventes.dueOn': { pote: 'Échéance {date}', pro: 'Échéance au {date}', direct: 'Éch. {date}' },
  'ventes.chipAcompte': {
    pote: 'Acompte {pct} %',
    pro: 'Acompte {pct} %',
    direct: 'Acompte {pct} %',
  },
  'ventes.chipAcompteSimple': { pote: 'Acompte', pro: 'Acompte', direct: 'Acompte' },
  'ventes.chipFinale': { pote: 'Facture finale', pro: 'Facture finale', direct: 'Finale' },
  'ventes.chipAvoir': { pote: 'Avoir', pro: 'Avoir', direct: 'Avoir' },
  'ventes.chipSituation': { pote: 'Situation', pro: 'Situation', direct: 'Situation' },
  'ventes.voiceFiltered': {
    pote: 'Je filtre sur « {query} » — {count} résultat(s) à l’écran.',
    pro: 'Filtre appliqué sur « {query} » : {count} résultat(s).',
    direct: '« {query} » : {count} résultat(s).',
  },
  'ventes.voiceFilterKind': {
    pote: 'Voilà, je n’affiche plus que ça.',
    pro: 'Filtre appliqué.',
    direct: 'Filtré.',
  },
  'devis.clientTagRemove': {
    pote: 'Changer de client',
    pro: 'Changer de client',
    direct: 'Changer',
  },
  'devis.cataloguePickOpen': {
    pote: 'Choisir dans mon catalogue',
    pro: 'Choisir dans le catalogue',
    direct: 'Catalogue',
  },
  'devis.cataloguePickTitle': {
    pote: 'Mon catalogue',
    pro: 'Votre catalogue',
    direct: 'Catalogue',
  },
  'devis.cataloguePickEmpty': {
    pote: 'Ton catalogue est vide — remplis-le depuis l’écran Catalogue.',
    pro: 'Votre catalogue est vide. Ajoutez des prestations depuis l’écran Catalogue.',
    direct: 'Catalogue vide. Va le remplir.',
  },
  'devis.voice.screenOnlyStep': {
    pote: 'Cette étape se valide à l’écran — c’est le garde-fou. Touche le bouton quand tu es prêt.',
    pro: 'Cette étape se valide à l’écran (garde-fou). Utilisez le bouton.',
    direct: 'Étape à valider à l’écran.',
  },
  'devis.voice.linePrepared': {
    pote: 'C’est prêt : {label} — {qty} × {price} HT. Dis « valide la ligne », ou touche Ajouter.',
    pro: 'Ligne préparée : {label} — {qty} × {price} HT. Dites « valide la ligne » ou touchez Ajouter.',
    direct: '{label} : {qty} × {price} HT. « Valide la ligne » ou touche.',
  },
  'devis.voice.linePreparedCatalogue': {
    pote: 'Trouvé dans ton catalogue : {label} — {qty} × {price} HT. Dis « valide la ligne », ou touche Ajouter.',
    pro: 'Repris du catalogue : {label} — {qty} × {price} HT. Dites « valide la ligne » ou touchez Ajouter.',
    direct: 'Catalogue : {label}, {qty} × {price} HT. « Valide la ligne » ?',
  },
  'devis.voice.lineInvalid': {
    pote: 'Il manque un truc sur la ligne (libellé ou prix) — complète, puis « valide la ligne ».',
    pro: 'La ligne est incomplète (libellé ou prix). Complétez puis validez.',
    direct: 'Ligne incomplète. Complète puis valide.',
  },
  'devis.voice.clientAmbiguous': {
    pote: 'J’en vois plusieurs qui collent : {options}. Lequel ?',
    pro: 'Plusieurs clients correspondent : {options}. Lequel ?',
    direct: 'Plusieurs candidats : {options}. Lequel ?',
  },
  'devis.voice.stepDone': {
    pote: 'C’est parti pour la suite.',
    pro: 'Étape suivante.',
    direct: 'Suite.',
  },
  // R3/R5/R7 — génération de facture depuis un devis SIGNÉ (devis/[id]) : la voix PROPOSE (dit,
  // ouvre au mieux le Sheet de choix) — jamais n'exécute. Le tap reste le seul point de génération.
  'devis.voice.invoiceAlreadyFinal': {
    pote: 'La facture finale est déjà générée pour ce devis.',
    pro: 'La facture finale est déjà générée pour ce devis.',
    direct: 'Facture finale déjà générée.',
  },
  'devis.voice.invoiceFinalReady': {
    pote: 'C’est prêt : touche « Générer la facture finale » pour confirmer.',
    pro: 'Prêt à générer : touchez « Générer la facture finale » pour confirmer.',
    direct: 'Prêt. Touche « Générer la facture finale ».',
  },
  'devis.voice.invoiceChoiceOpenedFinal': {
    pote: 'Je t’ouvre le choix — touche « Facture de 100 % » pour confirmer.',
    pro: 'Le choix est ouvert — touchez « Facture de 100 % » pour confirmer.',
    direct: 'Choix ouvert. Touche « Facture de 100 % ».',
  },
  'devis.voice.invoiceChoiceOpenedDeposit': {
    pote: 'Je t’ouvre le choix — touche « Facture d’acompte ({pct} %) » pour confirmer.',
    pro: 'Le choix est ouvert — touchez « Facture d’acompte ({pct} %) » pour confirmer.',
    direct: 'Choix ouvert. Touche « Facture d’acompte ({pct} %) ».',
  },
  'devis.voice.invoiceNoDeposit': {
    pote: 'Ce devis n’a pas d’acompte prévu — dis « facture complète » pour la facture de 100 %.',
    pro: 'Ce devis ne prévoit pas d’acompte. Dites « facture complète » pour la facture de 100 %.',
    direct: 'Pas d’acompte prévu. Dis « facture complète ».',
  },
  'devis.voice.invoiceDepositDraft': {
    pote: 'La facture d’acompte est encore en brouillon — vérifie-la et émets-la avant de créer la facture finale.',
    pro: 'La facture d’acompte est encore en brouillon. Vérifiez-la et émettez-la avant de générer la facture finale.',
    direct: 'Acompte encore en brouillon. Vérifie-le et émets-le d’abord.',
  },
  // R6/R7 — édition/suppression d'une ligne de devis BROUILLON à la voix (devis/[id]) : la voix
  // DIT ce qu'elle prépare et OUVRE la Sheet d'édition / la confirmation de suppression — jamais
  // n'écrit elle-même (même plancher que le choix de facture ci-dessus : proposer → tap → valider).
  'devis.voice.lineEditOpened': {
    pote: 'Je prépare la ligne {ordinal} — vérifie et touche Enregistrer pour valider.',
    pro: 'La ligne {ordinal} est prête à modifier — vérifiez puis touchez Enregistrer.',
    direct: 'Ligne {ordinal} prête. Touche Enregistrer.',
  },
  'devis.voice.lineDeleteOpened': {
    pote: 'Je prépare la suppression de la ligne {ordinal} — confirme à l’écran.',
    pro: 'Suppression de la ligne {ordinal} préparée — confirmez à l’écran.',
    direct: 'Suppression ligne {ordinal} préparée. Confirme.',
  },
  'devis.voice.lineUnknownOrdinal': {
    pote: 'Je ne trouve pas de ligne {ordinal} sur ce devis.',
    pro: 'Aucune ligne {ordinal} sur ce devis.',
    direct: 'Pas de ligne {ordinal}.',
  },
  // R4/R7 — « faire signer » un devis envoyé/vu (devis/[id]) : la voix DIT et OUVRE le Sheet
  // correspondant (choix des 2 options, pad sur place) — jamais n'exécute sign/send elle-même.
  // Le plancher de sûreté reste le TAP : « Valider la signature » ou l'option du Sheet de choix.
  'devis.voice.signChoiceOpened': {
    pote: 'Je t’ouvre le choix — touche « Sur place » ou « Envoyer le lien ».',
    pro: 'Le choix est ouvert — touchez « Sur place » ou « Envoyer le lien ».',
    direct: 'Choix ouvert. Sur place ou lien.',
  },
  'devis.voice.signOnsiteOpened': {
    pote: 'Signature sur place ouverte — fais tracer le trait à ton client, puis touche « Valider la signature ».',
    pro: 'Signature sur place ouverte — faites tracer le trait à votre client, puis touchez « Valider la signature ».',
    direct: 'Signature sur place ouverte. Trace puis valide.',
  },
  'devis.voice.signLinkChoiceOpened': {
    pote: 'Je t’ouvre le choix — touche « Envoyer le lien » pour l’envoyer à ton client.',
    pro: 'Le choix est ouvert — touchez « Envoyer le lien » pour l’envoyer à votre client.',
    direct: 'Choix ouvert. Touche « Envoyer le lien ».',
  },
  // ASK-1 — questions structurées (modale de choix quand la demande est ambiguë)
  'assistant.askAnswer': { pote: 'Répondre', pro: 'Répondre', direct: 'Répondre' },
  'assistant.askConfirm': { pote: 'Valider', pro: 'Valider', direct: 'Valider' },
  'assistant.askOther': {
    pote: 'Autre — je précise moi-même',
    pro: 'Autre réponse — préciser librement',
    direct: 'Autre.',
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
  'voix.dataLoading': {
    pote: 'Je prépare tes clients et tes tarifs.',
    pro: 'Chargement des clients, du profil et des tarifs.',
    direct: 'Chargement des données.',
  },
  'voix.dataError': {
    pote: 'Je n’arrive pas à charger tes clients ou tes tarifs. Rien n’a été créé.',
    pro: 'Les données nécessaires sont indisponibles. Aucune pièce n’a été créée.',
    direct: 'Données indisponibles. Rien créé.',
  },
  'voix.resumeTitle': {
    pote: 'Je reprends exactement où on s’est arrêté',
    pro: 'Reprise sécurisée de la création',
    direct: 'Reprise sécurisée',
  },
  'voix.resumeBody': {
    pote: 'Chaque étape terminée est conservée. Je ne rejoue jamais une action au hasard.',
    pro: 'Les étapes confirmées sont conservées et les actions incertaines restent bloquées.',
    direct: 'Étapes conservées. Actions incertaines bloquées.',
  },
  'voix.resumeProgress': {
    pote: 'Avancement',
    pro: 'Avancement',
    direct: 'Avancement',
  },
  'voix.resumeLocked': {
    pote: 'Création verrouillée pendant la reprise',
    pro: 'Création verrouillée pendant la reprise',
    direct: 'Reprise verrouillée',
  },
  'voix.resumeError': {
    pote: 'Je n’arrive pas à relire l’étape sécurisée. Rien ne sera rejoué sans vérification.',
    pro: 'La reprise sécurisée est indisponible. Aucune action ne sera rejouée sans contrôle.',
    direct: 'Reprise indisponible. Aucun rejeu.',
  },
  'voix.resumeAmbiguous': {
    pote: 'Je ne peux pas confirmer si le devis a été créé. Je bloque ici pour éviter un doublon.',
    pro: 'L’état de création du devis est incertain. La reprise est bloquée pour éviter un doublon.',
    direct: 'État incertain. Reprise bloquée anti-doublon.',
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
  // R6 — édition/suppression d'une ligne de devis BROUILLON au swipe (draft only).
  'devis.lineSwipeEdit': {
    pote: 'Modifier {label}',
    pro: 'Modifier {label}',
    direct: 'Modifier {label}',
  },
  'devis.lineSwipeDelete': {
    pote: 'Supprimer {label}',
    pro: 'Supprimer {label}',
    direct: 'Supprimer {label}',
  },
  'devis.lineEditTitle': {
    pote: 'Modifier la ligne',
    pro: 'Modifier la ligne',
    direct: 'Modifier la ligne',
  },
  'devis.lineEditSave': {
    pote: 'Enregistrer',
    pro: 'Enregistrer',
    direct: 'Enregistrer',
  },
  'devis.lineEditLabelHint': {
    pote: 'Décris clairement ce que tu factures.',
    pro: 'Décrivez précisément la prestation ou le produit facturé.',
    direct: 'Décris la ligne facturée.',
  },
  'devis.lineEditLabelError': {
    pote: 'Ajoute un libellé clair pour cette ligne.',
    pro: 'Saisissez un libellé valide pour cette ligne.',
    direct: 'Libellé requis.',
  },
  'devis.lineEditQtyHint': {
    pote: 'Mets une quantité positive, avec jusqu’à trois décimales.',
    pro: 'Saisissez une quantité positive, avec trois décimales au maximum.',
    direct: 'Quantité positive, trois décimales maximum.',
  },
  'devis.lineEditQtyError': {
    pote: 'La quantité doit être supérieure à zéro.',
    pro: 'Saisissez une quantité valide supérieure à zéro.',
    direct: 'Quantité invalide.',
  },
  'devis.lineEditPriceHint': {
    pote: 'Indique le prix unitaire hors taxes, en euros.',
    pro: 'Saisissez le prix unitaire hors taxes en euros, avec deux décimales au maximum.',
    direct: 'Prix unitaire HT en euros.',
  },
  'devis.lineEditPriceError': {
    pote: 'Indique un prix valide, avec deux décimales maximum.',
    pro: 'Saisissez un prix hors taxes valide, avec deux décimales au maximum.',
    direct: 'Prix HT invalide.',
  },
  'devis.lineEditDelete': {
    pote: 'Supprimer cette ligne',
    pro: 'Supprimer cette ligne',
    direct: 'Supprimer la ligne',
  },
  'devis.lineEditVisibleHint': {
    pote: 'Ouvre les détails pour modifier cette ligne.',
    pro: 'Ouvre le formulaire de modification de cette ligne.',
    direct: 'Ouvre la modification.',
  },
  'devis.lineMutationErrorTitle': {
    pote: 'Je n’ai pas pu modifier la ligne',
    pro: 'Modification de la ligne impossible',
    direct: 'Modification impossible',
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
  // R4 — signature sur place depuis le détail d'un devis envoyé/vu (SignOnsiteSheet, même pad
  // que l'étape 4 ci-dessus, réutilisée hors wizard).
  'devis.signOnsiteSubmit': {
    pote: 'Valider la signature',
    pro: 'Valider la signature',
    direct: 'Valider',
  },
  // R4 durci — mode passage client (SignOnsiteSheet plein écran isolé, challenge GPT 20260714) :
  // en-tête client + devis, consigne courte affichée au client, sortie PROPRIÉTAIRE unique
  // (appui long 1,5 s sur « Reprendre mon téléphone » — annule aussi la signature en cours).
  'devis.signOnsiteModeHeader': {
    pote: 'Signature de {customerName} — Devis {number}',
    pro: 'Signature de {customerName} — Devis {number}',
    direct: 'Signature — {customerName} · Devis {number}',
  },
  'devis.signOnsiteModeHeaderNoNumber': {
    pote: 'Signature de {customerName}',
    pro: 'Signature de {customerName}',
    direct: 'Signature — {customerName}',
  },
  'devis.signOnsiteModeInstruction': {
    pote: 'Relis vite fait, puis signe du doigt si t’es d’accord.',
    pro: 'Relisez le devis, puis signez du doigt si vous êtes d’accord.',
    direct: 'Relis. Signe si OK.',
  },
  'devis.signOnsiteModeExit': {
    pote: 'Reprendre mon téléphone',
    pro: 'Reprendre mon téléphone',
    direct: 'Reprendre le tél.',
  },
  'devis.signOnsiteModeExitHint': {
    pote: 'Maintenez appuyé 1,5 seconde pour reprendre la main — annule aussi la signature en cours.',
    pro: 'Maintenez appuyé 1,5 seconde pour reprendre la main — annule aussi la signature en cours.',
    direct: 'Appui long 1,5 s. Annule la signature.',
  },
  // R4 durci, suite — alternative accessible à l'appui long quand un lecteur d'écran est détecté
  // (VoiceOver/TalkBack) : l'activation standard « double-tap » ne peut pas mesurer un maintien
  // chronométré, donc double-tap pour armer puis un second double-tap sous 5 s pour confirmer.
  'devis.signOnsiteModeExitHintScreenReader': {
    pote: 'Double-tapez pour préparer la sortie, puis une seconde fois sous 5 secondes pour confirmer — annule aussi la signature en cours.',
    pro: 'Double-tapez pour préparer la sortie, puis une seconde fois sous 5 secondes pour confirmer — annule aussi la signature en cours.',
    direct: 'Double-tap : prépare. Re-double-tap sous 5 s : confirme. Annule la signature.',
  },
  'devis.signOnsiteModeExitArmed': {
    pote: 'Confirmer — reprendre mon téléphone',
    pro: 'Confirmer — reprendre mon téléphone',
    direct: 'Confirmer la sortie',
  },
  'devis.signOnsiteModeExitArmedHint': {
    pote: 'Double-tapez à nouveau dans les 5 secondes pour confirmer et sortir.',
    pro: 'Double-tapez à nouveau dans les 5 secondes pour confirmer et sortir.',
    direct: 'Re-double-tap sous 5 s pour confirmer.',
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
  'piece.kindSituation': {
    pote: 'Situation de travaux',
    pro: 'Situation de travaux',
    direct: 'Situation',
  },
  'piece.draftNumber': {
    pote: 'Brouillon — numérotée à l’émission',
    pro: 'Brouillon — le numéro sera attribué à l’émission',
    direct: 'Brouillon',
  },
  // Statuts (badge header)
  'piece.statusDraft': { pote: 'Brouillon', pro: 'Brouillon', direct: 'Brouillon' },
  'piece.statusIssued': { pote: 'Émise', pro: 'Émise', direct: 'Émise' },
  'piece.statusPartiallyPaid': {
    pote: 'Encaissée en partie',
    pro: 'Partiellement payée',
    direct: 'Partielle',
  },
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
  'piece.linkedSituation': {
    pote: 'Situation de travaux',
    pro: 'Situation de travaux',
    direct: 'Situation',
  },
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
  'piece.lineQuantityPrice': {
    pote: '{qty} {unit} × {price} HT',
    pro: '{qty} {unit} × {price} HT',
    direct: '{qty} {unit} × {price} HT',
  },
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
  // A5 — déduction composite (acompte + situations émises) : pas de pièce unique à citer.
  'piece.alreadyInvoiced': {
    pote: 'Déjà facturé (acompte + situations)',
    pro: 'Déjà facturé (acompte et situations)',
    direct: 'Déjà facturé',
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
  'piece.ereportingTitle': {
    pote: 'Vente à un particulier',
    pro: 'Vente à un particulier',
    direct: 'B2C',
  },
  'piece.ereportingBody': {
    pote: 'Pas de transmission PDP — la donnée part en e-reporting (déclaration à l’administration).',
    pro: 'Aucune transmission PDP requise : les données partent en e-reporting auprès de l’administration.',
    direct: 'Pas de PDP : e-reporting.',
  },
  'piece.transmissionPa': {
    pote: 'Facture électronique · PDP',
    pro: 'Facture électronique · plateforme agréée',
    direct: 'e-facture · PDP',
  },
  'piece.transmissionChorus': {
    pote: 'Facture électronique · Chorus Pro',
    pro: 'Facture électronique · Chorus Pro',
    direct: 'Chorus Pro',
  },
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
  // A4 — envoi du PDF au client (feuille de partage native, vrai fichier)
  'piece.actionSharePdf': {
    pote: 'Envoyer le PDF',
    pro: 'Envoyer le PDF',
    direct: 'Envoyer',
  },
  'piece.shareUnavailable': {
    pote: 'Le partage n’est pas dispo sur cet appareil — ouvre le PDF et envoie-le à la main.',
    pro: 'Le partage n’est pas disponible sur cet appareil. Ouvrez le PDF pour l’envoyer manuellement.',
    direct: 'Partage indispo. Ouvre le PDF.',
  },
  'piece.shareError': {
    pote: 'Je n’ai pas réussi à préparer le fichier. On réessaie ?',
    pro: 'Le fichier n’a pas pu être préparé. Veuillez réessayer.',
    direct: 'Échec de préparation. Réessaie.',
  },
  'piece.actionEncaisser': { pote: 'Encaisser', pro: 'Encaisser', direct: 'Encaisser' },
  'piece.actionEnvoyer': { pote: 'Envoyer au client', pro: 'Envoyer au client', direct: 'Envoyer' },
  'piece.actionRelancer': { pote: 'Relancer', pro: 'Relancer', direct: 'Relancer' },
  'piece.actionFacturer': {
    pote: 'Créer la facture',
    pro: 'Générer la facture',
    direct: 'Facturer',
  },
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
  'piece.close': { pote: 'Fermer', pro: 'Fermer', direct: 'Fermer' },
  'piece.accountingError': {
    pote: 'Je n’ai pas réussi à charger l’écriture comptable. On réessaie ?',
    pro: 'L’écriture comptable n’a pas pu être chargée. Veuillez réessayer.',
    direct: 'Écriture comptable injoignable. Réessaie.',
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
  'diag.qOffAppNo': {
    pote: 'Non, tout passe ici',
    pro: 'Non, tout passe par l’application',
    direct: 'Non',
  },
  'diag.qOffAppUnknown': { pote: 'Je sais pas trop', pro: 'Je ne sais pas', direct: 'Sais pas' },
  'diag.qAccountant': {
    pote: 'T’es accompagné par un comptable ?',
    pro: 'Êtes-vous accompagné par un expert-comptable ?',
    direct: 'Un comptable t’accompagne ?',
  },
  'diag.qAccountantYes': {
    pote: 'Oui, j’ai un comptable',
    pro: 'Oui, un expert-comptable',
    direct: 'Oui',
  },
  'diag.qAccountantOga': {
    pote: 'Oui, un OGA / CGA',
    pro: 'Oui, un OGA / CGA',
    direct: 'OGA / CGA',
  },
  'diag.qAccountantNo': { pote: 'Non, je gère seul', pro: 'Non, je gère seul', direct: 'Non' },
  // Résultat — titre par tranche de score (mêmes seuils que l'anneau : >75 · 50–75 · <50).
  'diag.resultTitleHigh': {
    pote: 'Prêt pour 2026 🎉',
    pro: 'Vous êtes prêt pour 2026',
    direct: 'Prêt.',
  },
  'diag.resultTitleMid': { pote: 'Presque prêt 💪', pro: 'Presque prêt', direct: 'Presque.' },
  'diag.resultTitleLow': {
    pote: 'Faut s’y mettre 🔧',
    pro: 'Des actions sont nécessaires',
    direct: 'Pas prêt.',
  },
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
  'diag.axisDonnees': {
    pote: 'Qualité des données',
    pro: 'Qualité des données',
    direct: 'Données',
  },
  'diag.planTitle': {
    pote: 'Ton plan d’action',
    pro: 'Votre plan d’action',
    direct: 'Plan d’action',
  },
  'diag.deadline': { pote: 'avant le {date}', pro: 'échéance {date}', direct: '{date}' },
  'diag.resultCta': {
    pote: 'Configurer ma réception',
    pro: 'Configurer la réception',
    direct: 'Configurer',
  },
  'diag.resultLater': { pote: 'Plus tard', pro: 'Plus tard', direct: 'Plus tard' },
  'diag.dataError': {
    pote: 'J’arrive pas à lire ton dossier, là. On réessaie ?',
    pro: 'Impossible de charger le diagnostic pour le moment.',
    direct: 'Chargement KO. Réessaie.',
  },
  'diag.dataLoading': {
    pote: 'Je vérifie ton dossier…',
    pro: 'Vérification du dossier…',
    direct: 'Vérification…',
  },
  'diag.staleData': {
    pote: 'Je n’ai pas pu actualiser le dossier. Le diagnostic utilisera la dernière version connue.',
    pro: 'L’actualisation a échoué. Le diagnostic utilisera la dernière version disponible.',
    direct: 'Actualisation impossible. Dernière version utilisée.',
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
  'diag.itemArchive': {
    pote: 'Archivage 10 ans',
    pro: 'Archivage 10 ans',
    direct: 'Archivage 10 ans',
  },
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
  'onboard.vatReelSimpl': {
    pote: 'Réel simplifié',
    pro: 'Réel simplifié',
    direct: 'Réel simplifié',
  },
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
    direct:
      'Pas de TVA facturée, mais la facture élec. te concerne quand même : réception obligatoire dès septembre 2026.',
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
  // Écarts assumés sur le footer proto « Chiffré de bout en bout · 2FA · conforme RGPD » :
  // « 2FA » retiré (non implémenté) et « de bout en bout » corrigé en « connexion
  // chiffrée » (l'archi est TLS client↔serveur, pas du E2E — le serveur lit les
  // données pour facturer/relancer). On n'affiche jamais une promesse fantôme.
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
    pote: 'Connexion chiffrée · conforme RGPD',
    pro: 'Connexion chiffrée · conforme RGPD',
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
  'auth.verifyResend': {
    pote: 'Je n’ai rien reçu — renvoyer',
    pro: 'Renvoyer l’email de confirmation',
    direct: 'Renvoyer l’email',
  },
  'auth.verifyResending': {
    pote: 'Je te le renvoie…',
    pro: 'Envoi en cours…',
    direct: 'Envoi…',
  },
  'auth.verifyResendIn': {
    pote: 'Tu pourras le renvoyer dans {seconds} s',
    pro: 'Nouvel envoi disponible dans {seconds} s',
    direct: 'Renvoyer dans {seconds} s',
  },
  'auth.verifyResent': {
    pote: 'C’est reparti — vérifie aussi tes indésirables.',
    pro: 'Email renvoyé. Pensez à vérifier vos courriers indésirables.',
    direct: 'Email renvoyé. Vérifie les indésirables.',
  },
  'auth.recoveryCheckingTitle': {
    pote: 'Je vérifie ton lien',
    pro: 'Vérification du lien',
    direct: 'Vérification…',
  },
  'auth.recoveryCheckingBody': {
    pote: 'Une seconde — je sécurise ta session avant de changer quoi que ce soit.',
    pro: 'Votre lien sécurisé est en cours de vérification.',
    direct: 'Lien sécurisé en cours de vérification.',
  },
  'auth.recoveryTitle': {
    pote: 'Choisis ton nouveau mot de passe',
    pro: 'Définissez votre nouveau mot de passe',
    direct: 'Nouveau mot de passe',
  },
  'auth.recoveryBody': {
    pote: 'Prends-en un que tu n’utilises nulle part ailleurs. Je m’occupe du reste.',
    pro: 'Utilisez un mot de passe unique, différent de vos autres comptes.',
    direct: 'Utilise un mot de passe unique.',
  },
  'auth.recoveryNewPassword': {
    pote: 'Nouveau mot de passe',
    pro: 'Nouveau mot de passe',
    direct: 'Nouveau mot de passe',
  },
  'auth.recoveryConfirmPassword': {
    pote: 'Confirme le mot de passe',
    pro: 'Confirmez le mot de passe',
    direct: 'Confirmation',
  },
  'auth.recoveryShowPassword': {
    pote: 'Afficher le mot de passe',
    pro: 'Afficher le mot de passe',
    direct: 'Afficher le mot de passe',
  },
  'auth.recoveryHidePassword': {
    pote: 'Masquer le mot de passe',
    pro: 'Masquer le mot de passe',
    direct: 'Masquer le mot de passe',
  },
  'auth.recoveryShow': { pote: 'Afficher', pro: 'Afficher', direct: 'Voir' },
  'auth.recoveryHide': { pote: 'Masquer', pro: 'Masquer', direct: 'Cacher' },
  'auth.recoveryCta': {
    pote: 'Enregistrer mon nouveau mot de passe',
    pro: 'Enregistrer le nouveau mot de passe',
    direct: 'Enregistrer',
  },
  'auth.recoveryRequired': {
    pote: 'Remplis les deux champs pour que je puisse vérifier.',
    pro: 'Les deux champs sont requis.',
    direct: 'Deux champs requis.',
  },
  'auth.recoveryMismatch': {
    pote: 'Les deux mots de passe ne sont pas identiques — vérifie-les.',
    pro: 'Les deux mots de passe ne correspondent pas.',
    direct: 'Mots de passe différents.',
  },
  'auth.recoveryTooLong': {
    pote: 'Ce mot de passe est vraiment trop long — reste sous 256 caractères.',
    pro: 'Le mot de passe ne peut pas dépasser 256 caractères.',
    direct: '256 caractères maximum.',
  },
  'auth.recoveryInvalidTitle': {
    pote: 'Ce lien ne fonctionne pas',
    pro: 'Lien invalide',
    direct: 'Lien invalide',
  },
  'auth.recoveryCheckFailedTitle': {
    pote: 'Je n’arrive pas à vérifier le lien',
    pro: 'Vérification impossible',
    direct: 'Vérification impossible',
  },
  'auth.recoveryInvalidBody': {
    pote: 'Il a peut-être déjà servi. Retourne à la connexion et demande-moi un nouveau lien.',
    pro: 'Ce lien est invalide ou a déjà été utilisé. Demandez-en un nouveau depuis la connexion.',
    direct: 'Lien invalide ou déjà utilisé. Demande-en un nouveau.',
  },
  'auth.recoveryExpiredTitle': {
    pote: 'Ce lien a expiré',
    pro: 'Lien expiré',
    direct: 'Lien expiré',
  },
  'auth.recoveryExpiredBody': {
    pote: 'Pas de souci : retourne à la connexion et je t’en envoie un tout neuf.',
    pro: 'Demandez un nouveau lien de réinitialisation depuis la connexion.',
    direct: 'Demande un nouveau lien depuis la connexion.',
  },
  'auth.recoveryBack': {
    pote: 'Retour à la connexion',
    pro: 'Retour à la connexion',
    direct: 'Connexion',
  },
  'auth.recoverySuccessTitle': {
    pote: 'C’est bon, ton mot de passe est changé',
    pro: 'Mot de passe mis à jour',
    direct: 'Mot de passe mis à jour',
  },
  'auth.recoverySuccessBody': {
    pote: 'Tout est sécurisé. Tu peux reprendre là où tu en étais.',
    pro: 'Votre nouveau mot de passe est actif. Vous pouvez continuer.',
    direct: 'Nouveau mot de passe actif.',
  },
  'auth.recoverySuccessCta': {
    pote: 'Continuer dans Bob Pro',
    pro: 'Continuer dans Bob Pro',
    direct: 'Continuer',
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
  'auth.bioUnavailable': {
    pote: 'La biométrie n’est pas disponible. Utilise ton mot de passe pour rentrer en sécurité.',
    pro: 'La biométrie est indisponible. Veuillez utiliser votre mot de passe.',
    direct: 'Biométrie indisponible. Utilise le mot de passe.',
  },
  'auth.bioPreferenceError': {
    pote: 'Je n’arrive pas à enregistrer ce choix. Réessaie avant de fermer.',
    pro: 'Impossible d’enregistrer ce choix de sécurité. Veuillez réessayer.',
    direct: 'Choix non enregistré. Réessaie.',
  },
  'auth.bioChecking': {
    pote: 'Je vérifie la protection de ta session…',
    pro: 'Vérification de la protection de la session…',
    direct: 'Vérification de la session…',
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
  'auth.bootstrapError': {
    pote: 'Je n’arrive pas à vérifier ta session. Rien n’a été effacé : réessaie quand la connexion revient.',
    pro: 'Impossible de vérifier votre session. Aucune donnée n’a été supprimée. Veuillez réessayer.',
    direct: 'Session non vérifiée. Réessaie.',
  },
  // C24b — fiche société complète (récap inscription) + provisioning tenant après confirmation.
  'auth.companyLegalFormLabel': {
    pote: 'Forme juridique',
    pro: 'Forme juridique',
    direct: 'Forme',
  },
  'auth.companyCreatedLabel': {
    pote: 'Créée le',
    pro: 'Date de création',
    direct: 'Créée le',
  },
  'auth.provisioningTitle': {
    pote: 'On prépare ton espace',
    pro: 'Préparation de votre espace',
    direct: 'Espace en création.',
  },
  'auth.provisioningBody': {
    pote: 'Deux secondes — je crée ton espace avec les infos officielles de ta boîte.',
    pro: 'Votre espace est en cours de création avec les informations officielles de votre entreprise.',
    direct: 'Je crée ton espace. 2 s.',
  },
  'auth.provisioningError': {
    pote: 'La création de ton espace a raté — et c’est pas toi. On réessaie ?',
    pro: 'La création de votre espace a échoué. Veuillez réessayer.',
    direct: 'Création KO. Réessaie.',
  },
  'auth.provisioningRetry': {
    pote: 'Réessayer',
    pro: 'Réessayer',
    direct: 'Réessayer',
  },
  'auth.provisioningSiretIntro': {
    pote: 'Ton compte est prêt ! Il me manque juste ton entreprise — donne-moi ton SIRET, je m’occupe du reste.',
    pro: 'Votre compte est prêt. Renseignez votre SIRET : la fiche de votre entreprise sera créée automatiquement.',
    direct: 'Compte OK. SIRET, et je fais le reste.',
  },
  'auth.provisioningLegalFormLabel': {
    pote: 'Sa forme juridique ?',
    pro: 'Forme juridique de l’entreprise',
    direct: 'Forme juridique ?',
  },
  'auth.provisioningConfirmCta': {
    pote: 'Créer mon espace',
    pro: 'Créer mon espace',
    direct: 'Créer',
  },
  'auth.provisioningSignOut': {
    pote: 'Se déconnecter',
    pro: 'Se déconnecter',
    direct: 'Déconnexion',
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
  'notif.conformiteTitle': {
    pote: 'Conformité 2026',
    pro: 'Conformité 2026',
    direct: 'Conformité 2026',
  },
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

  // ── Vague Bob partout — lot lu atomique, même commande en manuel et à la voix ─────
  'notif.markAllAction': {
    pote: 'Tout marquer lu',
    pro: 'Tout marquer lu',
    direct: 'Tout lire',
  },
  'notif.markAllActionA11y': {
    pote: '{count} notifications non lues. Tout marquer comme lu.',
    pro: '{count} notifications non lues. Tout marquer comme lu.',
    direct: '{count} non lues. Tout lire.',
  },
  'notif.markAllConfirmTitle': {
    pote: 'Tout marquer comme lu ?',
    pro: 'Marquer toutes les notifications comme lues ?',
    direct: 'Tout marquer lu ?',
  },
  'notif.markAllConfirmBody': {
    pote: 'Je marque ces {count} notifications comme lues. Celles qui arrivent pendant ta confirmation resteront non lues.',
    pro: 'Les {count} notifications actuellement non lues seront marquées comme lues. Toute nouvelle notification restera non lue.',
    direct: '{count} notifications seront lues. Les nouvelles restent non lues.',
  },
  'notif.markAllConfirmBodyOne': {
    pote: 'Je marque cette notification comme lue. Celles qui arrivent pendant ta confirmation resteront non lues.',
    pro: 'La notification actuellement non lue sera marquée comme lue. Toute nouvelle notification restera non lue.',
    direct: '1 notification sera lue. Les nouvelles restent non lues.',
  },
  'notif.markAllSuccess': {
    pote: 'C’est bon, {count} notifications sont lues.',
    pro: '{count} notifications ont été marquées comme lues.',
    direct: '{count} notifications lues.',
  },
  'notif.markAllSuccessOne': {
    pote: 'C’est bon, la notification est lue.',
    pro: 'La notification a été marquée comme lue.',
    direct: 'Notification lue.',
  },
  'notif.markAllNoop': {
    pote: 'Tout est déjà lu.',
    pro: 'Toutes les notifications sont déjà lues.',
    direct: 'Déjà à jour.',
  },
  'notif.markAllError': {
    pote: 'Je n’ai pas pu mettre le fil à jour. Réessaie.',
    pro: 'Impossible de mettre les notifications à jour. Veuillez réessayer.',
    direct: 'Mise à jour impossible. Réessaie.',
  },
  'notif.markReadError': {
    pote: 'Je n’ai pas pu marquer cette notification comme lue. Réessaie.',
    pro: 'La notification n’a pas pu être marquée comme lue. Veuillez réessayer.',
    direct: 'Lecture non enregistrée. Réessaie.',
  },

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
  'relance.queuedToast': {
    pote: 'Relance programmée pour {name} — Bob s’en charge.',
    pro: 'Relance programmée pour {name}. L’envoi sera suivi dans l’activité.',
    direct: '{name} : relance programmée.',
  },
  'relance.sendError': {
    pote: 'L’envoi a raté — réessaie dans un instant.',
    pro: 'L’envoi de la relance a échoué. Veuillez réessayer.',
    direct: 'Envoi KO. Réessaie.',
  },

  // ── A7 — recherche globale (/recherche) ─────────────────────────────────────
  'search.back': { pote: 'Fermer', pro: 'Fermer', direct: 'Fermer' },
  'search.eyebrow': { pote: 'Recherche', pro: 'Recherche', direct: 'Recherche' },
  'search.title': { pote: 'Tout retrouver', pro: 'Tout retrouver', direct: 'Recherche' },
  'search.subtitle': {
    pote: 'Un nom, un numéro de pièce, un fichier — je fouille partout.',
    pro: 'Un nom de client, un numéro de pièce ou un fichier — recherche sur tout votre espace.',
    direct: 'Nom, numéro, fichier.',
  },
  'search.placeholder': {
    pote: '« mairie », « F-2026-0001 », « leroy »…',
    pro: '« mairie », « F-2026-0001 », « leroy »…',
    direct: 'Nom, numéro, fichier…',
  },
  'search.hint': {
    pote: 'Tape un nom de client, un numéro de devis ou de facture, un fichier — je ramène tout ce qui colle.',
    pro: 'Saisissez un nom de client, un numéro de pièce ou un nom de fichier : les résultats couvrent tout votre espace.',
    direct: 'Tape, je cherche partout.',
  },
  'search.noResults': {
    pote: 'Rien pour « {query} » — essaie un nom de client ou un numéro de pièce.',
    pro: 'Aucun résultat pour « {query} ». Essayez un nom de client ou un numéro de pièce.',
    direct: 'Rien pour « {query} ».',
  },
  'search.dataError': {
    pote: 'Je n’ai pas accès à tout le coffre pour l’instant. Réessaie avant de conclure qu’un élément manque.',
    pro: 'La recherche globale est indisponible. Veuillez réessayer avant de conclure qu’un élément est absent.',
    direct: 'Recherche incomplète. Réessaie.',
  },
  'search.sectionClients': { pote: 'Clients', pro: 'Clients', direct: 'Clients' },
  'search.sectionPieces': { pote: 'Devis & factures', pro: 'Devis et factures', direct: 'Pièces' },
  'search.sectionDocs': { pote: 'Documents', pro: 'Documents', direct: 'Docs' },
  'search.draftNumber': { pote: 'Brouillon', pro: 'Brouillon', direct: 'Brouillon' },
  'search.everywhere': {
    pote: 'Chercher « {query} » partout',
    pro: 'Rechercher « {query} » sur tout l’espace',
    direct: '« {query} » partout',
  },

  // ── A2-C10 — encaisser depuis le briefing ───────────────────────────────────
  'today.ctaCollect': { pote: 'Encaisser', pro: 'Encaisser', direct: 'Encaisser' },
  'today.collectDone': {
    pote: '{amount} au chaud — joli.',
    pro: 'Paiement de {amount} enregistré.',
    direct: '{amount} encaissé.',
  },

  // ── E10 — écran « Dépenses » (charges fournisseurs, E4 payer) ───────────────
  'dep.back': { pote: 'Fermer', pro: 'Fermer', direct: 'Fermer' },
  'dep.eyebrow': { pote: 'Tes charges', pro: 'Vos charges', direct: 'Charges' },
  'dep.title': { pote: 'Dépenses', pro: 'Dépenses', direct: 'Dépenses' },
  'dep.subtitle': {
    pote: 'Chaque reçu scanné devient une charge comptabilisée — et tu vois ce qui reste à payer.',
    pro: 'Chaque dépense est comptabilisée au journal des achats — le reste à payer est suivi.',
    direct: 'Charges comptabilisées. Reste à payer suivi.',
  },
  'dep.toPay': { pote: 'À payer', pro: 'Reste à payer', direct: 'À payer' },
  'dep.toPayCount': {
    pote: '{count} factures fournisseurs',
    pro: '{count} factures fournisseurs',
    direct: '{count}',
  },
  'dep.toPayCountOne': { pote: '1 facture fournisseur', pro: '1 facture fournisseur', direct: '1' },
  'dep.paidMonth': { pote: 'Payé ce mois-ci', pro: 'Décaissé sur le mois', direct: 'Payé ce mois' },
  'dep.vatMonth': {
    pote: 'TVA récupérable du mois',
    pro: 'TVA déductible du mois',
    direct: 'TVA du mois',
  },
  'dep.sectionList': { pote: 'Tes dépenses', pro: 'Vos dépenses', direct: 'Dépenses' },
  'dep.statusToPay': { pote: 'À payer', pro: 'À payer', direct: 'À payer' },
  'dep.statusPaid': { pote: 'Payée', pro: 'Payée', direct: 'Payée' },
  'dep.pay': { pote: 'Payer', pro: 'Marquer payée', direct: 'Payer' },
  'dep.payConfirmTitle': {
    pote: 'Régler cette dépense ?',
    pro: 'Régler la dépense',
    direct: 'Régler ?',
  },
  'dep.payConfirmBody': {
    pote: 'Je passe {supplier} en payée et j’écris le décaissement au journal de banque ({amount}).',
    pro: 'La dépense {supplier} passe en payée ; le décaissement ({amount}) est écrit au journal de banque.',
    direct: '{supplier} payée · décaissement {amount} au journal.',
  },
  'dep.paidToast': {
    pote: '{supplier} réglée ✓ — le journal est à jour.',
    pro: 'Dépense {supplier} réglée. Journal de banque à jour.',
    direct: '{supplier} réglée.',
  },
  'dep.payError': {
    pote: 'Le règlement a raté — on réessaie ?',
    pro: 'Le règlement a échoué. Veuillez réessayer.',
    direct: 'Règlement KO. Réessaie.',
  },
  'dep.catFournitures': { pote: 'Fournitures', pro: 'Fournitures', direct: 'Fournitures' },
  'dep.catMateriel': { pote: 'Matériel', pro: 'Matériel', direct: 'Matériel' },
  'dep.catCarburant': { pote: 'Carburant', pro: 'Carburant', direct: 'Carburant' },
  'dep.catRepas': { pote: 'Repas', pro: 'Repas', direct: 'Repas' },
  'dep.catSousTraitance': { pote: 'Sous-traitance', pro: 'Sous-traitance', direct: 'Sous-trait.' },
  'dep.catAutre': { pote: 'Autre', pro: 'Autre', direct: 'Autre' },
  'dep.empty': {
    pote: 'Aucune dépense pour l’instant — scanne ton premier reçu, je m’occupe du reste.',
    pro: 'Aucune dépense enregistrée. Scannez un reçu : extraction et comptabilisation automatiques.',
    direct: 'Aucune dépense. Scanne un reçu.',
  },
  'dep.dataError': {
    pote: 'Je n’arrive pas à charger tes dépenses, là. On réessaie ?',
    pro: 'Impossible de charger les dépenses. Veuillez réessayer.',
    direct: 'Dépenses injoignables. Réessaie.',
  },
  'dep.retry': { pote: 'Réessayer', pro: 'Réessayer', direct: 'Réessayer' },
  'dep.scanCta': { pote: 'Scanner un reçu', pro: 'Scanner un reçu', direct: 'Scanner' },

  // ── CLOTURE-UI — écran « Clôture » (refonte @bob/ui) ────────────────────────
  'cloture.back': { pote: 'Accueil', pro: 'Accueil', direct: 'Accueil' },
  'cloture.eyebrow': {
    pote: 'Le mois pour ton comptable',
    pro: 'Le mois pour votre comptable',
    direct: 'Clôture',
  },
  'cloture.title': { pote: 'Clôture', pro: 'Clôture', direct: 'Clôture' },
  'cloture.subtitle': {
    pote: 'Je prépare {month} : anomalies, pièces, états de synthèse — prêt à envoyer.',
    pro: 'Préparation de {month} : anomalies, pièces manquantes et états de synthèse.',
    direct: '{month} — prêt pour le comptable.',
  },
  'cloture.paywallTitle': {
    pote: 'Clôture assistée — dès l’offre Pro',
    pro: 'Clôture assistée — à partir de l’offre Operations',
    direct: 'Clôture : offre Pro',
  },
  'cloture.paywallBody': {
    pote: 'Préparer le mois (anomalies, pièces, dossier pour le comptable) fait partie des offres avec compta.',
    pro: 'La préparation du mois (anomalies, pièces manquantes, dossier cabinet) est incluse dans les offres avec comptabilité.',
    direct: 'Anomalies + dossier cabinet : offres avec compta.',
  },
  'cloture.paywallCta': { pote: 'Voir les offres', pro: 'Voir les offres', direct: 'Offres' },
  'cloture.loading': {
    pote: 'Je prépare ton mois…',
    pro: 'Préparation du mois en cours…',
    direct: 'Préparation…',
  },
  'cloture.allClear': {
    pote: 'Tout est prêt pour le comptable ✓',
    pro: 'Tout est prêt pour votre comptable.',
    direct: 'Prêt pour le comptable.',
  },
  'cloture.readyTitle': {
    pote: 'J’ai préparé ton mois.',
    pro: 'Votre mois est préparé.',
    direct: 'Mois préparé.',
  },
  'cloture.remainArbitrer': {
    pote: '{count} points à arbitrer',
    pro: '{count} points à arbitrer',
    direct: '{count} à arbitrer',
  },
  'cloture.remainArbitrerOne': {
    pote: '1 point à arbitrer',
    pro: '1 point à arbitrer',
    direct: '1 à arbitrer',
  },
  'cloture.remainPieces': {
    pote: '{count} pièces manquantes',
    pro: '{count} pièces manquantes',
    direct: '{count} pièces',
  },
  'cloture.remainPiecesOne': {
    pote: '1 pièce manquante',
    pro: '1 pièce manquante',
    direct: '1 pièce',
  },
  'cloture.sectionArbitrer': { pote: 'À arbitrer', pro: 'À arbitrer', direct: 'À arbitrer' },
  'cloture.sectionPieces': { pote: 'Pièces', pro: 'Pièces', direct: 'Pièces' },
  'cloture.itemSignedNotInvoiced': {
    pote: 'Devis signés à facturer',
    pro: 'Devis signés à facturer',
    direct: 'Devis à facturer',
  },
  'cloture.itemDrafts': {
    pote: 'Factures à émettre (brouillons)',
    pro: 'Factures à émettre',
    direct: 'Brouillons',
  },
  'cloture.itemLate': {
    pote: 'Factures en retard',
    pro: 'Factures en retard',
    direct: 'En retard',
  },
  'cloture.itemPartial': {
    pote: 'Factures partiellement payées',
    pro: 'Factures partiellement payées',
    direct: 'Partielles',
  },
  'cloture.itemMissingPdf': {
    pote: 'Factures émises sans PDF archivé',
    pro: 'Factures émises sans PDF archivé',
    direct: 'PDF manquants',
  },
  'cloture.sectionBalance': {
    pote: 'Balance générale',
    pro: 'Balance générale',
    direct: 'Balance',
  },
  'cloture.resultProvisoire': {
    pote: 'Résultat provisoire',
    pro: 'Résultat provisoire',
    direct: 'Résultat',
  },
  'cloture.balanced': { pote: 'Équilibrée', pro: 'Équilibrée', direct: 'Équilibrée' },
  'cloture.unbalanced': { pote: 'Déséquilibrée', pro: 'Déséquilibrée', direct: 'Déséquilibrée' },
  'cloture.produitsCharges': {
    pote: 'Produits {produits} − charges {charges}',
    pro: 'Produits {produits} − charges {charges}',
    direct: 'P {produits} · C {charges}',
  },
  'cloture.totaux': {
    pote: 'Débit {debit} · Crédit {credit}',
    pro: 'Débit {debit} · Crédit {credit}',
    direct: 'D {debit} · C {credit}',
  },
  'cloture.totauxLabel': { pote: 'Totaux', pro: 'Totaux', direct: 'Totaux' },
  'cloture.sectionResult': {
    pote: 'Compte de résultat',
    pro: 'Compte de résultat',
    direct: 'Résultat',
  },
  'cloture.prodExpl': {
    pote: 'Produits d’exploitation',
    pro: 'Produits d’exploitation',
    direct: 'Produits expl.',
  },
  'cloture.chargesExpl': {
    pote: 'Charges d’exploitation',
    pro: 'Charges d’exploitation',
    direct: 'Charges expl.',
  },
  'cloture.resExpl': {
    pote: 'Résultat d’exploitation',
    pro: 'Résultat d’exploitation',
    direct: 'Rés. expl.',
  },
  'cloture.resFin': { pote: 'Résultat financier', pro: 'Résultat financier', direct: 'Rés. fin.' },
  'cloture.resExc': {
    pote: 'Résultat exceptionnel',
    pro: 'Résultat exceptionnel',
    direct: 'Rés. exc.',
  },
  'cloture.resNet': { pote: 'Résultat net', pro: 'Résultat net', direct: 'Rés. net' },
  'cloture.apresImpot': {
    pote: 'Après impôt sur les bénéfices de {amount}.',
    pro: 'Après impôt sur les bénéfices de {amount}.',
    direct: 'Après IS {amount}.',
  },
  'cloture.sectionBilan': { pote: 'Bilan', pro: 'Bilan', direct: 'Bilan' },
  'cloture.actif': { pote: 'Actif', pro: 'Actif', direct: 'Actif' },
  'cloture.passif': { pote: 'Passif', pro: 'Passif', direct: 'Passif' },
  'cloture.immo': { pote: 'Immobilisations', pro: 'Immobilisations', direct: 'Immo.' },
  'cloture.stocks': { pote: 'Stocks', pro: 'Stocks', direct: 'Stocks' },
  'cloture.creances': { pote: 'Créances', pro: 'Créances', direct: 'Créances' },
  'cloture.dispo': { pote: 'Disponibilités', pro: 'Disponibilités', direct: 'Dispo.' },
  'cloture.capitaux': { pote: 'Capitaux propres', pro: 'Capitaux propres', direct: 'Capitaux' },
  'cloture.resultat': { pote: 'Résultat', pro: 'Résultat', direct: 'Résultat' },
  'cloture.provisions': { pote: 'Provisions', pro: 'Provisions', direct: 'Provisions' },
  'cloture.emprunts': { pote: 'Emprunts', pro: 'Emprunts', direct: 'Emprunts' },
  'cloture.dettes': { pote: 'Dettes', pro: 'Dettes', direct: 'Dettes' },
  'cloture.decouvert': { pote: 'Découvert', pro: 'Découvert', direct: 'Découvert' },
  'cloture.total': { pote: 'Total', pro: 'Total', direct: 'Total' },
  'cloture.bilanBalanced': {
    pote: 'Actif = passif : ton bilan est équilibré.',
    pro: 'Actif = passif : bilan équilibré.',
    direct: 'Actif = passif ✓',
  },
  'cloture.bilanEcart': {
    pote: 'Écart de {amount} — je vérifie le journal.',
    pro: 'Écart de {amount} — vérification du journal.',
    direct: 'Écart {amount}.',
  },
  'cloture.sectionExport': {
    pote: 'Envoyer au comptable',
    pro: 'Envoyer au comptable',
    direct: 'Export cabinet',
  },
  'cloture.sendDossier': {
    pote: 'Envoyer le dossier au comptable',
    pro: 'Envoyer le dossier au comptable',
    direct: 'Envoyer le dossier',
  },
  'cloture.sendingDossier': {
    pote: 'Préparation du dossier…',
    pro: 'Préparation du dossier…',
    direct: 'Préparation…',
  },
  'cloture.exportFec': {
    pote: 'Exporter le FEC seul',
    pro: 'Exporter le FEC seul',
    direct: 'FEC seul',
  },
  'cloture.exportingFec': {
    pote: 'Génération du FEC…',
    pro: 'Génération du FEC…',
    direct: 'Génération…',
  },
  'cloture.exportHelper': {
    pote: 'Le dossier = compte de résultat, bilan et balance. Le FEC (fichier des écritures) l’accompagne.',
    pro: 'Le dossier réunit compte de résultat, bilan et balance ; le FEC (fichier des écritures) l’accompagne.',
    direct: 'Dossier = 3 états + FEC.',
  },
  'cloture.dossierPrepared': {
    pote: '{filename} préparé — partage indisponible ici.',
    pro: '{filename} préparé. Partage indisponible sur cet appareil.',
    direct: '{filename} prêt.',
  },
  'cloture.fecGenerated': {
    pote: '{filename} généré.',
    pro: '{filename} généré.',
    direct: '{filename}.',
  },
  // DOSSIER-2 — la revue de pré-signature (Bob exécute les diligences, l'EC signe)
  'cloture.reviewSection': {
    pote: 'La revue de Bob',
    pro: 'Revue de pré-signature',
    direct: 'Revue',
  },
  'cloture.reviewReady': {
    pote: 'J’ai passé toutes mes vérifications : rien à signaler.',
    pro: 'Diligences exécutées : aucun point bloquant, aucune réserve.',
    direct: 'Tout est passé.',
  },
  'cloture.reviewReserves': {
    pote: 'Rien de bloquant, mais {count} point(s) à justifier à ton comptable.',
    pro: 'Aucun point bloquant ; {count} réserve(s) à l’appréciation de votre expert-comptable.',
    direct: '{count} réserve(s).',
  },
  'cloture.reviewBlocked': {
    pote: '{count} anomalie(s) à corriger avant d’envoyer — on regarde ensemble ?',
    pro: '{count} anomalie(s) comptable(s) à corriger avant signature.',
    direct: '{count} anomalie(s). À corriger.',
  },
  'cloture.reviewHint': {
    pote: 'Les vérifications qu’un expert-comptable fait avant de signer — je les fais pour toi, il contrôle et signe.',
    pro: 'Les diligences de révision sont exécutées par Bob ; votre expert-comptable contrôle et signe.',
    direct: 'Bob révise. Ton comptable signe.',
  },

  // ── BA-3 — écran « Pilotage » (revue business : CA, DSO, tops, SIG) ─────────
  'pilotage.back': { pote: 'Argent', pro: 'Argent', direct: 'Argent' },
  'pilotage.eyebrow': {
    pote: 'Ton activité en clair',
    pro: 'Votre activité en clair',
    direct: 'Pilotage',
  },
  'pilotage.title': { pote: 'Pilotage', pro: 'Pilotage', direct: 'Pilotage' },
  'pilotage.subtitle': {
    pote: 'Ce que tu factures, ce que tu encaisses, où ça part — et ce que ça dégage vraiment.',
    pro: 'Chiffre d’affaires facturé et encaissé, postes de dépense, marges — dérivés de votre comptabilité réelle.',
    direct: 'CA, encaissements, marges. Les vrais chiffres.',
  },
  'pilotage.coverage': {
    pote: 'Historique depuis {month}',
    pro: 'Historique observé depuis {month}',
    direct: 'Depuis {month}',
  },
  'pilotage.empty': {
    pote: 'Pas encore de mouvement : dès ta première facture ou ton premier encaissement, je te montre tout ici.',
    pro: 'Aucun mouvement pour le moment. Le pilotage s’activera dès la première facture ou le premier encaissement.',
    direct: 'Aucun mouvement. Facture, et ça s’affiche.',
  },
  'pilotage.sectionMonth': {
    pote: 'Ton mois en cours',
    pro: 'Le mois en cours',
    direct: 'Mois en cours',
  },
  'pilotage.atDay': { pote: 'au {day} du mois', pro: 'au {day} du mois', direct: 'au {day}' },
  'pilotage.invoicedLabel': {
    pote: 'Facturé (hors TVA)',
    pro: 'Facturé (hors TVA)',
    direct: 'Facturé HT',
  },
  'pilotage.invoicedHint': {
    pote: 'Ton activité du mois — la base de ton résultat.',
    pro: 'L’activité du mois — la base de votre résultat.',
    direct: 'Base du résultat.',
  },
  'pilotage.collectedLabel': {
    pote: 'Encaissé (TVA comprise)',
    pro: 'Encaissé (TVA comprise)',
    direct: 'Encaissé TTC',
  },
  'pilotage.collectedHint': {
    pote: 'Ce qui est vraiment arrivé sur ton compte.',
    pro: 'Ce qui est effectivement arrivé en banque.',
    direct: 'Arrivé en banque.',
  },
  'pilotage.isoCompare': {
    pote: 'vs le mois dernier à date égale',
    pro: 'vs mois précédent à date égale',
    direct: 'vs M-1 à date égale',
  },
  'pilotage.sectionTrend': { pote: 'La tendance', pro: 'Tendance', direct: 'Tendance' },
  'pilotage.trendMonths': {
    pote: '{month} vs {prev}',
    pro: '{month} vs {prev}',
    direct: '{month} vs {prev}',
  },
  'pilotage.trendTooEarly': {
    pote: 'Encore un peu tôt : il me faut deux mois complets pour comparer honnêtement.',
    pro: 'Deux mois complets sont nécessaires pour une comparaison fiable.',
    direct: 'Trop tôt. Deux mois complets requis.',
  },
  'pilotage.ytdLabel': {
    pote: 'Depuis le 1ᵉʳ janvier',
    pro: 'Cumul depuis le 1ᵉʳ janvier',
    direct: 'Cumul annuel',
  },
  'pilotage.ytdPrev': {
    pote: 'même période l’an dernier : {amount}',
    pro: 'même période l’an dernier : {amount}',
    direct: 'N-1 : {amount}',
  },
  'pilotage.sectionSeries': {
    pote: 'Mois par mois',
    pro: 'Historique mensuel',
    direct: 'Par mois',
  },
  'pilotage.sectionDso': {
    pote: 'On te paie en…',
    pro: 'Délai d’encaissement',
    direct: 'Délai de paiement',
  },
  'pilotage.dsoDays': { pote: '{days} jours', pro: '{days} jours', direct: '{days} j' },
  'pilotage.dsoHint': {
    pote: 'Le temps moyen entre ta facture et l’argent sur ton compte (90 derniers jours).',
    pro: 'Délai moyen entre facturation et encaissement, mesuré sur 90 jours.',
    direct: 'Facture → banque, sur 90 j.',
  },
  'pilotage.dsoLocked': {
    pote: '{amount} dorment chez tes clients.',
    pro: '{amount} immobilisés chez vos clients.',
    direct: '{amount} immobilisés.',
  },
  'pilotage.dsoAllCollected': {
    pote: 'Tout est encaissé — rien ne dort chez tes clients ✓',
    pro: 'Encours client nul : tout est encaissé.',
    direct: 'Tout encaissé ✓',
  },
  'pilotage.dsoNoHistory': {
    pote: 'Il me faut 3 mois de facturation pour mesurer ça — on y est presque.',
    pro: 'Trois mois de facturation sont nécessaires pour une mesure fiable.',
    direct: '3 mois de facturation requis.',
  },
  'pilotage.dsoNoInvoicing': {
    pote: 'Pas assez de facturation récente pour mesurer un délai fiable.',
    pro: 'Facturation récente insuffisante pour une mesure fiable.',
    direct: 'Pas assez de facturation récente.',
  },
  'pilotage.sectionTopClients': {
    pote: 'Tes plus gros clients (12 mois)',
    pro: 'Principaux clients (12 mois)',
    direct: 'Top clients (12 mois)',
  },
  'pilotage.topClientsHint': {
    pote: 'Facturé TTC — acompte et solde comptés une seule fois.',
    pro: 'Montants facturés TTC, sans double compte acompte/solde.',
    direct: 'Facturé TTC.',
  },
  'pilotage.othersClients': {
    pote: 'Autres ({count})',
    pro: 'Autres ({count})',
    direct: 'Autres ({count})',
  },
  'pilotage.creditNet': {
    pote: 'Avoirs nets ({count})',
    pro: 'Avoirs nets ({count})',
    direct: 'Avoirs nets ({count})',
  },
  'pilotage.concentration': {
    pote: '{name} pèse {share} % de ton activité — si ce client tousse, tu t’enrhumes.',
    pro: '{name} représente {share} % de l’activité : une dépendance à surveiller.',
    direct: '{name} : {share} % du CA. Dépendance.',
  },
  'pilotage.noClients': {
    pote: 'Pas encore de facturation sur les 12 derniers mois.',
    pro: 'Aucune facturation sur les 12 derniers mois.',
    direct: 'Rien sur 12 mois.',
  },
  'pilotage.sectionTopExpenses': {
    pote: 'Où part ton argent (12 mois)',
    pro: 'Principaux postes de dépense (12 mois)',
    direct: 'Top dépenses (12 mois)',
  },
  'pilotage.topExpensesHint': {
    pote: 'La charge comptabilisée, comme dans ton compte de résultat.',
    pro: 'Charge comptabilisée, cohérente avec le compte de résultat.',
    direct: 'Charge comptabilisée.',
  },
  'pilotage.noExpenses': {
    pote: 'Pas de dépense enregistrée sur les 12 derniers mois.',
    pro: 'Aucune dépense enregistrée sur les 12 derniers mois.',
    direct: 'Aucune dépense sur 12 mois.',
  },
  'pilotage.sectionSig': {
    pote: 'Ce que ton activité dégage',
    pro: 'Soldes intermédiaires de gestion',
    direct: 'Marges (SIG)',
  },
  'pilotage.sigCa': { pote: 'Chiffre d’affaires', pro: 'Chiffre d’affaires', direct: 'CA' },
  'pilotage.sigMarge': {
    pote: 'Marge sur matériaux',
    pro: 'Marge commerciale',
    direct: 'Marge matériaux',
  },
  'pilotage.sigConso': {
    pote: 'Achats & charges externes',
    pro: 'Consommations de tiers',
    direct: 'Achats & charges ext.',
  },
  'pilotage.sigVa': { pote: 'Valeur ajoutée', pro: 'Valeur ajoutée', direct: 'VA' },
  'pilotage.sigImpots': {
    pote: 'Impôts et taxes',
    pro: 'Impôts et taxes',
    direct: 'Impôts et taxes',
  },
  'pilotage.sigPersonnel': {
    pote: 'Charges de personnel',
    pro: 'Charges de personnel',
    direct: 'Personnel',
  },
  'pilotage.sigEbe': {
    pote: 'EBE — avant ta rémunération',
    pro: 'Excédent brut d’exploitation',
    direct: 'EBE',
  },
  'pilotage.sigEbeHint': {
    pote: 'Ce que ton activité dégage : de quoi te payer, investir, mettre de côté.',
    pro: 'Ce que l’exploitation dégage avant amortissements — et avant votre rémunération.',
    direct: 'Avant ta rémunération et l’URSSAF.',
  },
  'pilotage.sigRex': {
    pote: 'Résultat d’exploitation',
    pro: 'Résultat d’exploitation',
    direct: 'Résultat d’exploitation',
  },
  'pilotage.sigPeriod': {
    pote: 'Exercice en cours — recolle au centime à ton compte de résultat.',
    pro: 'Exercice en cours à date — cohérent au centime avec le compte de résultat.',
    direct: 'Exercice à date. Recolle au CR.',
  },
  'pilotage.ratioOfCa': { pote: '{pct} % du CA', pro: '{pct} % du CA', direct: '{pct} % CA' },
  'pilotage.entrySubtitle': {
    pote: 'CA, délais de paiement, marges — ton activité en clair.',
    pro: 'CA, délais de paiement, marges : votre activité en clair.',
    direct: 'CA, DSO, marges.',
  },
  'pilotage.paywallTitle': {
    pote: 'Le pilotage arrive avec l’offre Pro',
    pro: 'Le pilotage est disponible à partir de l’offre Pro',
    direct: 'Pilotage : offre Pro.',
  },
  'pilotage.paywallBody': {
    pote: 'Séries de CA, délais de paiement, marges et ratios — dérivés de ta compta réelle.',
    pro: 'Séries de chiffre d’affaires, DSO, marges et ratios dérivés de votre comptabilité.',
    direct: 'CA, DSO, marges, ratios.',
  },
  'pilotage.paywallCta': { pote: 'Voir les offres', pro: 'Voir les offres', direct: 'Les offres' },

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
  'compta.unbalanced': {
    pote: 'Déséquilibré !',
    pro: 'Déséquilibre détecté',
    direct: 'Déséquilibré',
  },
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

  // ── C27 — catalogue de prestations ──────────────────────────────────────────
  'catalogue.eyebrow': { pote: 'Ton catalogue', pro: 'Votre catalogue', direct: 'Catalogue' },
  'catalogue.title': {
    pote: 'Mon catalogue',
    pro: 'Catalogue de prestations',
    direct: 'Catalogue',
  },
  'catalogue.subtitle': {
    pote: 'Tes prestations, tes prix — je les garde et je te les propose au devis.',
    pro: 'Vos prestations et vos prix, proposés automatiquement dans vos devis.',
    direct: 'Tes prix. Proposés au devis.',
  },
  'catalogue.searchPlaceholder': {
    pote: 'Chercher une prestation…',
    pro: 'Rechercher une prestation…',
    direct: 'Chercher…',
  },
  'catalogue.catAll': { pote: 'Tout', pro: 'Tout', direct: 'Tout' },
  'catalogue.indicative': {
    pote: 'prix indicatif',
    pro: 'Prix indicatif',
    direct: 'indicatif',
  },
  'catalogue.persoBadge': { pote: 'ton prix', pro: 'Votre prix', direct: 'ton prix' },
  'catalogue.add': {
    pote: 'Ajouter une prestation',
    pro: 'Ajouter une prestation',
    direct: 'Ajouter',
  },
  'catalogue.sheetAddTitle': {
    pote: 'Nouvelle prestation',
    pro: 'Nouvelle prestation',
    direct: 'Nouvelle prestation',
  },
  'catalogue.sheetEditTitle': {
    pote: 'Modifier la prestation',
    pro: 'Modifier la prestation',
    direct: 'Modifier',
  },
  'catalogue.sheetCustomizeTitle': {
    pote: 'Mets ton prix',
    pro: 'Personnaliser la prestation',
    direct: 'Ton prix',
  },
  'catalogue.sheetCustomizeHint': {
    pote: 'Le prix affiché est un indicatif marché — enregistre le tien, c’est lui qui comptera.',
    pro: 'Le prix affiché est indicatif : enregistrez le vôtre, il sera utilisé partout.',
    direct: 'Prix indicatif. Mets le tien.',
  },
  'catalogue.labelField': { pote: 'Libellé', pro: 'Libellé', direct: 'Libellé' },
  'catalogue.labelPlaceholder': {
    pote: 'Ex. Chauffe-eau 200 L posé',
    pro: 'Ex. Chauffe-eau 200 L posé',
    direct: 'Ex. Chauffe-eau 200 L posé',
  },
  'catalogue.priceField': {
    pote: 'Prix unitaire HT',
    pro: 'Prix unitaire HT',
    direct: 'PU HT',
  },
  'catalogue.vatField': { pote: 'TVA', pro: 'TVA', direct: 'TVA' },
  'catalogue.vatRatePct': { pote: '{rate} %', pro: '{rate} %', direct: '{rate} %' },
  'catalogue.categoryField': { pote: 'Catégorie', pro: 'Catégorie', direct: 'Catégorie' },
  'catalogue.save': { pote: 'Enregistrer', pro: 'Enregistrer', direct: 'Enregistrer' },
  'catalogue.delete': {
    pote: 'Supprimer la prestation',
    pro: 'Supprimer la prestation',
    direct: 'Supprimer',
  },
  'catalogue.savedToast': {
    pote: 'C’est noté — ta presta est au catalogue.',
    pro: 'Prestation enregistrée.',
    direct: 'Enregistré.',
  },
  'catalogue.deletedToast': {
    pote: 'Presta retirée.',
    pro: 'Prestation supprimée.',
    direct: 'Supprimé.',
  },
  'catalogue.empty': {
    pote: 'Rien ici pour l’instant. Ajoute ta première presta ou change de filtre.',
    pro: 'Aucune prestation ne correspond.',
    direct: 'Rien.',
  },
  'catalogue.dataError': {
    pote: 'Je n’arrive pas à ouvrir ton catalogue, là. On réessaie ?',
    pro: 'Impossible de charger le catalogue. Veuillez réessayer.',
    direct: 'Catalogue injoignable. Réessaie.',
  },
  'catalogue.suggestTitle': {
    pote: 'Depuis ton catalogue',
    pro: 'Depuis votre catalogue',
    direct: 'Catalogue',
  },
  'catalogue.back': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },

  // ── C27 — réglages facturation (Facturation & modèles) ─────────────────────
  'reglages.eyebrow': { pote: 'Tes réglages', pro: 'Vos réglages', direct: 'Réglages' },
  'reglages.title': {
    pote: 'Facturation & modèles',
    pro: 'Facturation & modèles',
    direct: 'Facturation & modèles',
  },
  'reglages.subtitle': {
    pote: 'Ce que je mets sur tes devis et factures.',
    pro: 'Ce qui figure sur vos devis et factures.',
    direct: 'Ce qui part sur tes factures.',
  },
  'reglages.catalogueRow': {
    pote: 'Mon catalogue de prestations',
    pro: 'Catalogue de prestations',
    direct: 'Catalogue',
  },
  'reglages.catalogueRowSub': {
    pote: 'Tes prestations et tes prix',
    pro: 'Vos prestations et vos prix',
    direct: 'Prestations & prix',
  },
  'reglages.sectionVat': {
    pote: 'TVA & mentions légales',
    pro: 'TVA & mentions légales',
    direct: 'TVA & mentions',
  },
  'reglages.vatDefaultLabel': {
    pote: 'TVA par défaut de ton métier ({trade})',
    pro: 'TVA par défaut du métier ({trade})',
    direct: 'TVA par défaut ({trade})',
  },
  'reglages.mentionsAuto': {
    pote: 'Pénalités de retard, TVA, décennale si bâtiment… je pose les mentions obligatoires tout seul sur chaque pièce, selon ton régime et ton client.',
    pro: 'Les mentions obligatoires (pénalités de retard, TVA, assurance décennale le cas échéant) sont générées automatiquement sur chaque pièce, selon votre régime et votre client.',
    direct: 'Mentions obligatoires : posées automatiquement, pièce par pièce.',
  },
  'reglages.mentionsPreviewTitle': {
    pote: 'Sur ta dernière facture',
    pro: 'Sur votre dernière facture',
    direct: 'Dernière facture',
  },
  'reglages.mentionsEmpty': {
    pote: 'Émets ta première facture et tu verras ici les mentions exactes.',
    pro: 'Les mentions exactes apparaîtront ici dès votre première facture émise.',
    direct: 'Visible dès ta première facture.',
  },
  'reglages.sectionNumbering': {
    pote: 'Numérotation',
    pro: 'Numérotation',
    direct: 'Numérotation',
  },
  'reglages.numberingBody': {
    pote: 'Chaque facture prend le numéro suivant, sans trou ni doublon — c’est la loi, et je m’en occupe.',
    pro: 'Numérotation séquentielle sans rupture, allouée à l’émission — exigence légale gérée automatiquement.',
    direct: 'Séquence sans trou, allouée à l’émission. Géré.',
  },
  'reglages.lastNumber': {
    pote: 'Dernier numéro émis',
    pro: 'Dernier numéro émis',
    direct: 'Dernier numéro',
  },
  'reglages.noNumberYet': {
    pote: 'Aucune facture émise pour l’instant.',
    pro: 'Aucune facture émise pour le moment.',
    direct: 'Aucune facture émise.',
  },
  'reglages.sectionLogo': { pote: 'Logo', pro: 'Logo', direct: 'Logo' },
  'reglages.logoSoon': {
    pote: 'Ton logo sur tes devis et factures — j’y travaille, ça arrive.',
    pro: 'L’ajout de votre logo sur vos documents arrive prochainement.',
    direct: 'Logo sur les PDF : bientôt.',
  },
  'reglages.sectionRib': {
    pote: 'Coordonnées bancaires (RIB)',
    pro: 'Coordonnées bancaires (RIB)',
    direct: 'RIB',
  },
  'reglages.ribSoon': {
    pote: 'Ton RIB sur les factures pour les virements — ça arrive aussi.',
    pro: 'L’affichage du RIB sur les factures (paiement par virement) arrive prochainement.',
    direct: 'RIB sur factures : bientôt.',
  },
  'reglages.soonBadge': { pote: 'Bientôt', pro: 'À venir', direct: 'Bientôt' },
  'reglages.dataError': {
    pote: 'Je n’arrive pas à lire tes réglages, là. On réessaie ?',
    pro: 'Impossible de charger les réglages. Veuillez réessayer.',
    direct: 'Réglages injoignables. Réessaie.',
  },
  'reglages.back': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },

  // ── C26 — Compte & abonnement ───────────────────────────────────────────────
  'account.back': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },
  'account.eyebrow': { pote: 'Ton compte', pro: 'Votre compte', direct: 'Compte' },
  'account.title': { pote: 'Mon compte', pro: 'Mon compte', direct: 'Mon compte' },
  'account.subtitle': {
    pote: 'Ton profil, ton offre, ton équipe.',
    pro: 'Votre profil, votre offre, votre équipe.',
    direct: 'Profil · offre · équipe.',
  },
  'account.tabProfile': { pote: 'Profil', pro: 'Profil', direct: 'Profil' },
  'account.tabSubscription': {
    pote: 'Abonnement',
    pro: 'Abonnement',
    direct: 'Abonnement',
  },
  'account.sectionCompany': { pote: 'Entreprise', pro: 'Entreprise', direct: 'Entreprise' },
  'account.companyName': {
    pote: 'Raison sociale',
    pro: 'Raison sociale',
    direct: 'Raison sociale',
  },
  'account.companySiret': { pote: 'SIRET', pro: 'SIRET', direct: 'SIRET' },
  'account.companyLegalTrade': {
    pote: 'Forme · activité',
    pro: 'Forme · activité',
    direct: 'Forme · activité',
  },
  'account.companyVat': { pote: 'Régime TVA', pro: 'Régime TVA', direct: 'TVA' },
  'account.companyEmpty': {
    pote: 'Ta fiche entreprise s’affichera ici dès que ton compte sera relié à ta société.',
    pro: 'Les informations de votre entreprise s’afficheront ici une fois votre société reliée à votre compte.',
    direct: 'Fiche entreprise : pas encore reliée.',
  },
  'account.billingRow': {
    pote: 'Facturation & modèles',
    pro: 'Facturation & modèles',
    direct: 'Facturation & modèles',
  },
  'account.billingRowSub': {
    pote: 'Logo, RIB, mentions, numérotation',
    pro: 'Logo, RIB, mentions, numérotation',
    direct: 'Logo · RIB · mentions · numéros',
  },
  'account.sectionConnections': {
    pote: 'Connexions',
    pro: 'Connexions',
    direct: 'Connexions',
  },
  'account.connBank': { pote: 'Banque', pro: 'Banque', direct: 'Banque' },
  'account.connPayment': { pote: 'Paiement', pro: 'Paiement', direct: 'Paiement' },
  'account.connAccountant': { pote: 'Comptable', pro: 'Comptable', direct: 'Comptable' },
  'account.connToConnect': {
    pote: 'À connecter',
    pro: 'À connecter',
    direct: 'À connecter',
  },
  'account.connSoon': { pote: 'À venir', pro: 'À venir', direct: 'Bientôt' },
  'account.referralTitle': {
    pote: 'Parraine un pote',
    pro: 'Parrainez un confrère',
    direct: 'Parrainage',
  },
  'account.referralSoon': {
    pote: 'Bientôt : un mois offert pour vous deux.',
    pro: 'Prochainement : un mois offert pour vous deux.',
    direct: 'Bientôt. Un mois offert chacun.',
  },
  'account.teamRow': {
    pote: 'Équipe & rôles',
    pro: 'Équipe & rôles',
    direct: 'Équipe & rôles',
  },
  'account.teamRowSub': {
    pote: 'Invite, attribue des rôles — bientôt.',
    pro: 'Invitations et rôles — prochainement.',
    direct: 'Invitations, rôles. Bientôt.',
  },
  'account.signOut': {
    pote: 'Se déconnecter',
    pro: 'Se déconnecter',
    direct: 'Déconnexion',
  },
  'account.offerLabel': { pote: 'Ton offre', pro: 'Votre offre', direct: 'Offre' },
  'account.offerEarlyAccess': {
    pote: 'Accès anticipé',
    pro: 'Accès anticipé',
    direct: 'Accès anticipé',
  },
  'account.offerPerMonth': { pote: '/mois', pro: '/mois', direct: '/mois' },
  'account.offerOpenPill': { pote: 'tout ouvert', pro: 'Tout ouvert', direct: 'ouvert' },
  'account.offerEarlyBody': {
    pote: 'Toutes les fonctions sont ouvertes et tu ne paies rien. Je te préviens bien avant que ça change.',
    pro: 'Toutes les fonctions sont ouvertes, sans frais. Vous serez prévenu avant toute évolution.',
    direct: 'Tout ouvert. 0 €. Prévenu avant tout changement.',
  },
  'account.sectionPlans': {
    pote: 'Changer d’offre',
    pro: 'Changer d’offre',
    direct: 'Offres',
  },
  'account.planCtaUnavailable': {
    pote: 'Dispo à l’ouverture de la facturation',
    pro: 'Disponible à l’ouverture de la facturation',
    direct: 'À l’ouverture de la facturation',
  },
  'account.planCurrent': {
    pote: 'Ton offre actuelle',
    pro: 'Votre offre actuelle',
    direct: 'Offre actuelle',
  },
  'account.sectionSubInvoices': {
    pote: 'Mes factures d’abonnement',
    pro: 'Mes factures d’abonnement',
    direct: 'Factures d’abo',
  },
  'account.invoicesEmpty': {
    pote: 'Tu ne paies rien pendant l’accès anticipé — donc zéro facture. Elles s’afficheront ici le moment venu.',
    pro: 'Aucune facture : l’accès anticipé est gratuit. Elles apparaîtront ici le moment venu.',
    direct: 'Accès anticipé : 0 facture.',
  },
  'account.sectionServices': {
    pote: 'Services en plus',
    pro: 'Services en plus',
    direct: 'Services',
  },
  'account.serviceOnlinePayment': {
    pote: 'Paiement en ligne',
    pro: 'Paiement en ligne',
    direct: 'Paiement en ligne',
  },
  'account.serviceOnlinePaymentSub': {
    pote: 'Encaisse par carte — 1,2 % par encaissement',
    pro: 'Encaissement par carte — 1,2 % par transaction',
    direct: 'CB — 1,2 % par encaissement',
  },
  'account.serviceAdvance': {
    pote: 'Avance sur facture',
    pro: 'Avance sur facture',
    direct: 'Avance sur facture',
  },
  'account.serviceAdvanceSub': {
    pote: 'Ton argent sans attendre l’échéance',
    pro: 'Financement de vos factures avant l’échéance',
    direct: 'Cash avant échéance',
  },
  'account.serviceInsurance': {
    pote: 'Assurance décennale & RC Pro',
    pro: 'Assurance décennale & RC Pro',
    direct: 'Décennale & RC Pro',
  },
  'account.serviceInsuranceSub': {
    pote: 'Couvert via un partenaire, sans paperasse',
    pro: 'Couverture via un partenaire assureur',
    direct: 'Via partenaire',
  },
  'account.serviceAccountant': {
    pote: 'Comptable partenaire',
    pro: 'Comptable partenaire',
    direct: 'Comptable partenaire',
  },
  'account.serviceAccountantSub': {
    pote: 'Un pro de la compta qui connaît déjà tes dossiers',
    pro: 'Un expert-comptable partenaire, connecté à vos données',
    direct: 'Expert-comptable connecté',
  },
  'account.serviceActive': { pote: 'Actif', pro: 'Actif', direct: 'Actif' },
  'account.serviceSoon': { pote: 'À venir', pro: 'À venir', direct: 'Bientôt' },
  'account.dataError': {
    pote: 'Je n’arrive pas à lire ton profil, là. On réessaie ?',
    pro: 'Impossible de charger le profil. Veuillez réessayer.',
    direct: 'Profil injoignable. Réessaie.',
  },
  'account.profileLoading': {
    pote: 'Je charge ton profil.',
    pro: 'Chargement du profil.',
    direct: 'Chargement du profil.',
  },
  'account.subscriptionLoading': {
    pote: 'Je vérifie ton abonnement.',
    pro: 'Chargement de l’abonnement.',
    direct: 'Chargement de l’abonnement.',
  },
  'account.subscriptionError': {
    pote: 'Je n’arrive pas à vérifier ton abonnement. Je préfère ne rien inventer : réessaie.',
    pro: 'Impossible de charger les informations d’abonnement. Veuillez réessayer.',
    direct: 'Abonnement injoignable. Réessaie.',
  },

  // ── C-EXP-UI1 — les moteurs d'expertise à l'écran ──────────────────────────
  // Échéancier fiscal sur l'écran Argent (deriveFiscalCalendar, C-EXP5/5b) :
  // dates réelles dérivées de la fiche société, JAMAIS de montant (amountHint null en v1).
  'argent.upcomingTitle': {
    pote: 'À venir',
    pro: 'Échéances à venir',
    direct: 'À venir',
  },
  'argent.upcomingEmpty': {
    pote: 'Rien à l’horizon : aucune échéance fiscale dans les 90 prochains jours. Tranquille.',
    pro: 'Aucune échéance fiscale dans les 90 prochains jours.',
    direct: 'Rien sous 90 j.',
  },
  'argent.upcomingError': {
    pote: 'J’arrive pas à charger tes échéances, là. Le reste de l’écran reste bon.',
    pro: 'Impossible de charger les échéances fiscales pour le moment.',
    direct: 'Échéances injoignables.',
  },
  // Badge des échéances 'assumed' (périodicité/clôture inconnues → hypothèse honnête).
  'argent.upcomingAssumed': {
    pote: 'à confirmer',
    pro: 'À confirmer',
    direct: 'à confirmer',
  },
  // Recouvrement (écran relances) : pénalités courues P12 — b2b/b2g seulement,
  // formatées depuis LatePenalties (dailyCents/interestCents), zéro calcul à l'écran.
  'relance.penaltiesLine': {
    pote: '+{daily}/jour · {accrued} courus',
    pro: '+{daily} par jour · {accrued} courus à ce jour',
    direct: '+{daily}/j · {accrued}',
  },
  // Chrono de prescription P04 — paliers d'urgence de derivePrescription.
  'relance.prescriptionFar': {
    pote: 'Prescription : t’as jusqu’au {date}.',
    pro: 'Prescription : action possible jusqu’au {date}.',
    direct: 'Prescription {date}.',
  },
  'relance.prescriptionLost': {
    pote: 'Après le {date}, c’est perdu — plus aucun recours.',
    pro: 'Après le {date}, la créance sera prescrite : plus aucun recours judiciaire.',
    direct: 'Après le {date} : perdu.',
  },
  'relance.prescriptionDead': {
    pote: 'Trop tard : prescrite depuis le {date}. Plus de recours en justice.',
    pro: 'Créance prescrite depuis le {date} — aucun recours judiciaire possible.',
    direct: 'Prescrite depuis le {date}.',
  },

  // ── C-EXP-UI2 — la provision URSSAF visible (écran Argent) ─────────────────
  // Carte « déclaration pré-calculée » sous le grand-livre (doctrine « Bob FAIT ») :
  // {period} = periodLabel du moteur (« T3 2026 » / « juillet 2026 »), le montant est
  // formatEUR(provisionCents) et l'explain vient de deriveUrssafProvision (@bob/core)
  // — voix Bob calculée au moteur, JAMAIS recomposée à l'écran.
  'argent.urssafTitle': {
    pote: 'Ta déclaration URSSAF · {period}',
    pro: 'Déclaration URSSAF · {period}',
    direct: 'URSSAF · {period}',
  },
  'argent.urssafSetAside': {
    pote: 'À mettre de côté',
    pro: 'Montant à provisionner',
    direct: 'À provisionner',
  },
  'argent.urssafDeclareBy': {
    pote: 'À déclarer au plus tard le {date}',
    pro: 'À déclarer au plus tard le {date}',
    direct: 'Déclaration : {date} max.',
  },
} as const satisfies Record<string, Copy>;

const fr = { ...legacyFr, ...cabinetFr, ...monetizationFr } as const satisfies Record<string, Copy>;

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
