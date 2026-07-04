# Expertise comptable — rapport final d'audit & roadmap réglementaire

> **Statut** : rapport final validé après vérification adversariale (chaque proposition a été contre-vérifiée sur Légifrance/BOFiP/service-public ET contre le code du repo ; les corrections du vérificateur PRIMENT sur les références initiales des experts).
> **Date** : 3 juillet 2026 · **Auteur** : audit d'expertise comptable multi-prismes (6 experts : TVA & régimes, e-facturation, recouvrement, trésorerie, obligations déclaratives, Data & IA comptable).
> **Périmètre** : 46 propositions brutes → 34 propositions consolidées retenues (doublons inter-experts fusionnés, convergences signalées) + 1 proposition réfutée en annexe.

---

## 1. Résumé exécutif

Bob Pro sait déjà *écrire* la conformité (mentions, taux, écritures, FEC, Factur-X sortant) mais ne sait presque jamais la *surveiller ni la chiffrer*. Les cinq améliorations les plus décisives :

1. **Vigie des seuils de franchise en base (art. 293 B CGI)** — l'app imprime « TVA non applicable » sans jamais confronter le CA réel aux seuils ; depuis 2025 la franchise cesse **le jour même** du dépassement du seuil majoré : jusqu'à 20 % de marge évaporée. Convergence de 4 experts sur 6.
2. **Relances B2C conformes + pénalités de retard enfin calculées** — risque juridique **actif aujourd'hui** : la mise en demeure unique cite L441-10 et réclame 40 € à des particuliers qui ne les doivent pas ; et à l'inverse, aucun montant de pénalités n'est jamais chiffré pour les pros — de l'argent dû de plein droit, abandonné.
3. **Provision URSSAF micro-entrepreneur** — la ligne cotisations du « Disponible prudent » est codée `null` (TODO C40) : 12,3 à 25,6 % du CA encaissé s'affiche comme dépensable. C'est le piège n° 1 qui coule les micro-entreprises la première année.
4. **Chaîne e-facturation réelle** — réception Factur-X entrante obligatoire au 1/9/2026 pour TOUS les assujettis, e-reporting, connecteur Plateforme Agréée : aujourd'hui tout le cycle est simulé en interne alors que le plan Free promet « Conforme 2026, gratuitement ».
5. **Moteur TVA de bout en bout** — exigibilité encaissements/débits (l'app provisionne de la TVA sur des factures impayées), brouillons CA3/CA12 datés, transition fin du régime simplifié au 1/1/2027 (bascule **trimestrielle de plein droit**, mécanisme corrigé par le vérificateur).

Trois quick-wins sont réalisables immédiatement sans aucune donnée nouvelle : relances B2C conformes, mention d'escompte + correction du taux de pénalités (deux non-conformités sur chaque facture émise), mention certifiée taux réduits 10 %/5,5 % (le remplaçant légal de l'attestation Cerfa, absent des pièces).

---

## 2. Tableau de priorisation

Tri : impact (critique → fort → moyen), puis effort (quick-win → claim → chantier). Les références sont celles **corrigées** par la vérification adversariale.

| # | Titre | Expert(s) | Impact | Effort | Data requise | Référence réglementaire (corrigée) |
|---|-------|-----------|--------|--------|--------------|-------------------------------------|
| P01 | Relances B2C conformes (plus de 40 € ni L441-10 aux particuliers) | Recouvrement | critique | quick-win | Rien (customer.type existe) | L441-10 II C. com (pros uniquement) ; art. 1344, 1344-1, 1231-6 C. civ ; B2G : L2192-13 CCP |
| P02 | Vigie seuils franchise 293 B (compteur CA temps réel, bascule le jour J, prorata année de création) | TVA · Tréso · Déclaratif · Data-IA (×4) | critique | claim (jauge v1 = quick-win) | Rien (Invoice, LineItem.category, vatRegime) | Art. 293 B CGI, rédaction LF 2024 (art. 82, loi 2023-1322) rétablie par loi 2025-1044 du 3/11/2025 ; seuils 2026 : 85 000/93 500 € et 37 500/41 250 € ; BOI-RES-TVA-000198 ; CIBS au 1/9/2026 (ord. 2025-1247) |
| P03 | Provision URSSAF micro + déclaration pré-calculée sur encaissements | Tréso · Déclaratif (×2) | critique | claim | Périodicité URSSAF + option VFL (2 questions) | Art. D613-4 CSS (décret 2025-943 : 12,3/21,2/25,6/23,2 % en 2026) ; art. L613-8 CSS ; art. 151-0 CGI (VFL 1/1,7/2,2 %) ; pénalité 1,5 % PMSS ≈ 60 €/déclaration |
| P04 | Chrono prescription par facture (« après cette date, c'est perdu ») | Recouvrement | critique | claim | Rien (dueAt, payments, customer.type) | B2C : 2 ans, L218-2 C. conso, point de départ = achèvement (Cass. 1re civ. 19/5/2021, 20-12.520 → ancrage conservateur min(émission, dueAt)) ; B2B : 5 ans, L110-4 C. com ; **B2G : déchéance quadriennale loi 68-1250** (réclamation écrite interruptive) ; art. 2240/2241/2244 C. civ |
| P05 | Réception 2026 : parseur Factur-X/CII entrant + bouton « Refuser » conforme | E-facturation | critique | claim | N° facture fournisseur + échéance sur Expense ; flux entrant | Art. 289 bis CGI (réception 1/9/2026, tous assujettis) ; norme AFNOR XP Z12-012 (statuts 200/210/212/213) ; LF 2026 (loi 2026-103) : amende 500 € puis 1 000 €/trimestre |
| P06 | Moteur TVA déclaratif : brouillons CA3/CA12 + échéancier daté + rapprochement livres | TVA · Tréso · Déclaratif · Data-IA (×4) | critique | chantier | TVA due N-1 (1 saisie) ; clôture décalée éventuelle | Art. 287, 2 et 3 CGI (CA3 ; acomptes 55 %/40 %, dispense < 1 000 €, base N-1 avant TVA/immobilisations ; CA12 au 2e jour ouvré suivant le 1er mai) ; art. 1728/1727 CGI ; LF 2025 art. 38 (fin RSI au 1/1/2027) |
| P07 | Connecteur Plateforme Agréée réel (dépôt, réception, cycle de vie, annuaire) | E-facturation | critique | chantier | Compte API PA, webhooks, annuaire | Art. 289 bis et 290 B CGI ; émission TPE-PME 1/9/2027 (report max 1/12/2027) ; amende 50 €/facture, plafond 15 000 €/an (art. 1737, III CGI, LF 2026) |
| P08 | Radar procédures collectives BODACC (2 mois pour déclarer la créance) | Recouvrement | critique | chantier | Flux API BODACC (DILA, gratuit) | L622-24, R622-24 (2 mois ; 4 mois hors métropole), L622-26, L622-21, L622-28 C. com |
| P09 | Moteur d'échéances fiscales deriveFiscalCalendar (toutes formes juridiques) | Déclaratif | critique | chantier | Date de clôture d'exercice + régime réel + périodicité URSSAF | Art. 1668, 1 CGI (acomptes IS ; dispense 1er exercice) ; **dispense ≤ 3 000 € : art. 359, 3 annexe III CGI** ; art. 360 bis annexe III ; art. 223, 1 CGI ; art. 1728, 1-a CGI |
| P10 | Fin du régime simplifié TVA : compte à rebours et bascule guidée 1/1/2027 | TVA | fort | quick-win | Rien (vatRegime, écritures 4457x) | Art. 38, loi 2025-127 (LF 2025) : **régime trimestriel DE PLEIN DROIT** si CA ≤ 1 M€ (N-1) et ≤ 1,1 M€ (en cours), **option** mensuelle ; au 1/1/2027 la règle vit dans le livre II du CIBS (ord. 2025-1247) |
| P11 | Mention certifiée taux réduits 10 %/5,5 % sur devis et factures | TVA | fort | quick-win | Rien (booléens suggestVatRate déjà saisis) | Art. 41, loi 2025-127 (LF 2025), en vigueur 16/2/2025 ; art. 279-0 bis et 278-0 bis A CGI ; BOI-TVA-LIQ-30-20-90-40 (version 22/10/2025) |
| P12 | Pénalités de retard + 40 € CALCULÉES dans les relances (B2B/B2G uniquement) | Facturation · Recouvrement · Tréso · Data-IA (×4) | fort | quick-win (v1) / claim (référentiel + B2G) | Référentiel semestriel 2 taux (BCE refi, taux légal) | L441-10 II C. com (BCE+10, plancher 3× taux légal, de plein droit) ; D441-5 (40 €, pros seulement) ; **B2G : L2192-12/13 CCP + décret 2013-269 (BCE+8)** ; S1 2026 = 12,15 % |
| P13 | Garde-fou plafond légal des délais de paiement (60 j / 45 j fin de mois) | Facturation · Recouvrement · Tréso (×3) | fort | quick-win | Booléen « stipulé au contrat » (dérogation 45 j fdm) | L441-10 I C. com ; L441-16 (amende 75 k€/2 M€) ; B2G : R2192-10 CCP (30 j) |
| P14 | Mention escompte + correction taux de pénalités irrégulier + pre-flight émission | E-facturation | fort | quick-win | Champ optionnel taux d'escompte (défaut néant) | L441-9 I et II C. com ; art. 1737, II CGI (15 €/omission, plafond ¼ facture) ; L441-10 II (plancher 3× taux légal → la mention actuelle « taux légal » est irrégulière) |
| P15 | Compléter les 4 mentions de la réforme (adresse livraison, option débits, TVA intracom client) | E-facturation | fort | quick-win | deliveryAddress par pièce ; flag vatOnDebits | Art. 242 nonies A annexe II CGI (décret 2022-1299 : 7° bis, 8° bis, 11° bis, I-4°) ; calendrier art. 91 LF 2024 + décret 2024-266 |
| P16 | Balance âgée + DSO en langage simple | Tréso | fort | quick-win | Rien | L441-10 I C. com (contexte plafond) — sinon pur produit |
| P17 | Détection de doublons de dépenses (SIREN+montant+date ±3 j, sha256) | Data-IA | fort | quick-win | Rien (Expense, SupplierMemoryProfile, StoredDocument.sha256) | Aucune (pur produit ; enjeu évité : double déduction TVA, art. 271/1727 CGI) |
| P18 | Vigie DAS2 : cumul honoraires par bénéficiaire, seuil 2 400 € | Déclaratif | fort | quick-win | **Catégorie `honoraires` (prérequis, pas une option)** | Art. 240/241 CGI ; seuil 2 400 € (BOFiP ACTU-2024-00154, BOI-BIC-DECLA-30-70-20) ; amende 50 % (art. 1736, I-1) ; **champ = honoraires (622), PAS la sous-traitance de travaux BTP (actes de commerce hors champ)** |
| P19 | Provision CFE lissée + 1447-C année de création + rappels 15/6 et 15/12 | Tréso · Déclaratif (×2) | fort | quick-win | CFE N-1 (1 saisie ou OCR de l'avis) | Art. 1679 quinquies CGI (acompte 50 % au 15/6 si N-1 ≥ 3 000 €, solde 15/12) ; art. 1478, II (exo année de création, base ½ en année 1) ; art. 1647 D (exo cotisation minimum si CA ≤ 5 000 €, apprécié sur N-2, art. 1467 A) |
| P20 | Exigibilité de la TVA : encaissements vs débits, ligne par ligne | TVA | fort | claim | Booléen optionDebits sur Company | Art. 269, 2-a et 2-c CGI ; option débits : art. 77 annexe III CGI ; mention décret 2022-1299 |
| P21 | Autoliquidation sous-traitance BTP côté PRENEUR | TVA | fort | claim | Flag autoliquidation + taux par dépense (mémorisé par fournisseur) | Art. 283, 2 nonies CGI ; amende 5 % (art. 1788 A, 4 CGI ; CC QPC n° 2022-1009 du 22/9/2022) |
| P22 | Moteur e-reporting : B2C + données de paiement des prestations | E-facturation | fort | claim | Rien pour la dérivation (transmission = P07) | Art. 290 et 290 A CGI ; périodicité décret 2022-1299 ; amende 500 €/transmission, plafond 15 000 €/an (art. 1788 D CGI, LF 2026) |
| P23 | Provision IS automatique + rappel des 4 acomptes | Déclaratif | fort | claim | Date de clôture + IS N-1 (1 saisie) | Art. 219, I-b CGI (15 % ≤ 42 500 €, maintenu par LF 2026) ; art. 1668, 1 (acomptes) ; **solde : art. 1668, 2 + art. 360 annexe III — 15 du 4e mois suivant clôture SAUF clôture 31/12 → 15 mai** ; dispense ≤ 3 000 € : art. 359, 3 annexe III |
| P24 | Lettrage automatique 411 + dossier de clôture (FEC + pièces) | Data-IA | fort | claim | Rien (Payment.invoiceId, sourceId, sha256) | LPF art. A. 47 A-1 — **EcritureLet/DateLet = colonnes 14-15** (pas 11-12) ; LPF art. L. 47 A, I ; argument = gain de temps EC (des colonnes vides ne rendent pas le FEC non conforme) |
| P25 | Dossier injonction de payer prêt à déposer | Recouvrement | fort | chantier | Preuve d'envoi LRE ; table CP → tribunal (**inclure les 12 TAE 2025-2028**) | **Art. 1405 à 1422 CPC** (1423-1424 abrogés) ; art. 1406, 1416 CPC ; décret 2021-1322 (formule exécutoire dès délivrance) ; palier existant = **J+45** dans relance-plan.ts |
| P26 | Retenue de garantie 5 % : récupérer l'argent un an après réception | Recouvrement | fort | chantier | % retenu + date de réception par pièce | Loi 71-584 du 16/7/1971, art. 1er (plafond 5 %) et 2 (libération à 1 an sauf opposition LRAR) |
| P27 | Prévisionnel 90 jours daté avec détection du point bas | Tréso | fort | chantier | Rien (s'enrichit des sorties datées P03/P06/P19/P23) | Aucune (pur produit ; corollaire : R243-18 CSS sur les rejets URSSAF) |
| P28 | Marge réelle par chantier (relier recettes et dépenses existantes) | Data-IA | fort | chantier | Table Chantier persistée + chantierId sur Expense/Quote/Invoice | Aucune (comptabilité analytique de poche) |
| P29 | Clause de réserve de propriété automatique (lignes 'supply') | Recouvrement | moyen | quick-win | Rien (LineItem.category) | Art. 2367 C. civ ; L624-16 et L624-9 C. com (revendication 3 mois) |
| P30 | TVA carburant/véhicule : coefficients 80 % / 100 % / 0 % | TVA | moyen | quick-win | Type de véhicule VP/VU (1 question mémorisée) | Art. 298, 4-1° CGI ; art. 206, IV-2-6°/7° annexe II CGI ; BOI-TVA-DED-30-30-20/-40 ; électricité VE = 100 % |
| P31 | Rituel annuel des sociétés : approbation + dépôt des comptes | Déclaratif | moyen | quick-win | Date de clôture (champ partagé P09/P23) | **Associé unique dirigeant : le dépôt vaut approbation — L223-31 al. 2 (EURL) / L227-9 dern. al. (SASU) → un seul rappel** ; sinon L232-22/23 (1 mois / 2 mois en ligne) ; R247-3 (1 500 €) ; L232-25 : confidentialité totale = micro seulement, compte de résultat = petites |
| P32 | Simulateur « rester en franchise ou opter » (art. 293 F) | TVA | moyen | claim | Rien (vatCents 12 mois, mix B2B/B2C du diagnostic) | Art. 293 F CGI (effet 1er jour du mois, engagement 2 ans, tacite reconduction) |
| P33 | Charge ou immobilisation ? Seuil 500 € HT + plan d'amortissement | Data-IA | moyen | claim | Durée d'usage (défaut par famille) | BOI-BIC-CHG-20-30-10 (tolérance 500 € HT) ; **poster en 215/2183 (2154 non seedé) ou étendre le seed** |
| P34 | « Te verser » teinté par la forme juridique (règle des 10 %, PFU 31,4 %) | Tréso | moyen | claim | Capital social (1 question) | **Art. L131-6 et L136-3 CSS (rédaction LFSS 2024, applicable depuis le 1/1/2025)** — règle des 10 % ; PFU 2026 = 12,8 % (art. 200 A CGI) + 18,6 % PS (**CSG capital +1,4 pt : 9,2 → 10,6 %**, LFSS 2026) |

---

## 3. Détail des propositions retenues

### 3.1 TVA & régimes fiscaux

#### P02 — Vigie des seuils de franchise en base (convergence ×4 : TVA, Tréso, Déclaratif, Data-IA)

**Problème.** Depuis 2025, la franchise cesse **pour les opérations intervenant dès la date du dépassement** du seuil majoré — plus de tolérance jusqu'à la fin du mois. Un plombier qui facture 0 % le lendemain doit la TVA sur ses deniers (~16,7 % du TTC / jusqu'à 20 % de marge), avec avoirs + refactures à produire. Second piège : dépasser le seuil de base (sans le majoré) fait perdre la franchise au 1er janvier N+1. Troisième piège que seul un expert connaît : **l'année de création, les seuils s'apprécient prorata temporis** (CA × 365 / jours d'activité). Or l'app affiche sereinement « TVA non applicable, art. 293 B » sans jamais vérifier le droit.

**Solution.** Cumul automatique du CA facturé de l'année civile (HT figé `_frozenTotals`, avoirs `credit_note` déduits), ventilé ventes/services via `LineItem.category` (`supply` = biens ; attention : la fourniture-et-pose BTP = **prestation de services**), annualisé l'année de création via `dateCreation`. Jauges à 80 %/95 %, alerte « Aujourd'hui », projection de la date de franchissement au rythme constaté, simulation à la signature d'un devis. Au franchissement du seuil majoré : `suggestVatRate` cesse de forcer 0 %, `buildMentions` retire la mention 293 B, bascule guidée du `vatRegime`, checklist (n° TVA intracom, prévenir les clients), détection des factures émises à tort à 0 % après la date de dépassement (avoirs + refactures).

**Construire avec l'existant.** Pur moteur de dérivation : `Invoice` (issuedAt, status, totaux figés) + `LineItem.category` (apps/api/prisma/schema.prisma), `vatRegime`/`isVatFranchise()` et `dateCreation` (⚠ champ **optionnel** — traiter le cas null) dans `packages/core/src/domain/company/company.ts`. Points d'accroche : `packages/core/src/domain/services/suggest-vat-rate.ts` (force 0 % sans contrôle), `packages/core/src/domain/services/build-mentions.ts` (bascule CIBS 2026-09-01 déjà gérée), `packages/core/src/domain/compliance/diagnostic.ts:137-144` (item statique à remplacer par le compteur réel). Rien à capter.

**Référence (corrigée).** Art. 293 B CGI — rédaction issue de l'art. 82 de la **LF 2024** (loi 2023-1322, transposition directive (UE) 2020/285), **rétablie** par la loi n° 2025-1044 du 3/11/2025 (abrogation du seuil unique 25 000 € de la LF 2025, jamais appliqué ; art. 25 du PLF 2026 supprimé le 20/11/2025). Seuils 2026 : 85 000 € / 93 500 € (biens, hébergement) et 37 500 € / 41 250 € (services). BOFiP : BOI-TVA-DECLA-40-10, BOI-RES-TVA-000198. Recodification CIBS au 1/9/2026 à droit constant (ord. 2025-1247 du 17/12/2025). ⚠ Veille active : la réforme des seuils est récurrente (25 000 € travaux immobiliers proposé puis rejeté fin 2025).

#### P06 — Moteur TVA déclaratif : CA3/CA12 pré-remplies, échéancier daté, rapprochement (convergence ×4)

**Problème.** L'app calcule la TVA au centime puis laisse l'artisan seul devant impots.gouv.fr. Réel simplifié : 2 acomptes (juillet 55 %, décembre 40 % de la TVA N-1) + CA12 début mai ; réel normal : CA3 mensuelle. Oubli = majoration 10 % (art. 1728) + intérêts 0,20 %/mois (art. 1727). La TVA due n'existe dans le code que comme **stock non daté** : l'acompte de décembre tombe en plein creux hivernal du BTP sans prévenir.

**Solution.** Dérivation pure « feuille TVA » par période fiscale : bases HT et TVA collectée **par taux** (lignes exactes de la CA3), TVA déductible ventilée, autoliquidations, TVA nette ou crédit à reporter — avec **rapprochement croisé automatique** écritures 4457x vs factures (tout écart au centime = anomalie signalée avant déclaration). Réel simplifié : acomptes 55 %/40 % (dispense si TVA N-1 < 1 000 € ; base = taxe N-1 **avant** déduction de la TVA sur immobilisations) + brouillon CA12. Chaque échéance devient une priorité datée dans « Aujourd'hui » et une sortie datée du prévisionnel/ledger — un seul chiffre partout. Export PDF à recopier ou envoyer au comptable ; Bob **prépare**, ne télédéclare pas. ⚠ Exigibilité : les bases services s'assoient sur les **encaissements** (art. 269, 2-c — cohérent avec P20 et avec `derive-vat-position.ts` qui raisonne déjà en encaissements), pas sur vatByRate × issuedAt seul, sauf option débits.

**Construire avec l'existant.** `AccountingEntry`/`AccountingEntryLine` 44571/44566/44562 par période, `vatByRate` (Json figé, schema.prisma:246), `Expense.vatCents` (:347), `vatRegime` sur Company. `projectCashflow` (`packages/core/src/domain/services/project-cashflow.ts`) reçoit `vatDue` en input hôte non daté ; `build-ledger-view.ts` et `derive-vat-position.ts` (`packages/core/src/application/argent/`) calculent une photo agrégée sans période ni taux. À capter : la TVA due N-1 (une saisie initiale, ou OCR de l'avis d'acompte) et la date de clôture si décalée.

**Référence.** Art. 287, 2 CGI (CA3 mensuelle ; option trimestrielle si taxe annuelle < 4 000 €, BOI-TVA-DECLA-20-20-10-10) ; art. 287, 3 (acomptes 55 %/40 %, dispense < 1 000 €, CA12 au 2e jour ouvré suivant le 1er mai — 5 mai 2026 pour 2025) ; sanctions art. 1728/1727 CGI. Obsolescence programmée du volet acomptes/CA12 : voir P10.

#### P10 — Fin du régime simplifié de TVA au 1/1/2027 : compte à rebours et bascule guidée **(CORRIGÉ)**

**Problème.** La LF 2025 supprime le RSI-TVA au 1er janvier 2027 : fini CA12 + 2 acomptes. Choc de rythme et de trésorerie que quasi aucun indépendant ne voit venir.

**Correction du vérificateur (prime sur la fiche initiale).** Le mécanisme initialement décrit était **inversé** : le RSI n'est pas remplacé par « le réel normal mensuel avec option trimestrielle ». Le texte (art. 287, 3 modifié ; au 1/1/2027 dans le **livre II du CIBS**) instaure un régime déclaratif **TRIMESTRIEL DE PLEIN DROIT** quand le CA (majoré des acquisitions taxables) n'excède pas 1 000 000 € l'année précédente ET 1 100 000 € l'année en cours ; c'est l'**option** qui est mensuelle (engagement minimal de 4 trimestres civils). En cas de dépassement de 1,1 M€ en cours d'année, passage au mensuel à compter du dépassement (les sources divergent entre « mois du dépassement » et « mois suivant » — à trancher à l'implémentation sur le texte consolidé). Conséquence produit : le tenant `reel_simpl` bascule par défaut vers des **échéances trimestrielles**, sans démarche d'option à simuler.

**Solution.** Pour tout `vatRegime='reel_simpl'` : item de diagnostic dédié + bannière compte à rebours, simulation du montant de TVA par trimestre sur SES données (écritures 44571/44566 des 12 derniers mois), bascule guidée au 1/1/2027 (mise à jour vatRegime, nouvelles échéances alimentant P06). « Aujourd'hui tu payes 2 fois par an, à partir de janvier ce sera ~870 € par trimestre. »

**Construire avec l'existant.** `company.ts` (VatRegime 3 valeurs), `diagnostic.ts` (ne code que le calendrier e-invoicing 2026-09-01/2027-09-01 — rien sur le RSI). Rien à capter.

**Référence (corrigée).** Art. 38, loi n° 2025-127 du 14/2/2025 (LF 2025), ni reporté ni abrogé par la LF 2026 ; seuils 1 M€ / 1,1 M€ ; recodification CIBS (ord. 2025-1247).

#### P20 — Exigibilité de la TVA : encaissements vs débits

**Problème.** Pour les prestations de services, la TVA n'est exigible qu'**à l'encaissement** ; or l'app crédite 44571 dès l'émission de toute facture : trésorerie sur-serrée à tort et future déclaration fausse (TVA versée trop tôt, voire jamais récupérée sur impayé). Pour les biens, l'exigibilité est à la livraison : il faut les deux logiques, ligne par ligne.

**Solution.** Moteur d'exigibilité domaine : lignes `supply` → 44571 direct à l'émission ; lignes services → compte d'attente (type 4457x « TVA sur factures non encaissées », le compte 4458 existe au seed), reclassé en 44571 **au prorata de chaque Payment** (les paiements partiels existent). Ledger et réserve `projectCashflow` ne comptent que la TVA réellement exigible. Booléen `optionDebits` sur Company : tout redevient exigible à la facturation ET `buildMentions` imprime la mention dédiée (TODO documenté dans le code).

**Construire avec l'existant.** `invoice-accounting.ts` (crédite 44571 à l'émission, l.119-121), `build-mentions.ts:63-65` (TODO mention débits), `build-ledger-view.ts` (provisionne sur préfixe 4457 dès l'émission), `chart-of-accounts.ts:250` (compte 4458 seedé), `LineItem.category`, Payments partiels. À capter : le booléen (une case réglages-facturation).

**Référence.** Art. 269, 2-c (encaissement, services) et 2-a (livraison, biens ; acomptes sur biens exigibles à l'encaissement depuis le 1/1/2023) CGI ; option débits : art. 77 annexe III CGI (courrier simple au SIE, révocable) ; mention obligatoire : décret 2022-1299 (art. 242 nonies A annexe II).

#### P21 — Autoliquidation sous-traitance BTP côté PRENEUR

**Problème.** L'app protège l'artisan quand il EST le sous-traitant (0 % + mention). Quand c'est LUI le donneur d'ordre, il devient redevable : il doit autoliquider la TVA sur la facture HT reçue (collectée ET déduite). Neutre financièrement, sauf si oublié : amende de **5 % de la TVA déductible** (200 € sur un sous-traitant à 20 000 € HT) — le redressement le plus fréquent et le plus bête du BTP.

**Solution.** Dépense `sous_traitance` sans TVA facturée → une question (« sous-traitance BTP sur un de tes chantiers ? », mémorisée par fournisseur via `SupplierMemoryProfile`), puis écriture d'autoliquidation automatique (crédit 44571 / débit 44566 au taux du chantier), injection dans le brouillon CA3 (base « autres opérations imposables » — dépend de P06), et contrôle que la facture reçue porte « Autoliquidation » (alerte sinon : c'est le sous-traitant qui a mal facturé).

**Construire avec l'existant.** `Expense.category` (enum fermé incluant `sous_traitance`, `packages/core/src/domain/expense/expense.ts:10`), `supplierSiren` validé Luhn, `SupplierMemoryProfile` (apps/api/src/persistence/supplier-memory.ts), comptes 44566/44571 seedés (`chart-of-accounts.ts:247,249`). Côté vendeur, `requiresAutoliquidation` (company.ts:110), `suggest-vat-rate.ts:24-27`, `build-mentions.ts:50-51` servent de référence. À capter : flag + taux par dépense (mémorisés).

**Référence.** Art. 283, 2 nonies CGI (depuis 2014) ; amende : art. 1788 A, 4 CGI (conformité constitutionnelle : CC, QPC n° 2022-1009 du 22/9/2022), cumulable avec l'art. 1727.

#### P11 — Mention certifiée taux réduits 10 % / 5,5 %

**Problème.** L'app suggère intelligemment 10 % (logement > 2 ans) et 5,5 % (rénovation énergétique) mais n'imprime **aucun justificatif**. Depuis le 16/2/2025, l'attestation Cerfa est remplacée par une mention obligatoire sur devis ou facture ; sans elle, en contrôle, le taux réduit saute (10 à 14,5 points de TVA sur les deniers de l'artisan, sur TOUS les chantiers concernés).

**Solution.** `buildMentions` ajoute la mention dès qu'une ligne porte 10 % ou 5,5 % : « Les travaux se rapportent à des locaux d'habitation achevés depuis plus de deux ans et sont éligibles au taux réduit (art. 279-0 bis [/278-0 bis A] CGI). Le client atteste que ces conditions sont remplies. » La signature « Bon pour accord » existante vaut certification **par le preneur** (c'est lui qu'elle engage — nuance BOFiP à intégrer dans la formulation, y c. absence de surélévation/production d'immeuble neuf) ; devis signé déjà archivé au coffre. Reprise sur la facture finale. Zéro donnée nouvelle.

**Construire avec l'existant.** `suggest-vat-rate.ts` (context.housingOlderThan2y / energyRenovation déjà saisis), `build-mentions.ts` (aucune mention taux réduits aujourd'hui), flow signature devis, coffre avec rétention.

**Référence.** Art. 41, loi 2025-127 (LF 2025), en vigueur 16/2/2025 ; art. 279-0 bis et 278-0 bis A CGI ; BOI-TVA-LIQ-30-20-90-40 (version 22/10/2025) ; conservation jusqu'au 31/12 de la 5e année.

#### P30 — TVA carburant/véhicule : coefficients 80 / 100 / 0 %

**Problème.** L'app déduit 100 % de la TVA de toute dépense `carburant` alors que la TVA sur l'essence/gazole d'un véhicule de tourisme n'est récupérable qu'à 80 % (100 % utilitaire), et que la TVA achat/location/entretien d'un VP n'est **pas déductible du tout**. TVA déductible surestimée → « TVA à reverser » sous-évaluée → rappel assuré.

**Solution.** À la première dépense carburant, une question mémorisée : « utilitaire (carte grise CTTE) ou voiture particulière ? ». Coefficient automatique 80 % (VP) / 100 % (VU), part non récupérable réintégrée en charge ; location/entretien de VP : tout en TTC. ⚠ Ne pas appliquer 80 % à une recharge électrique classée `carburant` (électricité 100 % déductible) ; pièces/prestations relèvent du 7° du IV-2.

**Construire avec l'existant.** `build-ledger-view.ts` (l.149 : déduit 100 % du vatCents — point de correction), catégorie `carburant` + garde-fous OCR (`ocr-extraction.ts`). À capter : type de véhicule (fiche société, ou par véhicule si flotte).

**Référence.** Art. 298, 4-1° CGI (80 %/100 %, essence-gazole alignés depuis le 1/1/2022) ; art. 206, IV-2-6° et 7° annexe II CGI ; BOI-TVA-DED-30-30-20 et -40.

#### P32 — Simulateur « rester en franchise ou opter » (art. 293 F)

**Problème.** Un artisan en franchise, acheteur de matériaux et à clientèle B2B, perd souvent de l'argent : il paye la TVA sur ses achats sans la récupérer, alors que ses clients pros la déduiraient. Ce calcul d'arbitrage, personne ne le fait gratuitement pour lui.

**Solution.** Simulation sur données réelles : TVA supportée 12 mois (`Expense.vatCents`) = gain récupérable ; mix B2C/B2B (déjà calculé en volume TTC par `derive-diagnostic.ts:222-237`) = exposition prix côté particuliers. Restitution simple + mode d'emploi de l'option (courrier au SIE, effet au 1er du mois, engagement 2 ans, lien avec P06 pour les obligations déclaratives déclenchées).

**Construire avec l'existant.** `company.ts:7` (VatRegime), `expense.ts:36` (vatCents OCR), `derive-diagnostic.ts` (mix clientèle). Rien à capter.

**Référence.** Art. 293 F CGI (effet 1er jour du mois de déclaration, période de 2 années y compris celle de la déclaration, tacite reconduction ; reconduction de plein droit 2 ans en cas de remboursement de crédit TVA art. 271). Abrogé seulement au 1/9/2026 par la recodification CIBS, à droit constant.

### 3.2 Conformité des factures & réforme e-facturation

#### P14 — Mention d'escompte + correction du taux de pénalités irrégulier + pre-flight émission

**Problème.** Deux non-conformités **sur chaque facture émise aujourd'hui** : (1) les conditions d'escompte (au minimum « Escompte : néant ») sont une mention obligatoire absente de `buildMentions` ; (2) la mention actuelle annonce des « pénalités au taux légal en vigueur » (build-mentions.ts:55) — or un taux stipulé ne peut être inférieur à 3× le taux d'intérêt légal : la clause telle qu'écrite est **irrégulière** et contredirait le calcul BCE+10 de P12 (le taux réclamable est celui stipulé sur la facture). Exposition double : amende administrative + amende fiscale par mention.

**Solution.** Ajouter « Escompte pour paiement anticipé : néant » (ou le taux, champ Company optionnel), corriger le libellé pénalités en « taux BCE majoré de 10 points » (= le défaut légal, cohérent avec P12), et ajouter un contrôle pre-flight à `issue()` listant en langage simple ce qui manque avant de figer la pièce (`Company.assertCanIssue` ne vérifie aujourd'hui que RCS/RM et adresse ; `issue-invoice.ts` ne fait aucun pre-flight).

**Référence.** Art. L441-9, I C. com (escompte, taux des pénalités, 40 €) ; sanctions : L441-9, II (75 k€ / 375 k€, doublées en réitération) et art. 1737, II CGI (15 €/omission ou inexactitude, plafond ¼ de la facture) ; plancher : L441-10, II.

#### P15 — Compléter les 4 mentions de la réforme

**Problème.** Le décret réforme impose 4 nouvelles mentions ; Bob en couvre 2 (SIREN client, nature d'opération — build-mentions.ts:39/41). Manquent : adresse de livraison si différente (7° bis — vise l'adresse de livraison **des biens**) et « Option pour le paiement de la taxe d'après les débits » (11° bis). En autoliquidation, le n° de TVA intracom du client est requis (I-4°) — or Customer ne le porte pas.

**Solution.** 1) `deliveryAddress` optionnel par pièce (pré-rempli « identique ») → mention auto ; 2) flag `vatOnDebits` → mention exacte (lié à P20) ; 3) dériver la TVA intracom du client français depuis son SIREN avec `frenchVatNumber(siren)` **déjà codée** (`packages/core/src/domain/compliance/facturx.ts:84`) et bloquer l'émission autoliquidée sans SIREN client.

**Référence.** Art. 242 nonies A annexe II CGI (décret 2022-1299 du 7/10/2022) ; applicabilité : art. 91 LF 2024 + décret 2024-266 (émission 1/9/2026 GE/ETI, 1/9/2027 TPE-PME, calendrier maintenu par la LF 2026) ; amende art. 1737, II CGI.

#### P05 — Réception 2026 : parseur Factur-X entrant + « Refuser » conforme

**Problème.** Dès le 1/9/2026, TOUS les assujettis — même en franchise — reçoivent leurs factures d'achat en électronique via plateforme agréée. Bob ne traite les pièces fournisseurs que par OCR probabiliste alors que le XML structuré arrive avec des données certaines ; et l'artisan doit pouvoir **refuser** une facture contestée (statut du cycle de vie), sinon elle reste réputée valable. La LF 2026 a créé l'amende « absence de plateforme de réception » : 500 € après mise en demeure, puis 1 000 €/trimestre (après une seconde mise en demeure).

**Solution.** Parseur CII/Factur-X entrant (inverse exact du générateur) → Expense pré-remplie exacte (fournisseur, SIREN, HT/TVA/TTC par taux, n° de facture, échéance — confiance 1.0) ; l'OCR ne reste que pour le papier. Boutons Approuver / Refuser (motif) produisant les statuts AFNOR (200 Déposée, 210 Refusée, 212 Encaissée, 213 Rejetée). XML archivé au coffre (kind `facturx_xml` existe).

**Construire avec l'existant.** `facturx.ts` (générateur = référence de mapping inverse), `document.ts` (kind facturx_xml), diagnostic `einvoice-reception` (dueDate 2026-09-01), `SupplierMemoryProfile`. À capter : n° facture fournisseur + échéance sur Expense ; flux entrant (V1 import manuel, V2 API PA). Note : `EinvoiceTransmission.refuse()` n'existe que pour le cycle SORTANT.

**Référence.** Art. 289 bis CGI ; norme AFNOR XP Z12-012 (mai 2025) ; LF 2026 (loi 2026-103 du 19/2/2026), art. 123.

#### P22 — Moteur e-reporting : transactions B2C + données de paiement des prestations

**Problème.** Un artisan qui facture des particuliers ou encaisse des prestations devra transmettre périodiquement ses transactions B2C et les données de paiement de ses prestations de services. Chaque transmission manquée = 500 € (LF 2026), plafond 15 000 €/an (tolérance 1re infraction régularisée sous 30 j). Bob possède toutes les données mais ne prépare rien ; sa machine à états ne modélise ni « encaissée » ni son payload.

**Solution.** Dérivation pure `buildEreporting(period)` : (a) récapitulatif B2C par taux (HT/TVA agrégés, périodicité selon régime : réel normal ≥ 3/mois, simplifié ≥ 1/mois, franchise ≥ 1/2 mois) ; (b) par encaissement sur facture de services non autoliquidée : {date, montant ventilé par taux} depuis Payment × vatByRate × operationNatureOf. Étendre `EinvoiceTransmission` aux 4 statuts DGFiP (payload de paiement inclus). Écran « prêt à transmettre » + compteur de retard chiffré en euros.

**Construire avec l'existant.** `einvoice-for.ts` (route b2c → 'ereporting', label seul), `derive-diagnostic.ts:420` (`ereporting_payments` codé done:true sans vérification — à corriger), `state-machines.ts:34-41` (cycle non aligné DGFiP), Payment/vatByRate/operationNatureOf/requiresAutoliquidation.

**Référence.** Art. 290 et 290 A CGI ; décret 2022-1299 (périodicités) ; art. 1788 D CGI (500 €, LF 2026) ; spécifications externes DGFiP v3.1 (31/10/2025).

#### P07 — Connecteur Plateforme Agréée réel

**Problème.** Toute la chaîne e-invoicing est simulée en interne : la frise « Émise→…→Payée » ne parle à aucune plateforme, alors que la réception devient obligatoire au 1/9/2026 et que le plan Free promet « Conforme 2026, gratuitement ». À partir du 1/9/2027, chaque facture B2B émise hors circuit = 50 € d'amende.

**Solution.** Intégrer UNE PA immatriculée (liste DGFiP, ~138 en juin 2026) via son API, Bob agissant en opérateur adossé : dépôt (le Factur-X BASIC est généré et validé), réception des achats (alimente P05), statuts de cycle de vie, consultation de l'annuaire avant émission (« ton client est raccordé via la plateforme X ✓ »). Brancher au passage le Schematron officiel EN 16931 + veraPDF (PDF/A-3) — `facturx-validation.ts:15-16` le demande explicitement.

**Construire avec l'existant.** Générateur Factur-X + ~25 règles EN 16931, `einvoiceChannelFor`, agrégat `EinvoiceTransmission` (machine purement interne), coffre, SIREN Luhn. `apps/api/src/adapters/` ne contient que ban-address, recherche-entreprises, vies-vat. À capter : contrat partenaire PA, webhooks, annuaire.

**Référence.** Art. 289 bis et 290 B CGI ; réception 1/9/2026, émission TPE-PME 1/9/2027 (report par décret possible au plus tard 1/12/2027, art. 91 LF 2024) ; amende 50 €/facture, plafond 15 000 €/an (art. 1737, III CGI, LF 2026, droit à l'erreur 30 j).

### 3.3 Recouvrement & droit commercial

#### P01 — Relances B2C conformes

**Problème (vérifié dans le code).** `build-relance.ts:39-43` envoie la MÊME mise en demeure à tous les clients : elle cite L441-10 et réclame 40 € même à un particulier. Juridiquement infondé (l'indemnité ne pèse que sur un débiteur professionnel), fragilise le dossier devant le juge, expose au reproche de pratique trompeuse. `CustomerType` existe (customer.ts:5) mais le moteur l'ignore (projeté en {id,name} dans apps/api/src/jobs/relance.service.ts:48-64).

**Solution.** Brancher `buildRelance` (et le plan J+3/10/20/30) sur `customer.type` : B2C → modèle fondé sur le code civil (la mise en demeure fait courir les intérêts au taux légal), sans 40 € ni code de commerce ; B2B/B2G → modèle actuel enrichi du compteur P12 (base B2G des 40 € : L2192-13 CCP). Même branchement pour l'outil agent `envoyer_relance` (registry.ts:316 — parité humain↔Bob). Zéro configuration : Bob choisit la bonne lettre.

**Référence.** L441-10, II C. com (débiteurs professionnels) ; art. 1344, 1344-1, 1231-6 C. civ ; D441-5 (40 €, inchangé — le règlement UE à 50 € n'est pas en vigueur).

#### P12 — Pénalités de retard et indemnité 40 € calculées (convergence ×4) **(CORRIGÉ)**

**Problème.** Bob écrit la mention légale mais ne calcule jamais rien : l'artisan ne réclame ni les 40 € ni les intérêts, dus **de plein droit, sans rappel**. Une mise en demeure chiffrée (« 1 628 € + 47,30 € de pénalités + 40 € ») paie bien plus vite qu'un texte générique.

**Corrections du vérificateur.** (1) **Gater sur CustomerType b2b/b2g** : ni 40 € ni BCE+10 pour un particulier (helper `isProfessional`, customer.ts:73) — la phrase « tu peux légalement ajouter 40 € » serait fausse en B2C. (2) **Corriger simultanément la mention** build-mentions.ts:55 (« taux légal » = stipulation sous le plancher 3× taux légal, non conforme, et le taux réclamable est celui stipulé) → stipuler BCE+10 (voir P14). (3) **B2G : taux BCE + 8 points** (L2192-12/13 CCP + décret 2013-269), 40 € dus aussi.

**Solution.** Service domaine pur `computeLatePenalties(facture, typeClient, asOf)` : intérêts = reste dû × taux × jours de retard / 365 ; taux = clause CGV s'il existe, sinon BCE refi + 10 pts, plancher 3× taux légal (B2B) ; BCE + 8 pts (B2G) ; + 40 €/facture (B2B/B2G, jamais B2C, non invocables en procédure collective). Montants injectés dans `buildRelance` et la mise en demeure via le **money-guard existant** (placeholders — le LLM ne peut pas inventer un chiffre, packages/ai/src/guardrails/money-guard.ts), affichés sur la fiche client (« pénalités acquises : X € »), choix conscient « je réclame / geste commercial ». Les taux (BCE refi, taux légal) vivent dans un mini-référentiel semestriel versionné (taux au 1er janvier pour S1, au 1er juillet pour S2 — mécanisme légal exact), jamais en dur. Valeurs : S1 2026 = 12,15 % (BCE 2,15 %) ; S2 2026 à verser au référentiel sur la valeur BCE publiée au 1/7/2026 (les vérifications divergent 12,40 %/12,75 %).

**Construire avec l'existant.** dueAt, netToPay figé, paidCents, `customer.type` (schema.prisma) ; `build-mentions.ts:54-55`, `build-relance.ts:42`, `derive-relance-plan.ts`.

**Référence.** L441-10, II C. com ; D441-5 (indemnité complémentaire sur justification possible) ; L313-2 CMF ; B2G : L2192-12/13 CCP + décret 2013-269 du 29/3/2013.

#### P13 — Garde-fou plafond légal des délais de paiement (convergence ×3)

**Problème (vérifié).** `PaymentTerms.of` accepte tout entier ≥ 0 (`packages/core/src/shared-kernel/payment-terms.ts:11-17`) : un artisan peut saisir « 90 jours » pour un client pro — illégal (amende DGCCRF jusqu'à 75 000 € / 2 M€) — et il subit des délais abusifs sans savoir qu'il est dans son droit.

**Solution.** Validation selon `customer.type` : B2B → avertissement bloquant au-delà de 60 j date d'émission, dérogation 45 j fin de mois seulement si case « stipulé au contrat » cochée ; défaut 30 j ; B2G → 30 j d'office ; B2C exclu du plafond. Préférer l'avertissement bloquant avec dérogation explicite au blocage absolu (factures périodiques 45 j, dérogations sectorielles L441-11 s.). Pédagogie : « tu peux exiger 60 jours max, c'est la loi, pas toi qui es difficile. »

**Référence.** L441-10, I C. com ; L441-16 (75 k€ / 2 M€, doublée en réitération — la PPL Rietmann, votée au Sénat seulement, n'est pas le droit positif) ; R2192-10 CCP.

#### P04 — Chrono prescription par facture **(CORRIGÉ)**

**Problème.** Une facture impayée meurt en silence : l'artisan croit « garder ça sous le coude » en ignorant qu'une relance, même LRAR, n'interrompt pas la prescription en droit privé (Cass. com. 18/5/2022, 20-23.204) — seuls action en justice, exécution forcée ou reconnaissance du débiteur (paiement partiel) l'interrompent.

**Corrections du vérificateur (invalidantes sur la dérivation initiale).** (1) **B2G ≠ 5 ans** : déchéance **quadriennale** (loi 68-1250, art. 1er) = 4 ans à compter du 1er janvier suivant l'année de naissance de la créance, et régime inversé : une simple **réclamation écrite** à l'administration interrompt (art. 2) — le message « une relance n'interrompt jamais » est faux pour les clients b2g. (2) **Point de départ B2C** : depuis Cass. 1re civ. 19/5/2021 (20-12.520, jurisprudence constante), la biennale court de l'**achèvement des travaux**/exécution de la prestation — pas de dueAt. Le schéma n'ayant pas de date d'achèvement (et dueAt nullable), ancrer B2C de façon **conservatrice sur min(date d'émission, dueAt)**.

**Solution.** Dérivation pure par facture encaissable : échéance = (dernier paiement partiel, qui repart le délai, sinon ancre ci-dessus) + 2 ans B2C / 5 ans B2B / règle quadriennale B2G. Alertes « Aujourd'hui » à −6/−3/−1 mois ; le compte à rebours nourrit le score client et le tri du plan de relance.

**Construire avec l'existant.** Invoice.dueAt (nullable, schema.prisma:263), Payment.receivedAt (:313), CustomerType (:31-35). Aucune notion de prescription nulle part (grep vérifié).

**Référence (corrigée).** L218-2 C. conso ; L110-4 C. com ; loi 68-1250 art. 1 et 2 ; art. 2240, 2241, 2244 C. civ ; Cass. 1re civ. 19/5/2021, 20-12.520 ; Cass. com. 18/5/2022, 20-23.204.

#### P08 — Radar procédures collectives BODACC

**Problème.** Client pro en dépôt de bilan → 2 mois à compter de la publication BODACC pour déclarer sa créance, sinon forclusion. Personne ne lit le BODACC à 21 h ; pire, continuer à relancer un client en redressement viole l'arrêt des poursuites individuelles.

**Solution.** Job serveur surveillant les SIREN clients via l'API open data BODACC (DILA, gratuite, licence ouverte, sans clé, dataset « annonces-commerciales »). À la détection d'un jugement d'ouverture : alerte + compte à rebours 2 mois (4 mois hors métropole), suspension automatique du plan de relance, déclaration de créance pré-remplie (principal + pénalités **arrêtées au jugement** via P12, pièces du coffre, adresse du mandataire extraite de l'annonce). Couplage avec P29 (revendication 3 mois).

**Construire avec l'existant.** `Customer.siren` (customer.ts:12), factures/reste dû, coffre (`packages/core/src/domain/document/document.ts` — entité `Document`). L'adapter recherche-entreprises exclut volontairement l'état de cessation ; le plan de relance (`packages/core/src/domain/dunning/`) ignore les procédures collectives.

**Référence.** L622-24, R622-24, L622-26, L622-21, L622-28 C. com (arrêt du cours des intérêts, sauf prêts ≥ 1 an — sans incidence ici). La loi 2026-307 (recouvrement extrajudiciaire simplifié) ne touche pas la déclaration de créance ; les modifications du livre VI (loi 2025-1403) ne valent que pour les procédures ouvertes dès le 1/1/2027.

#### P25 — Dossier injonction de payer prêt à déposer **(CORRIGÉ)**

**Problème.** Le plan de relance s'arrête à la mise en demeure et laisse l'artisan seul face au « et maintenant ? ». Beaucoup abandonnent des créances de 1 000-5 000 € en croyant qu'il faut un avocat — alors que l'injonction se fait sur pièces, sans avocat, ~35 € de frais de greffe, ordonnance exécutoire dès délivrance (exécution forcée après signification + délai d'opposition).

**Corrections du vérificateur.** (1) Plage exacte : **art. 1405 à 1422 CPC** (1423-1424 abrogés au 1/3/2022 par le décret 2021-1322 lui-même). (2) La table code postal → tribunal doit référencer les **12 tribunaux des activités économiques (TAE)** de l'expérimentation 2025-2028 (Avignon, Auxerre, Le Havre, Le Mans, Limoges, Lyon, Marseille, Nancy, Nanterre, Paris, Saint-Brieuc, Versailles). (3) Dans le code, la mise en demeure est au palier **J+45** de relance-plan.ts (J+30 = palier « ferme »).

**Solution.** Nouveau palier « action » proposé si la mise en demeure reste sans effet 15 jours : dossier assemblé depuis le coffre (devis signé, facture, relances, mise en demeure + preuve d'envoi, décompte principal + pénalités P12), requête pré-remplie (juridiction = tribunal de commerce/TAE du lieu du débiteur, art. 1406), guidage vers Tribunal digital. Bob prépare tout, l'humain dépose (plancher de sécurité agent).

**Construire avec l'existant.** relance-plan.ts / build-relance.ts (escalade max = miseendemeure), StoredDocument, NotificationJob. À capter : preuve d'envoi opposable (LRE partenaire) + table juridictions.

**Référence (corrigée).** Art. 1405-1422, 1406, 1416 CPC ; décret 2021-1322 du 11/10/2021 ; expérimentation TAE : loi 2023-1059 + arrêté du 5/7/2024.

#### P26 — Retenue de garantie 5 %

**Problème.** Marchés privés de travaux : jusqu'à 5 % retenus, restituables un an après la réception sauf opposition motivée — personne n'y pense 12 mois plus tard. 2 000 € oubliés sur un chantier de 40 000 €.

**Solution.** Mini-agrégat `RetenueGarantie` : à l'émission d'une situation/facture finale BTP, saisie du % (plafonné à 5 % par le domaine) et de la date de réception ; date de libération = réception + 1 an ; ligne « + retenues à récupérer » dans l'écran Argent (`build-ledger-view`) ; à J−30 et J0, courrier de demande de restitution (ou mainlevée de caution). Pédagogie : proposer la caution bancaire dès le devis.

**Construire avec l'existant.** `InvoiceKind` inclut 'situation' et 'final' (`packages/core/src/domain/billing/invoice/invoice.ts`) mais aucun champ retenue ; 'retenue_garantie' n'existe que comme ModuleKey produit (`trade-profile.ts`, palier pro / Pack BTP). À capter : % + date de réception par pièce.

**Référence.** Loi 71-584 du 16/7/1971, art. 1er et 2 (texte d'ordre public inchangé).

#### P29 — Clause de réserve de propriété automatique

**Problème.** La pompe à chaleur à 12 000 € livrée chez un pro qui dépose le bilan = créancier chirographaire. Avec une clause écrite au plus tard à la livraison, revendication possible dans les 3 mois de la publication du jugement.

**Solution.** Extension `buildMentions` : dès qu'une pièce contient une ligne `supply`, clause automatique sur devis ET facture (« Les marchandises et matériels livrés restent la propriété du vendeur jusqu'au paiement intégral du prix — art. 2367 C. civ »). Couplage P08 : en procédure collective, rappel du délai de 3 mois + demande en revendication préparée. Réserve pratique : le bien doit se retrouver **en nature** (un matériel incorporé à l'immeuble peut y échapper) — la clause reste valable, le couple devis signé + facture satisfait l'écrit antérieur à la livraison.

**Construire avec l'existant.** `LineCategory 'supply'` (`line-item.ts:3`), `operationNatureOf`, gel des mentions à l'émission. Rien à capter.

**Référence.** Art. 2367 C. civ ; L624-16 et L624-9 C. com.

### 3.4 Trésorerie & provisions

#### P03 — Provision URSSAF micro + déclaration pré-calculée (convergence ×2)

**Problème.** Le « Disponible prudent » **ment** pour un micro-entrepreneur : la ligne cotisations du ledger est codée `null` (TODO C40 explicite, `build-ledger-view.ts:154`) — 12,3 à 25,6 % du CA encaissé s'affiche comme dépensable. Et à 21 h, il ne sait pas quel chiffre saisir sur autoentrepreneur.urssaf.fr (CA **encaissé**, pas facturé) ; oubli ≈ 60 €/déclaration (1,5 % du PMSS 2026 = 4 005 €), taxation d'office à répétition.

**Solution.** À chaque Payment encaissé : provision micro-sociale selon la nature d'activité dérivée des catégories de lignes des factures rattachées (supply → ventes 12,3 % ; labor/services → prestations BIC 21,2 % ; BNC non réglementé 25,6 % ; Cipav 23,2 %) + 1/1,7/2,2 % si versement libératoire. Alimente `cotisationsCents` du ledger et crée la **sortie datée** à la prochaine échéance (mensuelle ou trimestrielle : 30/4, 31/7, 31/10, 31/1 ; 1re déclaration après 90 j). Écran déclaration : « À déclarer avant le 31 juillet : 4 320 € → ~916 € de cotisations. » Message au fil de l'eau : « J'ai mis 212 € de côté pour l'URSSAF sur cet encaissement. »

**Construire avec l'existant.** Payment (amount, receivedAt), LineItem.category (via Invoice.lines), legalForm 'micro' (schema.prisma) ; `build-ledger-view.ts` (TODO C40) ; `projectCashflow` (ne déduit que TVA + charges). À capter : périodicité URSSAF + option VFL (2 questions d'onboarding).

**Référence.** Art. D613-4 CSS (décret 2025-943 du 8/9/2025 : taux 2026 = 12,3 / 21,2 / **25,6** (abaissé vs 26,1 % du décret 2024-484) / 23,2 %) ; art. L613-8 CSS (déclaration même à 0 €) ; art. 151-0 CGI (VFL).

#### P16 — Balance âgée + DSO en langage simple

**Problème.** Aucune vue « qui me doit quoi depuis combien de temps » : le score existe par client, mais ni balance âgée globale ni DSO.

**Solution.** Balance âgée automatique (non échu / 1-30 / 31-60 / 61-90 / +90 j) sur netToPay − paid, avoirs en déduction ; DSO roulant 3 mois traduit sans jargon (« tes clients te paient en 52 jours, 12 de plus qu'au printemps — ~4 800 € immobilisés en permanence ») ; suggestion des relances existantes pour les tranches 61-90 et +90. Le volet garde-fou 60 j est porté par P13.

**Construire avec l'existant.** invoices (issuedAt, dueAt, netToPay, paidCents, kind), payments (receivedAt) ; `score-customer.ts`, `derive-relance-plan.ts` (tri des échues) ; `build-ledger-view.ts` calcule déjà netToPay − paid avec avoirs en négatif, sans tranches. Rien à capter.

#### P19 — Provision CFE lissée + 1447-C + rappels 15/6 et 15/12 (convergence ×2)

**Problème.** La CFE tombe le 15 décembre, en plein creux BTP, sans prélèvement automatique, avec un avis dans un espace impots.gouv jamais ouvert ; l'acompte du 15 juin surprend l'année où la CFE N-1 dépasse 3 000 €. Et tout créateur, exonéré l'année de création, doit quand même déposer la **1447-C avant le 31/12** — quasi inconnu.

**Solution.** Capter la CFE N-1 (une question ou scan de l'avis via le pipeline OCR + coffre existants) ; sorties datées : solde 15/12, acompte 50 % au 15/6 si N-1 ≥ 3 000 € ; provision lissée (« 65 €/mois de côté ») dans ledger et prévisionnel. Timeline création dérivée de `dateCreation` : 0 € l'année 1, dépôt 1447-C pré-rempli (SIRET, adresse, surface à confirmer), base réduite de moitié l'année suivante. Si CA ≤ 5 000 € : « tu es exonéré de la cotisation minimum » (⚠ CA apprécié sur la période de référence N-2, art. 1467 A).

**Construire avec l'existant.** `makeOcrExtraction` (ocr-extraction.ts:173), StoredDocument (schema.prisma:377), `Company.dateCreation` (company.ts:48). Aucune notion d'impôt local dans le code aujourd'hui.

**Référence.** Art. 1679 quinquies, 1478 II, 1647 D, 1467 A CGI ; dépôt 1447-C-SD au plus tard le 31/12 de l'année de création.

#### P27 — Prévisionnel 90 jours daté avec détection du point bas

**Problème (vérifié).** `projectCashflow` lisse tout par un facteur horizon/90 (project-cashflow.ts, RECEIVABLE_FACTOR 1/0,9/0,8 l.13, horizonFactor l.20) : il peut afficher « vert à 30 jours » alors qu'un trou de 10 jours existe au 15 du mois. C'est le **point bas** qui déclenche l'agio et le rejet de prélèvement URSSAF (majoration R243-18 CSS : 5 % + 0,2 %/mois), pas la moyenne.

**Solution.** Courbe datée jour par jour sur 90 j : encaissements aux dueAt pondérés par le score client réel (ScoreBand green/orange/red, `domain/customer/score.ts:3`) ; sorties datées = dépenses to_pay + échéanciers TVA (P06), URSSAF (P03), CFE (P19), IS (P23). Détection et affichage du point bas : « −340 € le 17 décembre — décale l'achat de matériaux ou relance Martin avant. » `cashflowBand` (tranquille/passe/creux/repart) reste la lecture simple par-dessus. Limite assumée : solde de départ = ledger interne (512/530), pas de connexion bancaire DSP2.

**Construire avec l'existant.** project-cashflow.ts, cashflow-band.ts, get-cashflow.ts, build-ledger-view.ts (photo instantanée), score-customer.

#### P34 — « Te verser » teinté par la forme juridique **(CORRIGÉ)**

**Problème.** Le « te verser ~2 000 € » est identique pour un micro, un gérant majoritaire d'EURL et un président de SASU, alors que les conséquences n'ont rien à voir (cotisations TNS sur dividendes au-delà de 10 % du capital ; ~45 % de cotisations sur la rémunération de gérance avec régularisation N+1 ; flat tax sans droits retraite).

**Correction du vérificateur.** La référence « art. L131-6, III CSS » est **périmée** depuis le 1/1/2025 : la LFSS 2024 (loi 2023-1250, art. 18) a réécrit L131-6 (plus de III) qui renvoie à l'assiette unifiée de l'art. **L136-3 CSS**, où figure la réintégration des revenus distribués (art. 108-115 CGI) et intérêts de compte courant (art. 124, 4°) excédant 10 % du capital + primes d'émission + comptes courants. Citer : « art. L131-6 et L136-3 CSS (rédaction LFSS 2024, applicable aux cotisations dues à compter du 1/1/2025) ». Détail : le PFU 2026 à 31,4 % vient d'un relèvement de la **CSG capital de 1,4 pt (9,2 → 10,6 %)** par la LFSS 2026, pas d'une contribution distincte.

**Solution.** Teinter le payout selon `legalForm` : micro/EI → « c'est ta rémunération, l'URSSAF est déjà mise de côté » (avec P03) ; EURL/SARL gérant majoritaire → alerte règle des 10 % + provision TNS + régularisation N+1 ; SAS/SASU → PFU 31,4 % (12,8 % IR + 18,6 % PS) et absence de protection sociale. V1 sobre : règle des 10 % + PFU, pas de simulateur d'optimisation.

**Construire avec l'existant.** legalForm persistée (company.ts), computePayout/projectCashflow (montant unique aujourd'hui). À capter : capital social (une question, pré-remplissable via lookup entreprise).

### 3.5 Obligations déclaratives & échéancier fiscal

#### P09 — Moteur d'échéances fiscales `deriveFiscalCalendar` **(CORRIGÉ)**

**Problème.** L'artisan ne sait ni quoi déclarer ni quand, et les dates changent du tout au tout selon la forme (EI micro : URSSAF mensuelle + 2042-C-PRO ; SASU IS : 4 acomptes + solde + liasse). Échéance ratée = 10 % d'office. Seul le calendrier e-invoicing est codé en dur (`diagnostic.ts`).

**Correction du vérificateur.** La dispense d'acomptes d'IS pour impôt de référence faible n'est pas à l'art. 1668, 1 mais au **3 de l'art. 359 de l'annexe III au CGI**, et la borne est « **n'excède pas 3 000 €** » (dispense aussi à exactement 3 000 €). L'art. 1668, 1 porte les acomptes trimestriels et la dispense du premier exercice.

**Solution.** Use case pur `deriveFiscalCalendar(company, today)` → liste typée d'échéances sur 12 mois glissants (même union discriminée que TodayPriority, nourrit l'écran Aujourd'hui et les notifications C25). Règles par forme : EI micro → URSSAF + 2042-C-PRO ; EI réel → liasse 2031/2035 au 2e jour ouvré suivant le 1er mai (+15 j télétransmission) ; société IS → acomptes 15/3-15/6-15/9-15/12, solde (voir P23), liasse 2065 dans les 3 mois de la clôture ; + CFE (P19) et TVA (P06) selon vatRegime.

**Construire avec l'existant.** Company.legalForm/dateCreation/vatRegime (schema.prisma:167-205, lookup SIRET). À capter : date de clôture (défaut 31/12 — champ partagé avec P23/P31), régime d'imposition réel (l'enum LegalForm mélange « micro », un régime, avec les formes juridiques — piège documenté dans `nature-juridique.ts:9-10`), périodicité URSSAF.

**Référence (corrigée).** Art. 1668, 1 CGI ; art. 359, 3 annexe III (dispense ≤ 3 000 €) ; art. 360 bis annexe III ; art. 223, 1 CGI ; art. 1728, 1-a CGI.

#### P23 — Provision IS automatique + rappel des 4 acomptes **(CORRIGÉ)**

**Problème.** Le président de SASU se verse tout et découvre l'IS au solde de mai — première cause de trou de trésorerie de 2e année. `projectCashflow` provisionne 50 % de la TVA mais ignore l'IS.

**Corrections du vérificateur.** (1) Base légale du solde : **art. 1668, 2 CGI + art. 360 annexe III** (l'art. 360 bis ne fixe que les 4 acomptes). (2) Règle du solde à implémenter : **15 du 4e mois suivant la clôture, SAUF clôture au 31/12 (ou aucun exercice clos) → 15 mai** — sinon l'app afficherait le 15/4 à toutes les SASU en exercice civil. (3) Le 1er acompte (15/3) est assis sur l'IS N-2 puis régularisé au 2e (simplification « ¼ de l'IS N-1 » acceptable). Le plafond 42 500 € du taux réduit est maintenu par la LF 2026 (l'amendement à 100 000 € n'a pas été retenu).

**Solution.** Pour les legalForm sociétés : estimation du résultat courant depuis les écritures (crédits classe 7 − débits classe 6), 15 % jusqu'à 42 500 € puis 25 %, ligne « Mets ~1 150 € de côté pour l'impôt société » dans le ledger et la réserve du payout. Rappels des acomptes avec dispenses automatiques affichées (IS de référence ≤ 3 000 € ; première année).

**Construire avec l'existant.** AccountingEntry/AccountingEntryLine par compte (schema.prisma:506-558, alimentées par invoice-accounting et payment-accounting) ; `summarize-accounting-entries.ts` (agrégat sans notion de résultat). À capter : date de clôture + IS N-1 (une saisie, puis dérivé après un exercice complet).

**Référence (corrigée).** Art. 219, I-b et I CGI ; art. 1668, 1 et 2 CGI ; art. 359, 3 et 360/360 bis annexe III CGI.

#### P18 — Vigie DAS2 (seuil 2 400 €) **(CORRIGÉ)**

**Problème.** Payer plus de 2 400 €/an à un même comptable, bureau d'études ou architecte impose la DAS2 — obligation quasi inconnue, amende de 50 % des sommes non déclarées. Le seuil n'est plus 1 200 € : doublé à 2 400 € pour les sommes versées depuis 2024.

**Corrections du vérificateur (invalidantes sur le déclencheur initial).** (1) **La DAS2 ne vise pas la sous-traitance de travaux BTP en bloc** : l'art. 240 CGI limite le champ aux rémunérations d'actes n'ayant pas le caractère d'actes de commerce ; déclencher sur la catégorie `sous_traitance` créerait des faux positifs massifs. Cibler les paiements de type **honoraires** (comptes 622) et marquer la sous-traitance indépendante douteuse « à vérifier avec ton comptable ». (2) La catégorie `honoraires` est un **prérequis**, pas une option : l'enum ExpenseCategory (expense.ts:5-11) ne la contient pas, `sous_traitance` est mappée au compte 611 (expense-accounting.ts:44) — aucune écriture 622 n'est générée aujourd'hui. (3) La DAS2 se dépose **séparément** en téléprocédure (EFI/EDI ou DSN) à la même échéance que la liasse.

**Solution.** Ajouter la catégorie `honoraires` (→ 622), cumul annuel par bénéficiaire (clé supplierSiren sinon supplierName normalisé) ; au franchissement de 2 400 €, item « DAS2 à télédéclarer » avec liste pré-remplie (nom, SIREN, cumul) ; pédagogie : « première infraction régularisée = pas d'amende ».

**Construire avec l'existant.** Expense (supplierName, supplierSiren Luhn, totalTtcCents, documentDate), SupplierMemoryProfile (schema.prisma:358-375), compte 622 seedé (chart-of-accounts.ts:277).

**Référence (corrigée).** Art. 240/241 CGI ; seuil 2 400 € (BOFiP ACTU-2024-00154 du 26/6/2024 ; BOI-BIC-DECLA-30-70-20, màj 12/2/2025) ; amende art. 1736, I-1 CGI (tolérance 1re infraction régularisée) ; échéance : 2e jour ouvré suivant le 1er mai.

#### P31 — Rituel annuel des sociétés : approbation + dépôt des comptes **(CORRIGÉ)**

**Problème.** Le gérant d'EURL/SASU ignore le rituel approbation + dépôt au greffe. Sanctions réelles : 1 500 € (R247-3), injonction sous astreinte (L611-2, II), et un dossier « comptes non déposés » qui grille la crédibilité bancaire.

**Corrections du vérificateur.** (1) Pour la persona visée (associé unique **dirigeant**), le PV n'est pas nécessaire : le **dépôt vaut approbation** (L223-31 al. 2 EURL ; L227-9 dern. al. SASU) → UN seul rappel « dépose tes comptes avant le 30 juin (6 mois après clôture) » ; le flux à deux rappels (approbation puis dépôt sous 1 mois / 2 mois en ligne) ne s'impose que si l'associé unique n'est pas le dirigeant. (2) Confidentialité L232-25 : comptes **entiers** = micro-entreprises seulement (bilan ≤ 450 k€, CA ≤ 900 k€, ≤ 10 salariés) ; les petites entreprises ne peuvent rendre confidentiel que le **compte de résultat** ; déclaration jointe **au moment du dépôt**. Le régime est inchangé au 1/7/2026 (extension censurée par le CC, déc. 2026-903 DC du 21/5/2026). (3) Base EURL : L223-31 (pas L223-26, réservé à la SARL pluripersonnelle).

**Solution.** Dérivé de legalForm société + date de clôture : rappel(s) daté(s) en langage simple selon la configuration associé unique/dirigeant, dépôt via guichet unique INPI, option de confidentialité proposée systématiquement selon la taille.

**Référence (corrigée).** L223-31, L227-9, L232-22, L232-23, L232-25, R247-3, L611-2 II C. com.

### 3.6 Data & dossier comptable

#### P17 — Détection de doublons de dépenses

**Problème.** Ticket scanné en photo puis reçu en PDF = deux dépenses : charges gonflées, TVA déduite deux fois (rappel + intérêts en contrôle), « disponible prudent » faussé. LE grand classique des apps de scan ; rien ne le détecte.

**Solution.** À la validation de chaque OCR : contrôle croisé (SIREN ou nom normalisé) + TTC identique + date ±3 j → carte « doublon ? » avec fusion en un clic ; doublon binaire exact gratuit via le sha256 des StoredDocument. Bonus : anomalies fournisseur via la mémoire apprise (taux de TVA inhabituel, montant > 3× la moyenne) → badge « inhabituel ».

**Construire avec l'existant.** Expense (schema.prisma:342-345), SupplierMemoryProfile (vatRatePct, seen), StoredDocument.sha256 (:387) ; les garde-fous OCR sont intra-document uniquement (ocr-extraction.ts : grounding l.160-162, HT+TVA=TTC l.209-222, plafond 1 M€ l.66) ; `record-expense.ts` crée sans lookup. Rien à capter.

#### P24 — Lettrage automatique 411 + dossier de clôture **(CORRIGÉ)**

**Problème.** Le FEC exporté laisse EcritureLet/DateLet vides alors que chaque Payment est déjà relié à sa facture : l'expert-comptable refait à la main un lettrage que Bob connaît — du temps facturé à l'artisan pour rien.

**Corrections du vérificateur.** EcritureLet/DateLet = **colonnes 14 et 15** du FEC (pas 11-12). Des colonnes vides ne rendent pas le FEC non conforme quand le lettrage n'est pas pratiqué — l'argument valide est le **gain de temps de l'expert-comptable**. Si EcritureLet est rempli, DateLet doit l'être aussi (convention « date du paiement soldant » acceptable).

**Solution.** Lettrage dérivé de `payment.invoiceId` : même lettre sur l'écriture de vente et ses encaissements, DateLet = date du paiement soldant. Autour : « dossier de clôture » téléchargeable — FEC + balance + grand livre + pièces jointes (StoredDocument par sourceId, empreinte SHA-256) + liste honnête des trous (« 2 dépenses sans justificatif ») que Bob relance.

**Construire avec l'existant.** `export-fec.ts` (émet EcritureLet/DateLet vides, l.120-121), Payment.invoiceId (schema.prisma:309), AccountingEntry.sourceType/sourceId (:530-531).

**Référence (corrigée).** LPF art. A. 47 A-1 (18 champs ; positions 14-15) ; LPF art. L. 47 A, I (remise du FEC en contrôle — l'obligation survit à la version du 1/9/2026).

#### P33 — Charge ou immobilisation ? Seuil 500 € HT **(CORRIGÉ)**

**Problème.** La perceuse à 890 € part en charge « matériel » alors que c'est une immobilisation à amortir (réintégration + intérêts en contrôle) ; à l'inverse, immobiliser des petites fournitures complique tout pour rien.

**Correction du vérificateur.** Le compte **2154 n'est pas seedé** dans `chart-of-accounts.ts` (le plan opérationnel seed **215** et 2183, avec 2815/28183/28184/2805 et dotation 6811) ; comme `AccountingEntry.create` valide les comptes contre le plan, une écriture au 2154 serait rejetée → poster en 215/2183 ou étendre le seed. ⚠ `totalHtCents` est nullable et c'est un total de pièce, pas un prix unitaire.

**Solution.** Dépense `materiel` > 500 € HT unitaire → proposition en langage simple d'inscription en 215/2183 avec plan d'amortissement linéaire (durée pré-suggérée par famille), dotations annuelles 68x/28x. Sous 500 € : charge immédiate, zéro friction. Exclusion si le matériel constitue l'objet même de l'activité ; plafond apprécié sur le prix global d'un ensemble indissociable.

**Référence.** BOI-BIC-CHG-20-30-10 (version 1/3/2017, seuil inchangé) ; BOI-BIC-CHG-20-10-20.

#### P28 — Marge réelle par chantier

**Problème.** Le plombier découvre chez son comptable, des mois plus tard, qu'un chantier lui a fait perdre de l'argent. Toutes les briques existent (devis signé, acompte, situations, facture finale ; dépenses OCR) mais rien ne les relie.

**Solution.** Persister la table Chantier + `chantierId` optionnel sur Expense/Quote/Invoice (migration Prisma) : les pièces de vente se rattachent via `parentQuoteId` ; au scan d'une dépense, Bob **suggère** le chantier (client récent, mémoire fournisseur, chantiers ouverts). Marge = facturé HT − dépenses imputées HT ; alerte de dérive : « les achats ont consommé 78 % du budget, le chantier est facturé à 40 % » (avancement via `situationProgressPct`, build-piece-view.ts:131 — ⚠ calculé en TTC).

**Construire avec l'existant (vérifié : moins coûteux qu'annoncé).** Un agrégat Chantier + use case CreateChantier + endpoints existent déjà côté core/API mais en persistance **in-memory** (backend.service.ts:279 « persistance Prisma = incrément suivant ») ; module produit 'chantiers' déjà gaté Solo/Pack BTP (plan.ts). ⚠ `Expense.totalHtCents` nullable : prévoir un repli si l'OCR ne capte que le TTC.

**Référence.** Aucune (comptabilité analytique de poche — aucune obligation légale).

---

## 4. Découpage suggéré en claims (protocole `design_handoff_bob_pro/CLAIMS.md`)

Six claims cohérents, quick-wins d'abord. Les numéros P## renvoient au tableau de la section 2.

### C-EXP1 — `conformite-pieces` : mentions & délais légaux (quick-wins purs)
**Contenu** : P14 (escompte + correction taux pénalités + pre-flight), P15 (4 mentions réforme), P11 (mention taux réduits), P29 (réserve de propriété), P13 (garde-fou 60 j/45 j fdm).
**Périmètre** : extensions de `build-mentions.ts`, `payment-terms.ts`, `Company.assertCanIssue`/`issue-invoice.ts` ; 3 petits champs à capter (taux d'escompte, deliveryAddress, vatOnDebits + case « stipulé au contrat »). Zéro nouvelle table.
**Acceptance (esquisse)** : toute facture émise porte escompte + taux BCE+10 + 40 € ; ligne 10 %/5,5 % → mention certifiante présente sur devis ET facture ; ligne supply → clause 2367 ; PaymentTerms > 60 j (B2B sans dérogation cochée) → avertissement bloquant ; émission autoliquidée sans SIREN client → bloquée ; pre-flight liste les manques en langage simple. Tests domaine purs sur chaque mention.

### C-EXP2 — `recouvrement-conforme` : chiffrer, différencier, ne rien laisser mourir
**Contenu** : P01 (relances B2C — **à faire en premier, risque actif**), P12 (computeLatePenalties B2B/B2G + référentiel semestriel), P16 (balance âgée + DSO), P04 (chrono prescription).
**Périmètre** : `computeLatePenalties` en domaine pur + référentiel 2 taux versionné ; branchement de `build-relance`/`derive-relance-plan`/outil `envoyer_relance` sur customer.type ; agrégats balance âgée/DSO ; dérivation prescription (ancres corrigées : min(émission, dueAt) B2C, quadriennale B2G).
**Acceptance (esquisse)** : une mise en demeure B2C ne cite jamais L441-10 ni 40 € ; une relance B2B affiche des montants issus du money-guard uniquement ; les pénalités sont arrêtées à la date du jugement si le client est en procédure ; alerte prescription à −6/−3/−1 mois dans « Aujourd'hui ».
**Extensions chantier (claims ultérieurs)** : P08 (radar BODACC), P25 (injonction de payer), P26 (retenue de garantie).

### C-EXP3 — `vigie-seuils-anomalies` : les compteurs que personne ne tient
**Contenu** : P02 (vigie franchise 293 B, avec prorata création et ventilation biens/services), P30 (coefficients carburant), P17 (doublons de dépenses), P18 (DAS2 honoraires — prérequis : catégorie `honoraires` → 622), P19 (CFE), P31 (rituel sociétés).
**Périmètre** : dérivations pures sur données existantes + 3 captures légères (type de véhicule, CFE N-1, date de clôture) ; alimente l'écran Aujourd'hui via TodayPriority.
**Acceptance (esquisse)** : CA cumulé vs 4 seuils recalculé à chaque émission, alerte 80 %/95 %, blocage du 0 % au franchissement du seuil majoré + détection des factures à refaire ; dépense carburant VP → 80 % de TVA seulement ; 2 scans du même ticket → carte doublon ; cumul honoraires ≥ 2 400 € → item DAS2.

### C-EXP4 — `moteur-tva` : de l'exigibilité aux brouillons CA3/CA12
**Contenu** : P20 (exigibilité encaissements/débits), P06 (feuille TVA par période + échéancier + rapprochement), P21 (autoliquidation preneur), P32 (simulateur 293 F), P10 (fin RSI 2027 — bascule **trimestrielle de plein droit**).
**Périmètre** : moteur d'exigibilité dans `invoice-accounting`/ledger ; `buildVatReturn(period)` en application/argent, cohérent avec `derive-vat-position.ts` (même logique d'encaissements — jamais deux chiffres différents à l'écran) ; échéances datées injectées dans projectCashflow.
**Acceptance (esquisse)** : facture de services impayée → TVA non provisionnée comme exigible ; brouillon CA3 = rapproché au centime des écritures 4457x ; acompte de juillet/décembre daté et provisionné ; dépense sous_traitance sans TVA → écriture d'autoliquidation générée après confirmation ; tenant reel_simpl → bannière compte à rebours 2027 avec simulation trimestrielle.

### C-EXP5 — `argent-date` : échéancier fiscal & provisions (le solde ne ment plus)
**Contenu** : P09 (deriveFiscalCalendar), P03 (URSSAF micro), P23 (provision IS), P34 (payout par forme juridique), P27 (prévisionnel 90 j point bas), P28 (marge par chantier).
**Périmètre** : une seule question d'onboarding (date de clôture) débloque P09/P23/P31 ; provisions datées URSSAF/IS/CFE/TVA convergent dans build-ledger-view (TODO C40 soldé) et la courbe datée remplace le lissage horizon/90.
**Acceptance (esquisse)** : encaissement d'un micro → provision URSSAF au bon taux (12,3/21,2/25,6/23,2 + VFL), sortie datée à la prochaine échéance ; société IS → ligne de réserve IS et 4 acomptes datés (solde 15/5 pour clôture 31/12 — règle dérogatoire codée) ; point bas affiché avec date et action suggérée ; « te verser » teinté selon legalForm.

### C-EXP6 — `e-facturation-niveau-2` : du simulé au réel + dossier comptable
**Contenu** : P05 (parseur Factur-X entrant + refus), P22 (moteur e-reporting), P07 (connecteur PA), P24 (lettrage FEC + dossier de clôture), P33 (immobilisations 500 €).
**Périmètre** : parseur CII entrant (mapping inverse de facturx.ts), extension EinvoiceTransmission aux statuts AFNOR 200/210/212/213 avec payload, intégration API d'une PA immatriculée + annuaire + Schematron officiel/veraPDF ; FEC colonnes 14-15 remplies + export dossier de clôture.
**Acceptance (esquisse)** : import d'un Factur-X reçu → Expense exacte confiance 1.0, XML archivé au coffre ; refus avec motif → statut 210 émis ; buildEreporting(period) produit les agrégats B2C et les données de paiement des services ; FEC : toute vente encaissée porte une lettre de lettrage et sa DateLet ; dépôt d'une facture émise sur la PA de test sans rejet.

**Ordre de lancement conseillé** : C-EXP1 et le volet P01/P12 de C-EXP2 immédiatement (risques juridiques actifs, zéro dépendance) → C-EXP3 (différenciation immédiate, données en place) → C-EXP4/C-EXP5 en parallèle (partagent la question « date de clôture » et l'échéancier) → C-EXP6 (dépend d'un contrat PA, à initier tôt pour le calendrier 1/9/2026).

---

## 5. Annexe — propositions réfutées (mémoire anti-résurgence)

| Proposition | Expert | Raison de la réfutation |
|---|---|---|
| **Écriture d'achat automatique (60x / 44566 / 401)** — « chaque dépense scannée entre vraiment dans les livres » | Data-IA comptable | **Déjà couvert par le code** : le commit `693f6f6` (E1 — cycle achats comptabilisé, journal AC + décaissements BQ) a livré exactement le miroir demandé — `packages/core/src/domain/accounting/expense-accounting.ts` contient `buildRecordedExpenseAccountingEntry` (débit 6xx, débit 44566 si TVA, crédit 401 ; mapping des 6 catégories) et `buildExpensePaymentAccountingEntry` (401/512), orchestrés par le use case idempotent `RecordExpenseAccountingEntries` câblé dans `packages/api-client/src/local-client.ts` (l.258, l.585). L'affirmation-pivot « aucun builder dépense→écriture n'existe » est fausse dans l'arbre actuel, tout comme « build-ledger-view lit la TVA déductible directement des dépenses » (il la calcule depuis les écritures 44571 vs 44566/44562). **Reliquat réel conservé** : le builder poste 100 % de la TVA en 44566 même pour `category='carburant'` sans flag VP/VU — repris dans **P30** comme amendement étroit du builder existant, pas comme création d'un builder. La référence légale de la proposition (art. 298, 4-1° CGI) était, elle, exacte. |

**Doublons fusionnés (pour mémoire)** : la vigie franchise a été proposée indépendamment par 4 experts (fusionnée en P02), les pénalités de retard par 4 (P12), le moteur CA3/CA12 par 4 (P06), le garde-fou 60 jours par 3 (P13), la CFE et l'URSSAF micro par 2 chacune (P19, P03) — convergence qui confirme la priorité de ces chantiers. Toute proposition future identique à celles-ci doit être rapprochée du présent rapport avant instruction.

---

*Rapport établi le 3 juillet 2026. Références vérifiées entre le 1er et le 4 juillet 2026 (Légifrance, BOFiP, service-public.gouv.fr, economie.gouv.fr). Les corrections du vérificateur adversarial priment sur les fiches d'experts initiales ; les items marqués **(CORRIGÉ)** signalent les références ou mécanismes rectifiés.*

---

## Suivis post-livraison (évalués le 4 juillet 2026, directive fondateur)

Évaluation des TODO résiduels des claims livrés (C-EXP1/2vA/5/5b/5c) — chaque item classé « à faire » entre dans un claim ou la v2 des moteurs ; les comportements conformes sont documentés pour ne pas resurgir.

| TODO | Verdict | Où |
|---|---|---|
| `FiscalDeadline.amountHint` figé à `null` (l'échéance URSSAF n'affiche pas « ~2 629 € » alors que `deriveUrssafProvision` sait le calculer) | **IMPORTANT — doctrine « Bob FAIT »** : une date sans montant est une alerte, pas une préparation. Élargir le type à `number \| null` (il traverse core→api→api-client→ai : attendre la fin du WIP session B sur packages/ai) puis brancher le module URSSAF. | **Claim C-EXP-UI2** |
| Rangée « cotisations » de l'écran Argent toujours `null` + `reserve` sans les cotisations (le câblage `company/payments/asOf` → `buildLedgerView` n'est pas fait) | **IMPORTANT — la moitié visible de P03** : la provision existe, l'artisan ne la voit pas ; le « Disponible prudent » ment encore aux micro. | **Claim C-EXP-UI2** |
| Décalage de la 1ʳᵉ déclaration URSSAF (~90 j après la création — pas d'échéance avant) non modélisé | **IMPORTANT pour la cible acquisition** (créateurs) : afficher une échéance trop tôt à un nouvel inscrit = fausse information au premier contact. Ancrer sur `dateCreation` (en BDD depuis C24b). | **v2 moteurs fiscaux** (deriveFiscalCalendar + deriveUrssafProvision) |
| Remboursements > encaissements → CA plancher 0 sans report sur la période suivante | **CONFORME, rien à faire** : le micro-social ne connaît ni CA négatif ni report d'une période sur l'autre — le plancher 0 est le comportement réglementaire exact. Documenté ici pour éviter la resurgence. | — |
