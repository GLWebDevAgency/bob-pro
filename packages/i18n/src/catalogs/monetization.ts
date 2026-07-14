type Copy = Readonly<Record<'pote' | 'pro' | 'direct', string>>;

const same = (value: string): Copy => ({ pote: value, pro: value, direct: value });

/**
 * Voix du système de monétisation (SPEC_PILIER2_MONETISATION.md) — paywall contextuel,
 * essai inversé, digest de valeur, win-back. Doctrine copy : CONCRET (des € et des heures,
 * jamais du marketing), un seul CTA, le « non » toujours facile. Interpolations : {amount}
 * (déjà formaté €), {days}, {feature}, {tier}, {price}, {delta}, {minutes}, {count}.
 */
export const monetizationFr = {
  // ── Paywall contextuel ──
  'paywall.title': {
    pote: 'On passe à la vitesse au-dessus ?',
    pro: 'Cette fonction fait partie de l’offre {tier}',
    direct: 'Fonction de l’offre {tier}',
  },
  'paywall.liveTeaser': {
    pote: 'Bob Live, c’est moi en direct : tu parles, je crée tes devis pendant que tu conduis. Ça fait partie de l’offre {tier}.',
    pro: 'Bob Live — la conversation vocale en temps réel — est inclus à partir de l’offre {tier}.',
    direct: 'Bob Live est inclus dans l’offre {tier}.',
  },
  'paywall.deltaAnchor': {
    pote: 'Ça fait {delta} de plus par mois, et je m’occupe du reste.',
    pro: 'Soit {delta} de plus par mois par rapport à ton offre actuelle.',
    direct: '+{delta}/mois.',
  },
  'paywall.upgradeCta': {
    pote: 'Passer à {tier} — {price}/mois',
    pro: 'Passer à l’offre {tier} ({price}/mois)',
    direct: '{tier} — {price}/mois',
  },
  'paywall.annualHint': same('{price}/mois en payant à l’année — environ 2 mois offerts.'),
  'paywall.dismiss': {
    pote: 'Pas maintenant',
    pro: 'Plus tard',
    direct: 'Non',
  },
  'paywall.dismissPromise': same('Si tu refuses deux fois, je ne t’en reparle pas pendant 14 jours.'),
  'paywall.pastDueTitle': {
    pote: 'Petit souci de paiement à régler d’abord',
    pro: 'Un paiement n’a pas abouti',
    direct: 'Paiement en échec',
  },
  'paywall.pastDueCta': {
    pote: 'Régler ça dans mon compte',
    pro: 'Régulariser mon paiement',
    direct: 'Régulariser',
  },
  'paywall.pastDueBody': same(
    'Ton dernier règlement n’est pas passé. Régularise quand tu peux — tes données et tes documents restent intacts, et rien ne t’est facturé en double.',
  ),
  'paywall.addonCta': {
    pote: 'Ajouter {feature} — {price}/mois',
    pro: 'Activer l’option {feature} ({price}/mois)',
    direct: '{feature} — {price}/mois',
  },
  'paywall.quotaTitle': {
    pote: 'Tu as bien bossé ce mois-ci !',
    pro: 'Quota mensuel atteint',
    direct: 'Quota atteint',
  },
  'paywall.quotaBody': same(
    'Tes {count} actions incluses ce mois-ci sont utilisées. Tes factures et exports restent toujours disponibles — la conformité n’est jamais bloquée.',
  ),

  // ── Essai inversé (reverse trial) ──
  'trial.badge': same('Essai Pro — {days} j restants'),
  'trial.started': {
    pote: 'Pendant 14 jours tu as tout Bob Pro, sans carte, sans piège. Profite, on fait les comptes à la fin.',
    pro: 'Tu disposes de l’offre Pro complète pendant 14 jours, sans carte bancaire.',
    direct: '14 jours d’offre Pro, sans carte.',
  },
  'trial.endingSoon': {
    pote: 'Plus que {days} jours d’essai. Pas de panique : quoi qu’il arrive, tes documents restent à toi.',
    pro: 'Ton essai se termine dans {days} jours. Tes données restent accessibles quelle que soit ta décision.',
    direct: 'Essai : {days} jours restants.',
  },
  'trial.reportTitle': same('Ce que Bob a fait pour toi en 14 jours'),
  'trial.reportRecommendation': {
    pote: 'Vu ton usage, l’offre {tier} te suffit largement. C’est celle que je te conseille.',
    pro: 'Au vu de ton usage réel, l’offre {tier} correspond à ton besoin.',
    direct: 'Recommandation d’après ton usage : {tier}.',
  },
  'trial.reportStayFree': same('Rester en Découverte (gratuit) — tes documents et ta facturation conforme restent disponibles.'),

  // ── Digest de valeur (« le lundi de Bob ») ──
  'digest.title': same('Ta semaine avec Bob'),
  'digest.moneyRecovered': {
    pote: '{amount} récupérés sur tes impayés grâce aux relances. Pas mal, non ?',
    pro: '{amount} encaissés sur des factures en retard, suite aux relances.',
    direct: '{amount} d’impayés récupérés.',
  },
  'digest.moneyCollected': {
    pote: '{amount} encaissés cette semaine. Ça, c’est fait.',
    pro: '{amount} encaissés sur la période.',
    direct: '{amount} encaissés.',
  },
  'digest.timeSaved': {
    pote: 'Environ {minutes} min d’administratif en moins cette semaine. Offre-toi un vrai café.',
    pro: 'Environ {minutes} minutes de gestion administrative économisées.',
    direct: '≈{minutes} min d’admin en moins.',
  },
  'digest.volume': same('{count} documents créés cette semaine.'),
  'digest.volumeOne': same('1 document créé cette semaine.'),
  'digest.estimateNote': same('Le temps gagné est une estimation ; les montants sont tes chiffres réels.'),
  'digest.openMoneyHint': same('Ouvre le détail dans Argent.'),

  // ── Win-back (valeur dormante) ──
  'winback.expiringQuote': {
    pote: 'Ton devis « {feature} » de {amount} expire bientôt. Un mot et je relance ton client.',
    pro: 'Le devis « {feature} » ({amount}) arrive à expiration. Souhaites-tu relancer le client ?',
    direct: 'Devis « {feature} » ({amount}) : expiration proche.',
  },
  'winback.overdueInvoice': {
    pote: '{amount} t’attendent toujours sur « {feature} ». Je peux préparer la relance.',
    pro: 'La facture « {feature} » présente {amount} impayés. Une relance peut être préparée.',
    direct: '{amount} impayés sur « {feature} ».',
  },

  // ── Changement d'offre (diff honnête) ──
  'planDiff.gains': same('Ce que tu gagnes'),
  'planDiff.losses': same('Ce que tu perds'),
  'planDiff.noChange': same('Aucun changement de fonctions entre ces deux offres.'),
  'planDiff.savings': {
    pote: 'Tu économises {amount}/mois. Et c’est très bien comme ça.',
    pro: 'Tu économises {amount} par mois.',
    direct: '−{amount}/mois.',
  },
  'planDiff.downgradeEffective': same('Le changement prend effet à la fin de ta période déjà payée — rien n’est perdu avant.'),

  // ── Usage honnête ──
  'usage.aiActions': same('{count} actions Bob utilisées sur {total} ce mois-ci'),
  'usage.liveMinutes': same('{minutes} min de Bob Live ce mois-ci — incluses dans ton offre'),
  'usage.almostThere': {
    pote: 'Plus que {count} actions ce mois-ci — je te préviens avant, pas de coupure surprise.',
    pro: 'Il te reste {count} actions ce mois-ci. Tu seras prévenu avant toute limite.',
    direct: '{count} actions restantes ce mois-ci.',
  },
} as const satisfies Record<string, Copy>;
