export type BobIntent =
  | 'contexte_ecran' // lire l'entite affichee : « cette facture », « ou suis-je ? »
  | 'payout'
  | 'relance'
  | 'encaisser'
  | 'factures'
  | 'envoyer_devis'
  | 'emettre_facture'
  | 'generer_facture' // générer la facture d'un devis signé (acompte ou solde) — ASK-2
  | 'documents'
  | 'scan' // numériser un reçu/ticket/justificatif (ouvre l'OCR caméra)
  | 'nouveau_devis' // ouvrir l'écran de création de devis
  | 'voir_chantiers' // ouvrir les chantiers
  | 'voir_catalogue' // ouvrir le catalogue de prestations (C27) — libellés, prix, TVA
  | 'cloture' // préparer le mois pour le comptable (ouvre l'écran de clôture)
  | 'diagnostic' // « prêt pour 2026 ? » — ouvrir le diagnostic conformité (C40, TODO ⑦)
  | 'echeances' // échéances fiscales à venir (TVA/URSSAF/IS/CFE) — lecture, C-EXP5b
  | 'tva' // position de TVA réelle (collectée/déductible/à provisionner) — lecture, BOB-1
  | 'balance' // balance âgée : qui me doit quoi, depuis quand — lecture, BOB-1
  | 'marquer_notifications_lues' // batch atomique borné par cutoff serveur — mutation confirmée
  | 'payer_depense' // enregistrer un règlement fournisseur déjà effectué — mutation comptable
  | 'depense_dictee' // « j'ai dépensé 89 € chez Leroy Merlin en carte » — dépense créée à la voix (M4), DISTINCT du scanner
  | 'lier_depense_chantier' // « mets la dépense Aldi sur le chantier Durand » — imputation dépense→chantier (M3)
  | 'ajouter_equipement' // « ajoute la clim du local serveur chez Carrefour » — création au parc du site (PR-11)
  | 'parc_equipements' // « montre-moi le parc du site Bastille » — lecture du parc (PR-11)
  | 'historique_equipement' // « l'historique de la fontaine de l'accueil » — historique dérivé (PR-11)
  | 'retirer_equipement' // « la vitrine froide est déposée, retire-la du parc » — retrait logique (PR-11)
  | 'valider_document' // « c'est bon, valide le ticket » — pose reviewedAt (AcknowledgeDocument), parité file « À valider »
  | 'classer_document' // « range le ticket Aldi dans le chantier Durand » — même séquence que « Classer là » (LOT 5)
  | 'renommer_document' // « renomme-le facture matériaux salle de bain » — RenameDocument, nom humain prioritaire (LOT 5)
  | 'chercher_document' // « retrouve la facture du radiateur de mars » — recherche réelle devis & factures, lecture (LOT 5)
  | 'lier_bon_commande' // « la RATP m'a envoyé un bon de commande n° 4500123 » — numéro d'engagement attaché au devis (B8)
  | 'envoyer_facture' // « envoie la facture 2026-014 » — envoi EMAIL réel d'une facture ÉMISE (PR-01, SendInvoice)
  | 'relance_devis' // « relance le devis Durand » — brouillon J+15/J+30 du devis sans réponse, lecture (PR-05)
  | 'declarer_transmission' // « j'ai déposé la facture sur Chorus hier » — dates de dépôt/acceptation déclarées (PR-02)
  | 'cadence_relances' // « coupe les relances automatiques » — cadence/interrupteur des relances (PR-06)
  | 'facture_directe' // « facture 380 € à Mme Girard pour le dépannage » — facture SANS devis signé (B1, ComposeStandaloneInvoice)
  | 'facturer_situation' // « facture une situation de 40 % sur le chantier Durand » — situation de travaux d'un devis signé (B2)
  | 'conditions_paiement' // « Durand paie à 45 jours fin de mois » — conditions de paiement propres au client (B4)
  | 'resultat' // résultat provisoire (produits − charges du grand-livre) — lecture, BOB-2
  | 'bilan' // bilan simplifié actif/passif — lecture, BOB-4
  | 'revue_cloture' // « mon dossier est-il prêt pour le comptable ? » — verdict de revue, DOSSIER-2
  | 'pilotage' // revue de pilotage : CA facturé/encaissé, tendance, ratios — lecture, BA-3
  | 'dso' // « on me paie en combien de temps ? » — DSO 90 j + € immobilisés, BA-3
  | 'top_clients' // plus gros clients 12 mois + dépendance — lecture, BA-3
  | 'abonnement' // « où en est mon abonnement / mon essai ? » — lecture seule, pilier 2 (jamais d'achat vocal)
  | 'aide' // « aide », « tu sais faire quoi ? » — catalogue parlé des capacités (découvrabilité, jamais un refus)
  | 'unknown';

function normalizeIntent(message: string): string {
  return message
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Détection d'intention déterministe (fallback hors-ligne / LLM indisponible / intention triviale). */
export function detectIntent(message: string): BobIntent {
  const m = message.toLowerCase();
  const normalizedMessage = normalizeIntent(message);
  // Mutation du fil AVANT le contexte de lecture : « marque toutes les notifications comme lues »
  // ne doit jamais être interprété comme un simple briefing. « tout » reste accepté pour le geste
  // naturel depuis l'écran Notifications ; la portée réelle vient du preview serveur, pas du contexte UI.
  if (
    // Portée PLURIELLE EXPLICITE seulement : « cette notification » / « la deuxième notification »
    // (singulier déterminé) ne doit JAMAIS escalader en tout-marquer-lu ; et une négation
    // (« ne marque pas tout lu ») ne propose rien.
    /\b(marque|marquer|passe|passer)\b.{0,40}\b(tout|toutes|les toutes|toutes? (les |mes )?notifications?|les notifications|mes notifications)\b.{0,30}\b(comme )?lu(?:e|es|s)?\b/.test(
      normalizedMessage,
    ) &&
    !/\b(cette|cet|la (\d{1,2}e?|premiere|seconde|deuxieme|troisieme)|une) notification\b/.test(normalizedMessage) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(marque|marquer|passe|passer)\b|\b(marque|marquer|passe|passer)\b.{0,30}\bpas\b/.test(normalizedMessage)
  ) {
    return 'marquer_notifications_lues';
  }
  const contextualNavigation =
    /\b(ouvre|ouvrir|affiche|afficher|accede|acceder|emmene|amene|va)\b/.test(normalizedMessage) &&
    /\b(facture|devis|client|depense|document|chantier|notification|ecriture|ligne|premier|premiere|second|seconde|deuxieme|troisieme|quatrieme|cinquieme|sixieme|septieme|huitieme|neuvieme|dixieme|e\d{1,2}|\d{1,2}(?:er|ere|e|eme))\b/.test(
      normalizedMessage,
    );
  // Contexte UI : AVANT les intents document/facture generiques. Lecture pure ; la cible vient
  // exclusivement d'AgentContext et reste a recharger/autoriser par l'hote.
  if (
    contextualNavigation ||
    /(o[uù] suis[- ]?je|qu['’ ]?est[- ]?ce que je (regarde|vois)|r[ée]sume (cet |cette |ce |la |le |l['’])?(facture|devis|client|d[ée]pense|document|chantier|notification|[ée]criture|ligne)|r[ée]sume (l['’]|cet )?[ée]cran|(explique|montre) (cet|cette|ce|la) (facture|devis|client|d[ée]pense|document|chantier|notification|[ée]criture|ligne)|(explique|montre|liste|lis|r[ée]sume)[^.]{0,30}(tout ce qu|les notifications?|les [ée]critures?)|parle[- ]?moi de (cet|cette|ce|la) (facture|devis|client|d[ée]pense|document|chantier|notification|[ée]criture|ligne))/.test(
      m,
    )
  )
    return 'contexte_ecran';
  // DÉCOUVRABILITÉ (S9) : question sur les CAPACITÉS de Bob — patterns stricts (interrogatifs
  // « quoi/que/ce que » requis) pour ne JAMAIS capter une vraie commande (« tu peux faire un
  // devis pour Martin » reste nouveau_devis) ; « aide » seul est ancré début/fin de message.
  if (
    /\b(tu|vous) (sais|savez|peux|pouvez) faire quoi\b/.test(normalizedMessage) ||
    /\bque (sais|peux)[- ]tu faire\b|\bque (savez|pouvez)[- ]vous faire\b/.test(normalizedMessage) ||
    /\bqu.{0,3}est[- ]ce que (tu|vous) (sais|savez|peux|pouvez) faire\b/.test(normalizedMessage) ||
    /\bce que (tu sais|vous savez) faire\b/.test(normalizedMessage) ||
    /\ba quoi (tu sers|sers[- ]tu|vous servez|servez[- ]vous)\b/.test(normalizedMessage) ||
    /\bcomment (tu peux|vous pouvez) m.{0,3}aider\b/.test(normalizedMessage) ||
    /\btu fais quoi\b/.test(normalizedMessage) ||
    // « besoin d'aide » / « aide » SEULS (ancrés) : « besoin d'aide pour un devis » reste un devis.
    /^\s*(j.{0,3}ai )?besoin d.{0,3}aide\s*[!?.…]*\s*$/.test(normalizedMessage) ||
    /^\s*(aide|aide[- ]moi|de l.{0,3}aide|help|au secours)\s*[!?.…]*\s*$/.test(normalizedMessage)
  )
    return 'aide';
  // PR-11 — PARC D'ÉQUIPEMENTS : AVANT les gestes documentaires, la dépense dictée et
  // voir_chantiers (« site », « chantier », « ajoute », « mets » y collisionnent).
  // Retrait (« la vitrine froide est déposée, retire-la du parc ») : le mot parc/équipement
  // est REQUIS — « retire » seul resterait ambigu. Négation ⇒ rien.
  if (
    /\b(retire|retirer|retires|enleve|enlever|enleves|sors|sortir|deposee?s? ?[,.]? ?retire)\b/.test(normalizedMessage) &&
    /\b(equipements?|parc|machines?)\b/.test(normalizedMessage) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(retire|retirer|enleve|enlever|sors)\b|\b(retire|retirer|enleve|enlever|sors)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'retirer_equipement';
  // Historique d'une machine : « l'historique de la fontaine de l'accueil » — la résolution du
  // NOM se fait contre le parc réel dans le handler ; les historiques d'autres objets restent
  // à leurs intents (client, facture…). [Revue train n°2] l'historique DU chantier/site
  // lui-même (« l'historique du chantier Durand ») et celui d'une PERSONNE désignée par sa
  // civilité (« l'historique de Mme Girard ») ne sont JAMAIS des équipements — mais une
  // machine SCOPÉE à son site (« l'historique de la clim du site Bastille ») en reste un :
  // l'exclusion ne porte que sur l'objet qui suit IMMÉDIATEMENT « historique de/du ».
  if (
    /\bhistoriques?\b/.test(normalizedMessage) &&
    !/\b(clients?|factures?|devis|paiements?|reglements?|relances?|comptes?|depenses?|documents?)\b/.test(
      normalizedMessage,
    ) &&
    !/\bhistoriques?\s+(?:complet\s+)?(?:du|des|de\s+la|de\s+l\W{0,3}|de)\s*(?:chantiers?|sites?)\b/.test(
      normalizedMessage,
    ) &&
    !/\bhistoriques?\s+(?:complet\s+)?(?:du|des|de)\s+(?:m\.|mr|mme|mlle|monsieur|madame|mademoiselle)\b/.test(
      normalizedMessage,
    )
  )
    return 'historique_equipement';
  // Lecture du parc : « le parc du site Bastille », « les équipements de Carrefour ».
  if (
    /\b(parc|equipements?)\b/.test(normalizedMessage) &&
    !/\b(ajoute|ajouter|ajoutes|installe|installer|enregistre|enregistrer|cree|creer|mets|mettre)\b/.test(
      normalizedMessage,
    ) &&
    // Les gestes documentaires et dépenses gardent leurs intents même si un libellé contient
    // « équipement » (« range le document équipements… »).
    !/\b(range|ranger|ranges|classe|classer|classes|deplace|deplacer|renomme|renommer|rebaptise|cherche|chercher|retrouve|retrouver|trouve|trouver|recherche|rechercher|scanne|scanner|valide|valider)\b/.test(
      normalizedMessage,
    ) &&
    !/\b(depenses?|documents?|tickets?|recus?|justificatifs?)\b/.test(normalizedMessage)
  )
    return 'parc_equipements';
  // Création : « ajoute un équipement au site X », « ajoute la clim du local serveur chez
  // Carrefour » (kind LIBRE — aucun lexique matériel codé : le marqueur site/chez + le verbe
  // d'ajout suffisent, les gestes documentaires/notes/dépenses sont EXCLUS explicitement).
  if (
    /\b(ajoute|ajouter|ajoutes|installe|installer|enregistre|enregistrer|cree|creer|mets|mettre|pose|poser)\b/.test(
      normalizedMessage,
    ) &&
    (/\b(equipements?|au parc|dans le parc)\b/.test(normalizedMessage) ||
      /\b(chez|au site|sur le site|du site)\b/.test(normalizedMessage)) &&
    !/\b(notes?|depenses?|documents?|tickets?|recus?|justificatifs?|devis|factures?|bons? de commande|bc\b|contacts?|lignes?|prestations?|clients?|rendez|rdv)\b/.test(
      normalizedMessage,
    ) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(ajoute|installe|enregistre|cree|mets|pose)\b|\b(ajoute|installe|enregistre|cree|mets|pose)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'ajouter_equipement';
  // M3 — imputation d'une dépense EXISTANTE à un chantier (« mets la dépense Aldi sur le
  // chantier Durand », « impute la dépense gasoil au chantier Sèvres ») : AVANT la dépense
  // dictée (« mets » y collisionne), AVANT payer_depense/classer_document/voir_chantiers
  // (« dépense », « range », « chantier » y collisionnent). Négation ⇒ rien.
  if (
    /\bdepenses?\b/.test(normalizedMessage) &&
    /\bchantiers?\b/.test(normalizedMessage) &&
    /\b(mets|met|mettre|impute|imputer|imputes|affecte|affecter|affectes|lie|lier|lies|rattache|rattacher|rattaches|attache|attacher|associe|associer|bascule|basculer|range|ranger|ranges|classe|classer|classes|deplace|deplacer|passe|passer)\b/.test(
      normalizedMessage,
    ) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(mets|met|impute|affecte|lie|rattache|attache|associe|bascule|range|classe|deplace|passe)\b|\b(mets|met|impute|affecte|lie|rattache|attache|associe|bascule|range|classe|deplace|passe)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'lier_depense_chantier';
  // B2 — SITUATION DE TRAVAUX (« facture une situation de 40 % sur le chantier Durand ») :
  // AVANT facture_directe (« facture … € » y collisionne), AVANT voir_chantiers (« chantier »),
  // generer_facture et nouveau_devis (« devis »). « la situation de ma trésorerie » ne matche
  // pas : le mot situation seul ne suffit jamais — il faut la facturation, l'avancement ou un
  // pourcentage adjacent. Négation ⇒ rien.
  if (
    (/\bfactur\w*\b.{0,40}\bsituations?\b|\bsituations?\b.{0,40}\bfactur\w*\b/.test(normalizedMessage) ||
      /\bsituations?\b\s+(d.avancement|de travaux)\b/.test(normalizedMessage) ||
      /\b(fais|faire|genere|generer|generes|cree|creer|crees|prepare|preparer|etablis|etablir|lance|lancer)\b.{0,30}\bsituations?\b.{0,40}(\d{1,3}(?:[.,]\d{1,2})?\s*(%|pour ?cent)|\bchantiers?\b|\bdevis\b|\bmarches?\b)/.test(
        normalizedMessage,
      ) ||
      /\bsituations?\b.{0,20}\bde\b.{0,10}\d{1,3}(?:[.,]\d{1,2})?\s*(%|pour ?cent)/.test(normalizedMessage)) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(facture|facturer|fais|genere|cree|prepare|etablis|lance)\b|\b(facture|facturer|fais|genere|cree|prepare|etablis|lance)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'facturer_situation';
  // B1 — FACTURE DIRECTE sans devis signé (« facture 380 € à Mme Girard pour le dépannage ») :
  // AVANT depense_dictee (« 45 € de dépannage » y collisionnerait) et AVANT les intents facture
  // génériques. Les gestes documentaires (ranger/chercher la facture), l'encaissement, la
  // relance, l'émission d'un brouillon existant et la chaîne devis (acompte/solde) restent
  // exclus — jamais de mutation sur une intention ambiguë. Négation ⇒ rien.
  if (
    (/\bfactur\w*\b(?:[- ](?:moi|nous|lui))?\s*(?:de\s+|d\W)?\d+(?:[.,]\d{1,2})?\s*(?:€|euros?\b|eur\b)/.test(
      normalizedMessage,
    ) ||
      /\b(fais|faire|cree|creer|genere|generer|prepare|preparer|etablis|etablir)\b.{0,24}\bfacture\b.{0,50}\d+(?:[.,]\d{1,2})?\s*(?:€|euros?\b|eur\b)/.test(
        normalizedMessage,
      ) ||
      /\bfacture directe\b/.test(normalizedMessage)) &&
    !/\bdevis\b/.test(normalizedMessage) &&
    !/\bsituations?\b/.test(normalizedMessage) &&
    !/\bdepens/.test(normalizedMessage) &&
    !/\b(acompte|solde|finale?)\b/.test(normalizedMessage) &&
    !/\b(range|ranger|classe|classer|deplace|deplacer|renomme|renommer|cherche|chercher|retrouve|retrouver|trouve|trouver|recherche|rechercher|scanne|scanner|valide|valider|encaisse|encaisser|paie|paye|payer|regle|regler|relance|relancer|emets|emettre|emet|numerote|envoie|envoyer)\b/.test(
      normalizedMessage,
    ) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(facture|fais|cree|genere|prepare|etablis)\b|\b(facture|fais|cree|genere|prepare|etablis)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'facture_directe';
  // M4 — dépense DICTÉE (« j'ai dépensé 89 € chez Leroy Merlin en carte », « 45 € de gasoil ce
  // matin ») : création vocale, DISTINCTE du scanner (« scanne ce ticket » reste scan) et du
  // règlement d'une dépense EXISTANTE (« j'ai payé la dépense EDF » reste payer_depense).
  // AVANT payer_depense (« dépense » y collisionne) et AVANT encaisser/scan. Négation ⇒ rien.
  if (
    (/\bj\W{0,3}ai depense\b/.test(normalizedMessage) ||
      /\bdepense (?:de |d\W)?\d/.test(normalizedMessage) ||
      /\b\d+(?:[.,]\d{1,2})?\s*(?:€|euros?)\s+(?:de|d\W|chez)\s*\S/.test(normalizedMessage) ||
      /\b(note|ajoute|ajouter|enregistre|enregistrer|cree|creer|mets|mettre)\b.{0,24}\b(une |la )?depense\b/.test(
        normalizedMessage,
      )) &&
    // Règlement d'une dépense EXISTANTE (« j'ai payé/réglé la dépense… ») ⇒ payer_depense.
    !/\b(pay|pai|regl|sold)[a-z]*\b.{0,20}\b(la |cette |ma |une )?depense\b/.test(normalizedMessage) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(note|ajoute|enregistre|cree|mets|depense)\b|\b(note|ajoute|enregistre|cree|mets)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'depense_dictee';
  // BOB-1 : régler une DÉPENSE/FOURNISSEUR — AVANT « encaisser » (« règle », « payé » collisionnent).
  if (/(pai|pay|regl|sold).*(depense|fournisseur)|(depense|fournisseur).*(pai|pay|regl|sold)/.test(normalizedMessage))
    return 'payer_depense';
  // PR-06 — CADENCE DE RELANCES & relances automatiques (« coupe les relances automatiques »,
  // « relance mes clients tous les 10 jours », « ma politique de relance ») : AVANT
  // conditions_paiement (« passe … à N jours » y collisionne), AVANT balance (« retards »
  // y collisionne) et AVANT la relance de facture (« relance » y collisionne).
  if (
    /\brelances?\b.{0,24}\b(automatiques?|auto)\b|\b(automatiques?|auto)\b.{0,10}\brelances?\b/.test(
      normalizedMessage,
    ) ||
    /\b(cadence|politique|frequence|reglages?|parametres?)\b.{0,30}\brelances?\b|\brelances?\b.{0,12}\b(cadence|politique|frequence)\b/.test(
      normalizedMessage,
    ) ||
    /\brelanc\w*\b.{0,40}\btous les \d{1,3} jours\b/.test(normalizedMessage)
  )
    return 'cadence_relances';
  // B4 — CONDITIONS DE PAIEMENT d'un client (« Durand paie à 45 jours fin de mois », « mets
  // Durand à 60 jours », « conditions de paiement de Durand ») : AVANT dso (« délai de
  // paiement » y collisionne) et AVANT encaisser (« paie » y collisionne). « on me paie en
  // 30 jours » (constat DSO) reste exclu : « me paie » ne cible jamais un client. Négation ⇒ rien.
  if (
    (/\b(paie|paient|payent|paye|payes|paiera|paieront|regle|reglent|reglera)\b.{0,24}\b(a|en|sous)?\s*\d{1,3}\s*jours?\b/.test(
      normalizedMessage,
    ) ||
      /\bconditions? de (paiement|reglement)\b/.test(normalizedMessage) ||
      /\bdelais? de (paiement|reglement)\b.{0,30}\b\d{1,3}\s*jours?\b/.test(normalizedMessage) ||
      /\b(mets|met|mettre|passe|passer|bascule|basculer)\b.{0,40}\b(a|en)\s+\d{1,3}\s*jours?\b/.test(
        normalizedMessage,
      )) &&
    !/\bme (paie|paient|payent|paye)\b/.test(normalizedMessage) &&
    !/\b(moyen|moyenne|combien|dso)\b/.test(normalizedMessage) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(paie|paye|regle|mets|met|passe|bascule|change)\b|\b(paie|paye|regle|mets|met|passe|bascule|change)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'conditions_paiement';
  // PR-07 — LECTURE de l'encaissement (« où en est mon encaissement ? », « mon taux
  // d'encaissement ») : c'est du PILOTAGE (carte Encaissement), jamais le flux mutatif
  // « encaisser une facture » — AVANT dso et encaisser (« encaiss » y collisionne).
  if (
    /\b(ou en est|comment va|etat de?|taux)\b.{0,24}\bencaissements?\b/.test(normalizedMessage) ||
    /\btaux d.encaissement\b|\bmon encaissement\b/.test(normalizedMessage)
  )
    return 'pilotage';
  // DSO (BA-3) : AVANT « encaisser » (« me paient », « temps pour encaisser » y collisionnent).
  if (/(me paie(nt)?|me payent|d[ée]lai.*(paiement|encaissement|r[èe]glement)|jours? pour ([êe]tre )?pay|\bdso\b|temps.*(encaiss|pay[ée]))/.test(m))
    return 'dso';
  // « payé(e/s) » = participe (paiement reçu) ; « payer/verser » = se verser (payout) — d'où la distinction.
  if (/(encaiss|paiement re[çc]u|re[çc]u le paiement|marque.*pay|r[ée]gl[ée]|\bpay[ée]e?s?\b)/.test(m)) return 'encaisser';
  // Revue de clôture (DOSSIER-2) : AVANT clôture — « dossier prêt pour le comptable » est une
  // QUESTION (verdict de revue), pas une demande d'ouvrir l'écran.
  if (/(dossier.{0,25}pr[êe]t|pr[êe]te?s? [àa] signer|revue de (pr[ée].?signature|cl[ôo]ture)|diligences|anomalies?.{0,20}(dossier|compta)|r[ée]serves?.{0,20}(dossier|comptable))/.test(m))
    return 'revue_cloture';
  if (/(cl[ôo]tur|pr[ée]pare?.*(le |mon )?mois|boucle.*mois|pour le comptable|bilan du mois)/.test(m)) return 'cloture';
  // « prêt(e/s) pour 2026 ? » (chip C15) / diagnostic conformité -> ouvrir l'écran diagnostic (C40 ⑦).
  if (/(diagnostic|pr[êe]te?s? pour 2026|conformit[ée].*(2026|facturation [ée]lectronique))/.test(m)) return 'diagnostic';
  // Échéances fiscales (C-EXP5b) : AVANT scan/documents (« déclaration », « impôts » ≠ pièces à classer).
  if (/([ée]ch[ée]anc|calendrier fiscal|urssaf|\bcfe\b|\bca3\b|\bca12\b|liasse|d[ée]clar.*(tva|urssaf|imp[ôo]t)|imp[ôo]ts? [àa] (venir|payer))/.test(m))
    return 'echeances';
  // Position de TVA (BOB-1) : AVANT payout (« combien » y appartient aussi).
  if (/(tva.*(dois|due|d[ûu]e|provision|position|net|combien)|combien.*tva|ma tva|position de tva|cr[ée]dit de tva)/.test(m))
    return 'tva';
  // Balance âgée (BOB-1) : AVANT relance (« en retard » y collisionne).
  if (/(qui me doit|balance [âa]g[ée]e|encours clients?|retards? clients?|me doivent|doit de l'argent)/.test(m))
    return 'balance';
  // Top clients (BA-3) : AVANT balance/relance (« clients » y collisionne).
  if (/(top.{0,10}clients?|(plus gros|meilleurs?|principaux) clients?|classement.*clients?|clients?.*(rapportent|rapporte le plus)|d[ée]pend[a-z]*.{0,15}client)/.test(m))
    return 'top_clients';
  // Abonnement/essai (pilier 2) : AVANT pilotage (« comment va mon essai » y collisionne) et
  // AVANT payout (« combien de jours d'essai » y collisionne). Lecture seule — jamais d'achat vocal.
  if (/abonnement|mon essai|p[ée]riode d.essai|jours? d.essai|essai (gratuit|pro|se termine)|fin de (mon |l.)essai|mon offre actuelle|quelle (est mon|offre)|mon plan\b|suis[- ]je (en essai|abonn[ée])/.test(m))
    return 'abonnement';
  // Pilotage (BA-3) : AVANT résultat/payout (« ça monte ? », « mon CA » ≠ « combien je gagne »).
  if (/(pilotage|comment va (mon|ma|l)|[çc]a (monte|baisse|progresse)|tendance|mon (ca|chiffre)\b|chiffre d'affaires|[ée]volution.*(ca|activit[ée]|ventes)|mes ratios|taux d'ebe|\bebe\b|valeur ajout[ée]e|factur[ée] vs encaiss[ée])/.test(m))
    return 'pilotage';
  // Bilan actif/passif (BOB-4) : AVANT résultat ; « bilan du mois » déjà capté par clôture.
  if (/(\bbilan\b|actif.{0,15}passif|capitaux propres|patrimoine de l'entreprise)/.test(m)) return 'bilan';
  // Résultat provisoire (BOB-2) : AVANT payout (« combien je gagne » ≠ « me verser »).
  if (/(r[ée]sultat|b[ée]n[ée]fice|combien je gagne|je gagne combien|en perte|balance g[ée]n[ée]rale)/.test(m))
    return 'resultat';
  // Bon de commande (B8) : « la RATP m'a envoyé un bon de commande n° 4500123 », « ajoute le
  // BC-2207 au devis de Durand » — AVANT les gestes documentaires (« commande », « reçu »,
  // « scanné » collisionnent avec scan/documents) et AVANT envoyer_devis/nouveau_devis
  // (« devis » y collisionne). Un geste documentaire EXPLICITE (ranger/classer/renommer/
  // chercher le bon de commande scanné) reste un geste documentaire. Négation ⇒ rien.
  if (
    /\b(bons? de commande|bc[- ]?\d|numeros? d.{0,3}engagement|purchase order)\b/.test(normalizedMessage) &&
    // PR-04 — « émets la facture X SANS bon de commande » est un ordre d'ÉMISSION (override
    // responsabilisé), jamais un attachement de BC : la commande canonique du rattrapage
    // doit atteindre emettre_facture.
    !/\bsans (le |son )?(bon de commande|bc)\b/.test(normalizedMessage) &&
    !/\b(range|ranger|ranges|classe|classer|classes|deplace|deplacer|deplaces|renomme|renommer|renommes|rebaptise|rebaptiser|cherche|chercher|retrouve|retrouver|trouve|trouver|recherche|rechercher)\b/.test(
      normalizedMessage,
    ) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(lie|lier|lies|ajoute|ajouter|attache|attacher|rattache|rattacher|mets|note|noter)\b|\b(lie|lier|lies|ajoute|ajouter|attache|attacher|rattache|rattacher|mets|note|noter)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'lier_bon_commande';
  // Recherche de pièce (LOT 5) : « retrouve la facture du radiateur de mars » — AVANT scan,
  // documents, nouveau_devis (« un devis » y collisionne) et emettre_facture. Lecture pure.
  if (
    /\b(retrouve|retrouver|retrouves|recherche|rechercher|cherche|chercher|trouve|trouver)\b.{0,50}\b(facture|factures|devis|document|documents|piece|pieces)\b/.test(
      normalizedMessage,
    )
  )
    return 'chercher_document';
  // Classement d'un document (LOT 5) : « range le ticket Aldi dans le chantier Durand »,
  // « classe la facture Leroy Merlin dans frais généraux » — AVANT scan/documents (« ticket »,
  // « justificatif » y collisionnent) et AVANT voir_chantiers (« chantier » y collisionne).
  // « classe » sans complément documentaire ni destination ne suffit pas. Négation ⇒ rien.
  if (
    (/\b(range|ranger|ranges|classe|classer|classes|deplace|deplacer|deplaces)\b.{0,60}\b(document|ticket|recu|justificatif|piece|attestation|releve|scan|facture|devis)s?\b/.test(
      normalizedMessage,
    ) ||
      /\b(range|ranger|ranges|classe|classer|classes|deplace|deplacer|deplaces)\b.{0,50}\b(dans|vers|au|aux)\b/.test(
        normalizedMessage,
      )) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(range|ranger|classe|classer|deplace|deplacer)\b|\b(range|ranger|classe|classer|deplace|deplacer)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'classer_document';
  // Renommage d'un document (LOT 5) : « renomme-le facture matériaux salle de bain » — le nom
  // dicté devient un renommage humain prioritaire. Clients/dossiers/chantiers exclus (autre geste).
  if (
    /\b(renomme|renommer|renommes|rebaptise|rebaptiser|rebaptises)\b/.test(normalizedMessage) &&
    !/\b(renomme|renommer|renommes|rebaptise|rebaptiser|rebaptises)\b.{0,24}\b(client|chantier|dossier)\b/.test(
      normalizedMessage,
    ) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(renomme|renommer|rebaptise|rebaptiser)\b|\b(renomme|renommer|rebaptise|rebaptiser)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'renommer_document';
  // Validation d'un document scanné (« c'est bon, valide le ticket Aldi ») : AVANT scan
  // (« ticket », « reçu », « justificatif » y collisionnent) et AVANT documents. Les noms
  // facture/devis sont EXCLUS du groupe nominal : « valide la facture » resterait ambigu avec
  // l'émission légale — jamais de mutation sur une intention ambiguë. Négation ⇒ aucune action.
  if (
    /\b(valide|valider|confirme|confirmer)\b.{0,40}\b(document|ticket|recu|justificatif|piece|attestation|releve|scan)\b|\b(document|ticket|recu|justificatif|piece|attestation|releve)s?\b.{0,30}\b(est|sont)?\s*(bon|bons|ok|valid[ée]s?)\b.{0,15}\b(valide|confirme)\b|\bmarque\b.{0,30}\b(document|ticket|recu|justificatif|piece)\b.{0,20}\bcomme (vu|lu|valid[ée])\b/.test(
      normalizedMessage,
    ) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(valide|valider|confirme|confirmer|marque)\b|\b(valide|valider|confirme|confirmer|marque)\b.{0,30}\bpas\b/.test(normalizedMessage)
  )
    return 'valider_document';
  if (/(scan|num[ée]ris|ticket|justificatif|note de frais|re[çc]u|photo.*(facture|ticket|d[ée]pense))/.test(m)) return 'scan';
  // PR-02 — DÉCLARATION de transmission d'une facture ÉMISE (« j'ai déposé la facture sur
  // Chorus hier », « marque la facture 2026-014 comme envoyée », « la facture RATP a été
  // acceptée ») : un FAIT déclaré daté — jamais un envoi (envoyer_facture) ni une émission.
  // AVANT envoyer_devis/envoyer_facture/emettre_facture (« facture », « envoyée » collisionnent).
  // Négation ⇒ rien.
  if (
    /\bfactures?\b/.test(normalizedMessage) &&
    (/\b(depose|deposes|deposee|deposees)\b/.test(normalizedMessage) ||
      /\b(chorus|portail)\b/.test(normalizedMessage) ||
      /\b(marque|marquer|note|noter|declare|declarer|considere|considerer)\b.{0,50}\b(envoyee|transmise|deposee|acceptee)s?\b/.test(
        normalizedMessage,
      ) ||
      /\b(a ete|est)\b.{0,16}\b(envoyee|transmise|acceptee)s?\b/.test(normalizedMessage)) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(marque|marquer|note|noter|declare|declarer|depose)\b|\b(marque|marquer|note|noter|declare|declarer)\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'declarer_transmission';
  // PR-05 — relance d'un DEVIS envoyé resté sans réponse (« relance le devis Durand ») :
  // AVANT envoyer_devis (« devis … client » y collisionne), nouveau_devis (« un devis ») et
  // la relance de facture. Négation ⇒ rien.
  if (
    /\brelanc\w*\b/.test(normalizedMessage) &&
    /\bdevis\b/.test(normalizedMessage) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\brelanc\w*\b|\brelanc\w*\b.{0,30}\bpas\b/.test(normalizedMessage)
  )
    return 'relance_devis';
  if (/(envoi|envoie|envoyer|transmets|exp[ée]die).*(devis)|devis.*(client|signature|envoi|envoyer|transmettre)/.test(m))
    return 'envoyer_devis';
  // PR-01 — envoi EMAIL réel d'une facture ÉMISE (« envoie la facture 2026-014 à Durand ») :
  // AVANT emettre_facture (« facture » y collisionne). Les devis et les relances restent
  // exclus (chacun a son intent) ; négation ⇒ rien.
  if (
    (/\b(envoi|envoie|envoies|envoyer|renvoie|renvoyer|transmets|transmettre|expedie|expedier)\b.{0,40}\bfactures?\b/.test(
      normalizedMessage,
    ) ||
      /\bfactures?\b.{0,30}\b(au client|par e?-?mail|par courriel)\b/.test(normalizedMessage)) &&
    !/\bdevis\b/.test(normalizedMessage) &&
    !/\brelanc/.test(normalizedMessage) &&
    !/\b(ne|n|pas|jamais|surtout pas)\b.{0,24}\b(envoi|envoie|envoyer|renvoie|transmets|expedie)\w*\b|\b(envoie|envoyer|renvoie|transmets|expedie)\w*\b.{0,30}\bpas\b/.test(
      normalizedMessage,
    )
  )
    return 'envoyer_facture';
  if (/([ée]met|emet|num[ée]rote|finalise|publie).*(facture)|facture.*([ée]mettre|emettre|d[ée]finitive|num[ée]ro)/.test(m))
    return 'emettre_facture';
  // Générer la facture d'un devis signé (ASK-2) : AVANT nouveau_devis (« fais la facture du
  // devis » y collisionnerait) et distinct d'emettre_facture (émettre = numéroter un brouillon).
  if (/(g[ée]n[èe]re.{0,15}facture|facture?.{0,10}(du|le|ce) devis|fais.{0,12}facture.{0,15}devis|facture d.acompte|facture (finale|de solde)|facture[rz]? l.acompte)/.test(m))
    return 'generer_facture';
  if (/(nouveau devis|fais.*devis|cr[ée]e?r?.*devis|faire un devis|un devis|chiffrer)/.test(m)) return 'nouveau_devis';
  if (/chantier/.test(m)) return 'voir_chantiers';
  // Catalogue de prestations (C27) : AVANT documents (« mes prestations » ne doit jamais
  // retomber sur la liste de pièces archivées).
  if (/(catalogue|mes prestations)/.test(m)) return 'voir_catalogue';
  if (/(document|pi[èe]ce|archive|pdf|factur-?x|justificatif|re[çc]u|ticket)/.test(m)) return 'documents';
  if (/(liste|mes factures|factures impay|reste (à|a) encaisser|à encaisser)/.test(m)) return 'factures';
  if (/(relanc|rappel|en retard|impay)/.test(m)) return 'relance';
  if (/(verser|me paye|me payer|combien|salaire)/.test(m)) return 'payout';
  return 'unknown';
}

/** Extrait une référence de facture (numéro type 2026-014) du message, sinon null. */
export function extractReference(message: string): string | null {
  const num = message.match(/\d{3,}(?:-\d+)?/);
  if (num) return num[0];
  const alias = /\bE(\d{1,2})\b/i.exec(message);
  if (alias) return `E${Number(alias[1])}`;
  const normalizedMessage = normalizeIntent(message);
  // Un ordinal ne cible que s'il est ANAPHORIQUE : adjacent au type visé (« la deuxième
  // facture ») ou quasi seul (« le deuxième »). « Encaisse la facture de Second Œuvre » ne
  // doit JAMAIS devenir ordinal:2 — le nom prime (hijack vague 4, repro contre-review).
  const TYPE_NOUN = '(facture|devis|client|notification|depense|document|chantier|ligne|ecriture|element|resultat)';
  const ORDINAL_WORD = '(premier|premiere|second|seconde|deuxieme|troisieme|quatrieme|cinquieme|sixieme|septieme|huitieme|neuvieme|dixieme|\\d{1,2}(?:er|ere|e|eme))';
  const ORDINAL_VALUE: Readonly<Record<string, number>> = {
    premier: 1, premiere: 1, second: 2, seconde: 2, deuxieme: 2, troisieme: 3, quatrieme: 4,
    cinquieme: 5, sixieme: 6, septieme: 7, huitieme: 8, neuvieme: 9, dixieme: 10,
  };
  const toOrdinal = (word: string): number => {
    const numeric = /^(\d{1,2})/.exec(word);
    return numeric?.[1] !== undefined ? Number(numeric[1]) : (ORDINAL_VALUE[word] ?? 0);
  };
  const typedOrdinal = new RegExp(`\\b(?:l[ae] |la |le )?${ORDINAL_WORD} ${TYPE_NOUN}\\b`).exec(normalizedMessage);
  if (typedOrdinal?.[1] !== undefined) {
    const n = toOrdinal(typedOrdinal[1]);
    if (n > 0) return `ordinal:${n}`;
  }
  // Ordinal quasi seul (« ouvre le deuxième ») : aucun autre mot significatif qui pourrait
  // être un NOM (client/pièce) — sinon le nom prime et l'ordinal est ignoré.
  const bareOrdinal = new RegExp(`\\b${ORDINAL_WORD}\\b`).exec(normalizedMessage);
  if (bareOrdinal?.[1] !== undefined) {
    const stripped = normalizedMessage
      .replace(new RegExp(`\\b${ORDINAL_WORD}\\b`, 'g'), ' ')
      .replace(/\b(ouvre|montre|affiche|resume|encaisse|relance|envoie|emets?|lis|amene|va|vas|aller|passe|sur|vers|dans|page|ecran|numero|le|la|les|l|de|du|des|un|une|moi|s il te plait|resultat|element)\b/g, ' ')
      .replace(new RegExp(`\\b${TYPE_NOUN}\\b`, 'g'), ' ')
      .replace(/[^a-z]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    if (stripped.length === 0) {
      const n = toOrdinal(bareOrdinal[1]);
      if (n > 0) return `ordinal:${n}`;
    }
    return null;
  }
  return null;
}
