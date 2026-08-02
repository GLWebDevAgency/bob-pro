/**
 * @bob/i18n — la copy de Bob, indexée par personnalité (VOICE_AND_TONE.md).
 * Toute chaîne visible dans l'app vient d'ici : une clé = une entrée par humeur
 * (Pote par défaut, Pro, Direct). Les claims d'écran ajoutent leurs clés (C10+).
 */

import { cabinetFr } from './catalogs/cabinet';
import { monetizationFr } from './catalogs/monetization';
import { fiscalFr } from './catalogs/fiscal';
import { legalFr } from './catalogs/legal';
import { billingTerrainFr } from './catalogs/billing-terrain';

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
  'common.close': { pote: 'Fermer', pro: 'Fermer', direct: 'Fermer' },
  'common.cancel': { pote: 'Annuler', pro: 'Annuler', direct: 'Annuler' },
  'common.retry': { pote: 'Réessayer', pro: 'Réessayer', direct: 'Réessayer' },
  // Valeur absente lue par un lecteur d'écran — « — » visuel, jamais « tiret » verbalisé.
  'common.notProvided': { pote: 'non renseigné', pro: 'non renseigné', direct: 'non renseigné' },

  // ── Lot 1 — chrome : libellés des 5 onglets (source unique ITEMS, (tabs)/_layout.tsx).
  // Chaînes IDENTIQUES dans les 3 tons au premier jour (plan DA 01/08 : « zéro changement
  // visible ») — la voix de Bob POURRA les différencier plus tard sans toucher au layout.
  'tabs.index': { pote: "Aujourd'hui", pro: "Aujourd'hui", direct: "Aujourd'hui" },
  'tabs.clients': { pote: 'Clients', pro: 'Clients', direct: 'Clients' },
  'tabs.argent': { pote: 'Argent', pro: 'Argent', direct: 'Argent' },
  'tabs.documents': { pote: 'Documents', pro: 'Documents', direct: 'Documents' },
  'tabs.assistant': { pote: 'Assistant', pro: 'Assistant', direct: 'Assistant' },
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
    pote: 'Solde bancaire observé',
    pro: 'Solde bancaire observé',
    direct: 'Solde observé',
  },
  'today.balanceObservedHint': {
    pote: 'C’est le dernier solde que tu as confirmé. Les prévisions restent séparées dans Argent.',
    pro: 'Dernier solde confirmé. Les projections sont présentées séparément dans Argent.',
    direct: 'Dernier solde confirmé. Projections dans Argent.',
  },
  // ── Position de trésorerie : DEUX nombres, jamais un seul ──────────────────
  // Le solde constaté est un FAIT daté qui ne bouge pas tant que personne ne reconstate la
  // banque ; l'affichr seul faisait croire à un bug (« j'encaisse, le solde ne bouge pas »).
  // La position ESTIMÉE lui ajoute les mouvements postérieurs — et se présente TOUJOURS comme
  // une estimation, jamais comme un relevé.
  'today.balanceEstimatedLabel': {
    pote: 'Ce que tu dois avoir en banque',
    pro: 'Position de trésorerie estimée',
    direct: 'Position estimée',
  },
  'today.balanceEstimatedVoice': {
    pote: 'Constaté {observed} le {date} — j’ai ajouté ce qui a bougé depuis.',
    pro: 'Solde constaté {observed} le {date}, ajusté des mouvements postérieurs.',
    direct: 'Constaté {observed} le {date}. Le reste est estimé.',
  },
  'today.balanceMovementsBadge': {
    pote: '+{inflow} encaissés · −{outflow} sortis',
    pro: '+{inflow} encaissés · −{outflow} décaissés',
    direct: '+{inflow} · −{outflow}',
  },
  'today.balanceMovementsHint': {
    pote: 'Ouvre Argent pour voir le détail.',
    pro: 'Ouvrir Argent pour consulter le détail.',
    direct: 'Détail dans Argent.',
  },
  'today.balanceMissingHint': {
    pote: 'Confirme ton solde dans Argent — je ne vais rien inventer.',
    pro: 'Confirmez le solde dans Argent. Aucune valeur n’est estimée à sa place.',
    direct: 'Confirme le solde dans Argent.',
  },
  'today.balanceUnavailableHint': {
    pote: 'Je n’arrive pas à relire ton solde. Ouvre Argent pour réessayer.',
    pro: 'Le solde bancaire est temporairement indisponible. Ouvrez Argent pour réessayer.',
    direct: 'Solde indisponible. Réessaie dans Argent.',
  },
  // CTA du geste attendu quand la trésorerie attend une confirmation de solde (périmé ou
  // jamais confirmé) : mène à Argent avec la feuille de confirmation DÉJÀ ouverte.
  'today.confirmBalanceCta': {
    pote: 'Confirmer mon solde',
    pro: 'Confirmer le solde',
    direct: 'Confirmer le solde',
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
    pote: 'Projection à 30 jours',
    pro: 'Projection à 30 jours',
    direct: 'Projection 30 j',
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
  // La tuile ouvre la vue pré-filtrée « factures émises » de /ventes (deep link status=issued,
  // today-quick-actions.ts) : le libellé nomme la DESTINATION (« À encaisser »), pas un verbe
  // d'action qui promettait un encaissement immédiat.
  'today.quickCollect': {
    pote: 'À encaisser',
    pro: 'À encaisser',
    direct: 'À encaisser',
  },
  'today.quickCatalogue': {
    pote: 'Catalogue',
    pro: 'Catalogue',
    direct: 'Catalogue',
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
  // PR-12c — « facture annuelle à émettre » (Bloc B) : carte DÉRIVÉE de deriveAnnualBillingDue
  // (période arithmétique + factures réelles). Extinction/réallumage par l'état réel UNIQUEMENT.
  'today.prioContractInvoiceTitle': {
    pote: 'Facture annuelle à émettre — {label}',
    pro: 'Facture annuelle à émettre — {label}',
    direct: 'Annuelle à émettre — {label}',
  },
  'today.prioContractInvoiceBadge': {
    pote: 'Contrat',
    pro: 'Contrat',
    direct: 'Contrat',
  },
  'today.prioContractInvoiceHint': {
    pote: 'Période {start} → {end} pas encore facturée.',
    pro: 'Période {start} → {end} non facturée.',
    direct: '{start} → {end} non facturée.',
  },
  'today.prioContractRebillHint': {
    pote: 'La facture {number} a été annulée : la période {start} → {end} est à re-facturer.',
    pro: 'La facture {number} a été annulée — la période {start} → {end} redevient à facturer.',
    direct: '{number} annulée — {start} → {end} à re-facturer.',
  },
  'today.ctaPrepareContractDraft': {
    pote: 'Préparer le brouillon',
    pro: 'Préparer le brouillon',
    direct: 'Brouillon',
  },
  // PR-13 — renouvellement J-60/J-30 (interne, jamais un envoi client).
  'today.prioRenewalTacitTitle': {
    pote: 'Se reconduit dans {days} jours — {label}',
    pro: 'Se reconduit dans {days} jours — {label}',
    direct: 'Reconduction J-{days} — {label}',
  },
  'today.prioRenewalNonTacitTitle': {
    pote: 'Arrive à échéance dans {days} jours — {label}',
    pro: 'Arrive à échéance dans {days} jours — {label}',
    direct: 'Échéance J-{days} — {label}',
  },
  'today.prioRenewalBadge': {
    pote: 'Renouvellement',
    pro: 'Renouvellement',
    direct: 'Renouv.',
  },
  'today.ctaSeeContract': {
    pote: 'Voir le contrat',
    pro: 'Voir le contrat',
    direct: 'Voir',
  },
  // Devis à transmettre (cas terrain fondateur 2026-07-20) : le devis est passé `sent` — son
  // numéro légal est alloué — mais le client n'a pas d'e-mail, donc rien n'est parti. La copy
  // dit CE QUI MANQUE et CE QU'ON PEUT FAIRE, sans jargon : ajouter l'adresse, ou envoyer le
  // lien par le canal que l'artisan a déjà (WhatsApp, SMS…) via la feuille de partage native.
  'today.prioTransmitBadge': {
    pote: 'À transmettre',
    pro: 'À transmettre',
    direct: 'À transmettre',
  },
  'today.prioTransmitTitle': {
    pote: 'Devis pas encore reçu — {name}',
    pro: 'Devis non transmis — {name}',
    direct: 'Devis non reçu — {name}',
  },
  'today.prioTransmitHint': {
    pote: 'Pas d’e-mail pour ce client, donc personne ne l’a reçu. Ajoute son adresse, ou envoie-lui le lien directement.',
    pro: 'Aucune adresse e-mail pour ce client : le devis n’a pas pu être transmis. Ajoutez son adresse, ou partagez-lui le lien.',
    direct: 'Pas d’e-mail : rien n’est parti. Ajoute l’adresse, ou envoie le lien.',
  },
  'today.ctaTransmitAddEmail': {
    pote: 'Ajouter l’e-mail',
    pro: 'Ajouter l’adresse e-mail',
    direct: 'Ajouter l’e-mail',
  },
  'today.ctaTransmitShare': {
    pote: 'Envoyer le lien',
    pro: 'Partager le lien',
    direct: 'Envoyer le lien',
  },
  // PR-02 « Encaisser » — facture ÉMISE jamais transmise (aucun envoi constaté, aucun dépôt
  // déclaré) : la douleur n° 1 de Fly Services (2 % encaissé), impossible à rater.
  'today.prioInvoiceTransmitTitle': {
    pote: 'Facture jamais envoyée — {name}',
    pro: 'Facture non transmise — {name}',
    direct: 'Facture non partie — {name}',
  },
  'today.prioInvoiceTransmitHint': {
    pote: 'Elle est émise, mais rien ne prouve qu’elle est partie. Tant qu’elle n’arrive pas, elle ne sera jamais payée.',
    pro: 'La pièce est émise, mais aucun envoi n’est constaté. Une facture jamais transmise ne sera jamais réglée.',
    direct: 'Émise, jamais partie. Pas partie = jamais payée.',
  },
  'today.prioInvoiceTransmitBadge': {
    pote: 'À transmettre',
    pro: 'À transmettre',
    direct: 'À transmettre',
  },
  'today.ctaInvoiceTransmit': {
    pote: 'Envoyer la facture',
    pro: 'Transmettre la facture',
    direct: 'Envoyer',
  },
  // PR-05 — devis sans réponse J+15/J+30 (relance manuelle pré-rédigée, jamais envoyée seule).
  'today.prioQuoteRelanceTitle': {
    pote: 'Devis sans réponse — {name}',
    pro: 'Devis sans réponse — {name}',
    direct: 'Sans réponse — {name}',
  },
  'today.prioQuoteRelanceHint': {
    pote: 'envoyé il y a {days} jours. Une relance courtoise et ça repart — le message est déjà écrit.',
    pro: 'transmis il y a {days} jours. Une relance courtoise augmente les chances de signature — le message est prêt.',
    direct: '{days} j sans réponse. Message prêt.',
  },
  'today.prioQuoteRelanceBadgeJ15': {
    pote: 'J+15',
    pro: 'J+15',
    direct: 'J+15',
  },
  'today.prioQuoteRelanceBadgeJ30': {
    pote: 'J+30',
    pro: 'J+30',
    direct: 'J+30',
  },
  'today.ctaQuoteRelance': {
    pote: 'Relancer',
    pro: 'Relancer le client',
    direct: 'Relancer',
  },
  // PR-05 — fiche devis : le rappel « un message pré-rédigé vous attend » (deep link /devis/[id])
  // est TENU ici — même palier que le cron, même copy que la carte Aujourd'hui.
  'devis.relanceCardTitle': {
    pote: 'Relance prête',
    pro: 'Relance prête à partir',
    direct: 'Relance prête',
  },
  'devis.relanceCardHint': {
    pote: 'Sans réponse depuis {days} jours. Le message ci-dessous est prêt — rien ne part sans toi.',
    pro: 'Sans réponse depuis {days} jours. Le message ci-dessous est pré-rédigé — rien ne part sans votre geste.',
    direct: '{days} j sans réponse. Message prêt — rien ne part sans toi.',
  },
  // PR-14 — « Refaire ce devis » : duplication en NOUVEAU brouillon via CreateQuote (TVA
  // revalidée au régime du jour ; signature, urgence, n°, validité JAMAIS copiés).
  'devis.duplicateCta': {
    pote: 'Refaire ce devis',
    pro: 'Refaire ce devis',
    direct: 'Refaire',
  },
  'devis.duplicateConfirmTitle': {
    pote: 'Refaire ce devis ?',
    pro: 'Dupliquer ce devis ?',
    direct: 'Refaire ce devis ?',
  },
  'devis.duplicateConfirmBody': {
    pote: 'Bob crée un NOUVEAU brouillon : mêmes lignes, remises et site. La TVA est revalidée au régime du jour ; signature, urgence, numéro et validité repartent de zéro.',
    pro: 'Un nouveau brouillon est créé : lignes, remises et site identiques. La TVA est revalidée au régime actuel ; signature, urgence, numéro et validité ne sont jamais repris.',
    direct: 'Nouveau brouillon. Mêmes lignes. TVA revalidée. Rien d’autre repris.',
  },
  'devis.duplicateConfirmCta': {
    pote: 'Créer le brouillon',
    pro: 'Créer le brouillon',
    direct: 'Créer',
  },
  // Taux réduits travaux : l'éligibilité est RE-DEMANDÉE — le fait légal appartient à la
  // nouvelle pièce, jamais copié (suggestVatRate refuse sinon, refus actionnable).
  'devis.duplicateEligibilityTitle': {
    pote: 'TVA réduite : toujours d’actualité ?',
    pro: 'Taux réduit : conditions à reconfirmer',
    direct: 'TVA réduite : on reconfirme ?',
  },
  'devis.duplicateEligibilityBody': {
    pote: 'Ce devis porte de la TVA réduite (logement de plus de 2 ans{energy}). C’est encore le cas pour le nouveau devis ?',
    pro: 'Ce devis comporte des lignes au taux réduit (logement achevé depuis plus de 2 ans{energy}). Ces conditions valent-elles pour le nouveau devis ?',
    direct: 'TVA réduite (logement > 2 ans{energy}). Toujours vrai ?',
  },
  'devis.duplicateEligibilityEnergy': {
    pote: ' et rénovation énergétique',
    pro: ' et rénovation énergétique',
    direct: ' + rénov énergétique',
  },
  'devis.duplicateEligibilityYes': {
    pote: 'Oui — conditions remplies',
    pro: 'Oui — conditions remplies',
    direct: 'Oui',
  },
  'devis.duplicateEligibilityNo': {
    pote: 'Non — TVA 20 %',
    pro: 'Non — repasser à 20 %',
    direct: 'Non — 20 %',
  },
  'devis.duplicateDone': {
    pote: 'Brouillon créé — à toi de jouer.',
    pro: 'Brouillon créé.',
    direct: 'Brouillon créé.',
  },
  'devis.duplicateVatAdjusted': {
    pote: 'TVA recalculée au régime actuel : {count} ligne(s) ajustée(s).',
    pro: 'TVA recalculée au régime actuel : {count} ligne(s) ajustée(s).',
    direct: 'TVA ajustée sur {count} ligne(s).',
  },
  // PR-05 — devis signé SANS n° de bon de commande alors que le contexte l'exige (b2g ou
  // canal chorus/portail) : sans BC, la facture dérivée sera rejetée par l'acheteur.
  'today.prioBcManquantTitle': {
    pote: 'BC manquant — {name}',
    pro: 'Bon de commande manquant — {name}',
    direct: 'BC manquant — {name}',
  },
  'today.prioBcManquantHint': {
    pote: 'devis signé, mais pas de n° de commande. Sans lui, la facture sera rejetée — récupère-le maintenant.',
    pro: 'devis signé sans n° de commande : la facture serait rejetée par l’acheteur. Saisissez-le dès réception.',
    direct: 'Signé sans BC. Facture rejetée sans lui.',
  },
  'today.prioBcManquantBadge': {
    pote: 'BC manquant',
    pro: 'BC manquant',
    direct: 'BC manquant',
  },
  'today.ctaBcManquant': {
    pote: 'Saisir le BC',
    pro: 'Saisir le bon de commande',
    direct: 'Saisir le BC',
  },
  // Rappel de brouillon de devis (C21 redécoupe 2026-07-17) — CLIENT-SIDE, jamais remonté au
  // serveur : composé dans le rendu du Home à partir du brouillon local (voir quote-draft).
  // Sobriété : n'apparaît qu'après ~1 h, ou à la réouverture de l'app — jamais pendant l'édition.
  'today.prioDraftTitle': {
    pote: 'Devis en cours — {name}',
    pro: 'Devis en préparation — {name}',
    direct: 'Devis en cours — {name}',
  },
  'today.prioDraftNoCustomer': {
    pote: 'un client',
    pro: 'un client',
    direct: 'un client',
  },
  'today.prioDraftHint': {
    pote: 'Un brouillon t’attend, jamais envoyé — reprends-le ou laisse-le filer.',
    pro: 'Un brouillon local n’a pas encore été envoyé.',
    direct: 'Brouillon local, pas envoyé.',
  },
  'today.prioDraftBadge': {
    pote: 'Brouillon',
    pro: 'Brouillon',
    direct: 'Brouillon',
  },
  'today.ctaDraftResume': {
    pote: 'Continuer',
    pro: 'Continuer',
    direct: 'Continuer',
  },
  'today.ctaDraftDelete': {
    pote: 'Supprimer le brouillon',
    pro: 'Supprimer le brouillon',
    direct: 'Supprimer',
  },
  'today.draftDeleteConfirmTitle': {
    pote: 'Supprimer ce brouillon ?',
    pro: 'Supprimer ce brouillon ?',
    direct: 'Supprimer le brouillon ?',
  },
  'today.draftDeleteConfirmBody': {
    pote: 'Le brouillon de devis pour {name} sera définitivement supprimé. Cette action est irréversible.',
    pro: 'Le brouillon de devis pour {name} sera définitivement supprimé. Cette action est irréversible.',
    direct: 'Brouillon {name} supprimé pour de bon. Irréversible.',
  },
  'today.voiceDraftResume': {
    pote: 'Je rouvre ton devis en cours.',
    pro: 'Le devis en cours se rouvre.',
    direct: 'Devis en cours rouvert.',
  },
  'today.voiceDraftDeleteOpened': {
    pote: 'Confirme à l’écran pour supprimer le brouillon.',
    pro: 'Confirmez à l’écran pour supprimer le brouillon.',
    direct: 'Confirme à l’écran.',
  },
  // Erreur de chargement — la voix de Bob, jamais un code d'erreur ni un chiffre inventé (A1-C10).
  'today.dataError': {
    pote: 'Je n’arrive pas à joindre le serveur. On réessaie dans un instant ?',
    pro: 'Connexion impossible pour le moment. Veuillez réessayer dans un instant.',
    direct: 'Hors ligne. Réessaie.',
  },
  'today.retry': {
    pote: 'Réessayer',
    pro: 'Réessayer',
    direct: 'Réessayer',
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
  'argent.balanceNeededTitle': {
    pote: 'Dis-moi ce qu’il y a vraiment en banque',
    pro: 'Confirmez votre solde bancaire',
    direct: 'Solde bancaire requis',
  },
  'argent.balanceNeededBody': {
    pote: 'Sans solde récent, je préfère ne rien inventer. Tu peux le confirmer maintenant ; il restera valable 24 h.',
    pro: 'Aucune projection n’est affichée sans solde récent. Confirmez-le maintenant ; cette preuve reste qualifiée 24 h.',
    direct: 'Pas de projection sans solde récent. Validité : 24 h.',
  },
  'argent.balanceNeededCta': {
    pote: 'Confirmer mon solde',
    pro: 'Confirmer le solde',
    direct: 'Saisir le solde',
  },
  'argent.balanceRefreshCta': {
    pote: 'Actualiser',
    pro: 'Actualiser',
    direct: 'Actualiser',
  },
  // ── Solde PÉRIMÉ (BANK_BALANCE_FRESHNESS_POLICY_V1 : confirmation expirée à 24 h) —
  // pédagogie au point de décision (patron LegalHint) : POURQUOI Bob refuse un solde
  // périmé, pas seulement « confirme ». Jamais un ton d'erreur : rien n'est cassé.
  'argent.staleTitle': {
    pote: 'Ton solde a pris un coup de vieux',
    pro: 'Votre solde doit être reconfirmé',
    direct: 'Solde à reconfirmer',
  },
  'argent.staleBody': {
    pote: 'Ton dernier solde confirmé a plus de 24 h. Une vieille vérité n’est pas une vérité : plutôt que de calculer tes prévisions sur du périmé, je te le redemande.',
    pro: 'Le dernier solde confirmé date de plus de 24 heures. Une vieille vérité n’est pas une vérité : aucune projection n’est calculée sur une donnée périmée.',
    direct: 'Solde confirmé il y a plus de 24 h. Une vieille vérité n’est pas une vérité : je ne calcule rien sur du périmé.',
  },
  'argent.staleWhy': {
    pote: 'C’est ma règle de fraîcheur : un solde confirmé vaut 24 h. C’est elle qui garde mes chiffres honnêtes.',
    pro: 'Règle de fraîcheur : un solde confirmé reste qualifié 24 h. C’est ce qui garantit des chiffres honnêtes.',
    direct: 'Règle de fraîcheur : 24 h. Chiffres honnêtes.',
  },
  // Labels distincts des 2 SegmentedControl de la carte prévision — au lecteur d'écran,
  // deux contrôles nommés pareil sur LA carte financière étaient indiscernables.
  'argent.horizonControlLabel': {
    pote: 'Horizon',
    pro: 'Horizon',
    direct: 'Horizon',
  },
  'argent.scenarioControlLabel': {
    pote: 'Scénario',
    pro: 'Scénario',
    direct: 'Scénario',
  },
  'argent.balanceObserved': {
    pote: 'Solde confirmé récemment · source propriétaire',
    pro: 'Solde confirmé récemment · source propriétaire',
    direct: 'Solde confirmé · propriétaire',
  },
  'argent.positionEstimatedLabel': {
    pote: 'Ce que tu dois avoir en banque',
    pro: 'Position de trésorerie estimée',
    direct: 'Position estimée',
  },
  'argent.positionObservedMention': {
    pote: 'Constaté {observed} le {date}',
    pro: 'Solde constaté : {observed} le {date}',
    direct: 'Constaté {observed} · {date}',
  },
  'argent.positionMovements': {
    pote: 'Depuis : +{inflow} encaissés, −{outflow} sortis',
    pro: 'Depuis l’observation : +{inflow} encaissés, −{outflow} décaissés',
    direct: 'Depuis : +{inflow} · −{outflow}',
  },
  'argent.positionEstimateNote': {
    pote: 'C’est une estimation, pas un relevé — reconfirme ton solde quand tu veux.',
    pro: 'Estimation, non un relevé bancaire. Reconfirmez le solde à tout moment.',
    direct: 'Estimation, pas un relevé.',
  },
  'argent.balanceSheetTitle': {
    pote: 'Quel est ton solde maintenant ?',
    pro: 'Confirmer le solde bancaire',
    direct: 'Solde bancaire actuel',
  },
  'argent.balanceSheetBody': {
    pote: 'Recopie le montant visible sur ton compte, découvert compris. Je l’utilise comme point de départ, sans le confondre avec une synchronisation bancaire.',
    pro: 'Saisissez le montant actuellement visible sur le compte, découvert compris. Il sera identifié comme une confirmation manuelle.',
    direct: 'Saisis le montant actuel, découvert compris. Source : confirmation manuelle.',
  },
  'argent.balanceFieldLabel': {
    pote: 'Solde actuel',
    pro: 'Solde actuel',
    direct: 'Solde',
  },
  'argent.balanceInvalid': {
    pote: 'Entre un montant valide, par exemple 1 234,56.',
    pro: 'Saisissez un montant valide, par exemple 1 234,56.',
    direct: 'Montant invalide.',
  },
  'argent.balanceProof': {
    pote: 'Je garde la date et la source de cette confirmation. Rien n’est présenté comme synchronisé par la banque.',
    pro: 'La date et la source sont conservées. Cette valeur n’est jamais présentée comme une synchronisation bancaire.',
    direct: 'Date et source conservées. Pas de fausse synchronisation.',
  },
  'argent.balanceSaveError': {
    pote: 'Je n’ai pas pu enregistrer ce solde. Rien n’a été modifié.',
    pro: 'Le solde n’a pas pu être enregistré. Aucune modification n’a été appliquée.',
    direct: 'Échec. Rien n’a changé.',
  },
  'argent.balanceSaving': {
    pote: 'J’enregistre…',
    pro: 'Enregistrement…',
    direct: 'Enregistrement…',
  },
  'argent.balanceConfirm': {
    pote: 'Oui, c’est le bon solde',
    pro: 'Confirmer ce solde',
    direct: 'Confirmer',
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
  'argent.forecastBasisDated': {
    pote: 'Jusqu’au {date} · je retiens {rate} % des créances avec une échéance dans cette période.',
    pro: 'Projection jusqu’au {date} · {rate} % des créances échéant sur la période sont retenues.',
    direct: 'Jusqu’au {date} · {rate} % des créances échues retenues.',
  },
  'argent.forecastUndatedReceivables': {
    pote: '{amount} de créances sans échéance restent hors prévision.',
    pro: '{amount} de créances sans échéance sont exclues de la prévision.',
    direct: '{amount} sans échéance exclus.',
  },
  'argent.forecastUndatedCharges': {
    pote: '{amount} de charges sans échéance sont quand même incluses par prudence.',
    pro: '{amount} de charges sans échéance sont incluses par prudence.',
    direct: '{amount} sans échéance inclus par prudence.',
  },
  'argent.forecastBasisLegacy': {
    pote: 'Cette estimation utilise encore une base non datée. Ajoute les échéances pour la rendre plus précise.',
    pro: 'Cette projection repose sur une base agrégée non datée ; sa précision est limitée.',
    direct: 'Base non datée. Précision limitée.',
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
  // État VIDE invitant (compte neuf après onboarding) — jamais un désert de « — » ni une erreur.
  'argent.emptyTitle': {
    pote: 'Ton argent apparaîtra ici',
    pro: 'Vos finances apparaîtront ici',
    direct: 'Ton argent, ici',
  },
  'argent.emptyBody': {
    pote: 'Commence par confirmer ton solde en banque, puis crée ton premier devis — je m’occupe de suivre le reste.',
    pro: 'Commencez par confirmer votre solde bancaire, puis créez votre premier devis — le suivi se fait ensuite automatiquement.',
    direct: 'Confirme ton solde, crée ton premier devis. Le suivi suit.',
  },
  'argent.emptyCtaBalance': {
    pote: 'Confirmer mon solde',
    pro: 'Confirmer mon solde',
    direct: 'Confirmer le solde',
  },
  'argent.emptyCtaQuote': {
    pote: 'Créer mon premier devis',
    pro: 'Créer mon premier devis',
    direct: 'Premier devis',
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
  // Formulaire client enrichi par type (CustomerForm, partagé création C12/C40 ET édition C13) —
  // arbitrage fondateur révisé : identité SEULE obligatoire (prénom+nom / raison sociale), tout
  // moyen de contact reste optionnel (l'envoi passera par un lien partageable, jamais un email forcé).
  'clients.createFirstNameLabel': { pote: 'Prénom', pro: 'Prénom', direct: 'Prénom' },
  'clients.createFirstNamePlaceholder': { pote: 'Julie', pro: 'Prénom', direct: 'Prénom' },
  'clients.createLastNameLabel': { pote: 'Nom', pro: 'Nom', direct: 'Nom' },
  'clients.createLastNamePlaceholder': { pote: 'Durand', pro: 'Nom', direct: 'Nom' },
  'clients.createCompanyNameLabel': {
    pote: 'Raison sociale',
    pro: 'Raison sociale',
    direct: 'Raison sociale',
  },
  'clients.createCompanyNamePlaceholder': {
    pote: 'SARL Martin, Mairie de Sèvres…',
    pro: 'Raison sociale de l’entreprise',
    direct: 'Raison sociale',
  },
  'clients.createSiretLabel': { pote: 'SIRET', pro: 'SIRET', direct: 'SIRET' },
  'clients.createSiretPlaceholder': {
    pote: '14 chiffres, si tu l’as sous la main',
    pro: 'Numéro SIRET (facultatif)',
    direct: 'SIRET',
  },
  'clients.createSiretSearch': { pote: 'Rechercher', pro: 'Rechercher', direct: 'Rechercher' },
  // ── SPEC_SYSTEME_ERREUR §8 — refus du lookup SIRET DISCRIMINÉS (vitrine anti-écrasement).
  // Un seul « introuvable » écrasait 404/422/429/502 : le fondateur a vu « non trouvé » pour un
  // SIRET servi en 200. Chaque motif porte SON copy actionnable ; le code court est affiché par
  // ErrorNotice, jamais dans ces textes.
  'clients.createSiretErrorInvalid': {
    pote: 'Ce SIRET a l’air bancal — 14 chiffres, vérifie-le ? Tu peux aussi continuer à la main.',
    pro: 'SIRET invalide : 14 chiffres attendus. Vous pouvez poursuivre la saisie manuellement.',
    direct: 'SIRET invalide. 14 chiffres, ou saisie manuelle.',
  },
  'clients.createSiretErrorNotFound': {
    pote: 'L’annuaire officiel ne connaît pas ce SIRET. Vérifie le numéro, ou continue à la main.',
    pro: 'SIRET introuvable à l’annuaire des entreprises. Vérifiez le numéro ou poursuivez manuellement.',
    direct: 'Introuvable à l’annuaire. Vérifie, ou saisie manuelle.',
  },
  'clients.createSiretErrorRateLimited': {
    pote: 'Trop de recherches d’un coup — réessaie dans {seconds} s, la fiche t’attend.',
    pro: 'Limite de recherches atteinte. Réessayez dans {seconds} secondes.',
    direct: 'Throttle. Réessaie dans {seconds} s.',
  },
  'clients.createSiretErrorLookupDown': {
    pote: 'L’annuaire des entreprises ne répond pas, là. Réessaie dans un instant, ou remplis la fiche à la main.',
    pro: 'L’annuaire des entreprises ne répond pas. Réessayez ou poursuivez la saisie manuellement.',
    direct: 'Annuaire KO. Réessaie ou saisie manuelle.',
  },
  'clients.createSiretErrorContract': {
    pote: 'L’annuaire a répondu quelque chose que je n’arrive pas à lire — c’est de notre côté. Réessaie, ou continue à la main.',
    pro: 'Réponse de l’annuaire illisible (anomalie de notre côté). Réessayez ou poursuivez manuellement.',
    direct: 'Réponse annuaire illisible (chez nous). Réessaie ou saisie manuelle.',
  },
  'clients.createSiretErrorUnknown': {
    pote: 'La recherche a échoué sans raison claire. Réessaie, ou continue à la main.',
    pro: 'La recherche a échoué pour une raison inattendue. Réessayez ou poursuivez manuellement.',
    direct: 'Échec inattendu. Réessaie ou saisie manuelle.',
  },
  'clients.createSiretFound': {
    pote: 'Trouvé : {name} — je préremplis la fiche.',
    pro: 'Fiche trouvée : {name}.',
    direct: 'Trouvé : {name}.',
  },
  // Établissement au statut « cessé » à l'annuaire des entreprises (INSEE). On n'interdit pas :
  // une facture finale, un avoir ou un litige sur un établissement fermé sont parfaitement
  // légitimes. Mais on le DIT, sinon un fermé passerait pour un client valide.
  'clients.createSiretClosed': {
    pote:
      'Attention : l’INSEE dit que cet établissement est fermé. Tu peux quand même l’enregistrer (facture finale, avoir), mais vérifie l’adresse avec ton client.',
    pro: 'Établissement déclaré fermé à l’annuaire (INSEE). L’enregistrement reste possible (facture finale, avoir) : vérifiez l’adresse de facturation.',
    direct: 'Établissement fermé (INSEE). Vérifiez l’adresse.',
  },
  'clients.createSiretAddressMissing': {
    pote:
      'L’annuaire ne donne pas l’adresse de cet établissement. Je l’ai laissée vide : ajoute-la si tu la connais.',
    pro:
      'L’annuaire ne publie pas l’adresse de cet établissement. Le champ a été laissé vide pour une saisie manuelle.',
    direct: 'Adresse absente de l’annuaire. Saisissez-la manuellement.',
  },
  'clients.createContactNameLabel': {
    pote: 'Contact chez le client',
    pro: 'Nom du contact',
    direct: 'Contact',
  },
  'clients.createContactNamePlaceholder': {
    pote: 'Prénom Nom de ton interlocuteur',
    pro: 'Nom du contact',
    direct: 'Contact',
  },
  'clients.createEmailLabel': { pote: 'Email', pro: 'Email', direct: 'Email' },
  'clients.createEmailPlaceholder': {
    pote: 'email@exemple.fr (facultatif)',
    pro: 'Adresse email (facultative)',
    direct: 'Email',
  },
  'clients.createPhoneLabel': { pote: 'Téléphone', pro: 'Téléphone', direct: 'Tél.' },
  'clients.createPhonePlaceholder': {
    pote: '06 12 34 56 78 (facultatif)',
    pro: 'Numéro de téléphone (facultatif)',
    direct: 'Téléphone',
  },
  // Copy de l'arbitrage fondateur (canal d'envoi = lien partageable, pas d'email forcé).
  'clients.createContactHint': {
    pote: 'Avec un email, je peux envoyer et relancer tout seul. Sans, tu partages les liens toi-même — SMS, WhatsApp, comme tu veux.',
    pro: 'Avec un email, l’envoi et les relances sont automatiques. Sans, les liens se partagent manuellement (SMS, WhatsApp…).',
    direct: 'Email = envoi auto. Sinon, tu partages le lien toi-même.',
  },
  'clients.createAddressLabel': { pote: 'Adresse', pro: 'Adresse', direct: 'Adresse' },
  'clients.createAddressPlaceholder': {
    pote: 'Commence à taper une adresse (facultatif)',
    pro: 'Adresse (facultative)',
    direct: 'Adresse facultative',
  },

  // ── Chantiers — états honnêtes, création assistée et suivi terrain ───────────
  // Paramétré par métier (tradeToWorksiteTerminology @bob/core) : {term}/{plural}/{pluralCap}
  // = « chantier(s) » (BTP), « mission(s) » (IT/conseil), « projet(s) » (défaut)… jamais
  // « chantier » figé pour tous. {article}/{de}/{newAdj}/{demonstrative}/{articleDefCap}/
  // {premierAdj}/{createdAdj}/{aucunAdj} portent l'accord (genre, élision, début de phrase,
  // participe passé) — cf. worksiteParamsFor (apps/mobile/src/lib/worksite-terminology.ts).
  'chantiers.back': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },
  'chantiers.eyebrow': { pote: 'SUIVI TERRAIN', pro: 'SUIVI TERRAIN', direct: 'TERRAIN' },
  'chantiers.title': { pote: '{pluralCap}', pro: '{pluralCap}', direct: '{pluralCap}' },
  'chantiers.subtitle': {
    pote: 'Tes interventions, leurs pièces et leur avancement au même endroit.',
    pro: 'Suivi des interventions, des pièces associées et de leur avancement.',
    direct: 'Interventions, pièces, avancement.',
  },
  'chantiers.add': {
    pote: '{newAdj} {term}',
    pro: 'Créer {article} {term}',
    direct: '{newAdj} {term}',
  },
  'chantiers.created': {
    pote: '{name} est prêt — tu peux y rattacher tes prochaines pièces.',
    pro: '{articleDefCap} {term} {name} a été {createdAdj}.',
    direct: '{name} créé.',
  },
  'chantiers.createError': {
    pote: 'Je n’ai pas pu créer {demonstrative} {term}. Rien n’a été perdu, réessaie.',
    pro: 'La création {de} {term} a échoué. Aucune donnée n’a été perdue.',
    direct: 'Création impossible. Réessaie.',
  },
  'chantiers.profileError': {
    pote: 'Je n’arrive pas à vérifier si le module {pluralCap} est actif. Réessaie.',
    pro: 'Impossible de vérifier l’activation du module {pluralCap}. Veuillez réessayer.',
    direct: 'Activation non vérifiée. Réessaie.',
  },
  'chantiers.moduleTitle': {
    pote: 'Module {pluralCap}',
    pro: 'Module {pluralCap}',
    direct: 'Module {pluralCap}',
  },
  'chantiers.moduleBody': {
    pote: 'Active-le pour regrouper devis, factures et situations par intervention.',
    pro: 'Activez ce module pour regrouper devis, factures et situations par {term}.',
    direct: 'Regroupe devis, factures et situations.',
  },
  'chantiers.seePlans': {
    pote: 'Voir les offres',
    pro: 'Voir les offres',
    direct: 'Voir les offres',
  },
  'chantiers.dataError': {
    pote: 'Je n’arrive pas à charger tes {plural}. Réessaie, je garde le contexte.',
    pro: 'Impossible de charger les {plural}. Veuillez réessayer.',
    direct: 'Chargement impossible. Réessaie.',
  },
  'chantiers.emptyTitle': {
    pote: '{aucunAdj} {term} pour l’instant',
    pro: '{aucunAdj} {term} pour le moment',
    direct: '{aucunAdj} {term}',
  },
  'chantiers.emptyBody': {
    pote: 'Crée le premier : Bob pourra ensuite y ranger les devis, factures et documents liés.',
    pro: 'Créez {article} {premierAdj} {term} afin d’y associer les devis, factures et documents concernés.',
    direct: 'Crée {article} {term} pour y rattacher tes pièces.',
  },
  'chantiers.listTitle': { pote: 'Tes {plural}', pro: 'Vos {plural}', direct: '{pluralCap}' },
  'chantiers.openedOn': {
    pote: 'Ouvert le {date}',
    pro: 'Ouvert le {date}',
    direct: 'Ouvert · {date}',
  },
  'chantiers.open': { pote: 'En cours', pro: 'En cours', direct: 'En cours' },
  'chantiers.closed': { pote: 'Terminé', pro: 'Terminé', direct: 'Terminé' },
  'chantiers.createTitle': {
    pote: '{newAdj} {term}',
    pro: 'Créer {article} {term}',
    direct: '{newAdj} {term}',
  },
  'chantiers.createHint': {
    pote: 'Donne-lui un nom clair. L’adresse est optionnelle et je peux t’aider à la retrouver.',
    pro: 'Renseignez un nom explicite. L’adresse est facultative et peut être recherchée automatiquement.',
    direct: 'Nom requis. Adresse facultative.',
  },
  'chantiers.nameLabel': { pote: 'Nom {de} {term}', pro: 'Nom {de} {term}', direct: 'Nom' },
  'chantiers.namePlaceholder': {
    pote: 'Villa Durand, rénovation cuisine…',
    pro: 'Ex. Villa Durand',
    direct: 'Ex. Villa Durand',
  },
  'chantiers.addressLabel': { pote: 'Adresse', pro: 'Adresse', direct: 'Adresse' },
  'chantiers.addressPlaceholder': {
    pote: 'Commence à taper une adresse',
    pro: 'Adresse {de} {term} (facultatif)',
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
    pote: 'Créer {article} {term}',
    pro: 'Créer {article} {term}',
    direct: 'Créer',
  },

  // ── Fiche chantier/projet (extension V1) — journal de notes + photos ─────────
  'chantierFiche.back': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },
  'chantierFiche.notFound': {
    pote: 'Introuvable — retour à la fiche client.',
    pro: 'Introuvable. Retour à la fiche client.',
    direct: 'Introuvable.',
  },
  'chantierFiche.dataError': {
    pote: 'Je n’arrive pas à charger cette fiche. Réessaie, je garde le contexte.',
    pro: 'Impossible de charger cette fiche. Veuillez réessayer.',
    direct: 'Chargement impossible. Réessaie.',
  },
  'chantierFiche.notesTitle': { pote: 'Journal', pro: 'Journal', direct: 'Journal' },
  'chantierFiche.notesEmpty': {
    pote: 'Aucune note pour l’instant — ajoute la première.',
    pro: 'Aucune note pour le moment.',
    direct: 'Aucune note.',
  },
  'chantierFiche.notePlaceholder': {
    pote: 'Ex. Fuite réparée, reste le joint du ballon…',
    pro: 'Ajouter une note',
    direct: 'Note',
  },
  'chantierFiche.noteSubmit': { pote: 'Ajouter', pro: 'Ajouter', direct: 'Ajouter' },
  'chantierFiche.voiceNoteOpened': {
    pote: 'Note prête — vérifie et valide à l’écran.',
    pro: 'Note prête à valider à l’écran.',
    direct: 'Note prête. Valide à l’écran.',
  },
  'chantierFiche.noteError': {
    pote: 'Je n’ai pas pu enregistrer cette note. Réessaie.',
    pro: 'L’enregistrement de la note a échoué. Veuillez réessayer.',
    direct: 'Échec. Réessaie.',
  },
  'chantierFiche.noteAuthorDate': {
    pote: '{author} · {date}',
    pro: '{author} · {date}',
    direct: '{date}',
  },
  'chantierFiche.photosTitle': { pote: 'Photos', pro: 'Photos', direct: 'Photos' },
  'chantierFiche.photosEmpty': {
    pote: 'Aucune photo pour l’instant — ajoute la première.',
    pro: 'Aucune photo pour le moment.',
    direct: 'Aucune photo.',
  },
  'chantierFiche.photoAdd': {
    pote: 'Ajouter une photo',
    pro: 'Ajouter une photo',
    direct: 'Photo',
  },
  'chantierFiche.photoSourceTitle': {
    pote: 'Ajouter une photo',
    pro: 'Ajouter une photo',
    direct: 'Ajouter une photo',
  },
  'chantierFiche.photoSourceCamera': {
    pote: 'Appareil photo',
    pro: 'Appareil photo',
    direct: 'Appareil photo',
  },
  'chantierFiche.photoSourceLibrary': { pote: 'Galerie', pro: 'Galerie', direct: 'Galerie' },
  'chantierFiche.photoSourceCancel': { pote: 'Annuler', pro: 'Annuler', direct: 'Annuler' },
  // Paramétré par métier (tradeToWorksiteTerminology) : {term} = « chantier »/« mission »/… —
  // seule clé chantierFiche.* qui nommait encore le regroupement en dur.
  'chantierFiche.photoPermissionCamera': {
    pote: 'Autorise l’appareil photo pour prendre une photo {de} {term}.',
    pro: 'Autorisez l’appareil photo pour ajouter une photo.',
    direct: 'Accès appareil photo requis.',
  },
  'chantierFiche.photoPermissionLibrary': {
    pote: 'Autorise l’accès aux photos pour en choisir une.',
    pro: 'Autorisez l’accès aux photos pour en choisir une.',
    direct: 'Accès aux photos requis.',
  },
  'chantierFiche.photoUploadError': {
    pote: 'Je n’ai pas pu envoyer cette photo. Réessaie.',
    pro: 'L’envoi de la photo a échoué. Veuillez réessayer.',
    direct: 'Envoi impossible. Réessaie.',
  },
  'chantierFiche.photoOpen': { pote: 'Voir la photo', pro: 'Voir la photo', direct: 'Photo' },
  'chantierFiche.photoClose': { pote: 'Fermer', pro: 'Fermer', direct: 'Fermer' },
  'chantierFiche.photoDelete': { pote: 'Supprimer', pro: 'Supprimer', direct: 'Supprimer' },
  'chantierFiche.photoDeleteConfirmTitle': {
    pote: 'Supprimer cette photo ?',
    pro: 'Supprimer cette photo ?',
    direct: 'Supprimer la photo ?',
  },
  'chantierFiche.photoDeleteConfirmBody': {
    pote: 'La photo sera définitivement supprimée. Cette action est irréversible.',
    pro: 'La photo sera définitivement supprimée. Cette action est irréversible.',
    direct: 'Suppression définitive.',
  },
  'chantierFiche.photoDeleteError': {
    pote: 'Je n’ai pas pu supprimer cette photo. Réessaie.',
    pro: 'La suppression a échoué. Veuillez réessayer.',
    direct: 'Échec. Réessaie.',
  },
  'chantierFiche.photoLoadError': {
    pote: 'Je n’arrive pas à ouvrir cette photo.',
    pro: 'Impossible d’ouvrir cette photo.',
    direct: 'Ouverture impossible.',
  },
  // Compte notes/photos sur la rangée liste (fiche client, onglet Chantiers/Projets…).
  'chantierFiche.rowNotesCount': {
    pote: '{count} note',
    pro: '{count} note',
    direct: '{count} note',
  },
  'chantierFiche.rowNotesCountPlural': {
    pote: '{count} notes',
    pro: '{count} notes',
    direct: '{count} notes',
  },
  'chantierFiche.rowPhotosCount': {
    pote: '{count} photo',
    pro: '{count} photo',
    direct: '{count} photo',
  },
  'chantierFiche.rowPhotosCountPlural': {
    pote: '{count} photos',
    pro: '{count} photos',
    direct: '{count} photos',
  },
  // ── Section « Dépenses » de la fiche (imputation chantier) — filtre CLIENT sur la liste
  // de dépenses existante (aucun endpoint dédié), total TTC simple en pied de liste. ──
  'chantierFiche.expensesTitle': {
    pote: 'Dépenses',
    pro: 'Dépenses',
    direct: 'Dépenses',
  },
  'chantierFiche.expensesEmpty': {
    pote: 'Aucune dépense liée pour l’instant. Scanne un ticket et choisis ce chantier : elle comptera ici.',
    pro: 'Aucune dépense imputée à ce chantier pour le moment.',
    direct: 'Aucune dépense liée.',
  },
  'chantierFiche.expensesTotal': {
    pote: 'Total',
    pro: 'Total',
    direct: 'Total',
  },

  // ── PR-08 — section « Pièces » de la fiche chantier/site : devis + factures rattachés,
  // dérivés des listes existantes (deriveChantierPieces @bob/core, aucun endpoint dédié). ──
  'chantierFiche.piecesTitle': {
    pote: 'Devis & factures',
    pro: 'Devis et factures',
    direct: 'Devis & factures',
  },
  'chantierFiche.piecesEmpty': {
    pote: 'Aucune pièce liée pour l’instant. Choisis {demonstrative} {term} en créant un devis ou une facture : elle apparaîtra ici.',
    pro: 'Aucun devis ni facture rattaché à ce {term} pour le moment.',
    direct: 'Aucune pièce liée.',
  },
  'chantierFiche.pieceQuote': {
    pote: 'Devis',
    pro: 'Devis',
    direct: 'Devis',
  },
  'chantierFiche.pieceInvoice': {
    pote: 'Facture',
    pro: 'Facture',
    direct: 'Facture',
  },
  'chantierFiche.pieceDraft': {
    pote: 'Brouillon',
    pro: 'Brouillon',
    direct: 'Brouillon',
  },

  // ── PR-11 — parc d'équipements d'un site (Bloc A « Le métier »). Chaque fait affiché est
  // ADOSSÉ à une colonne réelle (retiredAt, warrantyUntil) — jamais une date fabriquée. ──
  'equipements.title': { pote: 'Équipements', pro: 'Équipements', direct: 'Équipements' },
  'equipements.eyebrow': { pote: 'PARC DU SITE', pro: 'PARC DU SITE', direct: 'PARC' },
  'equipements.count': {
    pote: '{count} équipement(s)',
    pro: '{count} équipement(s)',
    direct: '{count} équip.',
  },
  'equipements.searchPlaceholder': {
    pote: 'Rechercher un équipement…',
    pro: 'Rechercher un équipement…',
    direct: 'Rechercher…',
  },
  'equipements.segmentActive': { pote: 'Actifs', pro: 'Actifs', direct: 'Actifs' },
  'equipements.segmentRetired': { pote: 'Retirés', pro: 'Retirés', direct: 'Retirés' },
  'equipements.addCta': {
    pote: 'Ajouter un équipement',
    pro: 'Ajouter un équipement',
    direct: 'Ajouter',
  },
  'equipements.emptyTitle': {
    pote: 'Aucun équipement pour l’instant',
    pro: 'Aucun équipement enregistré',
    direct: 'Parc vide',
  },
  'equipements.emptyBody': {
    pote: 'Ajoute les machines du site : chaque passage, note et photo s’y accrochera.',
    pro: 'Ajoutez les équipements du site : passages, notes et photos s’y rattacheront.',
    direct: 'Ajoute les machines du site.',
  },
  'equipements.emptyFilter': {
    pote: 'Rien ne correspond à ta recherche.',
    pro: 'Aucun équipement ne correspond à la recherche.',
    direct: 'Aucun résultat.',
  },
  'equipements.closedSiteTitle': {
    pote: 'Site clôturé',
    pro: 'Site clôturé',
    direct: 'Site clôturé',
  },
  'equipements.closedSiteBody': {
    pote: 'Ce site est clôturé — rouvre-le pour modifier le parc.',
    pro: 'Ce site est clôturé — rouvrez-le pour modifier le parc.',
    direct: 'Clôturé. Rouvre pour modifier.',
  },
  'equipements.reopenCta': {
    pote: 'Rouvrir le site',
    pro: 'Rouvrir le site',
    direct: 'Rouvrir',
  },
  'equipements.sheetTitle': {
    pote: 'Nouvel équipement',
    pro: 'Nouvel équipement',
    direct: 'Nouvel équipement',
  },
  'equipements.labelField': {
    pote: 'Nom (ex. Fontaine accueil R+2)',
    pro: 'Nom de l’équipement',
    direct: 'Nom',
  },
  'equipements.kindField': {
    pote: 'Type (libre — ex. Fontaine réseau)',
    pro: 'Type (libellé libre)',
    direct: 'Type (libre)',
  },
  'equipements.brandField': { pote: 'Marque', pro: 'Marque', direct: 'Marque' },
  'equipements.serialField': { pote: 'N° de série', pro: 'Numéro de série', direct: 'N° série' },
  'equipements.locationField': {
    pote: 'Emplacement (ex. R+2, accueil)',
    pro: 'Emplacement dans le site',
    direct: 'Emplacement',
  },
  'equipements.installedField': {
    pote: 'Posée le (AAAA-MM-JJ)',
    pro: 'Date de pose (AAAA-MM-JJ)',
    direct: 'Pose (AAAA-MM-JJ)',
  },
  'equipements.warrantyField': {
    pote: 'Garantie jusqu’au (AAAA-MM-JJ)',
    pro: 'Fin de garantie (AAAA-MM-JJ)',
    direct: 'Garantie (AAAA-MM-JJ)',
  },
  'equipements.saveCta': { pote: 'Ajouter', pro: 'Enregistrer', direct: 'Ajouter' },
  'equipements.labelRequired': {
    pote: 'Donne un nom à l’équipement.',
    pro: 'Le nom de l’équipement est requis.',
    direct: 'Nom requis.',
  },
  'equipements.dateInvalid': {
    pote: 'Date invalide (AAAA-MM-JJ).',
    pro: 'Date invalide (AAAA-MM-JJ).',
    direct: 'Date invalide.',
  },
  'equipements.editCta': { pote: 'Modifier', pro: 'Modifier', direct: 'Modifier' },
  'equipements.editSaveCta': { pote: 'Enregistrer', pro: 'Enregistrer', direct: 'Enregistrer' },
  'equipements.retireCta': { pote: 'Retirer', pro: 'Retirer du parc', direct: 'Retirer' },
  'equipements.retireConfirmTitle': {
    pote: 'Retirer cet équipement ?',
    pro: 'Retirer cet équipement du parc ?',
    direct: 'Retirer ?',
  },
  'equipements.retireConfirmBody': {
    pote: '« {label} » passe en Retirés — l’historique reste lisible, et tu peux réactiver à tout moment.',
    pro: '« {label} » passera dans les équipements retirés. L’historique reste intégral ; la réactivation est possible.',
    direct: '« {label} » → Retirés. Historique conservé.',
  },
  'equipements.retiredBadge': {
    pote: 'Retirée le {date}',
    pro: 'Retirée le {date}',
    direct: 'Retirée {date}',
  },
  'equipements.reactivateCta': { pote: 'Réactiver', pro: 'Réactiver', direct: 'Réactiver' },
  'equipements.activeBadge': { pote: 'Actif', pro: 'Actif', direct: 'Actif' },
  // [Revue n°2] annonces d'ACK (table reduce-motion = immédiat + ANNONCE, écrans §2.1) :
  // l'information portée par le mouvement est toujours dite au lecteur d'écran.
  'equipements.createdAnnounce': {
    pote: '« {label} » ajouté au parc',
    pro: 'Équipement « {label} » ajouté au parc',
    direct: '{label} ajouté',
  },
  'equipements.retiredAnnounce': {
    pote: '« {label} » retiré — déplacé vers Retirés',
    pro: 'Équipement « {label} » retiré — déplacé vers l’onglet Retirés',
    direct: '{label} retiré → Retirés',
  },
  'equipements.reactivatedAnnounce': {
    pote: '« {label} » réactivé — de retour dans les Actifs',
    pro: 'Équipement « {label} » réactivé — de retour dans les Actifs',
    direct: '{label} réactivé → Actifs',
  },
  'equipements.warrantyUntil': {
    pote: 'Garantie jusqu’au {date}',
    pro: 'Garantie jusqu’au {date}',
    direct: 'Garantie → {date}',
  },
  'equipements.warrantyExpired': {
    pote: 'Garantie échue le {date}',
    pro: 'Garantie échue le {date}',
    direct: 'Garantie échue {date}',
  },
  'equipements.installedOn': {
    pote: 'Posée le {date}',
    pro: 'Posée le {date}',
    direct: 'Pose {date}',
  },
  'equipements.historyTitle': { pote: 'Historique', pro: 'Historique', direct: 'Historique' },
  'equipements.historyEmpty': {
    pote: 'Rien encore ici : les notes et photos taguées sur cette machine apparaîtront là.',
    pro: 'Aucune trace pour l’instant : notes et photos liées à cet équipement s’afficheront ici.',
    direct: 'Aucune trace.',
  },
  'equipements.historyNote': { pote: 'Note', pro: 'Note', direct: 'Note' },
  'equipements.historyPhoto': { pote: 'Photo', pro: 'Photo', direct: 'Photo' },
  'equipements.addNoteCta': {
    pote: 'Ajouter une note',
    pro: 'Ajouter une note',
    direct: 'Note',
  },
  'equipements.notePlaceholder': {
    pote: 'Ex. détartrage complet, pression basse réglée…',
    pro: 'Note d’intervention sur cet équipement…',
    direct: 'Note…',
  },
  'equipements.noteCta': { pote: 'Enregistrer la note', pro: 'Enregistrer', direct: 'Enregistrer' },
  'equipements.sectionOnSite': {
    pote: 'ÉQUIPEMENTS',
    pro: 'ÉQUIPEMENTS',
    direct: 'ÉQUIPEMENTS',
  },
  'equipements.seeAll': { pote: 'Voir tout', pro: 'Voir tout', direct: 'Tout' },
  'equipements.notFound': {
    pote: 'Équipement introuvable — il a peut-être été retiré d’un autre appareil.',
    pro: 'Équipement introuvable.',
    direct: 'Introuvable.',
  },

  // ── PR-12c — contrat de maintenance (Bloc B « Le métier »). Chaque fait affiché est DÉRIVÉ
  // (période arithmétique, couverture par factures réelles) — l'écran constate, jamais il
  // n'invente ; les reconductions calculées sont étiquetées « (calculé) ». ──
  'contrat.eyebrow': {
    pote: 'CONTRAT DE MAINTENANCE',
    pro: 'CONTRAT DE MAINTENANCE',
    direct: 'CONTRAT',
  },
  'contrat.badgeDraft': { pote: 'Brouillon', pro: 'Brouillon', direct: 'Brouillon' },
  'contrat.badgeActive': { pote: 'Actif', pro: 'Actif', direct: 'Actif' },
  'contrat.badgeTerminated': {
    pote: 'Résilié le {date}',
    pro: 'Résilié le {date}',
    direct: 'Résilié {date}',
  },
  'contrat.badgeExpired': {
    pote: 'Échu le {date}',
    pro: 'Échu le {date}',
    direct: 'Échu {date}',
  },
  'contrat.tacitOn': {
    pote: 'Reconduction tacite',
    pro: 'Reconduction tacite',
    direct: 'Tacite',
  },
  'contrat.tacitOff': {
    pote: 'Sans reconduction tacite',
    pro: 'Sans reconduction tacite',
    direct: 'Non tacite',
  },
  'contrat.clientLabel': { pote: 'Client', pro: 'Client', direct: 'Client' },
  'contrat.siteLabel': { pote: 'Site', pro: 'Site', direct: 'Site' },
  'contrat.totalPerYear': {
    pote: '{amount} HT / an',
    pro: '{amount} HT / an',
    direct: '{amount} HT/an',
  },
  'contrat.visitsPerYear': {
    pote: '{count} passage(s) / an',
    pro: '{count} passage(s) / an',
    direct: '{count} passage(s)/an',
  },
  'contrat.sectionEcheances': { pote: 'ÉCHÉANCES', pro: 'ÉCHÉANCES', direct: 'ÉCHÉANCES' },
  'contrat.currentPeriod': {
    pote: 'Période en cours : {start} → {end}',
    pro: 'Période en cours : {start} → {end}',
    direct: 'Période : {start} → {end}',
  },
  'contrat.coveredByInvoice': {
    pote: 'Facturée ✓ — {number}',
    pro: 'Facturée ✓ — {number}',
    direct: 'Facturée — {number}',
  },
  'contrat.coveredByImport': {
    pote: 'Déjà facturée avant Bob (déclaré à la création)',
    pro: 'Facturée hors Bob (fait déclaré à la création)',
    direct: 'Facturée hors Bob',
  },
  'contrat.rebillHint': {
    pote: 'La facture {number} a été annulée : la période est à re-facturer.',
    pro: 'La facture {number} a été annulée — la période redevient à facturer.',
    direct: '{number} annulée — à re-facturer.',
  },
  'contrat.prepareCta': {
    pote: 'Préparer la facture annuelle',
    pro: 'Préparer la facture annuelle',
    direct: 'Facture annuelle',
  },
  'contrat.prepareNote': {
    pote: 'Bob prépare un brouillon — rien n’est envoyé.',
    pro: 'Un brouillon est préparé — aucune pièce n’est émise ni envoyée.',
    direct: 'Brouillon seulement — rien n’est envoyé.',
  },
  'contrat.nextAnniversary': {
    pote: 'Prochain anniversaire : {date}',
    pro: 'Prochain anniversaire : {date}',
    direct: 'Anniversaire : {date}',
  },
  'contrat.noticeDays': {
    pote: 'Préavis de résiliation : {days} jours',
    pro: 'Préavis de résiliation : {days} jours',
    direct: 'Préavis : {days} j',
  },
  'contrat.noticeLegal': {
    pote: 'Le préavis est une information pour te défendre (délai prévu au contrat) — Bob n’empêche jamais d’acter une résiliation subie.',
    pro: 'Le préavis est affiché pour information : il protège vos intérêts, mais Bob n’empêche jamais d’enregistrer une résiliation subie.',
    direct: 'Préavis affiché pour info — la résiliation reste toujours possible.',
  },
  'contrat.sectionEquipments': {
    pote: 'ÉQUIPEMENTS COUVERTS',
    pro: 'ÉQUIPEMENTS COUVERTS',
    direct: 'ÉQUIPEMENTS',
  },
  'contrat.equipmentsCount': {
    pote: '{count} couvert(s)',
    pro: '{count} équipement(s) couvert(s)',
    direct: '{count} couvert(s)',
  },
  'contrat.equipmentsCountRetired': {
    pote: '{count} couvert(s), dont {retired} retiré(s)',
    pro: '{count} équipement(s) couvert(s), dont {retired} retiré(s)',
    direct: '{count} couverts · {retired} retiré(s)',
  },
  'contrat.sectionLines': { pote: 'LIGNES', pro: 'LIGNES', direct: 'LIGNES' },
  'contrat.totalHtYear': {
    pote: 'Total HT / an',
    pro: 'Total HT / an',
    direct: 'Total HT/an',
  },
  'contrat.sectionHistory': { pote: 'HISTORIQUE', pro: 'HISTORIQUE', direct: 'HISTORIQUE' },
  'contrat.historyActivated': {
    pote: 'Activé',
    pro: 'Contrat activé',
    direct: 'Activé',
  },
  'contrat.historyRenewed': {
    pote: 'Reconduit tacitement (calculé)',
    pro: 'Reconduit tacitement (calculé)',
    direct: 'Reconduit (calculé)',
  },
  'contrat.historyTerminated': {
    pote: 'Résilié — {note}',
    pro: 'Résilié — motif : {note}',
    direct: 'Résilié — {note}',
  },
  'contrat.activateCta': {
    pote: 'Activer le contrat',
    pro: 'Activer le contrat',
    direct: 'Activer',
  },
  'contrat.deleteDraftCta': {
    pote: 'Supprimer le brouillon',
    pro: 'Supprimer le brouillon',
    direct: 'Supprimer',
  },
  // — RENOMMER (§2.7) : le geste que la garde du libellé PROMET (« un nom imparfait se corrige
  //   d'un tap »). Le nom sert à s'y retrouver DANS Bob ; la ligne de la facture annuelle, elle,
  //   reste composée par le domaine (prestation + période) — on le DIT, pour ne rien promettre
  //   de faux au point de décision. —
  'contrat.renameCta': { pote: 'Renommer', pro: 'Renommer', direct: 'Renommer' },
  'contrat.renameTitle': {
    pote: 'Renommer le contrat',
    pro: 'Renommer le contrat',
    direct: 'Renommer',
  },
  'contrat.renameField': {
    pote: 'Nom du contrat',
    pro: 'Intitulé du contrat',
    direct: 'Nom',
  },
  'contrat.renameHint': {
    pote: 'Ce nom, c’est pour t’y retrouver dans Bob — la fiche, la liste, les alertes. La ligne de ta facture annuelle, Bob l’écrit tout seul (prestation + période) : la renommer ici n’y touche pas.',
    pro: 'Ce nom identifie le contrat dans l’application (fiche, liste, alertes de renouvellement). La désignation portée par la facture annuelle est composée par Bob (nature de la prestation et période couverte) et reste inchangée.',
    direct: 'Nom d’affichage dans Bob. La ligne de la facture annuelle ne change pas.',
  },
  'contrat.renameConfirm': {
    pote: 'Enregistrer le nom',
    pro: 'Enregistrer le nom',
    direct: 'Enregistrer',
  },
  'contrat.renameUnchanged': {
    pote: 'Change le nom pour pouvoir enregistrer.',
    pro: 'Modifiez l’intitulé pour activer l’enregistrement.',
    direct: 'Aucun changement.',
  },
  'contrat.renameTooLong': {
    pote: 'C’est trop long : {max} caractères maximum.',
    pro: 'Intitulé limité à {max} caractères.',
    direct: '{max} caractères max.',
  },
  'contrat.renameControlChars': {
    pote: 'Il y a des caractères invisibles dans ce nom — retire-les et redis-moi ça.',
    pro: 'L’intitulé contient des caractères de contrôle : retirez-les.',
    direct: 'Caractères invisibles — à retirer.',
  },
  'contrat.renameConflict': {
    pote: 'La fiche a changé entre-temps — rouvre-la pour repartir du nom à jour. Rien n’a été écrasé.',
    pro: 'La fiche a été modifiée depuis son ouverture. Rouvrez-la pour repartir de la version à jour : aucune modification n’a été écrasée.',
    direct: 'Fiche modifiée entre-temps. Rouvre-la. Rien n’est écrasé.',
  },
  'contrat.renameReload': {
    pote: 'Recharger la fiche',
    pro: 'Recharger la fiche',
    direct: 'Recharger',
  },
  'contrat.renameReloadCloseHint': {
    pote: 'Recharge la version à jour avant de fermer cette fenêtre.',
    pro: 'Recharge la version serveur à jour avant de fermer cette fenêtre.',
    direct: 'Recharge avant de fermer.',
  },
  'contrat.renameReloadError': {
    pote: 'Je n’arrive pas à recharger la fiche. La fenêtre reste ouverte — réessaie.',
    pro: 'Impossible de recharger la version à jour. La fenêtre reste ouverte ; réessayez.',
    direct: 'Rechargement impossible. La fenêtre reste ouverte.',
  },
  'contrat.renameCommittedReloadError': {
    pote: 'Le nouveau nom est bien enregistré, mais je n’arrive pas à recharger la fiche. Réessaie sans renommer à nouveau.',
    pro: 'Le nouvel intitulé est enregistré, mais la fiche n’a pas pu être rechargée. Réessayez sans renommer à nouveau.',
    direct: 'Nom enregistré. Fiche non rechargée — réessaie.',
  },
  'contrat.renameSuperseded': {
    pote: 'Le nom a encore changé sur un autre appareil. Je t’affiche la version la plus récente.',
    pro: 'L’intitulé a de nouveau été modifié sur un autre appareil. La version la plus récente est affichée.',
    direct: 'Nom modifié ailleurs. Version la plus récente affichée.',
  },
  // Le rechargement suit TOUTE sortie d'un conflit (bouton comme scrim) : il s'annonce, sinon
  // seul un voyant saurait que la fiche affichée derrière vient de changer.
  'contrat.renameReloaded': {
    pote: 'Fiche rechargée — tu repars du nom à jour.',
    pro: 'Fiche rechargée : la version à jour est affichée.',
    direct: 'Fiche rechargée.',
  },
  'contrat.renameDone': {
    pote: 'Nom du contrat mis à jour.',
    pro: 'Intitulé du contrat mis à jour.',
    direct: 'Nom mis à jour.',
  },
  'contrat.terminateCta': { pote: 'Résilier…', pro: 'Résilier…', direct: 'Résilier…' },
  'contrat.terminateTitle': {
    pote: 'Résilier le contrat',
    pro: 'Résilier le contrat',
    direct: 'Résilier',
  },
  'contrat.terminateDateField': {
    pote: 'Fin de couverture (AAAA-MM-JJ)',
    pro: 'Date d’effet — fin de couverture (AAAA-MM-JJ)',
    direct: 'Fin de couverture (AAAA-MM-JJ)',
  },
  'contrat.terminateDateHint': {
    pote: 'Laisse vide pour le prochain anniversaire ({date}).',
    pro: 'Par défaut : prochain anniversaire calculé ({date}).',
    direct: 'Vide = prochain anniversaire ({date}).',
  },
  'contrat.terminateNoteField': {
    pote: 'Motif (obligatoire)',
    pro: 'Motif de résiliation (obligatoire)',
    direct: 'Motif (requis)',
  },
  'contrat.terminateConfirm': {
    pote: 'Acter la résiliation',
    pro: 'Enregistrer la résiliation',
    direct: 'Acter',
  },
  'contrat.terminatedCoverage': {
    pote: 'Résilié — couvert jusqu’au {date}',
    pro: 'Résilié — couverture jusqu’au {date}',
    direct: 'Couvert jusqu’au {date}',
  },
  'contrat.renewalTacit': {
    pote: 'Se reconduit dans {days} jours',
    pro: 'Se reconduit tacitement dans {days} jours',
    direct: 'Reconduction dans {days} j',
  },
  'contrat.renewalNonTacit': {
    pote: 'Arrive à échéance dans {days} jours',
    pro: 'Arrive à échéance dans {days} jours',
    direct: 'Échéance dans {days} j',
  },
  'contrat.vatDivergence': {
    pote: 'TVA recalculée au régime actuel : total {actual} au lieu de {expected}.',
    pro: 'TVA recalculée au régime en vigueur : total {actual} au lieu de {expected}.',
    direct: 'TVA recalculée : {actual} (contrat : {expected}).',
  },
  'contrat.vatDivergenceLegal': {
    pote: 'Ton régime de TVA a changé depuis la création du contrat (franchise 293 B du CGI ou bascule de taux) : Bob applique le taux légal du JOUR du brouillon — jamais un taux périmé recopié.',
    pro: 'Le régime de TVA a évolué depuis la création du contrat (franchise en base art. 293 B CGI, ou changement de taux). La TVA est recalculée au régime applicable au jour du brouillon.',
    direct: 'Régime de TVA changé depuis le contrat : taux recalculé au jour du brouillon.',
  },
  'contrat.seeDraftCta': {
    pote: 'Voir le brouillon',
    pro: 'Ouvrir le brouillon',
    direct: 'Brouillon',
  },
  'contrat.notFound': {
    pote: 'Contrat introuvable — il a peut-être été supprimé d’un autre appareil.',
    pro: 'Contrat introuvable.',
    direct: 'Introuvable.',
  },
  'contrat.dataError': {
    pote: 'Impossible de charger le contrat — réessaie.',
    pro: 'Le contrat n’a pas pu être chargé.',
    direct: 'Erreur de chargement.',
  },
  // — Wizard de création (écrans §3.3 — la saisie « déjà facturé jusqu'au » est INCLUSIVE,
  //   convertie +1 jour vers la borne exclusive par le wizard : annexe erratum n° 4) —
  'contrat.newTitle': {
    pote: 'Nouveau contrat',
    pro: 'Nouveau contrat',
    direct: 'Nouveau contrat',
  },
  'contrat.stepClient': { pote: 'Client & site', pro: 'Client & site', direct: 'Client' },
  'contrat.stepLines': { pote: 'Lignes', pro: 'Lignes', direct: 'Lignes' },
  'contrat.stepConditions': { pote: 'Conditions', pro: 'Conditions', direct: 'Conditions' },
  'contrat.stepReview': { pote: 'Revue', pro: 'Revue', direct: 'Revue' },
  'contrat.b2cFiltered': {
    pote: 'Contrats particuliers : bientôt — la loi Chatel (art. L215-1) exige un cadre dédié. En attendant : devis signé annuel.',
    pro: 'Les contrats avec des particuliers arrivent plus tard : la reconduction tacite exige le devoir d’information (art. L215-1 c. conso, loi Chatel). Alternative : devis signé annuel.',
    direct: 'B2C : bientôt (loi Chatel L215-1). Alternative : devis annuel.',
  },
  'contrat.labelField': {
    pote: 'Nom du contrat (ex. Entretien fontaines 2026)',
    pro: 'Intitulé du contrat',
    direct: 'Nom du contrat',
  },
  'contrat.labelRequired': {
    pote: 'Donne un nom au contrat.',
    pro: 'L’intitulé du contrat est requis.',
    direct: 'Nom requis.',
  },
  'contrat.customerRequired': {
    pote: 'Choisis le client du contrat.',
    pro: 'Le client est requis.',
    direct: 'Client requis.',
  },
  'contrat.anniversaryField': {
    pote: 'Début du contrat (AAAA-MM-JJ)',
    pro: 'Date de début (AAAA-MM-JJ)',
    direct: 'Début (AAAA-MM-JJ)',
  },
  'contrat.anniversaryHint': {
    pote: 'La vraie date de départ — même dans le passé pour un contrat migré.',
    pro: 'Date de début réelle du contrat — une date passée est valide (contrat migré).',
    direct: 'Date réelle — passé accepté (migration).',
  },
  'contrat.dateInvalid': {
    pote: 'Les dates s’écrivent AAAA-MM-JJ (ex. 2026-10-12).',
    pro: 'Format de date attendu : AAAA-MM-JJ.',
    direct: 'Format : AAAA-MM-JJ.',
  },
  'contrat.visitsField': {
    pote: 'Passages par an',
    pro: 'Passages par an',
    direct: 'Passages/an',
  },
  'contrat.noticeField': {
    pote: 'Préavis (jours)',
    pro: 'Préavis de résiliation (jours)',
    direct: 'Préavis (j)',
  },
  'contrat.tacitField': {
    pote: 'Reconduction tacite',
    pro: 'Reconduction tacite',
    direct: 'Tacite',
  },
  'contrat.migratedTitle': {
    pote: 'Contrat migré ?',
    pro: 'Contrat migré ?',
    direct: 'Migration',
  },
  'contrat.migratedField': {
    pote: 'Déjà facturé jusqu’au (inclus, AAAA-MM-JJ)',
    pro: 'Déjà facturé jusqu’au (date incluse, AAAA-MM-JJ)',
    direct: 'Facturé jusqu’au (inclus)',
  },
  'contrat.migratedHint': {
    pote: 'Bob ne réclamera pas ce qui est déjà réglé hors Bob ; les visites comptent à partir d’aujourd’hui.',
    pro: 'Bob ne redemandera jamais ce qui a déjà été facturé hors Bob ; les visites sont décomptées à partir de l’activation.',
    direct: 'Rien de déjà facturé ne sera réclamé ; visites comptées dès aujourd’hui.',
  },
  'contrat.lineLabelField': { pote: 'Libellé', pro: 'Libellé', direct: 'Libellé' },
  'contrat.lineQtyField': { pote: 'Quantité', pro: 'Quantité', direct: 'Qté' },
  'contrat.linePriceField': {
    pote: 'PU HT (€)',
    pro: 'Prix unitaire HT (€)',
    direct: 'PU HT (€)',
  },
  'contrat.lineVatField': { pote: 'TVA (%)', pro: 'Taux de TVA (%)', direct: 'TVA (%)' },
  'contrat.lineInvalid': {
    pote: 'Chaque ligne veut un libellé, une quantité et un prix valides.',
    pro: 'Chaque ligne exige libellé, quantité positive et prix valide.',
    direct: 'Ligne incomplète.',
  },
  'contrat.linesRequired': {
    pote: 'Ajoute au moins une ligne — c’est elle qui fera la facture annuelle.',
    pro: 'Au moins une ligne est requise (elle compose la facture annuelle).',
    direct: 'Au moins une ligne.',
  },
  'contrat.addLineCta': {
    pote: '+ Ajouter une ligne',
    pro: '+ Ajouter une ligne',
    direct: '+ Ligne',
  },
  'contrat.removeLineA11y': {
    pote: 'Retirer la ligne {label}',
    pro: 'Retirer la ligne {label}',
    direct: 'Retirer {label}',
  },
  'contrat.reviewPeriod': {
    pote: 'Période courante calculée : {start} → {end}',
    pro: 'Période courante (calculée) : {start} → {end}',
    direct: 'Période : {start} → {end}',
  },
  'contrat.createDraftCta': {
    pote: 'Créer le brouillon',
    pro: 'Créer le brouillon',
    direct: 'Créer le brouillon',
  },
  'contrat.createdAnnounce': {
    pote: 'Contrat {label} créé en brouillon.',
    pro: 'Le contrat {label} est créé en brouillon.',
    direct: 'Contrat {label} créé.',
  },
  'contrat.activateHint': {
    pote: 'L’activation figera la date de début et le « déjà facturé jusqu’au » — c’est un geste séparé, jamais automatique.',
    pro: 'L’activation fige la date de début et la borne migrée. C’est un geste distinct de la création.',
    direct: 'Activation = date de début figée. Geste séparé.',
  },
  'contrat.nextCta': { pote: 'Continuer', pro: 'Continuer', direct: 'Continuer' },
  'contrat.backCta': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },
  // — Section « Contrats » de la fiche client (écrans §6.3) —
  'contrat.sectionClient': { pote: 'Contrats', pro: 'Contrats', direct: 'Contrats' },
  'contrat.clientEmpty': {
    pote: 'Aucun contrat pour ce client.',
    pro: 'Aucun contrat de maintenance pour ce client.',
    direct: 'Aucun contrat.',
  },
  'contrat.clientDataError': {
    pote: 'Je n’arrive pas à charger les contrats. Réessaie — je ne vais rien inventer.',
    pro: 'Les contrats n’ont pas pu être chargés. Réessayez.',
    direct: 'Contrats indisponibles. Réessaie.',
  },
  'contrat.newCta': {
    pote: '+ Nouveau contrat',
    pro: '+ Nouveau contrat',
    direct: '+ Contrat',
  },

  // ── PR-08 — picker « site/chantier » des créations de pièces (wizard devis + facture
  // directe) : rattachement OPTIONNEL, terminologie adaptative ({termCap} = Chantier/Site…). ──
  'pieceSite.title': {
    pote: '{termCap} concerné (optionnel)',
    pro: '{termCap} concerné (facultatif)',
    direct: '{termCap} (optionnel)',
  },
  'pieceSite.none': {
    pote: 'Sans {term}',
    pro: 'Aucun {term}',
    direct: 'Sans {term}',
  },
  'pieceSite.pickedA11y': {
    pote: '{termCap} sélectionné : {name}',
    pro: '{termCap} sélectionné : {name}',
    direct: '{termCap} : {name}',
  },

  // ── PR-09 — carte « Contacts » de la fiche client (contacts multiples, label libre) ──
  'contacts.title': {
    pote: 'Contacts',
    pro: 'Contacts',
    direct: 'Contacts',
  },
  'contacts.hint': {
    pote: 'Les personnes à joindre chez ce client : demandeur, valideur, compta… Choisis le destinataire au moment d’envoyer une pièce.',
    pro: 'Les interlocuteurs de ce client (demandeur, valideur, comptabilité…). Le destinataire se choisit à l’envoi de chaque pièce.',
    direct: 'Interlocuteurs du client. Destinataire choisi à l’envoi.',
  },
  'contacts.addCta': {
    pote: '+ Ajouter',
    pro: '+ Ajouter',
    direct: '+ Ajouter',
  },
  'contacts.empty': {
    pote: 'Aucun contact pour l’instant. Ajoute la compta ou le valideur : tu choisiras à qui envoyer chaque facture.',
    pro: 'Aucun contact enregistré pour ce client.',
    direct: 'Aucun contact.',
  },
  'contacts.dataError': {
    pote: 'Impossible de charger les contacts — réessaie.',
    pro: 'Les contacts n’ont pas pu être chargés. Réessayez.',
    direct: 'Contacts indisponibles. Réessaie.',
  },
  'contacts.rowHint': {
    pote: 'Toucher pour modifier, appui long pour supprimer',
    pro: 'Toucher pour modifier, appui long pour supprimer',
    direct: 'Toucher : modifier. Appui long : supprimer.',
  },
  'contacts.createTitle': {
    pote: 'Nouveau contact',
    pro: 'Nouveau contact',
    direct: 'Nouveau contact',
  },
  'contacts.editTitle': {
    pote: 'Modifier le contact',
    pro: 'Modifier le contact',
    direct: 'Modifier le contact',
  },
  'contacts.fieldLabel': {
    pote: 'Rôle',
    pro: 'Rôle',
    direct: 'Rôle',
  },
  'contacts.fieldLabelPlaceholder': {
    pote: 'Compta, valideur, gardien…',
    pro: 'Comptabilité, valideur…',
    direct: 'Compta, valideur…',
  },
  'contacts.fieldName': {
    pote: 'Nom',
    pro: 'Nom',
    direct: 'Nom',
  },
  'contacts.fieldNamePlaceholder': {
    pote: 'Mme Lefèvre',
    pro: 'Nom du contact',
    direct: 'Nom',
  },
  'contacts.fieldEmail': {
    pote: 'E-mail (optionnel)',
    pro: 'E-mail (facultatif)',
    direct: 'E-mail (optionnel)',
  },
  'contacts.fieldEmailPlaceholder': {
    pote: 'compta@client.fr',
    pro: 'adresse@exemple.fr',
    direct: 'compta@client.fr',
  },
  'contacts.fieldPhone': {
    pote: 'Téléphone (optionnel)',
    pro: 'Téléphone (facultatif)',
    direct: 'Téléphone (optionnel)',
  },
  'contacts.fieldPhonePlaceholder': {
    pote: '06 12 34 56 78',
    pro: '06 12 34 56 78',
    direct: '06 12 34 56 78',
  },
  'contacts.createCta': {
    pote: 'Ajouter le contact',
    pro: 'Ajouter le contact',
    direct: 'Ajouter',
  },
  'contacts.saveCta': {
    pote: 'Enregistrer',
    pro: 'Enregistrer',
    direct: 'Enregistrer',
  },
  'contacts.deleteCta': {
    pote: 'Supprimer ce contact',
    pro: 'Supprimer le contact',
    direct: 'Supprimer',
  },
  'contacts.deleteConfirmTitle': {
    pote: 'Supprimer le contact ?',
    pro: 'Supprimer le contact',
    direct: 'Supprimer ?',
  },
  'contacts.deleteConfirmBody': {
    pote: '{name} disparaîtra des destinataires possibles. Les pièces déjà envoyées ne bougent pas.',
    pro: '{name} ne sera plus proposé comme destinataire. Les envois passés restent inchangés.',
    direct: '{name} retiré des destinataires. Envois passés inchangés.',
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
  // Édition post-création (C13/C40 TODO partagé) — la création mobile est MINIMALE (nom + type),
  // cette feuille permet de compléter/corriger adresse, SIREN, contact… Mêmes champs, même
  // formulaire (CustomerForm) que la création.
  'fiche.editCta': {
    pote: 'Modifier la fiche',
    pro: 'Modifier la fiche',
    direct: 'Modifier',
  },
  'fiche.editTitle': {
    pote: 'Modifier la fiche',
    pro: 'Modifier la fiche',
    direct: 'Modifier la fiche',
  },
  'fiche.editHint': {
    pote: 'Corrige ou complète ce qui manque — adresse, SIREN, contact…',
    pro: 'Complétez ou corrigez les informations de la fiche.',
    direct: 'Corrige les informations.',
  },
  'fiche.editSubmit': {
    pote: 'Enregistrer',
    pro: 'Enregistrer',
    direct: 'Enregistrer',
  },
  'fiche.editSuccess': {
    pote: 'Fiche mise à jour ✓',
    pro: 'Fiche mise à jour.',
    direct: 'Fiche mise à jour.',
  },
  'fiche.editError': {
    pote: 'Je n’ai pas pu enregistrer. Rien n’a été perdu, réessaie.',
    pro: 'L’enregistrement a échoué. Aucune donnée n’a été perdue.',
    direct: 'Échec. Rien n’a changé.',
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
  // Historique qualifié depuis factures + paiements. Aucun score avant modèle ratifié.
  'fiche.paymentHistoryTitle': {
    pote: 'Historique de paiement',
    pro: 'Historique de paiement',
    direct: 'Historique de paiement',
  },
  'fiche.paymentHistoryKnownBadge': {
    pote: 'Fiable',
    pro: 'Disponible',
    direct: 'Disponible',
  },
  'fiche.paymentHistoryPendingBadge': {
    pote: 'À compléter',
    pro: 'Indisponible',
    direct: 'Indisponible',
  },
  'fiche.paymentHistoryKnown': {
    pote: '{count} factures rapprochées · {ratio} % réglées dans les délais.',
    pro: '{count} factures rapprochées · {ratio} % réglées dans les délais.',
    direct: '{count} factures · {ratio} % dans les délais.',
  },
  'fiche.paymentHistoryIncomplete': {
    pote: 'Des paiements ne sont pas encore rapprochés de leurs factures. Je ne calcule pas de délai approximatif.',
    pro: 'Le rapprochement factures-paiements est incomplet. Aucun délai approximatif n’est affiché.',
    direct: 'Rapprochement incomplet. Aucun délai calculé.',
  },
  'fiche.paymentHistoryInsufficient': {
    pote: '{count} facture(s) rapprochée(s) sur 3 nécessaires. Je te donne une tendance dès que l’historique est suffisant.',
    pro: '{count} facture(s) rapprochée(s) sur 3 nécessaires pour calculer un historique fiable.',
    direct: '{count}/3 factures rapprochées. Historique insuffisant.',
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
  // Paramétré par métier (tradeToWorksiteTerminology @bob/core) : {pluralCap} = « Chantiers »
  // (BTP), « Missions » (IT/conseil), « Projets » (défaut)… jamais « chantier » figé pour tous.
  'fiche.tabChantiers': {
    pote: '{pluralCap}',
    pro: '{pluralCap}',
    direct: '{pluralCap}',
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
  // Paramétré par métier (tradeToWorksiteTerminology) : {plural} = « chantiers »/« missions »/…
  'fiche.chantiersEmpty': {
    pote: 'Aucun {plural} relié pour l’instant — j’y rangerai tes pièces.',
    pro: 'Aucun {plural} associé pour le moment.',
    direct: 'Aucun {plural}.',
  },
  'fiche.chantiersEmptyCta': {
    pote: 'Créer {article} {term}',
    pro: 'Créer {article} {term}',
    direct: 'Créer {article} {term}',
  },
  'fiche.chantierAddLabel': {
    pote: '{newAdj} {term}',
    pro: '{newAdj} {term}',
    direct: '{newAdj} {term}',
  },
  'fiche.chantierSectionTitle': {
    pote: 'Tes {plural}',
    pro: 'Vos {plural}',
    direct: '{pluralCap}',
  },
  'fiche.chantierCreateTitle': {
    pote: '{newAdj} {term}',
    pro: '{newAdj} {term}',
    direct: '{newAdj} {term}',
  },
  'fiche.chantierCreateHint': {
    pote: 'Rattaché à ce client — l’adresse est déjà reprise de sa fiche, tu peux la corriger.',
    pro: 'Rattaché à ce client ; l’adresse reprend celle de la fiche et reste modifiable.',
    direct: 'Rattaché au client. Adresse reprise, modifiable.',
  },
  'fiche.chantierNameLabel': {
    pote: 'Nom {de} {term}',
    pro: 'Nom {de} {term}',
    direct: 'Nom',
  },
  'fiche.chantierNamePlaceholder': {
    pote: 'Ex. Rénovation cuisine, Refonte du site…',
    pro: 'Ex. Rénovation cuisine',
    direct: 'Nom',
  },
  'fiche.chantierNotesLabel': {
    pote: 'Notes',
    pro: 'Notes',
    direct: 'Notes',
  },
  'fiche.chantierNotesPlaceholder': {
    pote: 'Code portail, étage, consignes d’accès… (facultatif)',
    pro: 'Contexte, accès, consignes (facultatif)',
    direct: 'Notes (facultatif)',
  },
  'fiche.chantierCreateSubmit': {
    pote: 'Créer {article} {term}',
    pro: 'Créer {article} {term}',
    direct: 'Créer',
  },
  'fiche.chantierCreateError': {
    pote: 'Je n’ai pas pu créer {article} {term}. Rien n’a été perdu, réessaie.',
    pro: 'La création a échoué. Aucune donnée n’a été perdue.',
    direct: 'Création impossible. Réessaie.',
  },
  'fiche.chantierCreatedToast': {
    pote: '{name} est prêt — tu peux y rattacher devis et factures.',
    pro: '{name} a été créé.',
    direct: '{name} créé.',
  },
  'fiche.contractDeletedToast': {
    pote: 'Ce contrat a été supprimé sur un autre appareil. Voici les contrats qui restent — rien n’a été écrasé.',
    pro: 'Ce contrat a été supprimé depuis un autre appareil. Les contrats restants sont affichés ; aucune modification n’a été écrasée.',
    direct: 'Contrat supprimé ailleurs. Contrats restants affichés.',
  },
  'fiche.contractDeletedListErrorToast': {
    pote: 'Ce contrat a été supprimé ailleurs. Je n’arrive pas à charger les autres — réessaie juste ici.',
    pro: 'Ce contrat a été supprimé ailleurs. La liste n’a pas pu être chargée ; réessayez dans cette section.',
    direct: 'Contrat supprimé ailleurs. Liste indisponible — réessaie ici.',
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
  // Libellés des 10 types analysés (DocumentAnalysisType) — source UNIQUE scan ↔ carte
  // partagée ↔ badge « À valider » (ANALYSIS_TYPE_LABEL_KEY côté mobile).
  'docs.typeSupplierInvoice': {
    pote: 'Facture fournisseur',
    pro: 'Facture fournisseur',
    direct: 'Fournisseur',
  },
  'docs.typeReceipt': {
    pote: 'Ticket de caisse',
    pro: 'Ticket de caisse',
    direct: 'Ticket',
  },
  'docs.typeBankStatement': {
    pote: 'Relevé bancaire',
    pro: 'Relevé bancaire',
    direct: 'Relevé',
  },
  'docs.typeInsurance': {
    pote: 'Attestation d’assurance',
    pro: 'Attestation d’assurance',
    direct: 'Assurance',
  },
  'docs.typeTaxSocial': {
    pote: 'Fiscal & social',
    pro: 'Document fiscal ou social',
    direct: 'Fiscal',
  },
  'docs.typeContract': {
    pote: 'Contrat',
    pro: 'Contrat',
    direct: 'Contrat',
  },
  'docs.typeCompanyRecord': {
    pote: 'Document de société',
    pro: 'Document de société',
    direct: 'Société',
  },
  'docs.typeChantierPhoto': {
    pote: 'Photo de chantier',
    pro: 'Photo de chantier',
    direct: 'Photo chantier',
  },
  'docs.typeAccounting': {
    pote: 'Document comptable',
    pro: 'Document comptable',
    direct: 'Comptable',
  },
  'docs.typeOther': {
    pote: 'À préciser',
    pro: 'Document à préciser',
    direct: 'À préciser',
  },
  // Pas encore d'analyse persistée pour cette version : badge honnête, jamais un type inventé.
  'docs.typeUnknown': {
    pote: 'À lire',
    pro: 'Analyse en attente',
    direct: 'À lire',
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
  // Encart « Je pense : … » — préfixe seul, la destination validée (label en gras) suit.
  'docs.aiGuess': {
    pote: 'Je pense : ',
    pro: 'Je suggère : ',
    direct: 'Je pense : ',
  },
  // Bandeau vert après classement (handoff §isDocs, état « classé » en fade-in).
  'docs.classifiedBanner': {
    pote: '{name} classé · {destination}',
    pro: 'Classé : {name} → {destination}.',
    direct: '{name} → {destination}.',
  },
  // Doc rangé (folderId non nul) mais jamais CONFIRMÉ (reviewedAt null) — carte « À valider ».
  'docs.filedToConfirm': {
    pote: 'Rangé · {folder} — à confirmer',
    pro: 'Rangé dans {folder} — à confirmer',
    direct: '{folder} — à confirmer',
  },
  // Nom du dossier non résolu (affichage dégradé, jamais inventé).
  'docs.filedToConfirmUnknown': {
    pote: 'Rangé — à confirmer',
    pro: 'Rangé — à confirmer',
    direct: 'Rangé — à confirmer',
  },
  // Geste principal : AcknowledgeDocument (« c'est bon, je valide ») — latch idempotent.
  'docs.confirmCta': {
    pote: 'C’est bon',
    pro: 'Confirmer',
    direct: 'OK',
  },
  'docs.confirmedBanner': {
    pote: '{name} confirmé ✓',
    pro: 'Confirmé : {name}.',
    direct: '{name} ✓',
  },
  'docs.confirmError': {
    pote: 'La confirmation a raté, là. On réessaie ?',
    pro: 'La confirmation a échoué. Veuillez réessayer.',
    direct: 'Confirmation ratée. Réessaie.',
  },
  // Lien métier DÉJÀ posé : un « Classer là » ne le réécrit jamais — décision depuis le détail.
  'docs.classifyLinkedError': {
    pote: 'Ce document est déjà rattaché ailleurs. Ouvre-le pour décider — je n’écrase rien tout seul.',
    pro: 'Ce document est déjà rattaché à une autre entité. Ouvrez son détail pour décider.',
    direct: 'Déjà rattaché. Ouvre le document.',
  },
  // ── Chantier S — « Lier à un chantier » (détail document, affordance manuelle du geste
  // vocal classer_document) : ligne d'action, feuille de sélection, toast et état lecture. ──
  'docs.linkChantierCta': {
    pote: 'Lier à un chantier',
    pro: 'Lier à un chantier',
    direct: 'Lier à un chantier',
  },
  'docs.linkChantierHeader': {
    pote: 'Chantier',
    pro: 'Chantier',
    direct: 'Chantier',
  },
  'docs.linkChantierQuestion': {
    pote: 'À quel chantier je rattache ce document ?',
    pro: 'À quel chantier rattacher ce document ?',
    direct: 'Quel chantier ?',
  },
  'docs.linkChantierSuggestedDesc': {
    pote: 'Ma proposition — d’après ce que j’ai lu',
    pro: 'Proposition de Bob — d’après l’analyse du document',
    direct: 'Proposition IA',
  },
  'docs.linkChantierConfirm': {
    pote: 'Lier au chantier',
    pro: 'Lier au chantier',
    direct: 'Lier',
  },
  'docs.linkChantierLater': {
    pote: 'Plus tard',
    pro: 'Plus tard',
    direct: 'Plus tard',
  },
  'docs.linkChantierToast': {
    pote: 'Lié au chantier « {name} » ✓',
    pro: 'Document lié au chantier « {name} ».',
    direct: '→ {name}.',
  },
  'docs.linkChantierError': {
    pote: 'Le rattachement au chantier a raté, là. On réessaie ?',
    pro: 'Le rattachement au chantier a échoué. Veuillez réessayer.',
    direct: 'Rattachement raté. Réessaie.',
  },
  // État lecture (lien déjà posé) : ouvre le chantier au tap — pas de déliaison en V1.
  'docs.linkChantierLinked': {
    pote: 'Chantier · {name}',
    pro: 'Chantier · {name}',
    direct: 'Chantier · {name}',
  },
  'docs.linkChantierLinkedUnknown': {
    pote: 'Chantier lié',
    pro: 'Chantier lié',
    direct: 'Chantier lié',
  },
  'docs.linkChantierLinkedA11y': {
    pote: 'Ouvrir le chantier {name}',
    pro: 'Ouvrir le chantier {name}',
    direct: 'Ouvrir le chantier {name}',
  },
  // Contexte accessible du badge de confiance « {pct} % » (carte partagée + extraction).
  'docs.confidenceA11y': {
    pote: 'Confiance de lecture : {pct} %',
    pro: 'Confiance de lecture : {pct} %',
    direct: 'Confiance : {pct} %',
  },
  // État « classé » de la carte document (écran détail — parité avec la carte du scan).
  'docs.classifiedIn': {
    pote: 'Classé dans « {folder} »',
    pro: 'Classé dans « {folder} »',
    direct: '→ {folder}',
  },
  // Accordéon Traçabilité : les preuves détaillées de lecture, repliées par défaut.
  'docs.traceToggle': {
    pote: 'Voir ce que Bob a lu (preuves)',
    pro: 'Afficher les données lues (preuves)',
    direct: 'Preuves de lecture',
  },
  'docs.traceEmpty': {
    pote: 'Aucune donnée chiffrée à prouver sur ce document.',
    pro: 'Aucune donnée extraite à prouver pour ce document.',
    direct: 'Aucune donnée extraite.',
  },
  'docs.pickSuggestedMeta': {
    pote: 'Ma proposition',
    pro: 'Proposition de Bob',
    direct: 'Proposition IA',
  },
  'docs.pickFolderMeta': {
    pote: 'Dossier du coffre',
    pro: 'Dossier du coffre',
    direct: 'Dossier',
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
  'docs.recentCustomerUnavailable': {
    pote: 'Client indisponible',
    pro: 'Client indisponible',
    direct: 'Client indisponible',
  },
  'docs.recentSubUnavailable': {
    pote: '{kind} · canal à confirmer',
    pro: '{kind} · canal à confirmer',
    direct: '{kind} · canal à confirmer',
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
  'docs.staleSummaries': {
    pote: 'Ton coffre est là, mais certaines synthèses compta n’ont pas voulu se rafraîchir.',
    pro: 'Le coffre reste disponible, mais certaines synthèses comptables n’ont pas pu être actualisées.',
    direct: 'Coffre OK, synthèses compta pas à jour.',
  },
  'docs.staleSummariesCta': {
    pote: 'Réessayer les synthèses',
    pro: 'Réessayer les synthèses',
    direct: 'Réessayer',
  },
  'docs.staleVault': {
    pote: 'Je te montre la dernière version de ton coffre — son actualisation n’a pas abouti.',
    pro: 'Le coffre affiché est la dernière version disponible. Son actualisation n’a pas abouti.',
    direct: 'Coffre affiché = dernière version. Actualisation échouée.',
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
  // DÉCOUVRABILITÉ (S9) — extension du pool (rotation par visite, SUGGESTION_CHIP_POOL) :
  // chaque libellé reste une commande CANONIQUE qui matche detectIntent @bob/ai à coup sûr
  // (tva / balance / pilotage / nouveau_devis / scan / echeances / aide).
  'assistant.chipVat': {
    pote: 'Combien de TVA je dois ?',
    pro: 'Quelle est ma position de TVA ?',
    direct: 'Ma TVA ?',
  },
  'assistant.chipBalance': {
    pote: 'Qui me doit de l’argent ?',
    pro: 'Qui me doit de l’argent ?',
    direct: 'Qui me doit quoi ?',
  },
  'assistant.chipPilotage': {
    pote: 'Comment va mon activité ?',
    pro: 'Comment va mon activité ?',
    direct: 'Ça monte ou ça baisse ?',
  },
  'assistant.chipNewQuote': {
    pote: 'Fais-moi un devis',
    pro: 'Créer un nouveau devis',
    direct: 'Nouveau devis',
  },
  'assistant.chipScan': {
    pote: 'Scanne un ticket',
    pro: 'Scanner un justificatif',
    direct: 'Scan ticket',
  },
  'assistant.chipEcheances': {
    pote: 'Mes échéances à venir ?',
    pro: 'Quelles sont mes échéances fiscales ?',
    direct: 'Échéances ?',
  },
  'assistant.chipHelp': {
    pote: 'Tu sais faire quoi ?',
    pro: 'Que savez-vous faire ?',
    direct: 'Tu fais quoi ?',
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
  'agent.global.timeZoneTitle': {
    pote: 'Ton heure locale',
    pro: 'Confirmer votre fuseau horaire',
    direct: 'Fuseau horaire',
  },
  'agent.global.timeZoneBody': {
    pote: 'Pour comprendre « demain », « lundi matin » ou une échéance sans me tromper, je dois savoir dans quel fuseau tu travailles.',
    pro: 'Bob utilise ce fuseau pour interpréter les dates relatives sans décalage. Il ne sera jamais choisi sans votre confirmation.',
    direct: 'Requis pour comprendre les dates relatives sans décalage.',
  },
  'agent.global.timeZoneConfirm': {
    pote: 'Oui, utiliser {timeZone}',
    pro: 'Confirmer {timeZone}',
    direct: 'Utiliser {timeZone}',
  },
  'agent.global.timeZoneConfirmSelection': {
    pote: 'Choisis d’abord ton fuseau',
    pro: 'Sélectionnez un fuseau',
    direct: 'Choisis un fuseau',
  },
  'agent.global.timeZoneSearchPlaceholder': {
    pote: 'Recherche une ville, par exemple Paris',
    pro: 'Rechercher une ville ou saisir Europe/Paris',
    direct: 'Ville ou Europe/Paris',
  },
  'agent.global.timeZoneSearchLabel': {
    pote: 'Rechercher ton fuseau horaire',
    pro: 'Rechercher ou saisir un fuseau horaire IANA',
    direct: 'Rechercher le fuseau',
  },
  'agent.global.timeZoneSuggested': {
    pote: 'détecté sur ce téléphone',
    pro: 'détecté sur cet appareil',
    direct: 'détecté',
  },
  'agent.global.timeZoneInvalid': {
    pote: 'Je ne reconnais pas encore ce fuseau. Essaie avec une ville ou un nom comme Europe/Paris.',
    pro: 'Fuseau non reconnu. Recherchez une ville ou saisissez un identifiant comme Europe/Paris.',
    direct: 'Fuseau invalide. Exemple : Europe/Paris.',
  },
  'agent.global.timeZoneDetectionUnavailable': {
    pote: 'Je n’ai pas pu le détecter, mais tu peux le rechercher ou le saisir ici.',
    pro: 'La détection est indisponible. Recherchez ou saisissez votre fuseau ci-dessus.',
    direct: 'Détection indisponible. Saisis le fuseau.',
  },
  'agent.global.timeZoneRedetect': {
    pote: 'Redétecter sur ce téléphone',
    pro: 'Relancer la détection',
    direct: 'Redétecter',
  },
  'agent.global.timeZoneCancel': {
    pote: 'Pas maintenant',
    pro: 'Plus tard',
    direct: 'Annuler',
  },
  'agent.global.timeZoneSaving': {
    pote: 'Je sécurise ce réglage…',
    pro: 'Enregistrement sécurisé…',
    direct: 'Enregistrement…',
  },
  'agent.global.timeZoneUnknown': {
    pote: 'Fuseau non détecté',
    pro: 'Fuseau non détecté',
    direct: 'Non détecté',
  },
  'agent.global.timeZoneError': {
    pote: 'Je n’ai pas pu confirmer ce fuseau. Rien n’a démarré ; réessaie.',
    pro: 'Le fuseau n’a pas pu être confirmé. Bob Live reste fermé ; veuillez réessayer.',
    direct: 'Confirmation impossible. Bob reste fermé.',
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
  'agent.global.diagnosticTraceTitle': {
    pote: 'Mode diagnostic de test',
    direct: 'Mode diagnostic de test',
    pro: 'Mode diagnostic de test',
  },
  'agent.global.diagnosticTrace': {
    pote: 'Mode test : la transcription de ta demande et la réponse de Bob sont chiffrées et conservées jusqu’à {retentionDays} jours pour diagnostiquer la qualité. Aucun audio n’est conservé.',
    direct:
      'Mode test : transcription et réponse de Bob chiffrées, conservées jusqu’à {retentionDays} jours pour le diagnostic qualité. Aucun audio conservé.',
    pro: 'Mode test : la transcription de votre demande et la réponse de Bob sont chiffrées et conservées jusqu’à {retentionDays} jours pour diagnostiquer la qualité. Aucun audio n’est conservé.',
  },
  'agent.global.diagnosticTraceConfirm': {
    pote: 'Continuer',
    direct: 'Continuer',
    pro: 'Continuer',
  },
  'agent.global.diagnosticTraceCancel': {
    pote: 'Annuler',
    direct: 'Annuler',
    pro: 'Annuler',
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
  /** Papa vocal — qty/label déjà extraits (missing_price) : Bob les redit et ne demande QUE
   * le prix ; un simple « 55 euros » en suivi complète la ligne (completePendingQuoteLinePrice),
   * jamais besoin de tout redire. */
  'devis.voice.missingPriceReady': {
    pote: '{qty} × {label}, c’est noté — à quel prix HT ?',
    pro: '{qty} × {label} noté. Quel est le prix HT ?',
    direct: '{qty} × {label} : prix HT ?',
  },
  'devis.voice.missingVatReady': {
    pote: '{qty} × {label} à {price} HT, c’est prêt. Choisis maintenant la TVA, puis valide la ligne.',
    pro: '{qty} × {label} à {price} HT est prêt. Choisissez le taux de TVA, puis validez la ligne.',
    direct: '{qty} × {label}, {price} HT. Choisis la TVA puis valide.',
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
  'devis.voice.vatRequired': {
    pote: 'Il reste à choisir la TVA avant de pouvoir ajouter la ligne.',
    pro: 'Le taux de TVA doit être confirmé avant l’ajout de la ligne.',
    direct: 'Choisis la TVA avant d’ajouter.',
  },
  'devis.voice.vatSelected': {
    pote: 'TVA {rate} % confirmée pour ce devis.',
    pro: 'Taux de TVA {rate} % confirmé pour ce devis.',
    direct: 'TVA {rate} % confirmée.',
  },
  'devis.voice.vatUnavailable': {
    pote: 'Ce taux ne colle pas au régime actuel. Choisis une option affichée, je ne veux rien inventer.',
    pro: 'Ce taux n’est pas disponible pour le régime actuel. Sélectionnez une option affichée.',
    direct: 'Taux indisponible pour ce régime.',
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
  'devis.voice.needLinesStep': {
    pote: 'On a dépassé l’étape des lignes — reviens en arrière (à l’écran, ou dis « étape précédente ») pour ajouter ça.',
    pro: 'L’étape des lignes est passée. Revenez en arrière (à l’écran, ou dites « étape précédente ») pour ajouter cette ligne.',
    direct: 'Retour à l’étape lignes pour ajouter.',
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
  'ventes.dataError': {
    pote: 'Je n’arrive pas à charger tes devis et factures, là. On réessaie ?',
    pro: 'Impossible de charger vos devis et factures pour le moment. Veuillez réessayer.',
    direct: 'Devis/factures injoignables. Réessaie.',
  },
  'ventes.emptyQuotesTitle': {
    pote: 'Ton premier devis',
    pro: 'Votre premier devis',
    direct: 'Premier devis',
  },
  'ventes.emptyQuotesBody': {
    pote: 'C’est ici que vivront tes devis. Crée le premier — deux minutes, et je t’aide à chaque étape.',
    pro: 'Vos devis apparaîtront ici. Créez le premier — l’assistant vous guide à chaque étape.',
    direct: 'Aucun devis. Crée le premier.',
  },
  'ventes.emptyQuotesCta': {
    pote: 'Créer mon premier devis',
    pro: 'Créer un devis',
    direct: 'Créer un devis',
  },
  'ventes.emptyInvoicesBody': {
    pote: 'Tes factures naîtront ici, directement de tes devis signés — acompte, solde, tout suit.',
    pro: 'Vos factures apparaîtront ici, générées depuis vos devis signés.',
    direct: 'Aucune facture. Elles naissent des devis signés.',
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
  // E5 — badge de statut d'un AVOIR (masculin, ambre à l'émission) : « Émis », jamais « Émise ».
  'ventes.badgeAvoirEmis': { pote: 'Émis', pro: 'Émis', direct: 'Émis' },
  'ventes.badgeAvoirAnnule': { pote: 'Annulé', pro: 'Annulé', direct: 'Annulé' },
  // PR-02 — pièce émise JAMAIS transmise : badge AMBRE de liste (le bleu « Émise » rassurait à tort).
  'ventes.badgeATransmettre': {
    pote: 'À transmettre',
    pro: 'À transmettre',
    direct: 'À transmettre',
  },
  // E6 — tag ambre sur la ligne d'une facture CRÉDITÉE : visible d'un coup d'œil en liste.
  'ventes.tagAvoirEmis': { pote: 'Avoir émis', pro: 'Avoir émis', direct: 'Avoir émis' },
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

  // ── B9 — recherche intelligente devis & factures (autocomplétion, chips de dates, filtres avancés) ──
  'ventes.searchAdvancedButton': {
    pote: 'Recherche avancée',
    pro: 'Recherche avancée',
    direct: 'Filtres',
  },
  'ventes.suggest.sectionCustomers': { pote: 'Clients', pro: 'Clients', direct: 'Clients' },
  'ventes.suggest.sectionNumbers': { pote: 'Numéros', pro: 'Numéros', direct: 'Numéros' },
  'ventes.suggest.sectionLabels': {
    pote: 'Prestations',
    pro: 'Prestations',
    direct: 'Prestations',
  },
  'ventes.suggest.sectionRecent': {
    pote: 'Recherches récentes',
    pro: 'Recherches récentes',
    direct: 'Récentes',
  },
  'ventes.suggest.count': {
    pote: '{count} pièce(s)',
    pro: '{count} pièce(s)',
    direct: '{count}',
  },
  'ventes.dateChip.thisMonth': { pote: 'Ce mois-ci', pro: 'Ce mois-ci', direct: 'Ce mois' },
  'ventes.dateChip.lastMonth': { pote: 'Mois dernier', pro: 'Mois dernier', direct: 'M-1' },
  'ventes.dateChip.last2Months': {
    pote: '2 derniers mois',
    pro: '2 derniers mois',
    direct: '2 mois',
  },
  'ventes.dateChip.custom': { pote: 'Personnalisé', pro: 'Personnalisé', direct: 'Perso.' },
  'ventes.dateChip.customRange': {
    pote: 'Du {from} au {to}',
    pro: 'Du {from} au {to}',
    direct: '{from} → {to}',
  },
  'ventes.activeFilter.customer': {
    pote: 'Client : {name}',
    pro: 'Client : {name}',
    direct: '{name}',
  },
  'ventes.activeFilter.remove': {
    pote: 'Retirer ce filtre',
    pro: 'Retirer ce filtre',
    direct: 'Retirer',
  },
  'ventes.advancedSearch.title': {
    pote: 'Recherche avancée',
    pro: 'Recherche avancée',
    direct: 'Filtres',
  },
  'ventes.advancedSearch.subtitle': {
    pote: 'Combine client, numéro, prestation et dates — j’applique tout d’un coup.',
    pro: 'Combinez client, numéro, prestation et dates ; tous les filtres s’appliquent ensemble.',
    direct: 'Combine les filtres, applique.',
  },
  'ventes.advancedSearch.fieldCustomer': { pote: 'Client', pro: 'Client', direct: 'Client' },
  'ventes.advancedSearch.customerPlaceholder': {
    pote: 'Chercher un client…',
    pro: 'Rechercher un client…',
    direct: 'Client…',
  },
  'ventes.advancedSearch.fieldNumber': { pote: 'Numéro', pro: 'Numéro de pièce', direct: 'N°' },
  'ventes.advancedSearch.numberPlaceholder': {
    pote: 'Ex. F-2026-0012',
    pro: 'Ex. F-2026-0012',
    direct: 'F-2026-0012',
  },
  'ventes.advancedSearch.fieldLabel': {
    pote: 'Prestation',
    pro: 'Libellé de ligne',
    direct: 'Prestation',
  },
  'ventes.advancedSearch.labelPlaceholder': {
    pote: 'Ex. chauffe-eau',
    pro: 'Ex. chauffe-eau',
    direct: 'Chauffe-eau…',
  },
  'ventes.advancedSearch.fieldDates': { pote: 'Période', pro: 'Période', direct: 'Dates' },
  'ventes.advancedSearch.fieldStatus': { pote: 'Statut', pro: 'Statut', direct: 'Statut' },
  'ventes.advancedSearch.statusAny': { pote: 'Tous statuts', pro: 'Tous statuts', direct: 'Tous' },
  'ventes.advancedSearch.dateFrom': { pote: 'Du', pro: 'Du', direct: 'Du' },
  'ventes.advancedSearch.dateTo': { pote: 'Au', pro: 'Au', direct: 'Au' },
  'ventes.advancedSearch.submit': {
    pote: 'Rechercher',
    pro: 'Rechercher',
    direct: 'Rechercher',
  },
  'ventes.advancedSearch.reset': {
    pote: 'Tout effacer',
    pro: 'Réinitialiser',
    direct: 'Effacer',
  },
  'ventes.advancedSearch.cancel': { pote: 'Annuler', pro: 'Annuler', direct: 'Annuler' },
  'ventes.voiceSearchResultWithCustomerAndPeriod': {
    pote: 'Voilà les {kind} de {customer} {period} — j’en ai trouvé {count}.',
    pro: 'Voici les {kind} de {customer} {period} : {count} résultat(s).',
    direct: '{kind} {customer} {period} : {count}.',
  },
  'ventes.voiceSearchResultWithCustomer': {
    pote: 'Voilà les {kind} de {customer} — j’en ai trouvé {count}.',
    pro: 'Voici les {kind} de {customer} : {count} résultat(s).',
    direct: '{kind} {customer} : {count}.',
  },
  'ventes.voiceSearchResultWithPeriod': {
    pote: 'Voilà les {kind} {period} — j’en ai trouvé {count}.',
    pro: 'Voici les {kind} {period} : {count} résultat(s).',
    direct: '{kind} {period} : {count}.',
  },
  'ventes.voiceSearchNoResults': {
    pote: 'Je ne trouve aucun résultat pour ça.',
    pro: 'Aucun résultat pour cette recherche.',
    direct: 'Aucun résultat.',
  },
  'ventes.voiceSearchKindQuotes': { pote: 'devis', pro: 'devis', direct: 'devis' },
  'ventes.voiceSearchKindInvoices': { pote: 'factures', pro: 'factures', direct: 'factures' },
  'ventes.voiceSearchKindAll': {
    pote: 'devis et factures',
    pro: 'devis et factures',
    direct: 'pièces',
  },
  // Fragments composés par le code (jamais affichés seuls) pour bâtir le {period} des clés
  // voiceSearchResult* ci-dessus — une SEULE source de vérité entre les chips et la voix
  // (packages/core parseFrenchPeriod pose le label, ces clés le traduisent en phrase).
  'ventes.period.thisMonth': { pote: 'de ce mois-ci', pro: 'de ce mois-ci', direct: 'ce mois-ci' },
  'ventes.period.lastMonth': {
    pote: 'du mois dernier',
    pro: 'du mois dernier',
    direct: 'mois dernier',
  },
  'ventes.period.thisWeek': {
    pote: 'de cette semaine',
    pro: 'de cette semaine',
    direct: 'cette semaine',
  },
  'ventes.period.today': { pote: 'du jour', pro: 'du jour', direct: 'aujourd’hui' },
  'ventes.period.thisYear': {
    pote: 'de cette année',
    pro: 'de cette année',
    direct: 'cette année',
  },
  'ventes.period.lastNMonths': {
    pote: 'des {n} derniers mois',
    pro: 'des {n} derniers mois',
    direct: '{n} derniers mois',
  },
  'ventes.period.since': {
    pote: 'depuis {month}',
    pro: 'depuis {month}',
    direct: 'depuis {month}',
  },

  // Brouillon local de devis (C21 redécoupe 2026-07-17) — carte visible en tête de la liste
  // Devis, jamais confondu avec un devis brouillon SERVEUR (QUOTE_BADGE.draft) : celui-ci n'a
  // encore jamais touché le backend.
  'ventes.draftCard.badge': {
    pote: 'Brouillon',
    pro: 'Brouillon',
    direct: 'Brouillon',
  },
  'ventes.draftCard.noCustomer': {
    pote: 'Client non choisi',
    pro: 'Client non choisi',
    direct: 'Client non choisi',
  },
  'ventes.draftCard.subtitle': {
    pote: 'Brouillon local · jamais envoyé',
    pro: 'Brouillon local · jamais envoyé',
    direct: 'Local · jamais envoyé',
  },
  'ventes.draftCard.resume': {
    pote: 'Continuer le devis',
    pro: 'Continuer le devis',
    direct: 'Continuer',
  },
  'ventes.draftCard.delete': {
    pote: 'Supprimer le brouillon',
    pro: 'Supprimer le brouillon',
    direct: 'Supprimer',
  },
  'ventes.draftCard.deleteConfirmTitle': {
    pote: 'Supprimer ce brouillon ?',
    pro: 'Supprimer ce brouillon ?',
    direct: 'Supprimer le brouillon ?',
  },
  'ventes.draftCard.deleteConfirmBody': {
    pote: 'Le brouillon de devis pour {name} sera définitivement supprimé. Cette action est irréversible.',
    pro: 'Le brouillon de devis pour {name} sera définitivement supprimé. Cette action est irréversible.',
    direct: 'Brouillon {name} supprimé pour de bon. Irréversible.',
  },
  'ventes.voiceDraftResume': {
    pote: 'Je rouvre ton brouillon.',
    pro: 'Le brouillon se rouvre.',
    direct: 'Brouillon rouvert.',
  },
  'ventes.voiceDraftDeleteOpened': {
    pote: 'Confirme à l’écran pour supprimer le brouillon.',
    pro: 'Confirmez à l’écran pour supprimer le brouillon.',
    direct: 'Confirme à l’écran.',
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
  'devis.voice.invoiceDepositUnavailable': {
    pote: 'Le parcours acompte pour un client professionnel attend encore sa certification Factur-X EXTENDED et Plateforme Agréée. Je ne te propose pas une action qui bloquerait ensuite au solde.',
    pro: 'Le parcours acompte professionnel reste fermé jusqu’à sa certification Factur-X EXTENDED et Plateforme Agréée. Aucune action incomplète n’est proposée.',
    direct: 'Acompte professionnel indisponible jusqu’à certification EXTENDED/PA.',
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
  // R7 : lien de consultation partagé — dit + Share natif déjà ouvert (pas de Sheet à toucher).
  'devis.voice.shareLinkOpened': {
    pote: 'C’est parti, je t’ouvre le partage du lien.',
    pro: 'Le partage du lien est ouvert.',
    direct: 'Partage ouvert.',
  },
  // R7 : même pattern côté facture (facture/[id].tsx) — dit + Share natif déjà ouvert.
  'facture.voice.shareLinkOpened': {
    pote: 'C’est parti, je t’ouvre le partage du lien.',
    pro: 'Le partage du lien est ouvert.',
    direct: 'Partage ouvert.',
  },
  // PR-01 « Encaisser » — envoi EMAIL réel de la facture émise (bouton confirmé, jamais un
  // effet de bord de l'émission). Le résultat dit le VRAI destinataire et le VRAI statut :
  // « en file » (outbox, worker à suivre) n'est jamais présenté comme « reçue ».
  'facture.sendButton': {
    pote: 'Envoyer par e-mail',
    pro: 'Envoyer par e-mail',
    direct: 'Envoyer',
  },
  'facture.sendConfirmTitle': {
    pote: 'Envoyer la facture ?',
    pro: 'Envoyer la facture',
    direct: 'Envoyer ?',
  },
  'facture.sendConfirmBody': {
    pote: 'Ton client reçoit un e-mail au nom de ta société, avec le lien de consultation et le PDF joint. Rien d’autre ne part.',
    pro: 'Votre client recevra un e-mail au nom de votre société, avec le lien de consultation et le PDF joint.',
    direct: 'E-mail au client : lien + PDF. Au nom de ta société.',
  },
  // PR-09 — choix du destinataire (contacts multiples du client) : le récap confirmé DIT
  // l'adresse choisie ; « e-mail de la fiche client » reste le défaut honnête.
  'facture.sendConfirmBodyTo': {
    pote: 'J’envoie à {recipient} — e-mail au nom de ta société, lien de consultation + PDF joint. Rien d’autre ne part.',
    pro: 'La facture sera envoyée à {recipient} au nom de votre société (lien de consultation + PDF joint).',
    direct: 'Envoi à {recipient} : lien + PDF. Au nom de ta société.',
  },
  'facture.sendRecipientTitle': {
    pote: 'À qui je l’envoie ?',
    pro: 'Choisir le destinataire',
    direct: 'Destinataire ?',
  },
  'facture.sendRecipientHint': {
    pote: 'Choisis le contact — ou laisse l’e-mail de la fiche client. Rien ne part avant ta confirmation.',
    pro: 'Sélectionnez un contact, ou conservez l’adresse de la fiche client. Aucun envoi avant confirmation.',
    direct: 'Contact ou e-mail de la fiche. Confirmation ensuite.',
  },
  'facture.sendRecipientDefault': {
    pote: 'E-mail de la fiche client',
    pro: 'Adresse de la fiche client',
    direct: 'E-mail de la fiche',
  },
  'facture.sendRecipientCta': {
    pote: 'Continuer',
    pro: 'Continuer',
    direct: 'Continuer',
  },
  'facture.sendQueuedTitle': {
    pote: 'C’est parti !',
    pro: 'Envoi programmé',
    direct: 'Parti.',
  },
  'facture.sendQueuedBody': {
    pote: 'La facture {number} part chez {recipient} — je te préviens si l’envoi échoue.',
    pro: 'La facture {number} est en cours d’envoi à {recipient}. Vous serez averti en cas d’échec.',
    direct: '{number} → {recipient}. Alerte si échec.',
  },
  'facture.sendAlreadySentBody': {
    pote: 'Cet envoi de la facture {number} à {recipient} est déjà parti — rien à renvoyer.',
    pro: 'Cet envoi de la facture {number} à {recipient} a déjà été effectué.',
    direct: 'Déjà envoyée : {number} → {recipient}.',
  },
  // PR-02 — suivi de transmission du canal EMAIL sur la fiche facture : preuve serveur (outbox)
  // vs déclaration manuelle — les deux formulations restent DISTINCTES (jamais un accusé inventé).
  'facture.emailDeliveredOn': {
    pote: 'Envoyée par e-mail le {date} ✓',
    pro: 'Envoyée par e-mail le {date}',
    direct: 'Envoyée le {date} ✓',
  },
  'facture.declaredSentOn': {
    pote: 'Marquée envoyée le {date} (déclaré par toi)',
    pro: 'Déclarée envoyée le {date}',
    direct: 'Déclarée envoyée le {date}.',
  },
  'facture.neverTransmitted': {
    pote: 'Émise, mais jamais transmise',
    pro: 'Émise, sans transmission constatée',
    direct: 'Émise. Jamais transmise.',
  },
  'facture.neverTransmittedHint': {
    pote: 'Rien ne prouve que ton client l’a reçue. Envoie-la par e-mail juste au-dessus — ou si elle est déjà partie autrement, dis-le-moi.',
    pro: 'Aucun envoi n’est constaté. Envoyez-la par e-mail — ou déclarez sa transmission si elle est déjà partie par un autre canal.',
    direct: 'Aucun envoi constaté. Envoie-la, ou déclare-la partie.',
  },
  'facture.markSentAction': {
    pote: 'Déjà partie ? Marquer envoyée',
    pro: 'Déclarer la facture envoyée',
    direct: 'Marquer envoyée',
  },
  'facture.markSentConfirmTitle': {
    pote: 'Marquer envoyée ?',
    pro: 'Déclarer la facture envoyée',
    direct: 'Marquer envoyée ?',
  },
  'facture.markSentConfirmBody': {
    pote: 'Je note qu’elle est partie aujourd’hui, par tes soins. C’est une déclaration — corrigeable dans le suivi de transmission.',
    pro: 'La facture sera déclarée transmise à la date du jour. Cette déclaration reste corrigeable.',
    direct: 'Déclarée partie aujourd’hui. Corrigeable.',
  },
  // PR-12b (écrans §6.5) — bloc « Contrat » du brouillon annuel : la pièce MONTRE le contrat
  // qu'elle facture et la période qu'elle porte ; période éditable en BROUILLON, figée à
  // l'émission (garde + trigger SQL). Bornes HUMAINES inclusives, jamais une borne exclusive
  // qui « ment d'un jour ».
  'facture.contractBlockTitle': {
    pote: 'Contrat',
    pro: 'Contrat de maintenance',
    direct: 'Contrat',
  },
  'facture.contractLabel': {
    pote: 'Contrat : {label}',
    pro: 'Contrat : {label}',
    direct: 'Contrat : {label}',
  },
  'facture.contractPeriod': {
    pote: 'Période : {start} → {end}',
    pro: 'Période : {start} → {end}',
    direct: 'Période : {start} → {end}',
  },
  'facture.contractPeriodMissing': {
    pote: 'Période non renseignée — il la faut avant d’émettre.',
    pro: 'Période de service non renseignée — requise avant émission.',
    direct: 'Période manquante (requise avant émission).',
  },
  'facture.contractPeriodEditCta': {
    pote: 'Modifier la période',
    pro: 'Modifier la période',
    direct: 'Modifier',
  },
  'facture.contractPeriodFrozen': {
    pote: 'Figée à l’émission.',
    pro: 'Période figée à l’émission.',
    direct: 'Figée à l’émission.',
  },
  'facture.contractPeriodSheetTitle': {
    pote: 'Période de service',
    pro: 'Période de service du contrat',
    direct: 'Période de service',
  },
  'facture.contractPeriodStartField': {
    pote: 'Début (AAAA-MM-JJ)',
    pro: 'Début de période (AAAA-MM-JJ)',
    direct: 'Début (AAAA-MM-JJ)',
  },
  'facture.contractPeriodEndField': {
    pote: 'Fin incluse (AAAA-MM-JJ)',
    pro: 'Fin de période incluse (AAAA-MM-JJ)',
    direct: 'Fin incluse (AAAA-MM-JJ)',
  },
  'facture.contractPeriodSaveCta': {
    pote: 'Enregistrer',
    pro: 'Enregistrer la période',
    direct: 'Enregistrer',
  },
  // PR-06 — historique des relances de la pièce (filtre du fil serveur, statut honnête).
  'facture.relanceHistoryTitle': {
    pote: 'Relances',
    pro: 'Relances',
    direct: 'Relances',
  },
  'facture.relanceSent': {
    pote: 'Envoyée',
    pro: 'Envoyée',
    direct: 'Envoyée',
  },
  'facture.relancePending': {
    pote: 'En cours',
    pro: 'En cours d’envoi',
    direct: 'En cours',
  },
  'facture.relanceFailed': {
    pote: 'Échec',
    pro: 'Échec d’envoi',
    direct: 'Échec',
  },
  // PR-06 — réglages : cadence de relance paramétrable + interrupteur automatique.
  'reglages.sectionRelances': {
    pote: 'Relances',
    pro: 'Relances',
    direct: 'Relances',
  },
  'reglages.relanceAutoTitle': {
    pote: 'Relances automatiques',
    pro: 'Relances automatiques',
    direct: 'Relances auto',
  },
  'reglages.relanceAutoSubtitle': {
    pote: 'Bob relance tes factures en retard tout seul (jamais la mise en demeure — elle attend toujours ton feu vert).',
    pro: 'Les factures en retard sont relancées automatiquement. La mise en demeure reste soumise à votre validation.',
    direct: 'Relances auto. MED toujours validée par toi.',
  },
  'reglages.relanceCadenceLabel': {
    pote: 'Cadence des relances',
    pro: 'Cadence des relances',
    direct: 'Cadence',
  },
  'reglages.relanceCadenceDefault': {
    pote: 'Réactive (défaut)',
    pro: 'Réactive (par défaut)',
    direct: 'Réactive',
  },
  'reglages.relanceCadenceSouple': {
    pote: 'Souple',
    pro: 'Souple',
    direct: 'Souple',
  },
  'reglages.relanceCadencePatiente': {
    pote: 'Patiente',
    pro: 'Patiente',
    direct: 'Patiente',
  },
  'reglages.relanceCadenceCurrent': {
    pote: 'Rappels à J+{cordial}, J+{neutre} et J+{ferme} après l’échéance — mise en demeure proposée à J+{med}, jamais envoyée sans toi.',
    pro: 'Rappels à J+{cordial}, J+{neutre} et J+{ferme} après l’échéance. Mise en demeure proposée à J+{med}, envoyée uniquement après validation.',
    direct: 'J+{cordial} / J+{neutre} / J+{ferme}. MED proposée à J+{med}.',
  },
  'reglages.relanceNote': {
    pote: 'Chaque relance embarque le lien de consultation de la facture — ton client règle en deux taps.',
    pro: 'Chaque relance contient le lien de consultation de la facture concernée.',
    direct: 'Le lien de la facture part avec chaque relance.',
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
  // PR-14 « Le métier » — forfaits/contrats récurrents (entretien annuel, maintenance).
  'voix.catSubscription': {
    pote: 'Abonnement / forfait',
    pro: 'Abonnement / forfait',
    direct: 'Abonnement',
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
  // Bannière de reprise (bug fondateur 2026-07-17) : « Devis » démarre TOUJOURS vierge — un
  // brouillon enregistré n'est jamais repris en silence, seulement PROPOSÉ ici.
  'devis.resumeBanner.prompt': {
    pote: 'Tu as un brouillon en cours ({name}) — le reprendre ?',
    pro: 'Un brouillon est en cours pour {name} — le reprendre ?',
    direct: 'Brouillon en cours ({name}). Reprendre ?',
  },
  'devis.resumeBanner.promptNoName': {
    pote: 'Tu as un brouillon de devis en cours — le reprendre ?',
    pro: 'Un brouillon de devis est en cours — le reprendre ?',
    direct: 'Brouillon en cours. Reprendre ?',
  },
  'devis.resumeBanner.dismiss': {
    pote: 'Ignorer, démarrer à neuf',
    pro: 'Ignorer, démarrer à neuf',
    direct: 'Ignorer',
  },
  'devis.close': {
    pote: 'Fermer',
    pro: 'Fermer',
    direct: 'Fermer',
  },
  'devis.draftLoad.loading': {
    pote: 'Je récupère ton brouillon sécurisé.',
    pro: 'Chargement du brouillon sécurisé.',
    direct: 'Chargement du brouillon.',
  },
  'devis.draftLoad.error': {
    pote: 'Je n’arrive pas à récupérer ton brouillon. Rien de local ne sera affiché à sa place.',
    pro: 'Le brouillon n’a pas pu être récupéré. Aucune donnée locale ne lui est substituée.',
    direct: 'Brouillon inaccessible. Aucune donnée locale affichée.',
  },
  'devis.mission.loading': {
    pote: 'Je synchronise le devis avec ce que tu viens de me demander.',
    pro: 'Synchronisation de la mission avec le devis affiché.',
    direct: 'Synchronisation du devis.',
  },
  'devis.mission.error': {
    pote: 'Je n’ai pas pu vérifier que ce devis est bien celui de notre conversation. Rien n’a été modifié.',
    pro: 'La mission n’a pas pu être reliée de façon sûre au devis affiché. Aucune modification n’a été appliquée.',
    direct: 'Mission non vérifiée. Aucune modification appliquée.',
  },
  'devis.mission.localChanges': {
    pote: 'Ce devis a changé pendant la synchronisation. Je garde tes modifications et je n’écrase rien. Ferme cet écran pour décider de la suite avant de relancer Bob.',
    pro: 'Le devis a été modifié pendant la synchronisation. Les modifications sont préservées. Fermez cet écran afin de décider de la suite avant de relancer Bob.',
    direct: 'Modifications préservées. Ferme cet écran avant de relancer Bob.',
  },
  'devis.mission.draftDecision': {
    pote: 'J’ai retrouvé un autre brouillon. Ferme cet écran, choisis celui que tu veux reprendre, puis relance Bob.',
    pro: 'Un autre brouillon a été retrouvé. Fermez cet écran, choisissez le brouillon à reprendre, puis relancez Bob.',
    direct: 'Autre brouillon trouvé. Ferme, choisis le brouillon, puis relance Bob.',
  },
  'devis.mission.expired': {
    pote: 'Cette mission a expiré. Le devis reste protégé : ferme cet écran, puis relance Bob pour décider de la suite sans rien écraser.',
    pro: 'Cette mission a expiré. Le brouillon reste protégé ; fermez cet écran, puis relancez Bob afin de décider de la suite.',
    direct: 'Mission expirée. Ferme cet écran, puis relance Bob.',
  },
  'devis.mission.leaveAction': {
    pote: 'Fermer sans rien modifier',
    pro: 'Fermer sans modifier',
    direct: 'Fermer',
  },
  'devis.mission.resumeTitle': {
    pote: 'J’ai retrouvé notre devis',
    pro: 'Mission de devis retrouvée',
    direct: 'Devis retrouvé',
  },
  'devis.mission.resumeBody': {
    pote: 'Le vrai brouillon et tes choix sont toujours là. Reprends avec Bob pour rattacher une nouvelle session, sans rejouer ni inventer quoi que ce soit.',
    pro: 'Le brouillon autoritaire et ses choix sont intacts. Reprenez avec Bob pour rattacher une nouvelle session sécurisée.',
    direct: 'Brouillon intact. Rattache une nouvelle session Bob.',
  },
  'devis.mission.resumeExpiredTitle': {
    pote: 'Cette conversation a expiré',
    pro: 'Mission arrivée à expiration',
    direct: 'Mission expirée',
  },
  'devis.mission.resumeExpiredBody': {
    pote: 'Le brouillon reste protégé. Relance Bob : il vérifiera la situation avant de reprendre ou de te rendre la main.',
    pro: 'Le brouillon reste protégé. Relancez Bob afin qu’il vérifie la situation avant toute reprise.',
    direct: 'Brouillon protégé. Relance Bob pour vérifier la suite.',
  },
  'devis.mission.resumeExpiredAction': {
    pote: 'Fermer sans rien modifier',
    pro: 'Fermer sans modifier',
    direct: 'Fermer',
  },
  'devis.mission.resumeAction': {
    pote: 'Reprendre avec Bob',
    pro: 'Reprendre avec Bob',
    direct: 'Reprendre avec Bob',
  },
  'devis.mission.resumeLoading': {
    pote: 'Je me reconnecte…',
    pro: 'Reconnexion sécurisée…',
    direct: 'Reconnexion…',
  },
  'devis.mission.linesHandoff': {
    pote: 'Le client est confirmé et le devis est libéré. Tu peux continuer les prestations à l’écran.',
    pro: 'Le client est confirmé et le devis est libéré. Vous pouvez poursuivre les prestations à l’écran.',
    direct: 'Client confirmé, devis libéré. Continue les prestations.',
  },
  'devis.mission.line.title': {
    pote: 'Bob construit ce devis avec toi',
    pro: 'Bob construit ce devis avec vous',
    direct: 'Bob pilote le devis',
  },
  'devis.mission.line.liveHint': {
    pote: 'Continue à parler ou touche un choix : c’est la même mission, sans double saisie.',
    pro: 'Poursuivez à la voix ou sélectionnez une option : les deux canaux partagent la même mission.',
    direct: 'Voix ou toucher. Même mission, même résultat.',
  },
  'devis.mission.line.abandonAction': {
    pote: 'Arrêter cette mission Bob',
    pro: 'Abandonner cette mission Bob',
    direct: 'Abandonner la mission',
  },
  'devis.mission.line.abandonHint': {
    pote: 'Le brouillon reste enregistré et tu pourras continuer à la main.',
    pro: 'Le brouillon reste enregistré et pourra être poursuivi manuellement.',
    direct: 'Conserve le brouillon et libère la saisie manuelle.',
  },
  'devis.mission.line.abandonTitle': {
    pote: 'Arrêter Bob sur ce devis ?',
    pro: 'Abandonner la mission Bob ?',
    direct: 'Abandonner la mission ?',
  },
  'devis.mission.line.abandonBody': {
    pote: 'Je garderai le brouillon tel quel et tu pourras continuer à la main. La ligne en attente ne sera pas ajoutée.',
    pro: 'Le brouillon sera conservé et rendu à la saisie manuelle. Toute ligne encore en attente sera écartée.',
    direct: 'Brouillon conservé. Ligne en attente écartée. Saisie manuelle disponible.',
  },
  'devis.mission.line.abandoning': {
    pote: 'Je sécurise le brouillon…',
    pro: 'Abandon sécurisé en cours…',
    direct: 'Abandon sécurisé…',
  },
  'devis.mission.line.abandonError': {
    pote: 'Je n’ai pas pu confirmer l’abandon. Le brouillon reste protégé et Bob garde la main.',
    pro: 'L’abandon n’a pas pu être confirmé. Le brouillon reste protégé et la mission demeure propriétaire.',
    direct: 'Abandon non confirmé. Brouillon protégé.',
  },
  'devis.mission.line.stateUpdated': {
    pote: 'Le devis a été mis à jour.',
    pro: 'La mission de devis a été mise à jour.',
    direct: 'Devis mis à jour.',
  },
  'devis.mission.line.busy': {
    pote: 'Je vérifie et j’enregistre.',
    pro: 'Vérification et enregistrement.',
    direct: 'Enregistrement.',
  },
  'devis.mission.line.confirmedTitle': {
    pote: 'Déjà dans le devis',
    pro: 'Lignes déjà enregistrées',
    direct: 'Lignes enregistrées',
  },
  'devis.mission.line.confirmedEmpty': {
    pote: 'Aucune ligne pour l’instant. Dis-moi ce que tu factures.',
    pro: 'Aucune ligne pour le moment. Dictez ou saisissez la première prestation.',
    direct: 'Aucune ligne. Dicte ou saisis la première.',
  },
  'devis.mission.line.catalogueTitle': {
    pote: 'J’ai trouvé ça dans ton catalogue',
    pro: 'Correspondances trouvées dans votre catalogue',
    direct: 'Correspondances catalogue',
  },
  'devis.mission.line.catalogueBody': {
    pote: 'Choisis la bonne entrée, ou continue avec une prestation qui n’y est pas encore.',
    pro: 'Sélectionnez l’entrée exacte ou poursuivez avec une prestation hors catalogue.',
    direct: 'Choisis une entrée ou une prestation libre.',
  },
  'devis.mission.line.catalogueChoiceA11y': {
    pote: 'Choix {ordinal}, {label}. {details}',
    pro: 'Choix {ordinal}, {label}. {details}',
    direct: 'Choix {ordinal}, {label}. {details}',
  },
  'devis.mission.line.catalogueChoiceDetails': {
    pote: '{category} · {price} par {unit} · {vat}',
    pro: '{category} · {price} par {unit} · {vat}',
    direct: '{category} · {price}/{unit} · {vat}',
  },
  'devis.mission.line.notSpecified': {
    pote: 'à préciser',
    pro: 'à préciser',
    direct: 'à préciser',
  },
  'devis.mission.line.catalogueUnavailable': {
    pote: 'Cette entrée n’est plus disponible',
    pro: 'Entrée désormais indisponible',
    direct: 'Entrée indisponible',
  },
  'devis.mission.line.catalogueFree': {
    pote: 'Aucune — créer cette prestation',
    pro: 'Aucune — poursuivre en saisie libre',
    direct: 'Nouvelle prestation',
  },
  'devis.mission.line.proposalTitle': {
    pote: 'Voilà la ligne que je te propose',
    pro: 'Ligne proposée pour validation',
    direct: 'Ligne proposée',
  },
  'devis.mission.line.diffTitle': {
    pote: 'Ce qui va changer dans ton devis',
    pro: 'Impact de la validation sur le devis',
    direct: 'Avant / après',
  },
  'devis.mission.line.diffBefore': {
    pote: 'Avant',
    pro: 'Avant validation',
    direct: 'Avant',
  },
  'devis.mission.line.diffAfter': {
    pote: 'Après ajout',
    pro: 'Après validation',
    direct: 'Après',
  },
  'devis.mission.line.diffSummaryOne': {
    pote: '1 ligne · {total} HT',
    pro: '1 ligne · total HT {total}',
    direct: '1 ligne · {total} HT',
  },
  'devis.mission.line.diffSummaryMany': {
    pote: '{count} lignes · {total} HT',
    pro: '{count} lignes · total HT {total}',
    direct: '{count} lignes · {total} HT',
  },
  'devis.mission.line.diffAccessibility': {
    pote: 'Impact sur ton devis. Avant : {before}. Après ajout : {after}.',
    pro: 'Impact sur le devis. Avant validation : {before}. Après validation : {after}.',
    direct: 'Impact. Avant : {before}. Après : {after}.',
  },
  'devis.mission.line.vatValue': {
    pote: 'TVA {rate} %',
    pro: 'TVA {rate} %',
    direct: 'TVA {rate} %',
  },
  'devis.mission.line.catalogueSource': {
    pote: 'Reprise du catalogue : {label}',
    pro: 'Source catalogue : {label}',
    direct: 'Catalogue : {label}',
  },
  'devis.mission.line.confirm': {
    pote: 'Oui, ajouter cette ligne',
    pro: 'Valider et ajouter la ligne',
    direct: 'Ajouter la ligne',
  },
  'devis.mission.line.modify': {
    pote: 'Modifier avant d’ajouter',
    pro: 'Modifier la proposition',
    direct: 'Modifier',
  },
  'devis.mission.line.cancel': {
    pote: 'Ne pas ajouter cette ligne',
    pro: 'Écarter cette ligne',
    direct: 'Annuler la ligne',
  },
  'devis.mission.line.modifyTitle': {
    pote: 'Qu’est-ce que tu veux corriger ?',
    pro: 'Sélectionnez l’élément à corriger',
    direct: 'Élément à corriger',
  },
  'devis.mission.line.factTitle': {
    pote: 'Il me manque juste une information',
    pro: 'Information nécessaire pour poursuivre',
    direct: 'Information requise',
  },
  'devis.mission.line.fact.service': {
    pote: 'Description de la prestation',
    pro: 'Description de la prestation',
    direct: 'Description',
  },
  'devis.mission.line.fact.category': {
    pote: 'Type de prestation',
    pro: 'Catégorie de prestation',
    direct: 'Catégorie',
  },
  'devis.mission.line.fact.quantity': {
    pote: 'Quantité',
    pro: 'Quantité',
    direct: 'Quantité',
  },
  'devis.mission.line.fact.unit': {
    pote: 'Unité',
    pro: 'Unité',
    direct: 'Unité',
  },
  'devis.mission.line.fact.price': {
    pote: 'Prix unitaire HT',
    pro: 'Prix unitaire hors taxes',
    direct: 'Prix unitaire HT',
  },
  'devis.mission.line.fact.vat': {
    pote: 'Taux de TVA',
    pro: 'Taux de TVA',
    direct: 'TVA',
  },
  'devis.mission.line.fact.housingAge': {
    pote: 'Le logement a plus de 2 ans',
    pro: 'Logement achevé depuis plus de deux ans',
    direct: 'Logement de plus de 2 ans',
  },
  'devis.mission.line.fact.energy': {
    pote: 'Travaux de rénovation énergétique',
    pro: 'Nature de rénovation énergétique',
    direct: 'Rénovation énergétique',
  },
  'devis.mission.line.yes': {
    pote: 'Oui',
    pro: 'Oui',
    direct: 'Oui',
  },
  'devis.mission.line.no': {
    pote: 'Non',
    pro: 'Non',
    direct: 'Non',
  },
  'devis.mission.line.submit': {
    pote: 'Envoyer cette correction',
    pro: 'Valider cette correction',
    direct: 'Valider',
  },
  'devis.mission.line.back': {
    pote: 'Revenir à la proposition',
    pro: 'Revenir à la proposition',
    direct: 'Retour',
  },
  'devis.mission.line.staleTitle': {
    pote: 'Cette proposition a changé',
    pro: 'Proposition à réviser',
    direct: 'Proposition périmée',
  },
  'devis.mission.line.staleCatalogue': {
    pote: 'Le catalogue a évolué depuis ma proposition. Corrige la ligne ou annule-la ; je ne validerai jamais un ancien prix.',
    pro: 'Le catalogue a changé depuis le calcul. Modifiez ou annulez la ligne avant toute validation.',
    direct: 'Catalogue modifié. Corrige ou annule la ligne.',
  },
  'devis.mission.line.staleVat': {
    pote: 'Le contexte de TVA a évolué depuis ma proposition. Corrige la ligne ou annule-la pour repartir sur les règles actuelles.',
    pro: 'Le contexte de TVA a changé. Modifiez ou annulez la ligne avant toute validation.',
    direct: 'TVA modifiée. Corrige ou annule la ligne.',
  },
  'devis.mission.line.manualTitle': {
    pote: 'Ou ajoute une prestation au clavier',
    pro: 'Ajouter une prestation manuellement',
    direct: 'Saisie manuelle',
  },
  'devis.mission.line.limitTitle': {
    pote: 'Ce devis est complet',
    pro: 'Limite de lignes atteinte',
    direct: 'Limite atteinte',
  },
  'devis.mission.line.limitBody': {
    pote: 'Le devis contient déjà {count} lignes. Pour les modifier, arrête cette mission Bob : ton brouillon restera enregistré et la saisie manuelle sera libérée.',
    pro: 'Le devis contient déjà les {count} lignes autorisées. Abandonnez cette mission Bob pour conserver le brouillon et libérer sa modification manuelle.',
    direct: '{count} lignes atteintes. Abandonne la mission pour conserver le brouillon et libérer la saisie manuelle.',
  },
  'devis.mission.line.service': {
    pote: 'Prestation',
    pro: 'Prestation',
    direct: 'Prestation',
  },
  'devis.mission.line.quantity': {
    pote: 'Qté',
    pro: 'Quantité',
    direct: 'Qté',
  },
  'devis.mission.line.unit': {
    pote: 'Unité',
    pro: 'Unité',
    direct: 'Unité',
  },
  'devis.mission.line.price': {
    pote: 'Prix HT',
    pro: 'Prix HT',
    direct: 'Prix HT',
  },
  'devis.mission.line.add': {
    pote: 'Proposer cette ligne',
    pro: 'Proposer cette ligne',
    direct: 'Proposer',
  },
  'devis.mission.line.finishingTitle': {
    pote: 'Je termine cette ligne',
    pro: 'Finalisation de la ligne en cours',
    direct: 'Ligne en cours de finalisation',
  },
  'devis.mission.line.finishingBody': {
    pote: 'La demande est enregistrée. Je relis le résultat avant de te proposer la suite.',
    pro: 'La demande est enregistrée. Le résultat autoritaire est relu avant la prochaine décision.',
    direct: 'Demande enregistrée. Vérification du résultat.',
  },
  'devis.mission.line.error': {
    pote: 'Je n’ai pas pu vérifier le résultat. Réessaie : je renverrai exactement la même commande, sans créer de doublon.',
    pro: 'Le résultat n’a pas pu être vérifié. Une nouvelle tentative rejouera strictement la même commande idempotente.',
    direct: 'Résultat non vérifié. Réessaie avec la même commande, sans doublon.',
  },
  'devis.mission.line.retry': {
    pote: 'Réessayer sans doublon',
    pro: 'Réessayer la même commande',
    direct: 'Réessayer',
  },
  'devis.mission.handoffTitle': {
    pote: 'Le client est confirmé',
    pro: 'Client confirmé',
    direct: 'Client confirmé',
  },
  'devis.mission.handoffBody': {
    pote: 'J’ai sécurisé le choix dans le vrai brouillon. Passe à la saisie manuelle pour ajouter les prestations sans perdre ce travail.',
    pro: 'Le choix est enregistré dans le brouillon autoritaire. Libérez la mission avant de poursuivre la saisie manuelle des prestations.',
    direct: 'Choix enregistré. Libère la mission pour saisir les prestations.',
  },
  'devis.mission.handoffAction': {
    pote: 'Continuer à la main',
    pro: 'Continuer à la main',
    direct: 'Continuer à la main',
  },
  'devis.mission.handoffLoading': {
    pote: 'Je sécurise la passation…',
    pro: 'Passation sécurisée…',
    direct: 'Passation…',
  },
  'devis.mission.handoffError': {
    pote: 'La passation n’a pas été confirmée. Le devis reste protégé : réessaie, rien n’a été perdu.',
    pro: 'La passation n’a pas été confirmée. Le brouillon reste protégé et aucune saisie concurrente n’est autorisée.',
    direct: 'Passation non confirmée. Brouillon protégé, réessaie.',
  },
  'devis.mission.customerSelectionLoading': {
    pote: 'Je confirme ce client.',
    pro: 'Confirmation du client.',
    direct: 'Confirmation du client.',
  },
  'devis.mission.customerSelectionError': {
    pote: 'Je n’ai pas pu confirmer ce client sans risque. Rien n’a été modifié ; réessaie.',
    pro: 'Le client n’a pas pu être confirmé de façon sûre. Aucune modification n’a été appliquée.',
    direct: 'Client non confirmé. Rien n’a été modifié.',
  },
  'devis.mission.customerRefreshError': {
    pote: 'Ce client n’est plus disponible et je n’ai pas pu actualiser la liste. Le devis n’a pas bougé ; réessaie.',
    pro: 'Ce client n’est plus disponible et la liste n’a pas pu être actualisée. Le devis reste inchangé.',
    direct: 'Client indisponible. Actualisation échouée, devis inchangé.',
  },
  'devis.mission.customerListPartialError': {
    pote: 'Les choix de Bob restent disponibles, mais je n’ai pas pu charger le reste de tes clients.',
    pro: 'Les choix proposés restent disponibles, mais le reste de la liste clients n’a pas pu être chargé.',
    direct: 'Choix Bob disponibles. Reste de la liste inaccessible.',
  },
  'devis.mission.customerChoicesTitle': {
    pote: 'Voici les choix que j’ai trouvés',
    pro: 'Choix proposés par Bob',
    direct: 'Choix proposés',
  },
  'devis.mission.customerChoicesBody': {
    pote: 'Ils sont numérotés dans le même ordre que mes choix vocaux. Tu peux répondre ou toucher directement un autre client.',
    pro: 'Les clients proposés sont numérotés dans l’ordre vocal. Vous pouvez répondre ou sélectionner directement un autre client.',
    direct: 'Ordre identique à la voix. Réponds ou touche un autre client.',
  },
  'devis.mission.customerChoiceAccessibility': {
    pote: 'Choix {ordinal}, {name}',
    pro: 'Choix {ordinal}, {name}',
    direct: 'Choix {ordinal}, {name}',
  },
  'devis.mission.customerChoiceUnavailable': {
    pote: 'Ce client n’est plus disponible',
    pro: 'Client désormais indisponible',
    direct: 'Client indisponible',
  },
  'devis.mission.customerChoiceUnavailableAccessibility': {
    pote: 'Choix {ordinal}, client indisponible',
    pro: 'Choix {ordinal}, client indisponible',
    direct: 'Choix {ordinal}, indisponible',
  },
  'devis.draftExit.title': {
    pote: 'Que veux-tu faire de ce devis ?',
    pro: 'Que souhaitez-vous faire de ce devis ?',
    direct: 'Que faire du devis ?',
  },
  'devis.draftExit.body': {
    pote: 'Tes modifications ne sont pas encore enregistrées. Tu peux les garder pour reprendre ici plus tard.',
    pro: 'Vos modifications ne sont pas encore enregistrées. Vous pouvez les conserver pour reprendre ici plus tard.',
    direct: 'Modifications non enregistrées. Garde-les pour reprendre plus tard.',
  },
  'devis.draftExit.signatureBody': {
    pote: 'La signature au doigt protège le client : elle devra être refaite à la reprise.',
    pro: 'La signature manuscrite protège le client : elle devra être recueillie à nouveau à la reprise.',
    direct: 'La signature devra être refaite à la reprise.',
  },
  'devis.draftExit.proposalBody': {
    pote: 'La proposition de Bob n’est pas appliquée tant que tu ne l’as pas confirmée.',
    pro: 'La proposition de Bob ne sera pas appliquée sans votre confirmation.',
    direct: 'Proposition Bob non appliquée sans confirmation.',
  },
  'devis.draftExit.generationBody': {
    pote: 'La création de la pièce est déjà engagée. Attends son résultat ou réessaie ici pour éviter un doublon.',
    pro: 'La création de la pièce est déjà engagée. Attendez son résultat ou réessayez ici afin d’éviter un doublon.',
    direct: 'Création en cours. Attends ici pour éviter un doublon.',
  },
  'devis.draftExit.persistenceError': {
    pote: 'Je n’ai pas pu sécuriser le brouillon. Il reste ouvert : réessaie avant de partir.',
    pro: 'L’enregistrement sécurisé a échoué. Votre devis reste ouvert : veuillez réessayer.',
    direct: 'Enregistrement sécurisé impossible. Le devis reste ouvert : réessaie.',
  },
  'devis.draftExit.persistenceConflict': {
    pote: 'Ce brouillon a changé ailleurs. Je n’écrase pas la version plus récente : recharge-la avant de continuer.',
    pro: 'Ce brouillon a été modifié ailleurs. La version plus récente n’a pas été écrasée ; rechargez-la avant de poursuivre.',
    direct: 'Brouillon modifié ailleurs. Version récente préservée : recharge avant de continuer.',
  },
  'devis.draftExit.continue': {
    pote: 'Continuer le devis',
    pro: 'Continuer le devis',
    direct: 'Continuer',
  },
  'devis.draftExit.save': {
    pote: 'Enregistrer et fermer',
    pro: 'Enregistrer et fermer',
    direct: 'Garder et fermer',
  },
  'devis.draftExit.discard': {
    pote: 'Supprimer le brouillon',
    pro: 'Supprimer le brouillon',
    direct: 'Supprimer',
  },
  'devis.draftExit.close': {
    pote: 'Fermer les options',
    pro: 'Fermer les options',
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
  // Titres des 6 étapes de la machine (client → lignes → TVA/mentions → acompte → signature →
  // recap — redécoupe C21 : le wizard s'arrête au devis, jamais de facture enchaînée).
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
  'devis.stepDeposit': {
    pote: 'Acompte',
    pro: 'Acompte',
    direct: 'Acompte',
  },
  'devis.stepSignature': {
    pote: 'Signature',
    pro: 'Signature',
    direct: 'Signature',
  },
  'devis.stepRecap': {
    pote: 'Le récap',
    pro: 'Le récapitulatif',
    direct: 'Récap',
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
  // Étape 2 — lignes (saisie libre : libellé, qté, PU HT, catégorie ; TVA confirmée).
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
  'devis.vatRequiredLabel': {
    pote: 'TVA de ce devis',
    pro: 'Taux de TVA du devis',
    direct: 'TVA du devis',
  },
  'devis.vatRequired': {
    pote: 'Choisis le taux avant d’ajouter une ligne. Je ne mets jamais 20 % à ta place.',
    pro: 'Confirmez le taux avant d’ajouter une ligne. Aucun taux n’est appliqué par défaut.',
    direct: 'TVA requise. Aucun taux automatique.',
  },
  'devis.vatProfileUnavailable': {
    pote: 'Je n’arrive pas à relire ton régime TVA. Réessaie avant de chiffrer.',
    pro: 'Le régime de TVA n’a pas pu être chargé. Réessayez avant de chiffrer.',
    direct: 'Régime TVA indisponible. Réessaie.',
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
  'devis.vatSpecialReduced': {
    pote: 'Taux particulier réglementé — 2,1 %',
    pro: 'Taux particulier réglementé — 2,1 %',
    direct: 'Taux particulier — 2,1 %',
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
  'devis.vatAutoliquidation': {
    pote: 'Sous-traitance BTP en autoliquidation — 0 %',
    pro: 'Autoliquidation de TVA — sous-traitance BTP — 0 %',
    direct: 'Autoliquidation BTP — 0 %',
  },
  'devis.vatFranchise': {
    pote: 'Franchise en base — TVA non facturée',
    pro: 'Franchise en base (art. 293 B) — TVA non facturée',
    direct: 'Franchise en base — 0 %',
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
  // Étape 5 — signature : choix sur place (SignaturePad + nom) ou envoi (email + lien).
  'devis.signTitle': {
    pote: 'Comment il signe ?',
    pro: 'Comment le client signe-t-il ?',
    direct: 'Signature ?',
  },
  'devis.signSub': {
    pote: 'Bon pour accord — sur place, du doigt, ou envoyé pour signer plus tard.',
    pro: 'Bon pour accord — sur place, ou envoyé pour une signature différée.',
    direct: 'Sur place ou envoyé.',
  },
  'devis.signModeOnsite': {
    pote: 'Sur place',
    pro: 'Sur place',
    direct: 'Sur place',
  },
  'devis.signModeOnsiteHint': {
    pote: 'Il signe du doigt, là, sur ton téléphone.',
    pro: 'Il signe du doigt, directement sur votre téléphone.',
    direct: 'Signature au doigt, ici.',
  },
  'devis.signModeRemote': {
    pote: 'Envoyer',
    pro: 'Envoyer',
    direct: 'Envoyer',
  },
  'devis.signModeRemoteHint': {
    pote: 'Le lien de signature part par e-mail — il signe quand il veut.',
    pro: 'Le lien de signature part par e-mail — signature à distance.',
    direct: 'Lien par e-mail.',
  },
  'devis.signModeRemoteSummaryTitle': {
    pote: 'Prêt à partir',
    pro: 'Devis prêt à envoyer',
    direct: 'Prêt à envoyer',
  },
  'devis.signModeRemoteSummaryBody': {
    pote: '{name} va recevoir le devis par e-mail, avec un lien pour le consulter et le signer en ligne.',
    pro: '{name} recevra le devis par e-mail, avec un lien pour le consulter et le signer en ligne.',
    direct: '{name} : devis + lien de signature par e-mail.',
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
  // Étape 6 — recap (chaîne réelle createQuote → sendQuote → signQuote SI sur place — JAMAIS
  // de facture ici, elle vit sur son chemin officiel post-signature, /devis/[id]).
  'devis.signOnsiteCta': {
    pote: 'Valider la signature',
    pro: 'Valider la signature',
    direct: 'Valider',
  },
  'devis.sendCta': {
    pote: 'Envoyer le devis',
    pro: 'Envoyer le devis',
    direct: 'Envoyer',
  },
  'devis.confirmSignTitle': {
    pote: 'Devis à signer',
    pro: 'Devis à signer',
    direct: 'Devis à signer',
  },
  'devis.confirmSignBody': {
    pote: 'J’envoie le devis à {name} et j’enregistre sa signature sur ton téléphone — {amount} TTC.',
    pro: 'Le devis est envoyé à {name} et sa signature est enregistrée — {amount} TTC.',
    direct: 'Envoi + signature {name} — {amount} TTC.',
  },
  'devis.confirmSendTitle': {
    pote: 'Devis à envoyer',
    pro: 'Devis à envoyer',
    direct: 'Devis à envoyer',
  },
  'devis.confirmSendBody': {
    pote: 'Le devis part chez {name} par e-mail, avec le lien pour signer — {amount} TTC.',
    pro: 'Le devis est envoyé à {name} par e-mail, avec le lien de signature — {amount} TTC.',
    direct: 'Envoi {name} — {amount} TTC.',
  },
  'devis.generating': {
    pote: 'Je m’en occupe…',
    pro: 'Traitement en cours…',
    direct: 'En cours…',
  },
  'devis.recapSignedTitle': {
    pote: 'Devis signé !',
    pro: 'Devis signé',
    direct: 'Signé.',
  },
  'devis.recapSignedBody': {
    pote: '{name} a signé le devis {number} — {amount} TTC. La suite, c’est toi qui décides.',
    pro: '{name} a signé le devis {number} — {amount} TTC.',
    direct: '{number} signé par {name}. {amount} TTC.',
  },
  'devis.recapSentTitle': {
    pote: 'Devis envoyé !',
    pro: 'Devis envoyé',
    direct: 'Envoyé.',
  },
  'devis.recapSentBody': {
    pote: '{name} a reçu le devis {number} par e-mail, avec le lien pour signer — en attente de sa signature.',
    pro: '{name} a reçu le devis {number} par e-mail — en attente de sa signature.',
    direct: '{number} envoyé à {name}. En attente de signature.',
  },
  // Bug terrain 20/07 : quand le client n'a AUCUNE adresse e-mail, le serveur répond
  // deliveryStatus 'skipped' et n'envoie rien — l'écran affirmait pourtant « a reçu le devis
  // par e-mail ». Un faux succès fait attendre à l'artisan une signature qui ne viendra jamais.
  // La pièce EXISTE et son numéro légal est alloué : on le dit, sans inventer un envoi.
  'devis.recapPreparedTitle': {
    pote: 'Devis prêt !',
    pro: 'Devis prêt',
    direct: 'Devis prêt.',
  },
  'devis.recapPreparedBody': {
    pote: 'Le devis {number} est prêt pour {name}, mais aucun e-mail n’est enregistré pour lui — partage-lui le lien de signature juste en dessous.',
    pro: 'Le devis {number} est prêt pour {name}. Aucune adresse e-mail n’est enregistrée : partagez le lien de signature ci-dessous.',
    direct: '{number} prêt. Pas d’e-mail pour {name} — partagez le lien ci-dessous.',
  },
  'devis.recapProposalTitle': {
    pote: 'La suite, quand tu veux',
    pro: 'La suite, à votre rythme',
    direct: 'La suite',
  },
  'devis.recapProposalBodyDeposit': {
    pote: 'Tu peux générer la facture d’acompte de {pct} % ({amount}) quand tu veux — rien ne part sans toi.',
    pro: 'Vous pouvez générer la facture d’acompte de {pct} % ({amount}) quand vous le souhaitez.',
    direct: 'Acompte {pct} % ({amount}) — quand tu veux.',
  },
  'devis.recapProposalBodyFull': {
    pote: 'Tu peux générer la facture quand tu veux — rien ne part sans toi.',
    pro: 'Vous pouvez générer la facture quand vous le souhaitez.',
    direct: 'Facture — quand tu veux.',
  },
  'devis.shareLink': {
    pote: 'Partager le lien de signature',
    pro: 'Partager le lien de signature',
    direct: 'Partager le lien',
  },
  'devis.seeQuote': {
    pote: 'Voir le devis',
    pro: 'Voir le devis',
    direct: 'Voir le devis',
  },
  'devis.toastSigned': {
    pote: 'Devis {number} signé ✓',
    pro: 'Devis {number} signé ✓',
    direct: '{number} signé ✓',
  },
  'devis.toastSent': {
    pote: 'Devis {number} envoyé ✓',
    pro: 'Devis {number} envoyé ✓',
    direct: '{number} envoyé ✓',
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
  'devis.guardSignMode': {
    pote: 'Choisis comment il signe : sur place, ou envoyer.',
    pro: 'Choisissez le mode de signature : sur place, ou envoyer.',
    direct: 'Sur place ou envoyer ?',
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
  // E3 — carte inverse sur l'écran d'un AVOIR : « Annule la facture · F-XXXX ».
  'piece.linkedCreditSource': {
    pote: 'Annule la facture',
    pro: 'Annule la facture',
    direct: 'Annule',
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
  'piece.advanceRecoveryUnavailableTitle': {
    pote: 'Solde professionnel en attente',
    pro: 'Reprise d’acompte indisponible',
    direct: 'Solde indisponible',
  },
  'piece.advanceRecoveryUnavailableBody': {
    pote: 'Cet acompte reste consultable, mais Bob ne créera pas une finale qu’il ne sait pas encore certifier et transmettre correctement.',
    pro: 'La facture finale après acompte reste fermée jusqu’à la certification Factur-X EXTENDED et Plateforme Agréée. Aucun numéro ne sera consommé.',
    direct: 'Finale après acompte fermée jusqu’à certification EXTENDED/PA.',
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
  // Lien public de consultation (canal universel, sans e-mail requis) — devis/facture
  'piece.actionShareLink': {
    pote: 'Partager le lien',
    pro: 'Partager le lien',
    direct: 'Lien',
  },
  'piece.shareLinkUnavailable': {
    pote: 'Le partage n’est pas dispo sur cet appareil — réessaie depuis un autre.',
    pro: 'Le partage n’est pas disponible sur cet appareil.',
    direct: 'Partage indispo.',
  },
  'piece.shareLinkError': {
    pote: 'Je n’ai pas réussi à préparer le lien. On réessaie ?',
    pro: 'Le lien n’a pas pu être préparé. Veuillez réessayer.',
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
  // BT-23 — nature de l'opération : décision utilisateur, jamais déduite par le LLM.
  'piece.operationCategory.title': {
    pote: 'Une précision avant d’émettre',
    pro: 'Nature de l’opération',
    direct: 'Nature de la facture',
  },
  'piece.operationCategory.question': {
    pote: 'Cette facture mélange fourniture et travail. Qu’est-ce qui décrit le mieux l’opération ?',
    pro: 'La facture contient des biens et des prestations. Comment faut-il qualifier l’opération ?',
    direct: 'Biens et prestations : quelle catégorie ?',
  },
  'piece.operationCategory.services': {
    pote: 'Prestation avec fournitures intégrées',
    pro: 'Prestation avec fournitures intégrées',
    direct: 'Prestation + fournitures',
  },
  'piece.operationCategory.goods': {
    pote: 'Vente avec prestation accessoire',
    pro: 'Vente avec prestation accessoire',
    direct: 'Vente + prestation',
  },
  'piece.operationCategory.mixed': {
    pote: 'Biens et prestations indépendants',
    pro: 'Biens et prestations indépendants',
    direct: 'Biens + prestations séparés',
  },
  'piece.operationCategory.confirm': {
    pote: 'Choisir et émettre',
    pro: 'Confirmer et émettre',
    direct: 'Émettre',
  },
  'piece.operationCategory.cancel': {
    pote: 'Pas maintenant',
    pro: 'Annuler',
    direct: 'Annuler',
  },
  'piece.operationCategory.invalid': {
    pote: 'Je n’ai pas reconnu ce choix. Réessaie.',
    pro: 'La nature sélectionnée est invalide. Veuillez réessayer.',
    direct: 'Choix invalide. Réessaie.',
  },
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

  // ── B8 — bon de commande (numéro d'engagement grands comptes) ─────────────────
  // Saisi UNE FOIS sur le devis, repris automatiquement sur la facture dérivée —
  // sans lui, la facture d'un grand compte (RATP, collectivité…) est rejetée/retardée.
  'po.sectionTitle': {
    pote: 'Bon de commande',
    pro: 'Bon de commande',
    direct: 'Bon de commande',
  },
  'po.emptyQuoteBody': {
    pote: 'Ton client t’a envoyé un bon de commande ? Ajoute son numéro : il suivra jusqu’à la facture.',
    pro: 'Votre client a émis un bon de commande ? Ajoutez son numéro : il sera repris sur la facture.',
    direct: 'Bon de commande reçu ? Ajoute le numéro — repris sur la facture.',
  },
  'po.emptyInvoiceBody': {
    pote: 'Un bon de commande pour cette facture ? Ajoute son numéro avant l’émission : il figurera dessus.',
    pro: 'Un bon de commande accompagne cette facture ? Ajoutez son numéro avant l’émission : il y figurera.',
    direct: 'Bon de commande ? Ajoute le numéro avant l’émission.',
  },
  'po.addCta': { pote: 'Ajouter le numéro', pro: 'Ajouter le numéro', direct: 'Ajouter' },
  'po.sheetTitleAdd': {
    pote: 'Ajouter le bon de commande',
    pro: 'Ajouter le bon de commande',
    direct: 'Bon de commande',
  },
  'po.sheetTitleEdit': {
    pote: 'Modifier le bon de commande',
    pro: 'Modifier le bon de commande',
    direct: 'Modifier le bon de commande',
  },
  'po.numberLabel': {
    pote: 'Numéro d’engagement',
    pro: 'Numéro d’engagement',
    direct: 'Numéro d’engagement',
  },
  'po.numberPlaceholder': {
    pote: 'Ex. BC-2026-0458',
    pro: 'Ex. BC-2026-0458',
    direct: 'BC-2026-0458',
  },
  'po.numberInvalid': {
    pote: 'Il me faut le numéro tel qu’il apparaît sur le bon (60 caractères max).',
    pro: 'Saisissez le numéro tel qu’il figure sur le bon de commande (60 caractères max).',
    direct: 'Numéro requis (60 car. max).',
  },
  'po.dateLabel': {
    pote: 'Reçu le (facultatif)',
    pro: 'Date de réception (facultative)',
    direct: 'Reçu le (option)',
  },
  'po.datePlaceholder': { pote: 'JJ/MM/AAAA', pro: 'JJ/MM/AAAA', direct: 'JJ/MM/AAAA' },
  'po.dateInvalid': {
    pote: 'Cette date ne passe pas — format JJ/MM/AAAA, tu revérifies ?',
    pro: 'Date invalide. Format attendu : JJ/MM/AAAA.',
    direct: 'Date invalide (JJ/MM/AAAA).',
  },
  'po.documentLabel': {
    pote: 'Document du coffre (facultatif)',
    pro: 'Document du coffre (facultatif)',
    direct: 'Document (option)',
  },
  'po.documentPickCta': { pote: 'Lier un document', pro: 'Lier un document', direct: 'Lier' },
  'po.documentChangeCta': { pote: 'Changer', pro: 'Modifier', direct: 'Changer' },
  'po.documentClearCta': {
    pote: 'Retirer le document',
    pro: 'Retirer le document',
    direct: 'Retirer le document',
  },
  'po.documentPickerTitle': {
    pote: 'Choisis le document du coffre',
    pro: 'Choisissez un document du coffre',
    direct: 'Document du coffre',
  },
  'po.documentPickerEmpty': {
    pote: 'Ton coffre est vide pour l’instant — scanne le bon de commande et reviens le lier.',
    pro: 'Aucun document dans le coffre pour le moment.',
    direct: 'Coffre vide.',
  },
  'po.documentPickerBack': { pote: 'Retour', pro: 'Retour', direct: 'Retour' },
  'po.documentFallbackName': {
    pote: 'Document du coffre',
    pro: 'Document du coffre',
    direct: 'Document',
  },
  'po.openDocument': {
    pote: 'Ouvrir le document {name}',
    pro: 'Ouvrir le document {name}',
    direct: 'Ouvrir {name}',
  },
  'po.saveCta': { pote: 'Enregistrer', pro: 'Enregistrer', direct: 'Enregistrer' },
  'po.receivedOn': { pote: 'Reçu le {date}', pro: 'Reçu le {date}', direct: 'Reçu {date}' },
  'po.editCta': { pote: 'Modifier', pro: 'Modifier', direct: 'Modifier' },
  'po.removeCta': { pote: 'Retirer', pro: 'Retirer', direct: 'Retirer' },
  'po.removeConfirmTitle': {
    pote: 'Retirer le bon de commande',
    pro: 'Retirer le bon de commande',
    direct: 'Retirer le bon de commande',
  },
  'po.removeConfirmBody': {
    pote: 'Le numéro {number} ne suivra plus jusqu’à la facture.',
    pro: 'Le numéro {number} ne sera plus repris sur la facture.',
    direct: '{number} retiré — plus repris sur la facture.',
  },
  'po.frozenNote': {
    pote: 'Figé à l’émission — ce numéro figure sur la facture.',
    pro: 'Figé à l’émission — le numéro figure sur la facture.',
    direct: 'Figé à l’émission.',
  },
  'po.quoteInvoicedNote': {
    pote: 'Devis déjà facturé — le bon de commande se gère maintenant sur la facture.',
    pro: 'Devis déjà facturé — le bon de commande se gère désormais sur la facture.',
    direct: 'Déjà facturé — gère le BC sur la facture.',
  },
  'po.carriedToInvoice': {
    pote: 'Bon de commande n° {number} repris sur la facture',
    pro: 'Bon de commande n° {number} repris sur la facture.',
    direct: 'BC n° {number} repris sur la facture.',
  },
  'po.saveError': {
    pote: 'Je n’ai pas réussi à enregistrer le bon de commande. On réessaie ?',
    pro: 'L’enregistrement du bon de commande a échoué. Veuillez réessayer.',
    direct: 'Enregistrement KO. Réessaie.',
  },
  'po.voice.sheetOpened': {
    pote: 'Je t’ouvre le bon de commande — vérifie et enregistre.',
    pro: 'J’ouvre la saisie du bon de commande — vérifiez puis enregistrez.',
    direct: 'Saisie du bon de commande ouverte.',
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
  'onboard.saving': { pote: 'Je sauvegarde…', pro: 'Enregistrement…', direct: 'Enregistrement…' },
  'onboard.saveError': {
    pote: 'Je n’ai pas pu enregistrer tes choix. Vérifie ta connexion et réessaie.',
    pro: 'Les choix n’ont pas pu être enregistrés. Vérifiez votre connexion puis réessayez.',
    direct: 'Enregistrement impossible. Vérifie ta connexion et réessaie.',
  },
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
  'auth.companyClosedWarning': {
    pote:
      'Attention : l’INSEE déclare cet établissement fermé. Vérifie le SIRET avant de créer ton espace.',
    pro:
      'Cet établissement est déclaré fermé à l’annuaire (INSEE). Vérifiez le SIRET avant de créer votre espace.',
    direct: 'Établissement fermé (INSEE). Vérifiez le SIRET.',
  },
  'auth.companyTvaLabel': {
    pote: 'TVA intracom',
    pro: 'TVA intracommunautaire',
    direct: 'TVA intracom',
  },
  'clients.createTvaLabel': {
    pote: 'N° de TVA intracommunautaire',
    pro: 'N° de TVA intracommunautaire',
    direct: 'N° TVA intracom',
  },
  'clients.createTvaPlaceholder': {
    pote: 'FR25 821503646',
    pro: 'FR25 821503646',
    direct: 'FR25 821503646',
  },
  'clients.createTvaHint': {
    pote: 'Facultatif. Recopie seulement un numéro réellement attribué au client.',
    pro: 'Facultatif. Saisissez uniquement le numéro réellement attribué au client.',
    direct: 'Facultatif · jamais déduit du SIREN.',
  },
  'clients.createTvaInvalid': {
    pote: 'Ce numéro ne correspond pas au SIREN trouvé ou sa clé est invalide.',
    pro: 'Ce numéro ne correspond pas au SIREN renseigné ou sa clé est invalide.',
    direct: 'N° TVA incohérent avec le SIREN.',
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
  'auth.loginResendConfirm': {
    pote: 'Renvoyer l’email de confirmation',
    pro: 'Renvoyer l’email de confirmation',
    direct: 'Renvoyer l’email',
  },
  'auth.confirmCheckingTitle': {
    pote: 'Je confirme ton compte',
    pro: 'Confirmation du compte',
    direct: 'Confirmation…',
  },
  'auth.confirmCheckingBody': {
    pote: 'Une seconde — je valide ton lien et je te connecte.',
    pro: 'Votre lien de confirmation est en cours de vérification.',
    direct: 'Lien en cours de vérification.',
  },
  'auth.confirmSignedInTitle': {
    pote: 'C’est bon, ton compte est confirmé 🎉',
    pro: 'Compte confirmé',
    direct: 'Compte confirmé.',
  },
  'auth.confirmSignedInBody': {
    pote: 'Je t’ouvre Bob Pro tout de suite.',
    pro: 'Votre session est ouverte, l’application démarre.',
    direct: 'Session ouverte.',
  },
  'auth.confirmDoneTitle': {
    pote: 'C’est bon, ton compte est confirmé 🎉',
    pro: 'Compte confirmé',
    direct: 'Compte confirmé.',
  },
  'auth.confirmDoneBody': {
    pote: 'Connecte-toi avec ton email et ton mot de passe, et c’est parti.',
    pro: 'Connectez-vous avec votre email et votre mot de passe pour commencer.',
    direct: 'Connecte-toi. C’est parti.',
  },
  'auth.confirmDoneCta': {
    pote: 'Me connecter',
    pro: 'Me connecter',
    direct: 'Connexion',
  },
  'auth.confirmExpiredTitle': {
    pote: 'Ce lien a expiré',
    pro: 'Lien expiré',
    direct: 'Lien expiré',
  },
  'auth.confirmExpiredBody': {
    pote: 'Pas de souci : retourne à la connexion, entre ton email et ton mot de passe — je te proposerai de renvoyer un email tout neuf.',
    pro: 'Depuis l’écran de connexion, saisissez vos identifiants : un nouvel email de confirmation pourra être renvoyé.',
    direct: 'Reconnecte-toi : je te renverrai un email.',
  },
  'auth.confirmInvalidTitle': {
    pote: 'Ce lien ne fonctionne pas',
    pro: 'Lien invalide',
    direct: 'Lien invalide',
  },
  'auth.confirmInvalidBody': {
    pote: 'Il a peut-être déjà servi. Retourne à la connexion : si besoin, je te renvoie un email de confirmation.',
    pro: 'Ce lien est invalide ou a déjà été utilisé. Un nouvel email peut être renvoyé depuis la connexion.',
    direct: 'Lien invalide ou déjà utilisé. Reconnecte-toi.',
  },
  'auth.confirmCheckFailedTitle': {
    pote: 'Je n’arrive pas à vérifier le lien',
    pro: 'Vérification impossible',
    direct: 'Vérification impossible',
  },
  'auth.confirmBack': {
    pote: 'Retour à la connexion',
    pro: 'Retour à la connexion',
    direct: 'Connexion',
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
  'notif.pushPrimerEyebrow': {
    pote: 'Alertes utiles',
    pro: 'Alertes utiles',
    direct: 'Alertes utiles',
  },
  'notif.pushPrimerTitle': {
    pote: 'Bob te prévient au bon moment',
    pro: 'Recevez les alertes utiles au bon moment',
    direct: 'Les alertes utiles, au bon moment',
  },
  'notif.pushPrimerBody': {
    pote: 'Échéance proche, relance terminée ou document à vérifier : reçois seulement les alertes utiles. Tu peux continuer sans les activer.',
    pro: 'Échéance proche, relance terminée ou document à vérifier : recevez uniquement les alertes utiles. Vous pouvez continuer sans les activer.',
    direct: 'Échéances, relances, documents : seulement l’utile. L’app fonctionne sans.',
  },
  'notif.pushPrimerAction': {
    pote: 'Activer les alertes',
    pro: 'Activer les alertes',
    direct: 'Activer',
  },
  'notif.pushPrimerLater': {
    pote: 'Pas maintenant',
    pro: 'Plus tard',
    direct: 'Plus tard',
  },
  'notif.pushDismissedTitle': {
    pote: 'Alertes non activées',
    pro: 'Alertes non activées',
    direct: 'Alertes inactives',
  },
  'notif.pushDismissedBody': {
    pote: 'Ton fil reste disponible ici. Tu peux activer les alertes quand tu veux.',
    pro: 'Votre fil reste disponible ici. Vous pouvez activer les alertes à tout moment.',
    direct: 'Le fil reste ici. Active-les quand tu veux.',
  },
  'notif.pushDeniedTitle': {
    pote: 'Alertes désactivées',
    pro: 'Alertes désactivées',
    direct: 'Alertes désactivées',
  },
  'notif.pushDeniedBody': {
    pote: 'Bob ne peut pas te prévenir hors de l’app. Ton fil reste disponible ici.',
    pro: 'Bob ne peut pas vous prévenir hors de l’application. Votre fil reste disponible ici.',
    direct: 'Pas d’alerte hors app. Le fil reste ici.',
  },
  'notif.pushProvisionalTitle': {
    pote: 'Alertes discrètes actives',
    pro: 'Alertes discrètes actives',
    direct: 'Alertes discrètes actives',
  },
  'notif.pushProvisionalBody': {
    pote: 'Elles arrivent sans t’interrompre. Tu peux autoriser les alertes complètes dans les réglages.',
    pro: 'Elles arrivent sans vous interrompre. Vous pouvez autoriser les alertes complètes dans les réglages.',
    direct: 'Elles arrivent discrètement. Les réglages permettent de tout autoriser.',
  },
  'notif.pushProvisionalAction': {
    pote: 'Autoriser les alertes complètes',
    pro: 'Autoriser les alertes complètes',
    direct: 'Tout autoriser',
  },
  'notif.pushSettingsAction': {
    pote: 'Ouvrir les réglages',
    pro: 'Ouvrir les réglages',
    direct: 'Réglages',
  },
  'notif.pushUnavailableTitle': {
    pote: 'Alertes indisponibles pour le moment',
    pro: 'Alertes temporairement indisponibles',
    direct: 'Alertes indisponibles',
  },
  'notif.pushUnavailableBody': {
    pote: 'Cet appareil n’a pas pu être enregistré. Ton fil reste disponible ici.',
    pro: 'Cet appareil n’a pas pu être enregistré. Votre fil reste disponible ici.',
    direct: 'Appareil non enregistré. Le fil reste ici.',
  },
  'notif.pushRetryAction': {
    pote: 'Réessayer',
    pro: 'Réessayer',
    direct: 'Réessayer',
  },
  'notif.pushEnabledToast': {
    pote: 'C’est fait, Bob pourra te prévenir.',
    pro: 'Les alertes sont activées.',
    direct: 'Alertes activées.',
  },
  'notif.pushDeniedToast': {
    pote: 'Pas de souci, ton fil reste disponible ici.',
    pro: 'Votre fil reste disponible ici.',
    direct: 'Le fil reste ici.',
  },
  'notif.pushErrorToast': {
    pote: 'Impossible d’activer les alertes pour le moment.',
    pro: 'Impossible d’activer les alertes pour le moment.',
    direct: 'Activation impossible.',
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
  'dep.pay': {
    pote: 'Enregistrer comme payée',
    pro: 'Enregistrer comme payée',
    direct: 'Noter payée',
  },
  'dep.payConfirmTitle': {
    pote: 'Tu l’as déjà payée ?',
    pro: 'Confirmer un paiement déjà effectué',
    direct: 'Paiement déjà fait ?',
  },
  'dep.payConfirmBody': {
    pote: 'Aucun virement ne part d’ici. Je note {amount} réglés à {supplier} le {date}, par {method}.{reference}',
    pro: 'Aucun paiement n’est déclenché. Enregistrer le règlement de {amount} à {supplier}, daté du {date}, par {method}.{reference}',
    direct: 'Aucun virement. Noter {amount} à {supplier}, le {date}, par {method}.{reference}',
  },
  'dep.paymentSheetTitle': {
    pote: 'Comment l’as-tu payée ?',
    pro: 'Preuve du règlement',
    direct: 'Détails du paiement',
  },
  'dep.paymentSheetBody': {
    pote: 'Je note un paiement déjà fait à {supplier}. Aucun argent ne part de Bob.',
    pro: 'Renseignez le règlement déjà effectué à {supplier}. Bob ne déclenche aucun transfert.',
    direct: 'Paiement déjà effectué à {supplier}. Aucun transfert.',
  },
  'dep.paymentDateLabel': { pote: 'Date du paiement', pro: 'Date du règlement', direct: 'Date' },
  'dep.paymentDatePlaceholder': { pote: 'JJ/MM/AAAA', pro: 'JJ/MM/AAAA', direct: 'JJ/MM/AAAA' },
  'dep.paymentToday': { pote: 'Aujourd’hui', pro: 'Aujourd’hui', direct: 'Aujourd’hui' },
  'dep.paymentDateRequired': {
    pote: 'Choisis la date du paiement.',
    pro: 'La date du règlement est requise.',
    direct: 'Date requise.',
  },
  'dep.paymentDateInvalid': {
    pote: 'Cette date ne semble pas correcte.',
    pro: 'Saisissez une date valide au format JJ/MM/AAAA.',
    direct: 'Date invalide.',
  },
  'dep.paymentDateFuture': {
    pote: 'Un paiement déjà fait ne peut pas être dans le futur.',
    pro: 'La date du règlement ne peut pas être future.',
    direct: 'Date future interdite.',
  },
  'dep.paymentMethodLabel': {
    pote: 'Comment as-tu payé ?',
    pro: 'Moyen de règlement',
    direct: 'Moyen',
  },
  'dep.paymentMethodCard': { pote: 'Carte', pro: 'Carte bancaire', direct: 'Carte' },
  'dep.paymentMethodTransfer': { pote: 'Virement', pro: 'Virement bancaire', direct: 'Virement' },
  'dep.paymentMethodCash': { pote: 'Espèces', pro: 'Espèces', direct: 'Espèces' },
  'dep.paymentMethodRequired': {
    pote: 'Choisis comment tu as payé.',
    pro: 'Le moyen de règlement est requis.',
    direct: 'Moyen requis.',
  },
  'dep.paymentReferenceLabel': {
    pote: 'Référence (facultatif)',
    pro: 'Référence du règlement (facultatif)',
    direct: 'Référence (facultatif)',
  },
  'dep.paymentReferencePlaceholder': {
    pote: 'N° de virement ou ticket',
    pro: 'N° de virement, remise ou ticket',
    direct: 'N° de référence',
  },
  'dep.paymentContinue': { pote: 'Vérifier', pro: 'Vérifier le règlement', direct: 'Vérifier' },
  'dep.paymentCancel': { pote: 'Annuler', pro: 'Annuler', direct: 'Annuler' },
  'dep.paidToast': {
    pote: 'Paiement de {supplier} enregistré ✓',
    pro: 'Paiement de {supplier} enregistré dans le journal.',
    direct: '{supplier} : paiement noté.',
  },
  'dep.payError': {
    pote: 'Je n’ai pas pu enregistrer le paiement — rien n’a changé.',
    pro: 'Le paiement n’a pas pu être enregistré. Aucune modification n’a été appliquée.',
    direct: 'Enregistrement KO. Rien n’a changé.',
  },
  // ── Régularisation d'une ligne HISTORIQUE payée sans preuve (lane preuves) ──
  'dep.statusPaidLegacy': {
    pote: 'Payée — à justifier',
    pro: 'Payée — à justifier',
    direct: 'Payée — à justifier',
  },
  'dep.regularize': {
    pote: 'Régulariser',
    pro: 'Régulariser le règlement',
    direct: 'Régulariser',
  },
  'dep.regularizeSheetTitle': {
    pote: 'On régularise ce paiement ?',
    pro: 'Régularisation du règlement',
    direct: 'Régularisation',
  },
  'dep.regularizeSheetBody': {
    pote: 'Cette dépense de {supplier} date d’avant le suivi des preuves. Dis-moi comment elle a été payée : je complète tes livres, sans toucher à ton compte.',
    pro: 'Cette dépense de {supplier} est antérieure au suivi des preuves de règlement. Renseignez le paiement réellement effectué : l’écriture comptable manquante sera enregistrée. Aucun transfert n’est déclenché.',
    direct: 'Dépense {supplier} d’avant le suivi des preuves. Indique le paiement réel. Aucun transfert.',
  },
  'dep.regularizeConfirmTitle': {
    pote: 'On complète tes livres ?',
    pro: 'Confirmer la régularisation comptable',
    direct: 'Régulariser ?',
  },
  'dep.regularizeConfirmBody': {
    pote: 'Aucun virement ne part d’ici. Je justifie {amount} déjà réglés à {supplier} le {date}, par {method}, et j’enregistre l’écriture qui manquait.{reference}',
    pro: 'Aucun paiement n’est déclenché. Régulariser {amount} réglés à {supplier}, datés du {date}, par {method} — l’écriture de décaissement manquante sera enregistrée.{reference}',
    direct: 'Aucun virement. Justifier {amount} à {supplier}, le {date}, par {method}. Écriture posée.{reference}',
  },
  'dep.regularizedToast': {
    pote: 'Dépense {supplier} régularisée ✓',
    pro: 'Règlement de {supplier} régularisé : écriture enregistrée.',
    direct: '{supplier} : régularisée.',
  },
  'dep.regularizeError': {
    pote: 'Je n’ai pas pu régulariser cette dépense — rien n’a changé.',
    pro: 'La régularisation n’a pas pu être enregistrée. Aucune modification n’a été appliquée.',
    direct: 'Régularisation KO. Rien n’a changé.',
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
  // Preuve du règlement (lane preuves) : la ligne payée montre son justificatif du coffre.
  'dep.proofLink': {
    pote: 'Voir la preuve du paiement',
    pro: 'Consulter le justificatif de règlement',
    direct: 'Preuve',
  },
  // ── Imputation chantier d'une dépense (rentabilité par chantier) — carte dépense et
  // écran document (dépense liée) : lier, état lecture, délier confirmé, toasts. ──
  'dep.chantierQuestion': {
    pote: 'À quel chantier je mets cette dépense ?',
    pro: 'À quel chantier imputer cette dépense ?',
    direct: 'Quel chantier ?',
  },
  'dep.chantierLinkToast': {
    pote: 'Dépense liée au chantier « {name} » ✓',
    pro: 'Dépense imputée au chantier « {name} ».',
    direct: '→ {name}.',
  },
  'dep.chantierError': {
    pote: 'Le lien avec le chantier a raté, là. On réessaie ?',
    pro: 'L’imputation au chantier a échoué. Veuillez réessayer.',
    direct: 'Imputation ratée. Réessaie.',
  },
  // Délier = geste LÉGITIME pour une dépense (contrairement au document) — confirmé, jamais sec.
  'dep.chantierUnlink': {
    pote: 'Délier',
    pro: 'Délier',
    direct: 'Délier',
  },
  'dep.chantierUnlinkConfirmTitle': {
    pote: 'Délier cette dépense du chantier ?',
    pro: 'Délier cette dépense du chantier ?',
    direct: 'Délier du chantier ?',
  },
  'dep.chantierUnlinkConfirmBody': {
    pote: 'La dépense {supplier} ne comptera plus dans ce chantier. Tu pourras la relier quand tu veux.',
    pro: 'La dépense {supplier} ne sera plus imputée à ce chantier. Vous pourrez la relier à tout moment.',
    direct: '{supplier} ne comptera plus dans ce chantier.',
  },
  'dep.chantierUnlinkedToast': {
    pote: 'Dépense déliée du chantier ✓',
    pro: 'Dépense déliée du chantier.',
    direct: 'Déliée.',
  },

  // ── SCAN — statut payé/à payer proposé après lecture (bug ticket ≠ facture) ──
  'scan.settlementLabel': {
    pote: 'Payée ou à payer ?',
    pro: 'Statut du règlement',
    direct: 'Règlement',
  },
  'scan.settlementPaid': { pote: 'Déjà payée', pro: 'Déjà réglée', direct: 'Payée' },
  'scan.settlementToPay': { pote: 'À payer', pro: 'À régler', direct: 'À payer' },
  'scan.settlementPaidDetail': {
    pote: 'Payée le {date} — le scan devient ta preuve de paiement.',
    pro: 'Réglée le {date} — l’original scanné est conservé comme preuve de paiement.',
    direct: 'Payée le {date}. Scan = preuve.',
  },
  'scan.settlementToPayDetail': {
    pote: 'Je la garde dans « À payer » et je te préviens au bon moment.',
    pro: 'La dépense restera à régler ; l’échéance lue sera suivie.',
    direct: 'Reste à payer.',
  },
  'scan.settlementDueDate': { pote: 'Échéance', pro: 'Échéance', direct: 'Échéance' },
  'scan.settlementMethodLabel': {
    pote: 'Payé comment ?',
    pro: 'Moyen de règlement',
    direct: 'Moyen',
  },
  'scan.settlementMethodSeen': {
    pote: 'Lu sur le ticket',
    pro: 'Lu sur le ticket',
    direct: 'Lu sur ticket',
  },
  'scan.settlementQuestionHeader': {
    pote: 'Petit doute',
    pro: 'Vérification',
    direct: 'À trancher',
  },
  'scan.settlementQuestion': {
    pote: 'C’est un ticket déjà payé ou une facture à régler ?',
    pro: 'S’agit-il d’un ticket déjà payé ou d’une facture à régler ?',
    direct: 'Ticket payé ou facture à régler ?',
  },
  'scan.settlementOptionTicket': {
    pote: 'Ticket déjà payé',
    pro: 'Ticket déjà payé',
    direct: 'Ticket payé',
  },
  'scan.settlementOptionTicketDesc': {
    pote: 'La dépense sera créée payée, avec le scan comme preuve.',
    pro: 'La dépense sera enregistrée payée ; le scan servira de preuve de règlement.',
    direct: 'Créée payée. Scan = preuve.',
  },
  'scan.settlementOptionInvoice': {
    pote: 'Facture à régler',
    pro: 'Facture à régler',
    direct: 'Facture à régler',
  },
  'scan.settlementOptionInvoiceDesc': {
    pote: 'La dépense restera à payer, avec son échéance si elle est lisible.',
    pro: 'La dépense restera à régler ; l’échéance lue sera reprise.',
    direct: 'Reste à payer.',
  },
  'scan.settlementLater': { pote: 'Plus tard', pro: 'Décider plus tard', direct: 'Plus tard' },
  'scan.settlementConfirm': { pote: 'Valider', pro: 'Valider', direct: 'Valider' },
  'scan.settlementRequired': {
    pote: 'Dis-moi d’abord si c’est déjà payé ou à payer — je ne devine pas ça.',
    pro: 'Indiquez d’abord si la pièce est déjà payée ou à régler.',
    direct: 'Choisis : payé ou à payer.',
  },
  // ── Scan — overlay « Je lis ton document… » + résultat (handoff §SCAN OVERLAY) ──
  'scan.reading': {
    pote: 'Je lis ton document…',
    pro: 'Lecture du document en cours…',
    direct: 'Je lis…',
  },
  'scan.readDone': {
    pote: 'Document lu',
    pro: 'Document lu',
    direct: 'Lu',
  },
  'scan.amountTtc': {
    pote: 'Montant TTC',
    pro: 'Montant TTC',
    direct: 'TTC',
  },
  'scan.vatRecoverable': {
    pote: 'TVA récupérable',
    pro: 'TVA récupérable',
    direct: 'TVA récup.',
  },
  'scan.attachedTo': {
    pote: 'Rattaché à',
    pro: 'Rattaché à',
    direct: 'Rattaché à',
  },
  'scan.classifyInto': {
    pote: 'Classer dans {label}',
    pro: 'Classer dans {label}',
    direct: '→ {label}',
  },
  'scan.chooseOtherFolder': {
    pote: 'Choisir un autre dossier',
    pro: 'Choisir un autre dossier',
    direct: 'Autre dossier',
  },
  // Feuille de rangement (confirmSingle) : bouton qui valide le choix surligné.
  'scan.filingConfirm': {
    pote: 'Classer',
    pro: 'Classer',
    direct: 'Classer',
  },
  // Question de la feuille quand la destination VALIDÉE par le domaine est un chantier
  // (préséance : elle prime sur toute heuristique de dossier système).
  'scan.filingQuestionChantier': {
    pote: 'Je te propose « {label} ». Où veux-tu conserver l’original ?',
    pro: 'Bob propose « {label} ». Où souhaitez-vous conserver l’original ?',
    direct: '« {label} » ? Sinon, choisis.',
  },
  'scan.chantierOption': {
    pote: 'Chantier · {name}',
    pro: 'Chantier · {name}',
    direct: 'Chantier · {name}',
  },
  'scan.recommendedOption': {
    pote: 'Recommandé · {label}',
    pro: 'Recommandé · {label}',
    direct: 'Reco · {label}',
  },
  'scan.folderOptionDescSuggested': {
    pote: 'Je te propose ce rangement d’après ce que j’ai vraiment lu.',
    pro: 'Bob propose ce rangement à partir du contenu réellement lu.',
    direct: 'Rangement déduit du contenu lu.',
  },
  'scan.folderOptionDesc': {
    pote: 'Je range l’original dans ce dossier.',
    pro: 'Classer l’original dans ce dossier.',
    direct: 'Dans ce dossier.',
  },
  'scan.chantierOptionDesc': {
    pote: 'Je range l’original dans Chantiers et je le lie à ce chantier.',
    pro: 'L’original est classé dans Chantiers et rattaché à ce chantier.',
    direct: 'Chantiers + lien chantier.',
  },
  // Variante quand l'original est un document de DÉPENSE (extraction) : le coût remonte au
  // chantier PAR LA DÉPENSE créée imputée — l'original reste libre d'en devenir le justificatif.
  'scan.chantierOptionDescExpense': {
    pote: 'Je range l’original dans Chantiers et la dépense comptera sur ce chantier.',
    pro: 'L’original est classé dans Chantiers ; la dépense sera imputée à ce chantier.',
    direct: 'Chantiers + dépense imputée.',
  },
  'scan.destinationError': {
    pote: 'Le classement a raté — l’original reste bien au chaud dans « À classer ».',
    pro: 'Le classement a échoué. L’original reste conservé dans « À classer ».',
    direct: 'Classement KO. Original conservé.',
  },
  'scan.linkedChantierTitle': {
    pote: 'Original rattaché au chantier',
    pro: 'Original rattaché au chantier',
    direct: 'Rattaché au chantier',
  },
  'scan.linkedChantierBody': {
    pote: 'Cette pièce est maintenant liée à son chantier : je ne peux plus créer une dépense avec elle comme justificatif. Si tu veux quand même suivre cet achat, crée la dépense depuis l’écran Dépenses — les montants lus restent visibles sur le document.',
    pro: 'Ce document est désormais rattaché à son chantier : il ne peut plus servir de justificatif à une nouvelle dépense. Pour suivre cet achat, créez la dépense depuis l’écran Dépenses — les montants lus restent consultables sur le document.',
    direct: 'Pièce liée au chantier : plus de dépense possible avec ce justificatif. Dépense à créer depuis Dépenses.',
  },
  'scan.linkedChantierCta': {
    pote: 'Voir le document',
    pro: 'Voir le document',
    direct: 'Voir le document',
  },
  // Ligne « Chantier » de la carte extraction : destination chantier choisie — la dépense
  // naîtra imputée (chantierId transmis à la création, chantier PROUVÉ côté serveur).
  'scan.expenseChantierLabel': {
    pote: 'Chantier',
    pro: 'Chantier',
    direct: 'Chantier',
  },
  'scan.expenseChantierNote': {
    pote: 'La dépense sera créée directement sur ce chantier',
    pro: 'La dépense sera imputée à ce chantier dès sa création.',
    direct: 'Dépense imputée à ce chantier.',
  },

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
  // PR-07 — carte « Encaissement » : le trou n° 1 (factures jamais transmises) rendu visible.
  'pilotage.sectionCollection': {
    pote: 'Encaissement',
    pro: 'Encaissement',
    direct: 'Encaissement',
  },
  'pilotage.collectionRate': {
    pote: '{pct} % encaissé',
    pro: '{pct} % encaissé',
    direct: '{pct} % encaissé',
  },
  'pilotage.collectionRateHint': {
    pote: '{collected} encaissés sur {invoiced} facturés ces 90 derniers jours.',
    pro: '{collected} encaissés pour {invoiced} facturés sur 90 jours.',
    direct: '{collected} / {invoiced} (90 j).',
  },
  'pilotage.collectionNoHistory': {
    pote: 'Il me faut 3 mois de facturation pour un taux honnête — encore un peu de patience.',
    pro: 'Trois mois d’historique de facturation sont nécessaires pour établir un taux fiable.',
    direct: '3 mois d’historique requis.',
  },
  'pilotage.collectionNoInvoicing': {
    pote: 'Rien de facturé ces 90 derniers jours — pas de taux à inventer.',
    pro: 'Aucune facturation sur les 90 derniers jours : aucun taux calculable.',
    direct: 'Rien de facturé sur 90 j.',
  },
  'pilotage.collectionOverdue': {
    pote: '{amount} en retard chez tes clients.',
    pro: 'Encours échu : {amount}.',
    direct: 'Échu : {amount}.',
  },
  'pilotage.collectionUntransmittedTitle': {
    pote: '{count} émise(s), jamais envoyée(s)',
    pro: '{count} émise(s) sans envoi constaté',
    direct: '{count} jamais envoyée(s)',
  },
  'pilotage.collectionNote': {
    pote: 'Une facture jamais transmise ne sera jamais payée — touche une ligne pour l’envoyer ou la déposer.',
    pro: 'Une facture non transmise ne peut pas être réglée. Touchez une ligne pour l’envoyer ou déclarer son dépôt.',
    direct: 'Pas transmise = pas payée. Touche pour envoyer.',
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
  'catalogue.vatRequired': {
    pote: 'Choisis le taux de cette prestation. Je ne mets pas 20 % automatiquement.',
    pro: 'Sélectionnez explicitement le taux de cette prestation.',
    direct: 'Taux requis. Aucun défaut automatique.',
  },
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
  'catalogue.loading': {
    pote: 'Je charge ton catalogue. Une seconde.',
    pro: 'Chargement du catalogue en cours.',
    direct: 'Je charge le catalogue.',
  },
  'catalogue.legacyProtectedTitle': {
    pote: 'Anciennes données mises à l’abri',
    pro: 'Anciennes données protégées',
    direct: 'Anciennes données protégées',
  },
  'catalogue.legacyProtectedBody': {
    pote: 'J’ai trouvé un ancien catalogue local. Je le garde chiffré sur cet appareil, mais je ne l’utilise pas : impossible de vérifier à quel compte il appartenait. Il reste ici jusqu’à ce que tu le supprimes.',
    pro: 'Un ancien catalogue local est conservé chiffré sur cet appareil, sans être utilisé : son compte d’origine ne peut pas être vérifié. Il sera conservé jusqu’à sa suppression explicite.',
    direct:
      'Ancien catalogue chiffré, non utilisé : compte d’origine invérifiable. Conservé jusqu’à suppression.',
  },
  'catalogue.legacyDeleteCta': {
    pote: 'Supprimer ces anciennes données',
    pro: 'Supprimer ces anciennes données',
    direct: 'Supprimer définitivement',
  },
  'catalogue.legacyDeleteTitle': {
    pote: 'Supprimer ces anciennes données ?',
    pro: 'Supprimer définitivement ces données ?',
    direct: 'Suppression définitive ?',
  },
  'catalogue.legacyDeleteBody': {
    pote: 'Elles seront effacées définitivement de cet appareil. Comme leur compte d’origine est inconnu, Bob ne pourra pas les récupérer.',
    pro: 'Ces données seront définitivement effacées de cet appareil. Leur compte d’origine étant inconnu, aucune récupération ne sera possible.',
    direct: 'Effacement irréversible de cet appareil. Aucune récupération possible.',
  },
  'catalogue.legacyDeletedToast': {
    pote: 'Anciennes données supprimées.',
    pro: 'Anciennes données supprimées.',
    direct: 'Données supprimées.',
  },
  'catalogue.legacyProtectionError': {
    pote: 'Je n’ai pas fini de protéger les anciennes données',
    pro: 'Protection des anciennes données incomplète',
    direct: 'Protection incomplète',
  },
  'catalogue.legacyProtectionErrorBody': {
    pote: 'Je ne les utilise pas et je ne les montre pas. Réessaie pour terminer leur mise à l’abri.',
    pro: 'Ces données ne sont ni utilisées ni affichées. Réessayez pour terminer leur mise en sécurité.',
    direct: 'Données non utilisées. Relance la protection.',
  },
  'catalogue.legacyProtectionRetry': {
    pote: 'Réessayer maintenant',
    pro: 'Réessayer la protection',
    direct: 'Réessayer',
  },
  'catalogue.suggestTitle': {
    pote: 'Depuis ton catalogue',
    pro: 'Depuis votre catalogue',
    direct: 'Catalogue',
  },
  // Le libellé nomme l'écran de destination (retours device fondateur, jamais « Retour »
  // générique) — le catalogue n'est ouvert QUE depuis Facturation & modèles.
  'catalogue.back': { pote: 'Facturation', pro: 'Facturation', direct: 'Facturation' },
  // Corbeille unifiée (DeleteIconButton) : sheet d'édition + swipe des cartes perso — jamais
  // une suppression directe, toujours cette ConfirmSheet (destructive, tap simple).
  'catalogue.deleteConfirmTitle': {
    pote: 'Supprimer « {label} » de ton catalogue ?',
    pro: 'Supprimer « {label} » de votre catalogue ?',
    direct: 'Supprimer « {label} » ?',
  },
  'catalogue.deleteConfirmBody': {
    pote: 'Cette prestation disparaît de ton catalogue. Tu pourras la recréer si besoin.',
    pro: 'Cette prestation sera retirée de votre catalogue. Vous pourrez la recréer si besoin.',
    direct: 'Retirée du catalogue. Recréable si besoin.',
  },
  // R6/R7 — swipe des cartes (accessibilité des actions révélées) : même libellé « Supprimer
  // {label} » que l'icône de la sheet, pour une seule paire de clés dans les deux surfaces.
  'catalogue.cardSwipeEdit': {
    pote: 'Modifier {label}',
    pro: 'Modifier {label}',
    direct: 'Modifier {label}',
  },
  'catalogue.cardSwipeDelete': {
    pote: 'Supprimer {label}',
    pro: 'Supprimer {label}',
    direct: 'Supprimer {label}',
  },
  // R7 (parité vocale) — « supprime {prestation} » : Bob DIT ce qu'il a compris et OUVRE la
  // ConfirmSheet ci-dessus — jamais de suppression vocale directe (plancher de sûreté établi
  // par les lignes de devis, R6/R7). Seules les prestations PERSO sont ciblées : une
  // suggestion métier indicative n'a pas de corbeille, elle n'est donc jamais « trouvée » ici.
  'catalogue.voice.deleteOpened': {
    pote: 'Je prépare la suppression de {label} — confirme à l’écran.',
    pro: 'Suppression de {label} préparée — confirmez à l’écran.',
    direct: 'Suppression {label} préparée. Confirme.',
  },
  'catalogue.voice.deleteNotFound': {
    pote: 'Je ne trouve pas cette prestation dans ton catalogue — redis son nom, ou touche l’écran.',
    pro: 'Prestation introuvable dans votre catalogue. Répétez le nom, ou choisissez à l’écran.',
    direct: 'Prestation introuvable. Redis ou touche.',
  },
  'catalogue.voice.deleteAmbiguous': {
    pote: 'Dans ton catalogue, plusieurs collent : {options}. Laquelle ?',
    pro: 'Plusieurs prestations de votre catalogue correspondent : {options}. Laquelle ?',
    direct: 'Catalogue ambigu : {options}. Laquelle ?',
  },

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
    pote: 'Règle de saisie TVA',
    pro: 'Règle de saisie de la TVA',
    direct: 'Règle TVA',
  },
  'reglages.vatFranchiseValue': {
    pote: 'Franchise en base · 0 %',
    pro: 'Franchise en base · 0 %',
    direct: 'Franchise · 0 %',
  },
  'reglages.vatPerDocumentValue': {
    pote: 'À choisir sur chaque devis',
    pro: 'À confirmer sur chaque pièce',
    direct: 'Choix par pièce',
  },
  // Segmented control réel branché sur PATCH /company/profile (le même endpoint que l'onboarding —
  // reel_simpl/reel_normal étaient déjà affichés comme UN SEUL bucket « à choisir sur chaque devis » ;
  // le segment « Réel » choisit reel_normal, la simplification 2 options du proto assumée ici).
  'reglages.vatSegmentReel': {
    pote: 'Réel · TVA 20 %',
    pro: 'Réel · TVA 20 %',
    direct: 'Réel · 20 %',
  },
  'reglages.vatSegmentFranchise': {
    pote: 'Franchise en base',
    pro: 'Franchise en base',
    direct: 'Franchise',
  },
  'reglages.vatRegimeHelpFranchise': {
    pote: 'Pas de TVA sur tes factures — la mention obligatoire est ajoutée automatiquement.',
    pro: 'Pas de TVA sur vos factures — la mention obligatoire est ajoutée automatiquement.',
    direct: 'Sans TVA. Mention ajoutée automatiquement.',
  },
  'reglages.vatRegimeHelpReel': {
    pote: 'Tu factures la TVA — le taux se confirme sur chaque devis ou facture.',
    pro: 'Vous facturez la TVA — le taux se confirme sur chaque devis ou facture.',
    direct: 'TVA facturée. Taux confirmé pièce par pièce.',
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
  // ── Fusion proto (retours device fondateur) — Aperçu en direct ─────────────────────────────
  'reglages.previewLive': {
    pote: 'Aperçu en direct',
    pro: 'Aperçu en direct',
    direct: 'Aperçu en direct',
  },
  'reglages.previewInvoiceLabel': { pote: 'FACTURE', pro: 'FACTURE', direct: 'FACTURE' },
  'reglages.previewNumberPlaceholder': {
    pote: 'Ton prochain numéro',
    pro: 'Votre prochain numéro',
    direct: 'Prochain numéro',
  },

  // ── Logo (image picker + copie locale persistante — aucun champ `logoUrl` côté serveur) ───
  'reglages.sectionLogo': { pote: 'Logo', pro: 'Logo', direct: 'Logo' },
  'reglages.logoTitle': { pote: 'Ton logo', pro: 'Votre logo', direct: 'Logo' },
  'reglages.logoSub': {
    pote: 'PNG ou JPG, fond transparent conseillé',
    pro: 'PNG ou JPG, fond transparent conseillé',
    direct: 'PNG/JPG, fond transparent conseillé',
  },
  'reglages.logoAdd': { pote: 'Ajouter', pro: 'Ajouter', direct: 'Ajouter' },
  'reglages.logoChange': { pote: 'Changer', pro: 'Changer', direct: 'Changer' },
  'reglages.logoRemove': { pote: 'Supprimer', pro: 'Supprimer', direct: 'Supprimer' },
  'reglages.logoPermissionDenied': {
    pote: 'Autorise l’accès à tes photos pour choisir un logo.',
    pro: 'Autorisez l’accès à vos photos pour choisir un logo.',
    direct: 'Accès photos requis.',
  },
  'reglages.logoError': {
    pote: 'Le logo n’a pas pu être enregistré, là. Réessaie.',
    pro: 'Le logo n’a pas pu être enregistré. Veuillez réessayer.',
    direct: 'Échec de l’enregistrement du logo.',
  },
  'reglages.logoOnPdfNote': {
    pote: 'Pour l’instant, ton logo change l’aperçu ici — je l’imprimerai sur le PDF très bientôt.',
    pro: 'Pour l’instant, ce logo s’applique à l’aperçu. Il sera bientôt imprimé sur le PDF généré.',
    direct: 'Aperçu seulement pour l’instant. PDF à venir.',
  },

  // ── Identité sur les factures — les QUATRE exigences de Company.assertCanIssue() ÉDITABLES
  // (PATCH /company/legal) : n° RCS/RM, adresse complète, capital social (société) et n° de TVA
  // intracommunautaire. Sans écran pour les saisir, le gate « entreprise incomplète » était un
  // cul-de-sac (aucune facture émissible) — RCS/adresse le 20/07, capital le 30/07. ───────────
  'reglages.sectionIdentity': {
    pote: 'Identité sur les factures',
    pro: 'Identité sur les factures',
    direct: 'Identité',
  },
  'reglages.identityName': {
    pote: 'Raison sociale',
    pro: 'Raison sociale',
    direct: 'Raison sociale',
  },
  'reglages.identitySiret': { pote: 'SIRET', pro: 'SIRET', direct: 'SIRET' },
  'reglages.identityRm': { pote: 'N° RM / RCS', pro: 'N° RM / RCS', direct: 'RM / RCS' },
  /** Ligne visible pour les SOCIÉTÉS uniquement (Company.isSociete()) — une EI n'a pas de
   *  capital ; montant affiché en euros français (« 10 000 € »), formatCapitalSocialEuros. */
  'reglages.identityCapital': {
    pote: 'Capital social',
    pro: 'Capital social',
    direct: 'Capital social',
  },
  /** « À compléter » seulement hors franchise (assertCanIssue) — en franchise : « — ». */
  'reglages.identityTva': {
    pote: 'N° TVA intracommunautaire',
    pro: 'N° TVA intracommunautaire',
    direct: 'TVA intracom',
  },
  'reglages.identityAddress': { pote: 'Adresse', pro: 'Adresse', direct: 'Adresse' },
  // Raison sociale et SIRET restent non éditables (identité posée à l'inscription, elle
  // engage les pièces déjà émises) — le n° RCS/RM, le capital, la TVA et l'adresse, eux,
  // se corrigent ici (feuille d'identité légale).
  'reglages.identityNotEditableNote': {
    pote: 'Ta raison sociale et ton SIRET viennent de ton inscription — écris-nous pour les corriger. Le reste (n° RCS/RM, capital, TVA, adresse), tu peux le modifier toi-même juste au-dessus.',
    pro: 'La raison sociale et le SIRET proviennent de votre inscription — contactez-nous pour les corriger. Le n° RCS/RM, le capital social, le n° de TVA et l’adresse sont modifiables ci-dessus.',
    direct: 'Raison sociale et SIRET : nous écrire. Le reste : modifiable au-dessus.',
  },
  'reglages.identityEmpty': { pote: 'À compléter', pro: 'À compléter', direct: 'À compléter' },
  /** Bandeau d'alerte affiché quand l'émission est RÉELLEMENT bloquée (assertCanIssue KO). */
  'reglages.identityBlockingTitle': {
    pote: 'Il te manque une info pour facturer',
    pro: 'Une information manque pour facturer',
    direct: 'Info manquante pour facturer',
  },
  'reglages.identityBlockingBody': {
    pote: 'Il me faut ton n° d’immatriculation, ton adresse complète, ton capital social si tu es en société et, si tu factures la TVA, le numéro qui t’a été attribué. Deux minutes et c’est réglé.',
    pro: 'Le numéro d’immatriculation, l’adresse complète, le capital social pour une société et, hors franchise, le numéro de TVA attribué sont requis avant émission.',
    direct: 'Immatriculation + adresse + capital (société) + TVA au réel requis.',
  },
  'reglages.identityFixCta': {
    pote: 'Compléter maintenant',
    pro: 'Compléter maintenant',
    direct: 'Compléter',
  },

  // ── Feuille d'édition de l'identité légale (n° RCS/RM + adresse du siège) ──────────────────
  'reglages.legalSheetTitle': {
    pote: 'Ton identité légale',
    pro: 'Votre identité légale',
    direct: 'Identité légale',
  },
  'reglages.legalSheetBody': {
    pote: 'Ces infos s’impriment sur tous tes devis et toutes tes factures.',
    pro: 'Ces informations figurent sur l’ensemble de vos devis et factures.',
    direct: 'Imprimé sur tes devis et factures.',
  },
  'reglages.legalSheetRcsLabel': {
    pote: 'N° d’immatriculation (RCS / RM)',
    pro: 'N° d’immatriculation (RCS / RM)',
    direct: 'N° RCS / RM',
  },
  'reglages.legalSheetRcsInvalid': {
    pote: 'J’ai besoin de ce numéro pour que ta facture soit valable.',
    pro: 'Ce numéro est requis pour la validité de vos factures.',
    direct: 'Numéro requis.',
  },
  'reglages.legalSheetTvaLabel': {
    pote: 'N° de TVA intracommunautaire',
    pro: 'N° de TVA intracommunautaire',
    direct: 'N° TVA intracom',
  },
  'reglages.legalSheetTvaPlaceholder': {
    pote: 'FR44 732829320',
    pro: 'FR44 732829320',
    direct: 'FR44 732829320',
  },
  'reglages.legalSheetTvaRequiredHint': {
    pote: 'Recopie le numéro attribué sur ton mémento fiscal. Je vérifie sa clé, je ne l’invente jamais.',
    pro: 'Recopiez le numéro attribué sur votre mémento fiscal. Bob vérifie sa clé sans jamais le déduire du SIREN.',
    direct: 'Numéro attribué requis au régime réel. Jamais calculé depuis le SIREN.',
  },
  'reglages.legalSheetTvaOptionalHint': {
    pote: 'Tu es en franchise : laisse vide si aucun numéro ne t’a été attribué.',
    pro: 'En franchise, laissez ce champ vide si aucun numéro ne vous a été attribué.',
    direct: 'Optionnel en franchise si non attribué.',
  },
  'reglages.legalSheetTvaInvalid': {
    pote: 'Ce numéro ne correspond pas à ton SIREN ou sa clé est invalide.',
    pro: 'Ce numéro ne correspond pas à votre SIREN ou sa clé est invalide.',
    direct: 'N° TVA incohérent avec le SIREN.',
  },
  // Capital social — champ affiché aux SOCIÉTÉS uniquement (Company.isSociete(), art. R123-238) :
  // le montant vient des STATUTS, jamais de l'annuaire (qui ne le fournit pas) ni d'une déduction.
  'reglages.legalSheetCapitalLabel': {
    pote: 'Capital social',
    pro: 'Capital social',
    direct: 'Capital social',
  },
  'reglages.legalSheetCapitalPlaceholder': {
    pote: '10 000',
    pro: '10 000',
    direct: '10 000',
  },
  'reglages.legalSheetCapitalHint': {
    pote: 'Le montant de tes statuts, en euros — la loi l’imprime sur les factures d’une société (art. R123-238).',
    pro: 'Le montant figurant dans vos statuts, en euros — mention obligatoire sur les factures d’une société (art. R123-238).',
    direct: 'Montant des statuts, en euros. Obligatoire sur les factures (art. R123-238).',
  },
  'reglages.legalSheetCapitalInvalid': {
    pote: 'Il me faut ton capital en euros — celui de tes statuts. Zéro ou négatif, ça n’existe pas pour une société.',
    pro: 'Un montant en euros strictement positif est requis — celui de vos statuts (deux décimales maximum).',
    direct: 'Capital invalide : euros > 0, 2 décimales max.',
  },
  'reglages.legalSheetAddressLabel': {
    pote: 'Adresse du siège',
    pro: 'Adresse du siège',
    direct: 'Adresse du siège',
  },
  'reglages.legalSheetLine1Label': { pote: 'Rue', pro: 'Rue', direct: 'Rue' },
  'reglages.legalSheetLine1Placeholder': {
    pote: '19 quai de la Seine',
    pro: '19 quai de la Seine',
    direct: '19 quai de la Seine',
  },
  'reglages.legalSheetLine1Invalid': {
    pote: 'Il me faut la rue de ton siège.',
    pro: 'La rue du siège est requise.',
    direct: 'Rue requise.',
  },
  'reglages.legalSheetZipLabel': { pote: 'Code postal', pro: 'Code postal', direct: 'CP' },
  'reglages.legalSheetZipPlaceholder': { pote: '75019', pro: '75019', direct: '75019' },
  // Exigé depuis le durcissement d'assertCanIssue (adresse complète = rue + CP + ville) : sans
  // ce message, un CP vide s'enregistrait et l'émission restait bloquée sans erreur visible.
  'reglages.legalSheetZipInvalid': {
    pote: 'Il me faut le code postal de ton siège.',
    pro: 'Le code postal du siège est requis.',
    direct: 'Code postal requis.',
  },
  'reglages.legalSheetCityLabel': { pote: 'Ville', pro: 'Ville', direct: 'Ville' },
  'reglages.legalSheetCityPlaceholder': { pote: 'Paris', pro: 'Paris', direct: 'Paris' },
  'reglages.legalSheetCityInvalid': {
    pote: 'Il me faut la ville de ton siège.',
    pro: 'La ville du siège est requise.',
    direct: 'Ville requise.',
  },
  'reglages.legalSheetError': {
    pote: 'Je n’arrive pas à enregistrer, là. Réessaie.',
    pro: 'Impossible d’enregistrer pour le moment. Veuillez réessayer.',
    direct: 'Échec de l’enregistrement.',
  },
  'reglages.legalSheetSave': { pote: 'Enregistrer', pro: 'Enregistrer', direct: 'Enregistrer' },
  'reglages.legalSheetCancel': { pote: 'Annuler', pro: 'Annuler', direct: 'Annuler' },

  // ── Suggestion dérivée du SIREN (doctrine « hypothèse de Bob, à confirmer ») ───────────────
  // JAMAIS posée en silence : Bob propose, l'utilisateur tape pour accepter, puis corrige s'il
  // le faut. La ville du GREFFE n'est pas toujours celle du siège — le libellé le dit.
  'reglages.legalSuggestRcsLabel': {
    pote: 'Mon hypothèse : {value}',
    pro: 'Hypothèse : {value}',
    direct: 'Hypothèse : {value}',
  },
  'reglages.legalSuggestRcsHint': {
    pote: 'Je l’ai déduit de ton SIREN et de la ville de ton siège. Le greffe n’est pas toujours dans ta ville — vérifie sur ton extrait Kbis avant de valider.',
    pro: 'Déduit de votre SIREN et de la ville de votre siège. Le greffe d’immatriculation n’est pas toujours celui de votre commune — vérifiez sur votre extrait Kbis avant de valider.',
    direct: 'Déduit du SIREN + ville du siège. Greffe ≠ ville parfois : vérifie ton Kbis.',
  },
  'reglages.legalSuggestApply': {
    pote: 'Utiliser cette valeur',
    pro: 'Utiliser cette valeur',
    direct: 'Utiliser',
  },
  'reglages.legalSuggestRmHint': {
    pote: 'Ton numéro au répertoire des métiers est sur ton extrait D1 — je ne peux pas le deviner, il dépend de ta chambre de métiers. Format attendu : {placeholder}.',
    pro: 'Votre numéro au répertoire des métiers figure sur votre extrait D1 — il dépend de votre chambre de métiers et ne peut être déduit. Format attendu : {placeholder}.',
    direct: 'N° RM sur ton extrait D1 — non déductible. Format : {placeholder}.',
  },

  // ── Coordonnées bancaires (RIB) — SEUL champ d'identité réellement éditable ici (PATCH
  // /company/billing) : iban/bic existaient déjà côté société mais sans endpoint d'écriture. ──
  'reglages.sectionRib': {
    pote: 'Coordonnées bancaires (RIB)',
    pro: 'Coordonnées bancaires (RIB)',
    direct: 'RIB',
  },
  'reglages.ribIbanLabel': { pote: 'IBAN', pro: 'IBAN', direct: 'IBAN' },
  'reglages.ribIbanEmpty': {
    pote: 'Aucun IBAN enregistré',
    pro: 'Aucun IBAN enregistré',
    direct: 'Aucun IBAN',
  },
  'reglages.ribToggleLabel': {
    pote: 'Afficher le RIB sur les factures',
    pro: 'Afficher le RIB sur les factures',
    direct: 'RIB sur factures',
  },
  'reglages.ribToggleSub': {
    pote: 'Pour les paiements par virement',
    pro: 'Pour les paiements par virement',
    direct: 'Paiements par virement',
  },
  'reglages.ribOnPdfNote': {
    pote: 'Ce réglage s’applique aux PDF de tes prochaines factures.',
    pro: 'Ce réglage s’applique aux PDF des prochaines factures.',
    direct: 'Appliqué aux prochains PDF.',
  },
  'reglages.ibanSheetTitle': { pote: 'Ton IBAN', pro: 'Votre IBAN', direct: 'IBAN' },
  'reglages.ibanSheetBody': {
    pote: 'Utilisé pour afficher ton RIB sur tes factures, si tu le souhaites.',
    pro: 'Utilisé pour afficher votre RIB sur vos factures, si vous le souhaitez.',
    direct: 'Affiché sur tes factures si activé.',
  },
  'reglages.ibanSheetLabel': { pote: 'IBAN', pro: 'IBAN', direct: 'IBAN' },
  'reglages.ibanSheetPlaceholder': {
    pote: 'FR76 3000 6000 0112 3456 7890 189',
    pro: 'FR76 3000 6000 0112 3456 7890 189',
    direct: 'FR76…',
  },
  'reglages.ibanSheetInvalid': {
    pote: 'Cet IBAN ne semble pas valide — vérifie les chiffres.',
    pro: 'Cet IBAN ne semble pas valide — vérifiez la saisie.',
    direct: 'IBAN invalide.',
  },
  'reglages.ibanSheetError': {
    pote: 'Je n’arrive pas à enregistrer ton IBAN, là. Réessaie.',
    pro: 'Impossible d’enregistrer l’IBAN pour le moment. Veuillez réessayer.',
    direct: 'Échec de l’enregistrement.',
  },
  'reglages.ibanSheetSave': { pote: 'Enregistrer', pro: 'Enregistrer', direct: 'Enregistrer' },
  'reglages.ibanSheetCancel': { pote: 'Annuler', pro: 'Annuler', direct: 'Annuler' },

  // ── Assurance — adaptatif métier (décennale BTP / RC Pro hors bâtiment) ────────────────────
  'reglages.sectionInsuranceBtp': { pote: 'Assurance', pro: 'Assurance', direct: 'Assurance' },
  'reglages.sectionInsuranceOther': {
    pote: 'Assurance (RC Pro)',
    pro: 'Assurance (RC Pro)',
    direct: 'RC Pro',
  },
  'reglages.insuranceDecennaleLabel': { pote: 'Décennale', pro: 'Décennale', direct: 'Décennale' },
  'reglages.insuranceRcProLabel': { pote: 'RC Pro', pro: 'RC Pro', direct: 'RC Pro' },
  'reglages.insuranceEmptyBtp': {
    pote: 'Aucune décennale enregistrée pour l’instant — écris-nous pour l’ajouter.',
    pro: 'Aucune assurance décennale enregistrée — contactez-nous pour l’ajouter.',
    direct: 'Aucune décennale enregistrée.',
  },
  'reglages.insuranceEmptyOther': {
    pote: 'Aucune RC Pro enregistrée pour l’instant — écris-nous pour l’ajouter.',
    pro: 'Aucune RC Pro enregistrée — contactez-nous pour l’ajouter.',
    direct: 'Aucune RC Pro enregistrée.',
  },
  'reglages.insuranceToggleLabelBtp': {
    pote: 'Afficher sur les factures BTP',
    pro: 'Afficher sur les factures BTP',
    direct: 'Sur factures BTP',
  },
  'reglages.insuranceToggleSubBtp': {
    pote: 'Obligatoire pour le bâtiment',
    pro: 'Obligatoire pour le bâtiment',
    direct: 'Obligatoire (bâtiment)',
  },
  'reglages.insuranceToggleLabelOther': {
    pote: 'Afficher sur les factures',
    pro: 'Afficher sur les factures',
    direct: 'Sur les factures',
  },
  'reglages.insuranceToggleSubOther': {
    pote: 'Rassure tes clients',
    pro: 'Rassure vos clients',
    direct: 'Optionnel',
  },
  'reglages.insuranceOnPdfNote': {
    pote: 'Ce réglage s’applique aux PDF de tes prochaines factures.',
    pro: 'Ce réglage s’applique aux PDF des prochaines factures.',
    direct: 'Appliqué aux prochains PDF.',
  },

  // Valeurs canoniques PostgreSQL : validité/acompte alimentent le wizard devis, couleur le PDF.
  'reglages.sectionDefaults': {
    pote: 'Valeurs par défaut',
    pro: 'Valeurs par défaut',
    direct: 'Valeurs par défaut',
  },
  'reglages.defaultsValidityLabel': {
    pote: 'Validité des devis',
    pro: 'Validité des devis',
    direct: 'Validité devis',
  },
  'reglages.defaultsValidityDays': {
    pote: '{days} jours',
    pro: '{days} jours',
    direct: '{days} j',
  },
  'reglages.defaultsDepositLabel': {
    pote: 'Acompte par défaut',
    pro: 'Acompte par défaut',
    direct: 'Acompte',
  },
  'reglages.defaultsPaymentTermsLabel': {
    pote: 'Conditions de paiement',
    pro: 'Conditions de paiement',
    direct: 'Conditions',
  },
  'reglages.paymentTermsReception': {
    pote: 'À réception',
    pro: 'À réception',
    direct: 'Réception',
  },
  'reglages.paymentTermsJ30': { pote: '30 jours', pro: '30 jours', direct: '30 j' },
  'reglages.paymentTermsJ45': { pote: '45 jours', pro: '45 jours', direct: '45 j' },
  'reglages.paymentTermsRequired': {
    pote: 'Choisis ce délai avant d’émettre ta prochaine facture — je ne vais pas en inventer un.',
    pro: 'Choisissez ce délai avant la prochaine émission. Aucune échéance n’est présumée.',
    direct: 'Requis avant émission. Aucun délai présumé.',
  },
  'reglages.defaultsAccentLabel': {
    pote: 'Couleur d’accent du PDF',
    pro: 'Couleur d’accent du PDF',
    direct: 'Couleur PDF',
  },
  'reglages.defaultsNote': {
    pote: 'La validité et l’acompte s’appliquent aux nouveaux devis. Le délai choisi fixe l’échéance des prochaines factures.',
    pro: 'La validité et l’acompte s’appliquent aux nouveaux devis. Le délai choisi fixe l’échéance des prochaines factures.',
    direct: 'Appliqué aux nouveaux devis, factures et PDF.',
  },

  'invoice.paymentTermsMissingTitle': {
    pote: 'Choisis ton délai de paiement',
    pro: 'Conditions de paiement requises',
    direct: 'Délai requis',
  },
  'invoice.paymentTermsMissingBody': {
    pote: 'Avant de donner un numéro légal à cette facture, choisis son vrai délai dans Facturation & modèles.',
    pro: 'Choisissez le délai contractuel dans Facturation & modèles avant d’attribuer le numéro légal.',
    direct: 'Choisis le délai réel avant l’émission légale.',
  },
  'invoice.paymentTermsMissingCta': {
    pote: 'Choisir le délai',
    pro: 'Configurer',
    direct: 'Configurer',
  },

  'reglages.soonBadge': { pote: 'Bientôt', pro: 'À venir', direct: 'Bientôt' },
  'reglages.dataError': {
    pote: 'Je n’arrive pas à lire tes réglages, là. On réessaie ?',
    pro: 'Impossible de charger les réglages. Veuillez réessayer.',
    direct: 'Réglages injoignables. Réessaie.',
  },
  // Le libellé nomme l'écran de destination — reglages-facturation ET profil-fiscal ne sont
  // ouverts QUE depuis Compte (compte.tsx), la clé partagée reste donc correcte pour les deux.
  'reglages.back': { pote: 'Compte', pro: 'Compte', direct: 'Compte' },

  // ── Modale menu profil (design_handoff_bob_pro/Bob Pro.dc.html §PROFILE SHEET) — tap sur
  // l'avatar du Home, LE flow du handoff : bottom sheet, jamais une navigation directe. ────────
  'menu.title': { pote: 'Menu profil', pro: 'Menu profil', direct: 'Menu' },
  'menu.closeLabel': { pote: 'Fermer', pro: 'Fermer', direct: 'Fermer' },
  'menu.account': {
    pote: 'Mon compte & abonnement',
    pro: 'Mon compte & abonnement',
    direct: 'Compte & abonnement',
  },
  'menu.accountSub': {
    pote: 'Profil, entreprise, offre Pro',
    pro: 'Profil, entreprise, offre Pro',
    direct: 'Profil · entreprise · offre',
  },
  'menu.onboarding': {
    pote: 'Revoir l’onboarding',
    pro: 'Revoir l’onboarding',
    direct: 'Onboarding',
  },
  'menu.onboardingSub': {
    pote: 'Configuration adaptée à ton métier',
    pro: 'Configuration adaptée à votre métier',
    direct: 'Configuration par métier',
  },
  'menu.tips': { pote: 'Revoir les astuces', pro: 'Revoir les astuces', direct: 'Astuces' },
  'menu.tipsSub': {
    pote: 'Réaffiche les conseils first-run des écrans',
    pro: 'Réaffiche les conseils de premier lancement',
    direct: 'Réaffiche les conseils des écrans',
  },
  'menu.tipsResetToast': {
    pote: 'Les astuces réapparaîtront sur leurs écrans.',
    pro: 'Les astuces réapparaîtront sur leurs écrans.',
    direct: 'Astuces réaffichées.',
  },
  'menu.diagnostic': {
    pote: 'Diagnostic conformité 2026',
    pro: 'Diagnostic conformité 2026',
    direct: 'Diagnostic 2026',
  },
  'menu.diagnosticSub': {
    pote: 'Où tu en es pour la facture élec.',
    pro: 'Votre avancement pour la facture électronique',
    direct: 'Facture électronique 2026',
  },

  // ── Gate « entreprise complète » (DocumentActions.tsx — émission devis/facture) ─────────────
  // Le corps NOMME le champ manquant (une clé PAR exigence d'assertCanIssue, carte
  // COMPANY_GATE_BODY_KEY) : le générique « complète ta fiche » a fait re-vérifier au fondateur
  // FLY SERVICES des champs déjà remplis, sans jamais dire que le capital social manquait.
  // Doctrine pédagogie légale : la loi en simple + pourquoi + où aller — source citée.
  'gate.companyIncompleteTitle': {
    pote: 'Complète ta fiche entreprise',
    pro: 'Complétez votre fiche entreprise',
    direct: 'Fiche entreprise incomplète',
  },
  /** Repli quand le champ fautif n'est pas nommable (fiche pas chargée / Company.of KO). */
  'gate.companyIncompleteBody': {
    pote: 'Il manque une info sur ta fiche entreprise pour émettre une pièce officielle. Deux minutes dans Réglages → Identité et c’est réglé.',
    pro: 'Une information de votre fiche entreprise manque pour émettre. Complétez-la dans Réglages → Identité.',
    direct: 'Fiche entreprise incomplète. Réglages → Identité.',
  },
  'gate.companyIncompleteBodyRcsOrRm': {
    pote: 'Il manque ton n° d’immatriculation (RCS ou RM) — obligatoire sur les devis et factures (art. R123-237 du code de commerce). Deux minutes dans Réglages → Identité et c’est réglé.',
    pro: 'Votre n° d’immatriculation (RCS ou RM) manque — mention obligatoire sur les factures (art. R123-237 du code de commerce). Renseignez-le dans Réglages → Identité.',
    direct: 'N° RCS/RM manquant — obligatoire (art. R123-237 c. com.). Réglages → Identité.',
  },
  'gate.companyIncompleteBodyAddress': {
    pote: 'Il manque l’adresse complète de ton siège (rue, code postal, ville) — elle doit figurer sur tes devis et factures (art. L441-9 du code de commerce). Deux minutes dans Réglages → Identité et c’est réglé.',
    pro: 'L’adresse complète de votre siège (rue, code postal, ville) manque — mention obligatoire sur les factures (art. L441-9 du code de commerce). Complétez-la dans Réglages → Identité.',
    direct: 'Adresse du siège incomplète (rue, CP, ville) — obligatoire (art. L441-9 c. com.). Réglages → Identité.',
  },
  'gate.companyIncompleteBodyCapitalSocial': {
    pote: 'Il manque ton capital social — c’est obligatoire sur les factures d’une société (art. R123-238 du code de commerce). Prends le montant de tes statuts : deux minutes dans Réglages → Identité.',
    pro: 'Votre capital social manque — mention obligatoire sur les factures d’une société (art. R123-238 du code de commerce). Indiquez le montant de vos statuts dans Réglages → Identité.',
    direct: 'Capital social manquant — obligatoire pour une société (art. R123-238 c. com.). Réglages → Identité.',
  },
  'gate.companyIncompleteBodyTvaIntracom': {
    pote: 'Il manque ton n° de TVA intracommunautaire — obligatoire dès que tu factures la TVA (art. 242 nonies A du CGI). Recopie celui de ton mémento fiscal dans Réglages → Identité.',
    pro: 'Votre n° de TVA intracommunautaire manque — mention obligatoire dès que vous facturez la TVA (art. 242 nonies A du CGI). Recopiez celui de votre mémento fiscal dans Réglages → Identité.',
    direct: 'N° TVA intracom manquant — obligatoire avec TVA (art. 242 nonies A CGI). Réglages → Identité.',
  },
  'gate.companyIncompleteCta': { pote: 'Compléter', pro: 'Compléter', direct: 'Compléter' },
  'gate.companyIncompleteCancel': { pote: 'Plus tard', pro: 'Plus tard', direct: 'Plus tard' },

  // ── C26 — Compte & abonnement ───────────────────────────────────────────────
  // « Fermer » (pas « Retour ») : Compte est désormais atteint depuis la modale menu profil
  // (bottom sheet) — on ferme un écran ouvert depuis une modale, on n'y « retourne » pas.
  'account.back': { pote: 'Fermer', pro: 'Fermer', direct: 'Fermer' },
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
  // Retours device fondateur — l'ancien texte mort « ça s'affichera ici » devient une carte
  // actionnable (contact support, aucun flow de ré-édition en libre-service pour l'instant).
  'account.companyEmptyTitle': {
    pote: 'Renseigne ta fiche entreprise',
    pro: 'Complétez votre fiche entreprise',
    direct: 'Fiche entreprise incomplète',
  },
  'account.companyEmptyBody': {
    pote: 'On dirait que ta société n’est pas encore reliée à ton compte — écris-nous, on répare ça avec toi.',
    pro: 'Votre société ne semble pas reliée à votre compte — contactez-nous, nous nous en occupons avec vous.',
    direct: 'Société non reliée. Contacte-nous.',
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
  'account.planChoose': {
    pote: 'Choisir cette offre',
    pro: 'Choisir cette offre',
    direct: 'Choisir',
  },
  'account.planManage': {
    pote: 'Gérer mon abonnement',
    pro: 'Gérer l’abonnement',
    direct: 'Gérer l’abonnement',
  },
  'account.planManageStore': {
    pote: 'Gérer dans le store',
    pro: 'Gérer dans le store',
    direct: 'Ouvrir le store',
  },
  'account.sectionSubInvoices': {
    pote: 'Mes factures d’abonnement',
    pro: 'Mes factures d’abonnement',
    direct: 'Factures d’abo',
  },
  'account.invoicesEmpty': {
    pote: 'Aucune facture d’abonnement pour le moment. Elles apparaîtront ici après ton premier paiement.',
    pro: 'Aucune facture d’abonnement pour le moment. Elles apparaîtront ici après votre premier paiement.',
    direct: 'Aucune facture d’abonnement.',
  },
  'account.invoicesEmptyEarlyAccess': {
    pote: 'Ton accès anticipé est gratuit : tu n’as donc aucune facture d’abonnement.',
    pro: 'Votre accès anticipé est gratuit : aucune facture d’abonnement n’est due.',
    direct: 'Accès anticipé gratuit. Aucune facture.',
  },
  'account.invoiceWithoutNumber': {
    pote: 'Facture d’abonnement',
    pro: 'Facture d’abonnement',
    direct: 'Facture d’abonnement',
  },
  'account.invoiceStatusPaid': { pote: 'Payée', pro: 'Payée', direct: 'Payée' },
  'account.invoiceStatusOpen': { pote: 'À régler', pro: 'À régler', direct: 'À régler' },
  'account.invoiceStatusVoid': { pote: 'Annulée', pro: 'Annulée', direct: 'Annulée' },
  'account.invoiceStatusUncollectible': {
    pote: 'Paiement à régulariser',
    pro: 'Paiement à régulariser',
    direct: 'À régulariser',
  },
  'account.invoiceStatusDraft': {
    pote: 'En préparation',
    pro: 'En préparation',
    direct: 'Brouillon',
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

  // ── Audit stores 20260716 — footer légal + suppression de compte (Apple 5.1.1(v)) ─────────
  'account.sectionLegal': { pote: 'Infos légales', pro: 'Informations légales', direct: 'Légal' },
  'account.appVersion': {
    pote: 'Version {version}',
    pro: 'Version {version}',
    direct: 'v{version}',
  },
  'account.legalTerms': {
    pote: 'Conditions d’utilisation',
    pro: 'Conditions d’utilisation',
    direct: 'CGU',
  },
  'account.legalPrivacy': {
    pote: 'Politique de confidentialité',
    pro: 'Politique de confidentialité',
    direct: 'Confidentialité',
  },
  'account.contactSupport': {
    pote: 'Une question ? Écris-nous',
    pro: 'Nous contacter',
    direct: 'Contact',
  },
  'account.linkUnavailable': {
    pote: 'Je n’arrive pas à ouvrir ce lien, là.',
    pro: 'Impossible d’ouvrir ce lien pour le moment.',
    direct: 'Lien indisponible.',
  },
  'account.dangerZoneTitle': {
    pote: 'Zone dangereuse',
    pro: 'Zone sensible',
    direct: 'Zone dangereuse',
  },
  'account.deleteAccountRow': {
    pote: 'Supprimer mon compte',
    pro: 'Supprimer mon compte',
    direct: 'Supprimer le compte',
  },
  'account.deleteAccountRowSub': {
    pote: 'Fermeture définitive de ton accès',
    pro: 'Fermeture définitive de votre accès',
    direct: 'Fermeture définitive',
  },
  'account.gdprNote': {
    pote: 'Tu peux aussi demander l’export de tes données — écris-nous à {email}.',
    pro: 'Vous pouvez aussi demander l’export de vos données — contactez-nous à {email}.',
    direct: 'Export de données : {email}.',
  },
  'account.deleteSheetTitle': {
    pote: 'Supprimer ton compte ?',
    pro: 'Supprimer votre compte ?',
    direct: 'Supprimer le compte ?',
  },
  'account.deleteSheetIntro': {
    pote: 'C’est une action définitive, à froid — pas à la voix. Voici exactement ce qui se passe.',
    pro: 'Cette action est définitive. Voici précisément ce qu’elle implique.',
    direct: 'Action définitive et irréversible.',
  },
  'account.deleteSheetGoesTitle': {
    pote: 'Ce qui disparaît',
    pro: 'Ce qui disparaît',
    direct: 'Supprimé',
  },
  'account.deleteSheetGoesBody': {
    pote: 'Ton accès à l’appli et tes informations personnelles (nom, contact) sont supprimés.',
    pro: 'Votre accès à l’application et vos informations personnelles (nom, contact) sont supprimés.',
    direct: 'Accès + infos personnelles supprimés.',
  },
  'account.deleteSheetStaysTitle': {
    pote: 'Ce qui reste — obligation légale',
    pro: 'Ce qui reste — obligation légale',
    direct: 'Conservé — obligation légale',
  },
  'account.deleteSheetStaysBody': {
    pote: 'Tes factures et devis déjà émis restent conservés 10 ans, comme l’exige la loi — même après la suppression de ton compte. Personne n’y touche.',
    pro: 'Vos factures et devis déjà émis restent conservés 10 ans, comme l’exige la loi, même après la suppression de votre compte.',
    direct: 'Factures/devis déjà émis conservés 10 ans (loi).',
  },
  'account.deleteSheetConfirmLabel': {
    pote: 'Pour confirmer, écris le nom de ton entreprise :',
    pro: 'Pour confirmer, saisissez le nom de votre entreprise :',
    direct: 'Confirme en écrivant le nom de l’entreprise :',
  },
  'account.deleteSheetConfirmPlaceholder': {
    pote: 'Nom de l’entreprise',
    pro: 'Nom de l’entreprise',
    direct: 'Nom de l’entreprise',
  },
  'account.deleteSheetConfirmMismatch': {
    pote: 'Ça ne correspond pas encore au nom de ton entreprise.',
    pro: 'Le texte saisi ne correspond pas au nom de votre entreprise.',
    direct: 'Ne correspond pas.',
  },
  'account.deleteSheetReasonLabel': {
    pote: 'Pourquoi tu pars ? (facultatif)',
    pro: 'Pourquoi partez-vous ? (facultatif)',
    direct: 'Motif (facultatif)',
  },
  'account.deleteSheetSubmit': {
    pote: 'Supprimer définitivement mon compte',
    pro: 'Supprimer définitivement mon compte',
    direct: 'Supprimer définitivement',
  },
  'account.deleteSheetCancel': { pote: 'Annuler', pro: 'Annuler', direct: 'Annuler' },
  'account.deleteSheetError': {
    pote: 'Je n’arrive pas à supprimer ton compte, là. Réessaie.',
    pro: 'Impossible de supprimer votre compte pour le moment. Veuillez réessayer.',
    direct: 'Suppression impossible. Réessaie.',
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

  // ── SPEC_SYSTEME_ERREUR — chrome ErrorNotice (les deux faces, §6) ──────────
  'errors.noticeDetails': {
    pote: 'Détails techniques',
    pro: 'Détails techniques',
    direct: 'Détails',
  },
  'errors.noticeHide': {
    pote: 'Masquer les détails',
    pro: 'Masquer les détails',
    direct: 'Masquer',
  },
  'errors.noticeShare': {
    pote: 'Partager le rapport',
    pro: 'Partager le rapport',
    direct: 'Partager',
  },
  'errors.noticeReference': { pote: 'Référence', pro: 'Référence', direct: 'Réf.' },
  'errors.noticeCorrelation': { pote: 'Corrélation', pro: 'Corrélation', direct: 'Corr.' },
  'errors.noticeKind': { pote: 'Type', pro: 'Type', direct: 'Type' },
  'errors.noticeAt': { pote: 'Heure', pro: 'Heure', direct: 'Heure' },
  'errors.noticeDetailsHint': {
    pote: 'De quoi me donner la référence exacte si tu appelles à l’aide.',
    pro: 'Références exactes à communiquer au support.',
    direct: 'Références support.',
  },

  // ── SPEC_SYSTEME_ERREUR — écran « Diagnostic technique » (§5.2) ────────────
  'diagtech.eyebrow': {
    pote: 'Sous le capot',
    pro: 'Support technique',
    direct: 'Technique',
  },
  'diagtech.title': {
    pote: 'Diagnostic technique',
    pro: 'Diagnostic technique',
    direct: 'Diagnostic technique',
  },
  'diagtech.subtitle': {
    pote: 'Les derniers pépins techniques, avec leurs références. Aucune donnée client là-dedans.',
    pro: 'Les derniers incidents techniques et leurs références. Aucune donnée client.',
    direct: 'Derniers incidents + références. Zéro donnée client.',
  },
  'diagtech.empty': {
    pote: 'Rien à signaler : aucun échec technique enregistré sur cet appareil.',
    pro: 'Aucun échec technique enregistré sur cet appareil.',
    direct: 'Aucun échec enregistré.',
  },
  'diagtech.share': { pote: 'Partager', pro: 'Partager', direct: 'Partager' },
  'diagtech.shareUnavailable': {
    pote: 'Le partage n’est pas dispo sur cet appareil, là.',
    pro: 'Le partage est indisponible sur cet appareil.',
    direct: 'Partage indisponible.',
  },
  'diagtech.clear': { pote: 'Vider', pro: 'Vider', direct: 'Vider' },
  'diagtech.clearConfirmTitle': {
    pote: 'Vider le journal ?',
    pro: 'Vider le journal ?',
    direct: 'Vider ?',
  },
  'diagtech.clearConfirmBody': {
    pote: 'Les références des derniers échecs seront effacées de cet appareil.',
    pro: 'Les références des derniers échecs seront effacées de cet appareil.',
    direct: 'Effacement local des références.',
  },
  'diagtech.clearConfirmYes': { pote: 'Vider', pro: 'Vider', direct: 'Vider' },
  'diagtech.sectionJournal': {
    pote: 'Derniers échecs',
    pro: 'Derniers échecs',
    direct: 'Échecs',
  },
  'diagtech.channelTitle': {
    pote: 'Canal de crash',
    pro: 'Canal de crash',
    direct: 'Canal crash',
  },
  'diagtech.channelActive': {
    pote: 'Actif sur ce build — les plantages remontent (sans aucune donnée client).',
    pro: 'Actif sur ce build : les plantages sont remontés, sans donnée client.',
    direct: 'Actif. Zéro donnée client.',
  },
  'diagtech.channelDormant': {
    pote: 'Dormant sur ce build — rien ne quitte l’appareil.',
    pro: 'Dormant sur ce build : aucune télémétrie ne quitte l’appareil.',
    direct: 'Dormant. Rien ne sort.',
  },
  'diagtech.statusLine': {
    pote: '{count} échec(s) gardé(s) en mémoire, sur les {max} derniers max.',
    pro: '{count} échec(s) conservé(s) (maximum {max}).',
    direct: '{count}/{max} échecs.',
  },

  // ── Mon compte — accès au diagnostic technique ─────────────────────────────
  'account.diagnosticRow': {
    pote: 'Diagnostic technique',
    pro: 'Diagnostic technique',
    direct: 'Diagnostic technique',
  },
  'account.diagnosticRowSub': {
    pote: 'Les références des derniers pépins, à partager au support',
    pro: 'Références des derniers incidents, partageables au support',
    direct: 'Références incidents',
  },
} as const satisfies Record<string, Copy>;

const fr = {
  ...legacyFr,
  ...cabinetFr,
  ...monetizationFr,
  ...fiscalFr,
  ...legalFr,
  ...billingTerrainFr,
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
