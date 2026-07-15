type Copy = Readonly<Record<'pote' | 'pro' | 'direct', string>>;

/**
 * Voix du PROFIL FISCAL (SPEC_EXPERT_FISCAL.md §UX FLOW, Phase 1B). Doctrine copy héritée du
 * quick-win ⓪ : jamais « rémunération exacte » ni « 3 questions » (amendement GPT 1) — toujours
 * « affiner ton estimation » / « quelques infos ». Chaque somme reste incertaine tant que le
 * profil ne la confirme pas — le ton reste prudent, jamais affirmatif à la place de l'utilisateur.
 * Interpolations : {label} (libellé forme/régime), {date}, {count}.
 */
export const fiscalFr = {
  // ── Entrée Argent (carte douce, amendement 1/2) ──────────────────────────────
  'fiscal.entry.title': {
    pote: 'Affine ton estimation',
    pro: 'Affiner votre estimation',
    direct: 'Affiner l’estimation',
  },
  'fiscal.entry.body': {
    pote: 'Quelques infos sur ton statut, et je deviens plus précis sur ta rémunération.',
    pro: 'Quelques informations sur votre statut affinent l’estimation de rémunération.',
    direct: 'Quelques infos sur ton statut → estimation plus précise.',
  },

  // ── Badge Home (amendement 2 : pas de 2ᵉ carte, une simple pastille) ─────────
  'fiscal.badge.label': {
    pote: 'estimation prudente',
    pro: 'Estimation prudente',
    direct: 'estimation prudente',
  },
  'fiscal.badge.accessibilityHint': {
    pote: 'Affiner l’estimation avec quelques infos sur ton statut.',
    pro: 'Affiner l’estimation avec quelques informations sur votre statut.',
    direct: 'Affiner l’estimation.',
  },

  // ── Chrome du mini-flow ───────────────────────────────────────────────────────
  'fiscal.flow.title': {
    pote: 'Ton profil fiscal',
    pro: 'Votre profil fiscal',
    direct: 'Profil fiscal',
  },
  'fiscal.flow.progress': {
    pote: 'Encore {count} infos',
    pro: 'Encore {count} informations',
    direct: '{count} infos restantes',
  },
  'fiscal.flow.progressOne': {
    pote: 'Encore une info',
    pro: 'Encore une information',
    direct: '1 info restante',
  },
  'fiscal.flow.later': {
    pote: 'Plus tard',
    pro: 'Plus tard',
    direct: 'Plus tard',
  },
  'fiscal.flow.laterAccessibilityHint': {
    pote: 'Ferme sans rien enregistrer — Bob reste prudent sur ce point.',
    pro: 'Ferme sans rien enregistrer — Bob reste prudent sur ce point.',
    direct: 'Ferme sans enregistrer.',
  },
  'fiscal.flow.laterConsequence': {
    pote: 'Ok, je reste prudent sur ta rémunération tant que c’est pas confirmé.',
    pro: 'Bob reste prudent sur votre rémunération tant que ce point n’est pas confirmé.',
    direct: 'Bob reste prudent tant que non confirmé.',
  },
  'fiscal.flow.close': {
    pote: 'Fermer',
    pro: 'Fermer',
    direct: 'Fermer',
  },
  'fiscal.flow.done': {
    pote: 'Merci ! Je m’en sers pour affiner ta rémunération.',
    pro: 'Merci — ces informations affinent l’estimation de rémunération.',
    direct: 'Enregistré. Estimation affinée.',
  },
  'fiscal.flow.confirmedAnnounce': {
    pote: 'Confirmé.',
    pro: 'Confirmé.',
    direct: 'Confirmé.',
  },

  // ── Étape « couple forme + régime » ──────────────────────────────────────────
  'fiscal.step.legalRegime.header': {
    pote: 'Ta forme',
    pro: 'Votre forme juridique',
    direct: 'Forme',
  },
  'fiscal.step.legalRegime.hypothesisQuestion': {
    pote: 'D’après ton SIRET, tu serais en {label} — c’est bien ça ?',
    pro: 'D’après votre SIRET, vous seriez en {label} — est-ce exact ?',
    direct: 'D’après ton SIRET : {label}. Exact ?',
  },
  'fiscal.step.legalRegime.yes': {
    pote: 'Oui, c’est ça',
    pro: 'Oui, c’est exact',
    direct: 'Oui',
  },
  'fiscal.step.legalRegime.no': {
    pote: 'Non, corriger',
    pro: 'Non, corriger',
    direct: 'Corriger',
  },
  'fiscal.step.legalRegime.correctionHeader': {
    pote: 'Forme & régime',
    pro: 'Forme et régime',
    direct: 'Forme & régime',
  },
  'fiscal.step.legalRegime.correctionQuestion': {
    pote: 'Quelle est ta situation ?',
    pro: 'Quelle est votre situation ?',
    direct: 'Ta situation ?',
  },

  // Combinaisons forme+régime (7, LEGAL_REGIME_COMBOS) — label court + description.
  'fiscal.combo.micro.label': { pote: 'Micro-entreprise', pro: 'Micro-entreprise', direct: 'Micro-entreprise' },
  'fiscal.combo.micro.desc': {
    pote: 'Cotisations calculées sur ce que t’encaisses, compta simplifiée.',
    pro: 'Cotisations calculées sur l’encaissé, comptabilité simplifiée.',
    direct: 'Cotisations sur l’encaissé. Compta simplifiée.',
  },
  'fiscal.combo.ei_reel.label': { pote: 'Entreprise individuelle, au réel', pro: 'Entreprise individuelle, au réel', direct: 'EI au réel' },
  'fiscal.combo.ei_reel.desc': {
    pote: 'EI hors micro : cotisations sur le bénéfice réel, compta complète.',
    pro: 'EI hors micro : cotisations sur le bénéfice réel, comptabilité complète.',
    direct: 'Cotisations sur le bénéfice réel.',
  },
  'fiscal.combo.eurl_ir.label': { pote: 'EURL, à l’impôt sur le revenu', pro: 'EURL, à l’impôt sur le revenu', direct: 'EURL à l’IR' },
  'fiscal.combo.eurl_ir.desc': {
    pote: 'Gérant associé unique, le bénéfice est imposé directement à ton nom.',
    pro: 'Gérant associé unique, le bénéfice est imposé directement à votre nom.',
    direct: 'Bénéfice imposé à ton nom.',
  },
  'fiscal.combo.eurl_is.label': { pote: 'EURL, à l’impôt sur les sociétés', pro: 'EURL, à l’impôt sur les sociétés', direct: 'EURL à l’IS' },
  'fiscal.combo.eurl_is.desc': {
    pote: 'Gérant associé unique, la société paie l’impôt, toi un salaire.',
    pro: 'Gérant associé unique, la société paie l’impôt sur les sociétés, vous un salaire.',
    direct: 'La société paie l’IS, toi un salaire.',
  },
  'fiscal.combo.sasu.label': { pote: 'SASU', pro: 'SASU', direct: 'SASU' },
  'fiscal.combo.sasu.desc': {
    pote: 'Président assimilé salarié, la société paie l’impôt sur les sociétés.',
    pro: 'Président assimilé salarié, la société est soumise à l’impôt sur les sociétés.',
    direct: 'Assimilé salarié. Société à l’IS.',
  },
  'fiscal.combo.sarl.label': { pote: 'SARL', pro: 'SARL', direct: 'SARL' },
  'fiscal.combo.sarl.desc': {
    pote: 'Plusieurs associés, le statut du gérant reste à préciser séparément.',
    pro: 'Plusieurs associés, le statut social du gérant reste à préciser séparément.',
    direct: 'Statut du gérant à préciser à part.',
  },
  'fiscal.combo.sas.label': { pote: 'SAS', pro: 'SAS', direct: 'SAS' },
  'fiscal.combo.sas.desc': {
    pote: 'Plusieurs associés, président assimilé salarié.',
    pro: 'Plusieurs associés, président assimilé salarié.',
    direct: 'Plusieurs associés. Assimilé salarié.',
  },

  // ── Étape « activité » ────────────────────────────────────────────────────────
  'fiscal.step.activity.header': {
    pote: 'Ton activité',
    pro: 'Votre activité',
    direct: 'Activité',
  },
  'fiscal.step.activity.question': {
    pote: 'C’est quoi la nature de ton activité ?',
    pro: 'Quelle est la nature de votre activité ?',
    direct: 'Nature de l’activité ?',
  },
  'fiscal.activity.bic_vente.label': { pote: 'Vente de marchandises', pro: 'Vente de marchandises', direct: 'Vente' },
  'fiscal.activity.bic_vente.desc': {
    pote: 'Achat-revente d’objets, fournitures, denrées.',
    pro: 'Achat-revente d’objets, de fournitures ou de denrées.',
    direct: 'Achat-revente.',
  },
  'fiscal.activity.bic_service.label': { pote: 'Prestations de service', pro: 'Prestations de service', direct: 'Services' },
  'fiscal.activity.bic_service.desc': {
    pote: 'Artisan ou commerçant, tu factures ton travail.',
    pro: 'Artisan ou commerçant, vous facturez votre travail.',
    direct: 'Artisan/commerçant, facturation du travail.',
  },
  'fiscal.activity.bnc.label': { pote: 'Activité libérale', pro: 'Activité libérale', direct: 'Libéral' },
  'fiscal.activity.bnc.desc': {
    pote: 'BNC non réglementé — conseil, création, etc.',
    pro: 'BNC non réglementé (conseil, création…).',
    direct: 'BNC non réglementé.',
  },
  'fiscal.activity.bnc_cipav.label': { pote: 'Profession libérale réglementée', pro: 'Profession libérale réglementée', direct: 'Libéral réglementé' },
  'fiscal.activity.bnc_cipav.desc': {
    pote: 'Rattachée à la Cipav — architecte, ostéopathe…',
    pro: 'Rattachée à la Cipav (architecte, ostéopathe…).',
    direct: 'Rattaché Cipav.',
  },
  'fiscal.activity.mixte.label': { pote: 'Mixte', pro: 'Mixte', direct: 'Mixte' },
  'fiscal.activity.mixte.desc': {
    pote: 'Vente et prestations de service à la fois.',
    pro: 'Vente et prestations de service à la fois.',
    direct: 'Vente + services.',
  },

  // ── Étape « ACRE » ────────────────────────────────────────────────────────────
  'fiscal.step.acre.header': {
    pote: 'L’ACRE',
    pro: 'L’ACRE',
    direct: 'ACRE',
  },
  'fiscal.step.acre.question': {
    pote: 'T’as l’ACRE (l’aide à la création d’entreprise) ?',
    pro: 'Bénéficiez-vous de l’ACRE (aide à la création d’entreprise) ?',
    direct: 'ACRE ?',
  },
  'fiscal.step.acre.yes': {
    pote: 'Oui, j’ai l’ACRE',
    pro: 'Oui, j’en bénéficie',
    direct: 'Oui',
  },
  'fiscal.step.acre.no': {
    pote: 'Non, pas d’ACRE',
    pro: 'Non, pas d’ACRE',
    direct: 'Non',
  },
  'fiscal.step.acre.dateQuestion': {
    pote: 'Depuis quel mois ?',
    pro: 'Depuis quel mois ?',
    direct: 'Depuis quand ?',
  },
  'fiscal.step.acre.dateHint': {
    pote: 'La date de début fixe le taux réduit de tes cotisations.',
    pro: 'La date de début fixe le taux réduit de vos cotisations.',
    direct: 'Fixe le taux réduit.',
  },
  'fiscal.step.acre.confirmDate': {
    pote: 'Confirmer cette date',
    pro: 'Confirmer cette date',
    direct: 'Confirmer',
  },

  // ── Étape « versement libératoire » ──────────────────────────────────────────
  'fiscal.step.vl.header': {
    pote: 'Versement libératoire',
    pro: 'Versement libératoire',
    direct: 'Versement libératoire',
  },
  'fiscal.step.vl.question': {
    pote: 'T’as opté pour le versement libératoire de l’impôt sur le revenu ?',
    pro: 'Avez-vous opté pour le versement libératoire de l’impôt sur le revenu ?',
    direct: 'Versement libératoire actif ?',
  },
  'fiscal.step.vl.yes': {
    pote: 'Oui, j’ai opté',
    pro: 'Oui',
    direct: 'Oui',
  },
  'fiscal.step.vl.no': {
    pote: 'Non',
    pro: 'Non',
    direct: 'Non',
  },
  'fiscal.step.vl.helper': {
    pote: 'Optionnel : l’impôt est prélevé en même temps que tes cotisations, à taux fixe.',
    pro: 'Optionnel : l’impôt est prélevé avec vos cotisations, à taux fixe.',
    direct: 'Optionnel. Taux fixe, prélevé avec les cotisations.',
  },

  // ── Étape « TVA » ─────────────────────────────────────────────────────────────
  'fiscal.step.vat.header': {
    pote: 'TVA',
    pro: 'TVA',
    direct: 'TVA',
  },
  'fiscal.step.vat.question': {
    pote: 'C’est quoi ton régime de TVA ?',
    pro: 'Quel est votre régime de TVA ?',
    direct: 'Régime de TVA ?',
  },
  'fiscal.vat.franchise.label': { pote: 'Franchise en base', pro: 'Franchise en base', direct: 'Franchise' },
  'fiscal.vat.franchise.desc': {
    pote: 'Pas de TVA facturée tant que tu restes sous les seuils.',
    pro: 'Pas de TVA facturée tant que vous restez sous les seuils.',
    direct: 'Aucune TVA facturée sous seuils.',
  },
  'fiscal.vat.reel_simplifie.label': { pote: 'Réel simplifié', pro: 'Réel simplifié', direct: 'Réel simplifié' },
  'fiscal.vat.reel_simplifie.desc': {
    pote: 'TVA facturée, déclaration annuelle avec deux acomptes.',
    pro: 'TVA facturée, déclaration annuelle avec acomptes.',
    direct: 'TVA facturée. Déclaration annuelle.',
  },
  'fiscal.vat.reel_normal.label': { pote: 'Réel normal', pro: 'Réel normal', direct: 'Réel normal' },
  'fiscal.vat.reel_normal.desc': {
    pote: 'TVA facturée, déclaration mensuelle ou trimestrielle.',
    pro: 'TVA facturée, déclaration mensuelle ou trimestrielle.',
    direct: 'TVA facturée. Déclaration mensuelle/trim.',
  },

  // ── Noms de champs (écran « Mon profil fiscal ») ─────────────────────────────
  'fiscal.field.legalForm': { pote: 'Forme juridique', pro: 'Forme juridique', direct: 'Forme juridique' },
  'fiscal.field.taxRegime': { pote: 'Régime fiscal', pro: 'Régime fiscal', direct: 'Régime fiscal' },
  'fiscal.field.socialStatus': { pote: 'Statut social', pro: 'Statut social', direct: 'Statut social' },
  'fiscal.field.activityNature': { pote: 'Nature d’activité', pro: 'Nature d’activité', direct: 'Activité' },
  'fiscal.field.vatRegime': { pote: 'Régime de TVA', pro: 'Régime de TVA', direct: 'TVA' },
  'fiscal.field.acre': { pote: 'ACRE', pro: 'ACRE', direct: 'ACRE' },
  'fiscal.field.versementLiberatoire': { pote: 'Versement libératoire', pro: 'Versement libératoire', direct: 'VL' },
  'fiscal.field.fiscalYearEnd': { pote: 'Clôture d’exercice', pro: 'Clôture d’exercice', direct: 'Clôture' },

  // Libellés valeur (régime fiscal / forme / statut social) réutilisés hors combo.
  'fiscal.taxRegime.micro': { pote: 'Micro', pro: 'Micro', direct: 'Micro' },
  'fiscal.taxRegime.reel_ir': { pote: 'Réel, à l’IR', pro: 'Réel, à l’IR', direct: 'Réel IR' },
  'fiscal.taxRegime.is': { pote: 'Impôt sur les sociétés', pro: 'Impôt sur les sociétés', direct: 'IS' },
  'fiscal.taxRegime.option_ir': { pote: 'IS, option IR', pro: 'IS, option IR', direct: 'IS option IR' },

  'fiscal.legalForm.EI': { pote: 'Entreprise individuelle', pro: 'Entreprise individuelle', direct: 'EI' },
  'fiscal.legalForm.EURL': { pote: 'EURL', pro: 'EURL', direct: 'EURL' },
  'fiscal.legalForm.SASU': { pote: 'SASU', pro: 'SASU', direct: 'SASU' },
  'fiscal.legalForm.SARL': { pote: 'SARL', pro: 'SARL', direct: 'SARL' },
  'fiscal.legalForm.SAS': { pote: 'SAS', pro: 'SAS', direct: 'SAS' },
  'fiscal.legalForm.micro': { pote: 'Micro-entreprise', pro: 'Micro-entreprise', direct: 'Micro-entreprise' },

  'fiscal.socialStatus.tns': { pote: 'Travailleur non salarié (TNS)', pro: 'Travailleur non salarié (TNS)', direct: 'TNS' },
  'fiscal.socialStatus.assimile_salarie': { pote: 'Assimilé salarié', pro: 'Assimilé salarié', direct: 'Assimilé salarié' },

  'fiscal.acreValue.grantedSince': {
    pote: 'Oui, depuis {date}',
    pro: 'Oui, depuis {date}',
    direct: 'Oui, {date}',
  },
  'fiscal.acreValue.granted': { pote: 'Oui', pro: 'Oui', direct: 'Oui' },
  'fiscal.acreValue.notGranted': { pote: 'Non', pro: 'Non', direct: 'Non' },
  'fiscal.boolValue.yes': { pote: 'Oui', pro: 'Oui', direct: 'Oui' },
  'fiscal.boolValue.no': { pote: 'Non', pro: 'Non', direct: 'Non' },
  'fiscal.yearEnd.civil': { pote: '31 décembre (année civile)', pro: '31 décembre (année civile)', direct: '31 décembre' },

  // ── Pastille de statut (amendement 6 : texte, jamais couleur seule) ──────────
  'fiscal.status.confirmed': { pote: 'Confirmé ✓', pro: 'Confirmé', direct: 'Confirmé' },
  'fiscal.status.toConfirm': { pote: 'À confirmer', pro: 'À confirmer', direct: 'À confirmer' },
  'fiscal.status.missing': { pote: 'Manquant', pro: 'Manquant', direct: 'Manquant' },

  'fiscal.source.insee': {
    pote: 'Source : ton SIRET · {date}',
    pro: 'Source : SIRET · {date}',
    direct: 'SIRET · {date}',
  },
  'fiscal.source.userConfirmed': {
    pote: 'Confirmé par toi · {date}',
    pro: 'Confirmé par vous · {date}',
    direct: 'Confirmé · {date}',
  },
  'fiscal.source.hypothesis': {
    pote: 'Hypothèse de Bob — à confirmer',
    pro: 'Hypothèse de Bob — à confirmer',
    direct: 'Hypothèse — à confirmer',
  },
  'fiscal.source.missingHint': {
    pote: 'Pas encore renseigné',
    pro: 'Pas encore renseigné',
    direct: 'Non renseigné',
  },

  // ── Écran « Mon profil fiscal » (Compte → écran dédié) ───────────────────────
  'fiscal.screen.eyebrow': { pote: 'Compte', pro: 'Compte', direct: 'Compte' },
  'fiscal.screen.title': { pote: 'Ton profil fiscal', pro: 'Votre profil fiscal', direct: 'Profil fiscal' },
  'fiscal.screen.subtitle': {
    pote: 'Ces infos affinent ta rémunération estimée — jamais partagées sans ton accord.',
    pro: 'Ces informations affinent l’estimation de rémunération — jamais partagées sans votre accord.',
    direct: 'Affine l’estimation de rémunération.',
  },
  'fiscal.screen.sectionInputs': {
    pote: 'Tes informations',
    pro: 'Vos informations',
    direct: 'Informations',
  },
  'fiscal.screen.completeCta': {
    pote: 'Compléter mon profil · encore {count}',
    pro: 'Compléter votre profil · encore {count}',
    direct: 'Compléter · {count} restantes',
  },
  'fiscal.screen.completeCtaOne': {
    pote: 'Compléter mon profil · encore 1',
    pro: 'Compléter votre profil · encore 1',
    direct: 'Compléter · 1 restante',
  },
  'fiscal.screen.allSet': {
    pote: 'Ton profil est complet, bravo.',
    pro: 'Votre profil est complet.',
    direct: 'Profil complet.',
  },
  'fiscal.screen.dataError': {
    pote: 'J’arrive pas à charger ton profil fiscal, là. On réessaie ?',
    pro: 'Impossible de charger le profil fiscal. Veuillez réessayer.',
    direct: 'Profil fiscal injoignable. Réessaie.',
  },
  'fiscal.screen.stale': {
    pote: 'T’es hors ligne — voici les dernières infos connues, peut-être plus à jour.',
    pro: 'Hors ligne — dernières informations connues, potentiellement obsolètes.',
    direct: 'Hors ligne. Données peut-être obsolètes.',
  },

  // ── Carte d’accès (Compte) ────────────────────────────────────────────────────
  'fiscal.account.row': { pote: 'Mon profil fiscal', pro: 'Mon profil fiscal', direct: 'Profil fiscal' },
  'fiscal.account.rowSubPending': {
    pote: 'Encore {count} infos à confirmer',
    pro: 'Encore {count} informations à confirmer',
    direct: '{count} infos à confirmer',
  },
  'fiscal.account.rowSubPendingOne': {
    pote: 'Encore une info à confirmer',
    pro: 'Encore une information à confirmer',
    direct: '1 info à confirmer',
  },
  'fiscal.account.rowSubComplete': {
    pote: 'À jour',
    pro: 'À jour',
    direct: 'À jour',
  },

  // ── Voix (parité stricte — proposition opaque + diff + confirmation, amendement 7) ──
  'fiscal.voice.confirmLegalRegime': {
    pote: 'J’ai compris : {label}. Je t’ouvre la confirmation.',
    pro: 'Compris : {label}. Voici la confirmation.',
    direct: 'Compris : {label}. Confirmation ouverte.',
  },
  'fiscal.voice.confirmAcreGranted': {
    pote: 'J’ai compris : t’as l’ACRE depuis {date}. Je t’ouvre la confirmation.',
    pro: 'Compris : ACRE depuis {date}. Voici la confirmation.',
    direct: 'Compris : ACRE depuis {date}. Confirmation ouverte.',
  },
  'fiscal.voice.confirmAcreGrantedNoDate': {
    pote: 'J’ai compris : t’as l’ACRE. Je t’ouvre la confirmation.',
    pro: 'Compris : vous avez l’ACRE. Voici la confirmation.',
    direct: 'Compris : ACRE. Confirmation ouverte.',
  },
  'fiscal.voice.confirmAcreNotGranted': {
    pote: 'J’ai compris : pas d’ACRE. Je t’ouvre la confirmation.',
    pro: 'Compris : pas d’ACRE. Voici la confirmation.',
    direct: 'Compris : pas d’ACRE. Confirmation ouverte.',
  },
  'fiscal.voice.confirmVlYes': {
    pote: 'J’ai compris : versement libératoire activé. Je t’ouvre la confirmation.',
    pro: 'Compris : versement libératoire activé. Voici la confirmation.',
    direct: 'Compris : VL activé. Confirmation ouverte.',
  },
  'fiscal.voice.confirmVlNo': {
    pote: 'J’ai compris : pas de versement libératoire. Je t’ouvre la confirmation.',
    pro: 'Compris : pas de versement libératoire. Voici la confirmation.',
    direct: 'Compris : pas de VL. Confirmation ouverte.',
  },
  'fiscal.voice.proposalTitle': {
    pote: 'Bob propose',
    pro: 'Proposition de Bob',
    direct: 'Proposition',
  },
  'fiscal.voice.proposalConfirm': {
    pote: 'Confirmer',
    pro: 'Confirmer',
    direct: 'Confirmer',
  },
  'fiscal.voice.proposalCancel': {
    pote: 'Annuler',
    pro: 'Annuler',
    direct: 'Annuler',
  },
  'fiscal.voice.proposalBefore': { pote: 'Avant', pro: 'Avant', direct: 'Avant' },
  'fiscal.voice.proposalAfter': { pote: 'Après', pro: 'Après', direct: 'Après' },

  // ── Erreurs de mutation ────────────────────────────────────────────────────────
  'fiscal.mutation.error': {
    pote: 'Ça n’a pas pu être enregistré, là. Réessaie ?',
    pro: 'L’enregistrement a échoué. Veuillez réessayer.',
    direct: 'Échec de l’enregistrement. Réessaie.',
  },
} as const satisfies Record<string, Copy>;
