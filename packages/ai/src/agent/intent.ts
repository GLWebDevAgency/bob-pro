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
  | 'cloture' // préparer le mois pour le comptable (ouvre l'écran de clôture)
  | 'diagnostic' // « prêt pour 2026 ? » — ouvrir le diagnostic conformité (C40, TODO ⑦)
  | 'echeances' // échéances fiscales à venir (TVA/URSSAF/IS/CFE) — lecture, C-EXP5b
  | 'tva' // position de TVA réelle (collectée/déductible/à provisionner) — lecture, BOB-1
  | 'balance' // balance âgée : qui me doit quoi, depuis quand — lecture, BOB-1
  | 'marquer_notifications_lues' // batch atomique borné par cutoff serveur — mutation confirmée
  | 'payer_depense' // régler une dépense fournisseur (écriture 401/512) — mutation, BOB-1/E4
  | 'resultat' // résultat provisoire (produits − charges du grand-livre) — lecture, BOB-2
  | 'bilan' // bilan simplifié actif/passif — lecture, BOB-4
  | 'revue_cloture' // « mon dossier est-il prêt pour le comptable ? » — verdict de revue, DOSSIER-2
  | 'pilotage' // revue de pilotage : CA facturé/encaissé, tendance, ratios — lecture, BA-3
  | 'dso' // « on me paie en combien de temps ? » — DSO 90 j + € immobilisés, BA-3
  | 'top_clients' // plus gros clients 12 mois + dépendance — lecture, BA-3
  | 'abonnement' // « où en est mon abonnement / mon essai ? » — lecture seule, pilier 2 (jamais d'achat vocal)
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
  // BOB-1 : régler une DÉPENSE/FOURNISSEUR — AVANT « encaisser » (« règle », « payé » collisionnent).
  if (/(pa[iy]e[rz]?|r[èe]gle[rz]?|solde[rz]?).*(d[ée]pense|fournisseur)|(d[ée]pense|fournisseur).*(pay[ée]|r[ée]gl)/.test(m))
    return 'payer_depense';
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
  if (/(scan|num[ée]ris|ticket|justificatif|note de frais|re[çc]u|photo.*(facture|ticket|d[ée]pense))/.test(m)) return 'scan';
  if (/(envoi|envoie|envoyer|transmets|exp[ée]die).*(devis)|devis.*(client|signature|envoi|envoyer|transmettre)/.test(m))
    return 'envoyer_devis';
  if (/([ée]met|emet|num[ée]rote|finalise|publie).*(facture)|facture.*([ée]mettre|emettre|d[ée]finitive|num[ée]ro)/.test(m))
    return 'emettre_facture';
  // Générer la facture d'un devis signé (ASK-2) : AVANT nouveau_devis (« fais la facture du
  // devis » y collisionnerait) et distinct d'emettre_facture (émettre = numéroter un brouillon).
  if (/(g[ée]n[èe]re.{0,15}facture|facture?.{0,10}(du|le|ce) devis|fais.{0,12}facture.{0,15}devis|facture d.acompte|facture (finale|de solde)|facture[rz]? l.acompte)/.test(m))
    return 'generer_facture';
  if (/(nouveau devis|fais.*devis|cr[ée]e?r?.*devis|faire un devis|un devis|chiffrer)/.test(m)) return 'nouveau_devis';
  if (/chantier/.test(m)) return 'voir_chantiers';
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
