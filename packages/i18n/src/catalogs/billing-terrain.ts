type Copy = Readonly<Record<'pote' | 'pro' | 'direct', string>>;

/**
 * Voix de la FACTURATION TERRAIN (épic B — AUDIT_INDISPENSABLES_V1 groupe B) :
 *  • B1 facture directe sans devis (dépannage urgent B2C qualifié, régie TJM, syndic/B2B) ;
 *  • B2 situations de travaux (avancement du marché, garde cumul serveur) ;
 *  • B3 remises (ligne et globale — mention L441-9 imprimée par le serveur) ;
 *  • B4 conditions de paiement par client (plafond légal L441-10 pour un débiteur pro) ;
 *  • B5 retenue de garantie 5 % (loi n° 71-584 du 16 juillet 1971) ;
 *  • canal de facturation (email | Chorus Pro | portail fournisseur) + guide de dépôt ;
 *  • garde-fou client professionnel étranger (B7 — module TVA intracom hors V1).
 * Doctrine LegalHint : l'in-line dit le BÉNÉFICE, la feuille explique (loi + pourquoi),
 * la source est citée telle quelle. Articles vérifiés sur Légifrance.
 */
export const billingTerrainFr = {
  // ── B1 — Facture directe (sans devis signé) ────────────────────────────────
  'fd.title': {
    pote: 'Nouvelle facture',
    pro: 'Nouvelle facture',
    direct: 'Nouvelle facture',
  },
  'fd.badge': {
    pote: 'Facture directe',
    pro: 'Facture directe',
    direct: 'Directe',
  },
  'fd.intro': {
    pote: 'Sans devis signé : dépannage urgent, régie au temps passé, syndic… Tu composes, tu émets, c’est réglé.',
    pro: 'Facture composée sans devis signé : dépannage urgent, régie au temps passé, syndics et donneurs d’ordre.',
    direct: 'Facture sans devis : dépannage, régie, syndic.',
  },
  'fd.stepClient': {
    pote: 'Client',
    pro: 'Client',
    direct: 'Client',
  },
  'fd.stepLines': {
    pote: 'Prestations',
    pro: 'Prestations',
    direct: 'Lignes',
  },
  'fd.stepRecap': {
    pote: 'Récap',
    pro: 'Récapitulatif',
    direct: 'Récap',
  },
  'fd.guardClient': {
    pote: 'Choisis d’abord le client à facturer.',
    pro: 'Sélectionnez le client à facturer avant de continuer.',
    direct: 'Client requis.',
  },
  'fd.guardLines': {
    pote: 'Ajoute au moins une prestation.',
    pro: 'Ajoutez au moins une prestation.',
    direct: 'Au moins une ligne.',
  },
  'fd.vatRequired': {
    pote: 'Confirme le taux de TVA avant de continuer.',
    pro: 'Confirmez le taux de TVA avant de continuer.',
    direct: 'TVA à confirmer.',
  },
  'fd.urgentQuestion': {
    pote: 'C’est un dépannage urgent chez un particulier, demandé par lui ?',
    pro: 'S’agit-il d’un dépannage urgent au domicile, expressément sollicité par le client ?',
    direct: 'Dépannage urgent demandé par le client ?',
  },
  'fd.urgentYes': {
    pote: 'Oui, dépannage urgent',
    pro: 'Oui — intervention urgente sollicitée',
    direct: 'Oui, urgent',
  },
  'fd.urgentNo': {
    pote: 'Non',
    pro: 'Non',
    direct: 'Non',
  },
  'fd.urgentRequiredBody': {
    pote: 'Pour un particulier, la facture directe n’existe que pour un dépannage urgent qu’il a demandé lui-même. Sinon, passe par un devis signé : c’est lui ton contrat.',
    pro: 'Pour un client particulier, la facture directe est réservée au dépannage urgent expressément sollicité. À défaut, établissez un devis signé — c’est le contrat.',
    direct: 'Particulier sans urgence = devis signé obligatoire.',
  },
  'legal.fdUrgent.inline': {
    pote: 'Le dépannage urgent te dispense du devis signé — la loi le prévoit noir sur blanc.',
    pro: 'Le dépannage urgent vous dispense du devis signé — l’exception est prévue par la loi.',
    direct: 'Urgence = dispense légale de devis.',
  },
  'legal.fdUrgent.law': {
    pote: 'Chez un particulier, les travaux d’entretien ou de réparation à faire en urgence, qu’il a demandés lui-même, échappent au formalisme habituel : pas de délai de rétractation pour ces travaux, et l’artisan peut facturer directement l’intervention.',
    pro: 'Chez un consommateur, les travaux d’entretien ou de réparation à réaliser en urgence, expressément sollicités par lui, sont exclus du droit de rétractation : l’intervention peut être facturée directement, sans devis signé préalable.',
    direct: 'Travaux urgents expressément demandés par le consommateur : pas de rétractation, facturation directe possible.',
  },
  'legal.fdUrgent.why': {
    pote: 'Bob trace la demande d’urgence sur la facture : si le client conteste plus tard, tu as la preuve que l’exception s’appliquait — jamais une facture attaquable.',
    pro: 'Bob trace la qualification d’urgence sur la pièce : en cas de contestation, la preuve de l’exception légale est conservée — la facture reste inattaquable.',
    direct: 'L’urgence est tracée sur la pièce : preuve en cas de contestation.',
  },
  'fd.recapTitle': {
    pote: 'On vérifie, et on crée',
    pro: 'Vérification avant création',
    direct: 'Vérifie. Crée.',
  },
  'fd.confirmTitle': {
    pote: 'Créer la facture',
    pro: 'Créer la facture',
    direct: 'Créer la facture',
  },
  'fd.confirmBody': {
    pote: 'Brouillon de facture pour {name} — {amount}. Tu pourras la relire avant de l’émettre.',
    pro: 'Un brouillon de facture sera créé pour {name} ({amount}). Vous pourrez le vérifier avant émission.',
    direct: 'Brouillon {amount} pour {name}. Émission ensuite.',
  },
  'fd.createCta': {
    pote: 'Créer la facture',
    pro: 'Créer la facture',
    direct: 'Créer',
  },
  'fd.createdToast': {
    pote: 'Brouillon créé — relis et émets quand tu veux.',
    pro: 'Brouillon créé. Vérifiez puis émettez la facture.',
    direct: 'Brouillon créé.',
  },
  'fd.entryVentes': {
    pote: 'Nouvelle facture',
    pro: 'Nouvelle facture',
    direct: 'Nouvelle',
  },
  // Tuile « Vite fait » de la Home : nommer le raccourci comme le flux réel (B1, facture SANS
  // devis signé) — « Facture » seul laissait croire qu'on facturait un devis. La tuile
  // QuickAction accepte 2 lignes (numberOfLines={2}), le libellé complet tient sans troncature.
  'today.quickInvoice': {
    pote: 'Facture directe',
    pro: 'Facture directe',
    direct: 'Facture directe',
  },

  // ── B7 — Garde-fou client professionnel étranger ───────────────────────────
  'fd.intlBlockedTitle': {
    pote: 'Client pro étranger : pas encore',
    pro: 'Client professionnel étranger : indisponible',
    direct: 'Pro étranger : bloqué',
  },
  'fd.intlBlockedBody': {
    pote: 'Facturer un pro étranger, c’est de l’autoliquidation UE ou de l’exonération export — pas une TVA française. Bob préfère te bloquer ici que te faire émettre une facture fausse.',
    pro: 'La facturation d’un professionnel étranger relève de l’autoliquidation intracommunautaire ou de l’exonération export — jamais d’une TVA française. Bob bloque plutôt que d’émettre une pièce fiscalement fausse.',
    direct: 'TVA intracom/export non gérée : blocage plutôt qu’une facture fausse.',
  },
  'legal.intl.inline': {
    pote: 'Bloqué exprès : une TVA française ici serait une facture fausse.',
    pro: 'Blocage volontaire : une TVA française serait ici fiscalement erronée.',
    direct: 'Bloqué : TVA française = facture fausse.',
  },
  'legal.intl.law': {
    pote: 'Pour un client professionnel établi à l’étranger, la TVA n’est en général pas due en France : c’est le client qui l’autoliquide dans son pays (UE), ou la vente est exonérée à l’export. Facturer une TVA française à la place est une erreur fiscale.',
    pro: 'Pour un preneur professionnel établi hors de France, la TVA n’est généralement pas due en France : le preneur l’autoliquide dans son État (UE) ou l’opération est exonérée à l’export. Facturer une TVA française serait fiscalement erroné.',
    direct: 'Preneur pro étranger : autoliquidation UE ou exonération export — pas de TVA française.',
  },
  'legal.intl.why': {
    pote: 'Le module TVA intracom arrive. En attendant, Bob te bloque honnêtement plutôt que de te laisser émettre une pièce fausse que ton comptable devra rattraper.',
    pro: 'Le module TVA intracommunautaire arrive dans une prochaine version. Dans l’intervalle, Bob bloque honnêtement plutôt que de produire une pièce à régulariser.',
    direct: 'Module intracom à venir. En attendant : blocage honnête.',
  },

  // ── B3 — Remises (ligne et globale) ────────────────────────────────────────
  'discount.lineLabel': {
    pote: 'Remise',
    pro: 'Remise',
    direct: 'Remise',
  },
  'discount.linePlaceholder': {
    pote: '0',
    pro: '0',
    direct: '0',
  },
  'discount.typePercent': {
    pote: '%',
    pro: '%',
    direct: '%',
  },
  'discount.typeAmount': {
    pote: '€',
    pro: '€',
    direct: '€',
  },
  'discount.globalTitle': {
    pote: 'Remise globale',
    pro: 'Remise globale',
    direct: 'Remise globale',
  },
  'discount.globalHint': {
    pote: '« Je t’arrondis à… » : la remise s’imprime sur la pièce, comme la loi le demande.',
    pro: 'La remise accordée est imprimée sur la pièce, conformément à la loi.',
    direct: 'Remise imprimée sur la pièce (obligation légale).',
  },
  'discount.recapGross': {
    pote: 'Total HT avant remise',
    pro: 'Total HT avant remise',
    direct: 'HT avant remise',
  },
  'discount.recapSaved': {
    pote: 'Remise accordée',
    pro: 'Remise accordée',
    direct: 'Remise',
  },
  'discount.invalid': {
    pote: 'Cette remise ne passe pas : vérifie le montant (elle ne peut pas dépasser la base).',
    pro: 'Remise invalide : le montant ne peut pas excéder la base remisée.',
    direct: 'Remise > base : refusée.',
  },

  // ── B2 — Situations de travaux ─────────────────────────────────────────────
  'situation.action': {
    pote: 'Facturer une situation',
    pro: 'Facturer une situation',
    direct: 'Situation',
  },
  'situation.sheetTitle': {
    pote: 'Situation de travaux',
    pro: 'Situation de travaux',
    direct: 'Situation',
  },
  'situation.progressLabel': {
    pote: 'Avancement facturé de ce marché',
    pro: 'Avancement facturé du marché',
    direct: 'Déjà facturé',
  },
  'situation.alreadyInvoiced': {
    pote: 'Déjà facturé : {amount} ({pct} %)',
    pro: 'Déjà facturé : {amount} ({pct} %)',
    direct: 'Facturé : {amount} ({pct} %)',
  },
  'situation.remaining': {
    pote: 'Reste facturable : {amount}',
    pro: 'Reste facturable : {amount}',
    direct: 'Reste : {amount}',
  },
  'situation.pctLabel': {
    pote: 'Cette situation : {pct} % du marché',
    pro: 'Cette situation : {pct} % du marché',
    direct: '{pct} % du marché',
  },
  'situation.amountDerived': {
    pote: 'Montant HT de la situation',
    pro: 'Montant HT de la situation',
    direct: 'HT situation',
  },
  'situation.confirmCta': {
    pote: 'Facturer {amount}',
    pro: 'Facturer {amount}',
    direct: 'Facturer {amount}',
  },
  'situation.confirmTitle': {
    pote: 'Facturer une situation',
    pro: 'Facturer une situation',
    direct: 'Situation',
  },
  'situation.confirmBody': {
    pote: 'Situation de {pct} % ({amount} HT) sur le devis {number}. Un brouillon se crée, tu l’émets après relecture.',
    pro: 'Situation de {pct} % ({amount} HT) sur le devis {number}. Un brouillon sera créé, à émettre après vérification.',
    direct: '{pct} % — {amount} HT sur {number}. Brouillon créé.',
  },
  'situation.createdToast': {
    pote: 'Situation créée en brouillon — relis et émets.',
    pro: 'Situation créée en brouillon. Vérifiez puis émettez.',
    direct: 'Situation créée.',
  },
  'situation.overGuard': {
    pote: 'Au-delà du marché : le serveur refusera. Reste facturable : {amount}.',
    pro: 'Le cumul dépasserait le marché signé — le serveur refusera. Reste facturable : {amount}.',
    direct: 'Dépassement du marché. Reste : {amount}.',
  },
  'situation.noRemaining': {
    pote: 'Tout le marché est déjà facturé — rien à mettre en situation.',
    pro: 'Le marché est intégralement facturé : aucune situation possible.',
    direct: 'Marché facturé à 100 %.',
  },
  'situation.tasksTitle': {
    pote: 'Ou coche ce qui est terminé',
    pro: 'Ou sélectionnez les postes terminés',
    direct: 'Postes terminés',
  },
  'situation.tasksHint': {
    pote: 'Bob traduit tes postes cochés en % — c’est toujours toi qui décides du montant.',
    pro: 'Les postes cochés proposent un pourcentage d’avancement — le montant reste votre décision.',
    direct: 'Postes cochés → % proposé. Ajustable.',
  },
  'situation.tasksApplied': {
    pote: 'Postes cochés : {pct} % du marché — ajuste aux steppers si besoin.',
    pro: 'Postes sélectionnés : {pct} % du marché. Ajustable aux steppers.',
    direct: '{pct} % du marché.',
  },
  'situation.tasksAllBilled': {
    pote: 'Ces postes sont déjà couverts par ce qui est facturé — coche plus ou règle le % à la main.',
    pro: 'Les postes cochés sont déjà couverts par le facturé : élargissez la sélection ou réglez le pourcentage.',
    direct: 'Déjà couvert par le facturé.',
  },

  // ── Repli acompte professionnel (B2B/B2G — décision fondateur 25/07) ───────
  // L'acompte pro reste FERMÉ (professionalAdvanceRecoveryGuard, fail-closed : EN 16931/
  // Factur-X sans reprise d'avance fiable). Le repli propose l'équivalent CONFORME au moment
  // exact où l'artisan aurait cherché l'acompte : la situation n°1 — 30 % du marché par
  // défaut, TOUJOURS modifiable dans la feuille situation (steppers maîtres, cumul serveur).
  // HONNÊTETÉ : l'option et le CTA nomment une SITUATION — jamais « facture d'acompte » pour
  // la pièce créée (testé) ; « acompte » n'apparaît que pour dire l'équivalence ou la fermeture.
  'advanceFallback.option': {
    pote: 'Situation n°1 — {pct} % du marché',
    pro: 'Situation n°1 — {pct} % du marché',
    direct: 'Situation n°1 — {pct} %',
  },
  'advanceFallback.optionHint': {
    pote: 'Même encaissement que l’acompte prévu, en version conforme e-facture.',
    pro: 'Encaissement équivalent à l’acompte prévu, conforme à la facturation électronique.',
    direct: 'Encaissement équivalent, conforme.',
  },
  'advanceFallback.sheetTitle': {
    pote: 'Pas d’acompte pro — la situation fait pareil',
    pro: 'Acompte professionnel fermé — l’équivalent conforme',
    direct: 'Acompte pro fermé. Situation n°1.',
  },
  'advanceFallback.sheetBody': {
    pote: 'Client pro ou public : la facture d’acompte reste fermée, alors Bob te propose la situation n°1 — tu factures {pct} % du marché tout de suite, même encaissement, pièce conforme. Le pourcentage se règle avant de créer, et la facture finale déduira les situations émises.',
    pro: 'Pour un client professionnel ou public, la facture d’acompte reste fermée. La situation n°1 la remplace : {pct} % du marché facturés dès maintenant, encaissement identique, pièce conforme. Le pourcentage est réglable avant création, et la facture finale déduira les situations émises.',
    direct: 'Acompte pro fermé. Situation n°1 : {pct} % du marché, même encaissement, conforme. Pourcentage réglable ; la finale déduit les situations émises.',
  },
  'advanceFallback.confirm': {
    pote: 'Ouvrir la situation n°1 ({pct} %)',
    pro: 'Ouvrir la situation n°1 ({pct} %)',
    direct: 'Situation n°1 ({pct} %)',
  },
  'advanceFallback.cancel': {
    pote: 'Pas maintenant',
    pro: 'Pas maintenant',
    direct: 'Annuler',
  },
  'legal.advanceFallback.inline': {
    pote: 'Même argent encaissé, zéro donnée fiscale fausse — Bob te met sur le chemin conforme.',
    pro: 'Encaissement préservé, aucune donnée fiscale erronée : le chemin conforme est proposé d’office.',
    direct: 'Même encaissement, zéro donnée fausse.',
  },
  'legal.advanceFallback.law': {
    pote: 'Pour un client pro ou public, ta facture part en format électronique structuré (Factur-X, norme EN 16931). Ce format ne sait pas encore exprimer de façon fiable la reprise d’un acompte sur la facture finale — une facture qui déclare mal cette reprise transmet une donnée fiscale fausse à l’administration.',
    pro: 'Pour un client professionnel ou public, la facture est transmise en format électronique structuré (Factur-X, norme EN 16931). Ce format ne permet pas encore d’exprimer de manière fiable la reprise d’un acompte sur la facture finale : une pièce qui déclarerait mal cette reprise transmettrait une donnée fiscale erronée à l’administration.',
    direct: 'B2B/B2G = facture électronique structurée (Factur-X, EN 16931). La reprise d’acompte n’y est pas exprimable de façon fiable : la déclarer quand même = donnée fiscale fausse.',
  },
  'legal.advanceFallback.why': {
    pote: 'Bob refuse d’émettre une donnée fiscale fausse en ton nom. La situation de travaux facture une part du marché sans reprise à déclarer : tu encaisses pareil, et tes pièces restent justes et transmissibles.',
    pro: 'Bob refuse d’émettre une donnée fiscale erronée en votre nom. La situation de travaux facture une part du marché sans reprise d’acompte à déclarer : encaissement identique, pièces exactes et transmissibles.',
    direct: 'Bob n’émet pas de donnée fausse. La situation facture une part du marché sans reprise : encaissement identique, pièces justes.',
  },

  // ── B4 — Conditions de paiement par client ─────────────────────────────────
  'terms.sectionTitle': {
    pote: 'Conditions de paiement',
    pro: 'Conditions de paiement',
    direct: 'Paiement',
  },
  'terms.followsDefault': {
    pote: 'Ce client suit ton réglage société.',
    pro: 'Ce client suit le paramètre société par défaut.',
    direct: 'Défaut société.',
  },
  'terms.daysOnly': {
    pote: '{days} jours',
    pro: '{days} jours',
    direct: '{days} j',
  },
  'terms.daysEom': {
    pote: '{days} jours fin de mois',
    pro: '{days} jours fin de mois',
    direct: '{days} j fin de mois',
  },
  'terms.edit': {
    pote: 'Modifier',
    pro: 'Modifier',
    direct: 'Modifier',
  },
  'terms.sheetTitle': {
    pote: 'Conditions de paiement',
    pro: 'Conditions de paiement',
    direct: 'Conditions',
  },
  'terms.daysField': {
    pote: 'Délai (jours)',
    pro: 'Délai de paiement (jours)',
    direct: 'Jours',
  },
  'terms.eomToggle': {
    pote: 'Fin de mois',
    pro: 'Fin de mois',
    direct: 'Fin de mois',
  },
  'terms.eomHint': {
    pote: 'Le délai court, puis l’échéance saute à la fin du mois.',
    pro: 'Le délai s’applique, puis l’échéance est reportée à la fin du mois.',
    direct: 'Délai + report fin de mois.',
  },
  'terms.labelField': {
    pote: 'Libellé imprimé',
    pro: 'Libellé imprimé sur la facture',
    direct: 'Libellé',
  },
  'terms.saveError': {
    pote: 'J’ai pas réussi à enregistrer les conditions. Réessaie.',
    pro: 'L’enregistrement des conditions a échoué. Veuillez réessayer.',
    direct: 'Échec enregistrement. Réessaie.',
  },
  'terms.clear': {
    pote: 'Revenir au réglage société',
    pro: 'Revenir au paramètre société',
    direct: 'Défaut société',
  },
  'legal.terms.inline': {
    pote: 'Plafond légal pro : 60 jours, ou 45 jours fin de mois — Bob vérifie pour toi.',
    pro: 'Plafond légal (client professionnel) : 60 jours, ou 45 jours fin de mois — vérifié automatiquement.',
    direct: 'Plafond pro : 60 j ou 45 j fdm.',
  },
  'legal.terms.law': {
    pote: 'Entre professionnels, le délai de paiement convenu ne peut pas dépasser 60 jours après la facture — ou 45 jours fin de mois si le contrat le prévoit. Au-delà, c’est une clause illégale, passible d’amende administrative.',
    pro: 'Entre professionnels, le délai convenu ne peut excéder 60 jours à compter de la facture, ou 45 jours fin de mois si le contrat le stipule. Une clause au-delà est illégale et expose à une amende administrative.',
    direct: 'Débiteur pro : 60 j max après facture, ou 45 j fin de mois si stipulé. Au-delà : clause illégale.',
  },
  'legal.terms.why': {
    pote: 'Une échéance fausse déclenche des relances et des pénalités à tort — Bob cale l’échéance sur la condition légale du client, et tes relances tombent juste.',
    pro: 'Une échéance erronée déclenche relances et pénalités à tort. Bob dérive l’échéance de la condition légale du client : vos relances restent exactes.',
    direct: 'Échéance juste = relances justes.',
  },
  // ── PR-04 — Garde « BC obligatoire » par client (désactivée par défaut) ───────
  'poGuard.sectionTitle': {
    pote: 'Bon de commande',
    pro: 'Bon de commande',
    direct: 'Bon de commande',
  },
  'poGuard.on': {
    pote: 'BC obligatoire avant émission',
    pro: 'N° de commande exigé avant émission',
    direct: 'BC obligatoire',
  },
  'poGuard.off': {
    pote: 'Pas de BC exigé',
    pro: 'Aucun n° de commande exigé',
    direct: 'BC non exigé',
  },
  'poGuard.hint': {
    pote: 'Activé, Bob refuse d’émettre une facture pour ce client sans n° de bon de commande — fini les factures rejetées.',
    pro: 'Une fois activée, l’émission d’une facture sans n° de bon de commande est bloquée pour ce client.',
    direct: 'Activé = pas d’émission sans n° de BC.',
  },
  'poGuard.saveError': {
    pote: 'J’ai pas réussi à enregistrer le réglage. Réessaie.',
    pro: 'L’enregistrement du réglage a échoué. Veuillez réessayer.',
    direct: 'Échec enregistrement. Réessaie.',
  },
  'poGuard.enable': {
    pote: 'Activer',
    pro: 'Activer',
    direct: 'Activer',
  },
  'poGuard.disable': {
    pote: 'Désactiver',
    pro: 'Désactiver',
    direct: 'Désactiver',
  },
  'legal.poGuard.inline': {
    pote: 'Grands comptes et acheteurs publics rejettent toute facture sans n° de commande — Bob te protège du rejet.',
    pro: 'Les grands comptes et acheteurs publics rejettent une facture sans n° de commande — la garde vous protège du rejet.',
    direct: 'Sans n° de BC : facture rejetée.',
  },
  'legal.poGuard.law': {
    pote: 'Les acheteurs publics (Chorus Pro) et beaucoup de grands comptes exigent le n° d’engagement ou de commande sur la facture — sans lui, la pièce est rejetée à réception et le délai de paiement ne court pas. La référence voyage aussi dans la facture électronique (champ BT-13 de la norme EN 16931).',
    pro: 'Les acheteurs publics (Chorus Pro) et de nombreux grands comptes exigent le n° d’engagement ou de commande sur la facture : sans lui, la pièce est rejetée à réception et le délai de paiement ne court pas. La référence est portée par la facture électronique (BT-13, norme EN 16931).',
    direct: 'Chorus/grands comptes : n° d’engagement exigé. Sans lui : rejet, délai gelé.',
  },
  'legal.poGuard.why': {
    pote: 'Une facture rejetée, c’est 45 à 60 jours d’encaissement perdus puis tout à refaire — Bob bloque AVANT, quand c’est encore simple de saisir le BC.',
    pro: 'Une facture rejetée représente 45 à 60 jours d’encaissement perdus et une réémission. Bob bloque en amont, lorsque la saisie du BC est encore simple.',
    direct: 'Rejet = 45-60 j perdus. Bloquer avant coûte 10 secondes.',
  },
  'poGuard.sheetTitle': {
    pote: 'Bon de commande manquant',
    pro: 'Bon de commande manquant',
    direct: 'BC manquant',
  },
  'poGuard.ctaAttach': {
    pote: 'Saisir le bon de commande',
    pro: 'Saisir le bon de commande',
    direct: 'Saisir le BC',
  },
  'poGuard.ctaOverride': {
    pote: 'Émettre sans BC (tracé)',
    pro: 'Émettre sans bon de commande (tracé)',
    direct: 'Émettre sans BC',
  },
  'poGuard.overrideConfirmTitle': {
    pote: 'Émettre sans BC ?',
    pro: 'Émettre sans bon de commande',
    direct: 'Sans BC ?',
  },
  'poGuard.overrideConfirmBody': {
    pote: 'Ce client exige un n° de commande : sans lui, la facture risque d’être rejetée et le paiement repoussé. Ton choix sera journalisé.',
    pro: 'Ce client exige un n° de commande : sans lui, la facture risque un rejet et un report du paiement. Cette décision sera journalisée.',
    direct: 'Risque : rejet + paiement repoussé. Décision journalisée.',
  },
  'poGuard.cancel': {
    pote: 'Annuler',
    pro: 'Annuler',
    direct: 'Annuler',
  },
  'terms.dueAtIssued': {
    pote: 'Échéance : {date} — {label}',
    pro: 'Échéance : {date} — {label}',
    direct: 'Échéance {date} — {label}',
  },
  'terms.dueAtIssuedNoLabel': {
    pote: 'Échéance : {date}',
    pro: 'Échéance : {date}',
    direct: 'Échéance {date}',
  },

  // ── B5 — Retenue de garantie (loi n° 71-584 du 16 juillet 1971) ───────────
  'retenue.toggleTitle': {
    pote: 'Retenue de garantie',
    pro: 'Retenue de garantie',
    direct: 'Retenue de garantie',
  },
  'retenue.toggleHint': {
    pote: '{pct} % retenus sur chaque situation et la finale, restitués un an après la réception.',
    pro: '{pct} % retenus sur les situations et la facture finale, restitués un an après la réception des travaux.',
    direct: '{pct} % retenus, restitués réception + 1 an.',
  },
  'retenue.none': {
    pote: 'Sans retenue',
    pro: 'Sans retenue',
    direct: 'Sans',
  },
  'legal.retenue.inline': {
    pote: 'Plafonnée à 5 % par la loi — et Bob suit la restitution pour toi.',
    pro: 'Plafonnée à 5 % par la loi — la restitution est suivie automatiquement.',
    direct: 'Max 5 % (loi). Restitution suivie.',
  },
  'legal.retenue.law': {
    pote: 'Sur un marché privé de travaux, le maître d’ouvrage peut retenir au plus 5 % de chaque paiement pour garantir la levée des réserves. Cette retenue doit être libérée un an après la réception des travaux, sauf opposition motivée par lettre recommandée.',
    pro: 'Dans les marchés privés de travaux, les paiements peuvent être amputés d’une retenue d’au plus 5 %, garantissant la levée des réserves. Elle est libérée à l’expiration du délai d’un an après la réception, sauf opposition motivée par lettre recommandée.',
    direct: 'Marché privé de travaux : retenue ≤ 5 % des paiements, libérée réception + 1 an sauf opposition motivée.',
  },
  'legal.retenue.why': {
    pote: 'La TVA est déjà facturée sur le montant plein : seule ta trésorerie attend. Bob déduit la retenue du net à payer, l’imprime sur la pièce, et te rappelle de récupérer tes 5 % à l’échéance.',
    pro: 'La TVA est facturée sur le montant plein : seul l’encaissement est différé. Bob déduit la retenue du net à payer, l’imprime sur la pièce et suit la créance jusqu’à sa restitution.',
    direct: 'Retenue déduite du net à payer, imprimée, suivie jusqu’à restitution.',
  },
  'retenue.totalsRow': {
    pote: 'Retenue de garantie',
    pro: 'Retenue de garantie',
    direct: 'Retenue',
  },
  'retenue.suiviTitle': {
    pote: 'Retenue à récupérer',
    pro: 'Retenue de garantie à récupérer',
    direct: 'Retenue à récupérer',
  },
  'retenue.suiviNoReception': {
    pote: 'Restitution : un an après la réception des travaux — pense au PV de réception.',
    pro: 'Restitution due un an après la réception des travaux (PV de réception faisant foi).',
    direct: 'Restitution : réception + 1 an.',
  },
  'retenue.suiviPieces': {
    pote: '{count} pièce(s) avec retenue',
    pro: '{count} pièce(s) portant retenue',
    direct: '{count} pièce(s)',
  },
  'retenue.suiviCustomer': {
    pote: 'Chez {name}',
    pro: 'Client : {name}',
    direct: '{name}',
  },

  // ── Canal de facturation (email | Chorus Pro | portail fournisseur) ────────
  'canal.sectionTitle': {
    pote: 'Comment ce client reçoit ses factures',
    pro: 'Réception des factures',
    direct: 'Canal de facturation',
  },
  'canal.email': {
    pote: 'Par e-mail',
    pro: 'Par e-mail',
    direct: 'E-mail',
  },
  'canal.emailHint': {
    pote: 'Le canal par défaut : la facture part par e-mail ou par lien partagé.',
    pro: 'Canal par défaut : envoi par e-mail ou lien de consultation partagé.',
    direct: 'Défaut : e-mail ou lien.',
  },
  'canal.chorus': {
    pote: 'Chorus Pro',
    pro: 'Chorus Pro',
    direct: 'Chorus Pro',
  },
  'canal.chorusHint': {
    pote: 'Obligatoire pour la sphère publique : mairies, collectivités, État.',
    pro: 'Dépôt obligatoire pour la sphère publique (collectivités, État).',
    direct: 'Sphère publique : dépôt obligatoire.',
  },
  'canal.portail': {
    pote: 'Portail fournisseur',
    pro: 'Portail fournisseur',
    direct: 'Portail',
  },
  'canal.portailHint': {
    pote: 'Les grands comptes qui veulent leurs factures sur LEUR portail.',
    pro: 'Portail de dépôt imposé par certains grands comptes.',
    direct: 'Grands comptes.',
  },
  'canal.chorusServiceCode': {
    pote: 'Code service (si l’entité l’exige)',
    pro: 'Code service du destinataire',
    direct: 'Code service',
  },
  'canal.portailNom': {
    pote: 'Nom du portail',
    pro: 'Nom du portail',
    direct: 'Nom',
  },
  'canal.portailUrl': {
    pote: 'Adresse du portail (https://…)',
    pro: 'URL du portail (https://…)',
    direct: 'URL',
  },
  'canal.edit': {
    pote: 'Modifier',
    pro: 'Modifier',
    direct: 'Modifier',
  },
  'canal.saveError': {
    pote: 'J’ai pas réussi à enregistrer le canal. Réessaie.',
    pro: 'L’enregistrement du canal a échoué. Veuillez réessayer.',
    direct: 'Échec enregistrement. Réessaie.',
  },
  'canal.sheetTitle': {
    pote: 'Canal de facturation',
    pro: 'Canal de facturation',
    direct: 'Canal',
  },

  // ── Guide de dépôt (facture émise, canal chorus/portail) ───────────────────
  'guide.entryTitle': {
    pote: 'Déposer la facture',
    pro: 'Déposer la facture',
    direct: 'Dépôt',
  },
  'guide.entrySubtitleChorus': {
    pote: 'Ce client passe par Chorus Pro — je te guide pas à pas.',
    pro: 'Ce client reçoit ses factures via Chorus Pro. Guide pas à pas.',
    direct: 'Chorus Pro. Guide.',
  },
  'guide.entrySubtitlePortail': {
    pote: 'Ce client passe par son portail fournisseur — je te guide pas à pas.',
    pro: 'Ce client reçoit ses factures via son portail fournisseur. Guide pas à pas.',
    direct: 'Portail fournisseur. Guide.',
  },
  'guide.screenTitle': {
    pote: 'Guide de dépôt',
    pro: 'Guide de dépôt',
    direct: 'Dépôt',
  },
  'guide.actionDownload': {
    pote: 'Partager le PDF Factur-X',
    pro: 'Partager le PDF Factur-X',
    direct: 'PDF Factur-X',
  },
  'guide.actionShareNumber': {
    pote: 'Partager le n° d’engagement',
    pro: 'Partager le n° d’engagement',
    direct: 'N° d’engagement',
  },
  'guide.actionOpenChorus': {
    pote: 'Ouvrir Chorus Pro',
    pro: 'Ouvrir Chorus Pro',
    direct: 'Chorus Pro',
  },
  'guide.actionOpenPortal': {
    pote: 'Ouvrir {name}',
    pro: 'Ouvrir {name}',
    direct: '{name}',
  },
  'guide.portalFallbackName': {
    pote: 'le portail',
    pro: 'le portail',
    direct: 'portail',
  },
  'guide.suiviTitle': {
    pote: 'Suivi du dépôt',
    pro: 'Suivi du dépôt',
    direct: 'Suivi',
  },
  'guide.suiviHint': {
    pote: 'Deux taps, et Bob sait où en est ta facture — les relances suivent.',
    pro: 'Déclarez le dépôt et l’acceptation : le suivi et les relances en dépendent.',
    direct: 'Déclare dépôt et acceptation.',
  },
  'guide.markDeposited': {
    pote: 'Déposée aujourd’hui',
    pro: 'Déposée aujourd’hui',
    direct: 'Déposée',
  },
  'guide.markAccepted': {
    pote: 'Acceptée aujourd’hui',
    pro: 'Acceptée aujourd’hui',
    direct: 'Acceptée',
  },
  'guide.depositedOn': {
    pote: 'Déposée le {date}',
    pro: 'Déposée le {date}',
    direct: 'Déposée {date}',
  },
  'guide.acceptedOn': {
    pote: 'Acceptée le {date}',
    pro: 'Acceptée le {date}',
    direct: 'Acceptée {date}',
  },
  'guide.suiviError': {
    pote: 'J’ai pas réussi à enregistrer le suivi. Réessaie.',
    pro: 'L’enregistrement du suivi a échoué. Veuillez réessayer.',
    direct: 'Échec. Réessaie.',
  },
  'guide.pdfMissing': {
    pote: 'Le PDF n’est pas encore archivé — réessaie dans un instant.',
    pro: 'Le PDF n’est pas encore archivé. Réessayez dans un instant.',
    direct: 'PDF pas encore prêt.',
  },
  'guide.checklistTitle': {
    pote: 'Les étapes',
    pro: 'Étapes',
    direct: 'Étapes',
  },
  'guide.checkDone': {
    pote: 'OK',
    pro: 'Vérifié',
    direct: 'OK',
  },
  'guide.checkTodo': {
    pote: 'À vérifier',
    pro: 'À vérifier',
    direct: 'À vérifier',
  },
  'guide.checkManual': {
    pote: 'À faire par toi',
    pro: 'À réaliser manuellement',
    direct: 'Manuel',
  },
} as const satisfies Record<string, Copy>;
