# AUDIT INDISPENSABLES MÉTIER — verdict du 2026-07-19

Balayage 3 angles (réglementaire FR, terrain BTP, terrain IT/services), chaque manque VÉRIFIÉ dans le code
(8 re-vérifications lourdes : zéro faux positif). À trancher fondateur + challenge GPT, puis MAJ
PROGRAMME_V1_PUBLICATION.md. Réf : SPEC_AVENANTS.md (avenants déjà actés V1 par le fondateur).

## GROUPE A — OBLIGATIONS LÉGALES (non négociables pour publier)

### A1 — Mentions légales sur le devis (PDF + page de signature sign-web) [M]
Source : Art. L243-2 code des assurances (décennale sur devis ET factures, amende 3 000 €) ; art. 293 B CGI (franchise) ; art. 41 LF 2025 (certification taux réduits 10/5,5 % portée par le devis signé, remplace le Cerfa depuis le 16/02/2025) ; arrêté du 24/01/2017 (date d'établissement, caractère gratuit/payant)
Spec : Ajouter mentions: string[] à QuotePdfData et appeler buildMentions(kind:'quote') — code déjà écrit et testé mais mort (seul issue-invoice.ts l'appelle, vérifié) — dans renderQuote (apps/api/src/documents/pdf-renderer.ts) ET dans SignatureView (apps/sign-web/app/sign/[token]/page.tsx, zéro mention aujourd'hui) ; ajouter la date d'établissement à l'agrégat Quote (seul validUntil existe, vérifié quote.ts).

### A2 — Médiateur de la consommation (profil + mention auto B2C) [S]
Source : Art. L612-1 et L616-1 code de la consommation — adhésion obligatoire + coordonnées sur devis/factures ; amende administrative jusqu'à 3 000 € (pers. physique) / 15 000 € (pers. morale)
Spec : Deux champs au profil entreprise (nom + coordonnées du médiateur), mention générée par buildMentions quand customer.type === 'b2c' sur devis et factures, nudge d'onboarding « as-tu un médiateur ? » ; vérifié : zéro occurrence produit (seule la lettre de mission cabinet en parle).

### A3 — Droit de rétractation 14 jours B2C hors établissement / à distance [M]
Source : Art. L221-18 s. et L221-28 code conso, formulaire type annexe art. R221-1 ; sanctions : délai porté à 12 mois, nullité, travaux exécutés non payables (jurisprudence constante)
Spec : Bloc d'information + formulaire détachable de rétractation sur le devis B2C, régime déclenché par le canal de signature déjà distingué (onsite_draw / remote_link dans sign-quote.ts), case « demande d'exécution anticipée » avec renonciation tracée, gel du passage devis→facture pendant le délai ; vérifié : grep rétractation/L221 vide dans tout le produit.

### A4 — Factur-X autoliquidation : catégorie AE au lieu de Z [S]
Source : EN 16931 règles BR-AE-1 à BR-AE-10 (norme d'application de la réforme e-invoicing) ; art. 283-2 nonies CGI
Spec : Propager le flag autoliquidation (connu de company.requiresAutoliquidation + customer.isSubcontractingBtp) jusqu'à facturXDataFromInvoice (packages/core/src/domain/compliance/facturx.ts:254, vérifié : franchise ? 'E' : rate > 0 ? 'S' : 'Z', le type 'AE' déclaré n'est jamais assigné) → catégorie AE + ExemptionReason, sinon XML rejeté ou fiscalement faux sur les plateformes.

### A5 — PDF d'avoir : titre « Avoir » + référence à la facture rectifiée [S]
Source : Art. 242 nonies A CGI (référence obligatoire à la facture initiale sur pièce rectificative) ; condition de récupération de la TVA sur l'avoir (art. 272 CGI)
Spec : renderInvoice (apps/api/src/documents/pdf-renderer.ts:105, vérifié : titre « Facture {number} » inconditionnel) doit lire data.kind → titre « Avoir » et imprimer le CreditNoteSourceSnapshot (numéro + date de la pièce d'origine) que le domaine fige déjà.

### A6 — Bloc émetteur complet sur les PDF : SIREN, TVA intracom, forme juridique + capital, mention « EI » [S]
Source : Art. 242 nonies A CGI (TVA intracom du vendeur dès que TVA facturée) ; art. R123-237/238 code de commerce (SIREN, forme, capital) ; décret n° 2022-725 (mention « EI » sur tous documents professionnels)
Spec : Imprimer SIREN et company.tvaIntracom (existent au modèle, vérifié company.ts, déjà corrects dans le XML mais absents du PDF lisible) ; ajouter un champ capital social (aucun n'existe, vérifié) ; imprimer legalForm + capital pour les sociétés et le suffixe « EI » pour les entrepreneurs individuels, via buildMentions.

### A7 — Date de la prestation et adresse de chantier/livraison sur la facture [M]
Source : Art. L441-9 code de commerce et 242 nonies A CGI (date de la vente/prestation si distincte de l'émission ; adresse de livraison si distincte de facturation) ; donnée renforcée par la réforme e-invoicing 2026
Spec : Champs date de prestation sur Invoice (seuls issuedAt/dueAt existent) et adresse de chantier (dérivée du chantier lié, déjà présent côté produit, ou saisie), imprimés sur le PDF et injectés au XML Factur-X ; le TODO est déjà écrit dans build-mentions.ts l.117-118.

### A8 — Archivage immuable du devis signé (le contrat) [M]
Source : Art. L213-1 code conso (conservation 10 ans des contrats électroniques B2C ≥ 120 €) ; valeur probante art. 1366-1367 code civil
Spec : À la signature, figer et archiver le PDF exact (sha256 + storage) en réutilisant la mécanique d'archivage des factures émises (archivage à l'émission + barrière assertIssuedInvoiceArchivesComplete, déjà en place dans backend.service.ts) ; vérifié : commentaire « jamais archivé » backend.service.ts:4530, seuls signerName + sha256 du tracé sont conservés — le contrat signé reste altérable rétroactivement.

## GROUPE B — BLOQUANTS TERRAIN (recommandations par item)

### B1 — Facture directe sans devis signé (dépannage urgent, syndics/B2B, régie TJM) — fusion des angles BTP et IT [M]
Spec : Use case de composition libre (lignes + émission) sur Invoice.composeStandalone (prêt et testé côté domaine, vérifié : aucun appelant hors tests) + POST /invoices + écran mobile ; couvre l'exception légale au devis en dépannage ET la facture mensuelle TJM × jours.
Reco : RENTRÉ — bloquant semaine 1 sur les deux cibles (première intervention de dépannage, première fin de mois de régie) ; le plus gros écart usage réel/produit, et la factory domaine existante réduit le coût au raccordement API+UI.

### B2 — Situations de travaux / factures intermédiaires multi-jalons — fusion BTP + forfaits IT [M]
Spec : Mode 'situation' (montant ou % du devis, garde cumul ≤ devis) dans GenerateInvoiceFromQuote + endpoint + UI ; vérifié : la finale déduit DÉJÀ acompte + situations émises (generate-invoice-from-quote.ts l.29-56), kind persistable, frise d'avancement affichée — seule la création manque.
Reco : RENTRÉ — trésorerie du premier chantier de plus de 2-3 semaines ; les fondations déjà posées rendent le rapport valeur/coût imbattable, et l'item couvre aussi les jalons 30/40/30 des forfaits IT.

### B3 — Remises (ligne et globale) [M]
Spec : Champ remise de ligne et/ou globale dans Quote/Invoice + compute-totals + impression « rabais, remises, ristournes acquis » ; vérifié : unitPriceHT < 0 rejeté et grep remise/discount/rabais vide dans tout le core.
Reco : RENTRÉ — une négociation sur deux se conclut par « je vous arrondis à… » : blocage en rendez-vous client semaine 1, et la mention obligatoire L441-9 est sans support tant que la remise n'existe pas.

### B4 — Conditions de paiement par client + délais « fin de mois » [S]
Spec : Terms par client (jours + endOfMonth + label) utilisés au calcul de dueAt à l'émission ; vérifié : PaymentTerms.endOfMonth complet au domaine mais figé à false dans backend.service.ts:1575, seul un défaut société en jours nets existe, Customer.paymentTermsLabel purement décoratif.
Reco : RENTRÉ — échéance fausse = relances automatiques J+3/J+10/J+20/J+30 et pénalités calculées à tort → grillage de relation commerciale dès le premier cycle ; le domaine étant prêt, c'est du raccordement.

### B5 — Retenue de garantie 5 % (calcul, mention, suivi de restitution) [M]
Spec : Champ retenue sur situation/facture (loi n° 71-584), déduction dans netToPay, mention imprimée, échéance de restitution à réception + 1 an ; vérifié : zéro champ au schéma (les hits « retention » de schema.prisma sont de la rétention de données), seuls des libellés d'onboarding et de palier tarifaire existent.
Reco : RENTRÉ si les situations rentrent (même chantier de code, la retenue s'applique aux situations) — d'autant que l'onboarding plombier/électricien et le plan Pro la PROMETTENT déjà ; si elle ne rentre pas, retirer la promesse avant publication.

### B6 — Débours stricts à 0 % hors franchise (régime réel) [S]
Spec : suggestVatRate doit autoriser le taux 0 pour category === 'disbursement' (art. 267 II-2° CGI) ; vérifié : category n'est même pas destructuré dans la fonction, alors que la même catégorie est déjà traitée hors base en compta (compte 467) et exclue de la nature d'opération — incohérence interne.
Reco : RENTRÉ — correction S d'un bug de cohérence qui fait émettre une facture fiscalement fausse à toute société au réel utilisant la catégorie exposée dans le produit.

### B7 — TVA client professionnel étranger : autoliquidation B2B UE et exonération export [M]
Spec : Taux 0 + mention « Autoliquidation » (art. 259 CGI / directive 2006/112) ou exonération art. 262 CGI, champ n° TVA intracom du preneur sur Customer, correction du routage e-invoice ; vérifié : suggestVatRate n'examine jamais isInternational, siren = regex 9 chiffres française, mention intracom absente de buildMentions.
Reco : PAS RENTRÉ pour le lancement BTP-first (client pro étranger marginal) — MAIS ajouter le garde-fou S : bloquer l'émission pour un client pro international avec message clair plutôt que forcer une TVA française fausse ; module complet obligatoire avant d'ouvrir la vague IT/conseil.

### B8 — Raccordement réel à une Plateforme Agréée (réception 09/2026, émission B2B + e-reporting 09/2027) [L]
Spec : Choisir un partenaire PA, inscription à l'annuaire, brancher réception → import dépenses (parser Factur-X entrant avec motifs AFNOR déjà prêt, vérifié einvoice-inbound.ts), puis flux émission/e-reporting via la machine à états EinvoiceTransmission existante.
Reco : CODE PAS RENTRÉ dans l'avion V1, DÉCISION RENTRÉE : le partenaire PA doit être acté et l'inscription annuaire opérationnelle avant le 01/09/2026 (échéance dure, à 6 semaines) — la réception peut transiter par la PA du partenaire en attendant le connecteur intégré V1.x, l'émission n'est due que 09/2027.

### B9 — CRA — compte-rendu d'activité mensuel signé [L]
Spec : Modèle CRA + signature à distance (réutilise sign-web + preuve sha256) + chaînage CRA validé → facture du mois ; vérifié : zéro implémentation (aucun modèle, écran, route ; PublicAccessScope = quote_signature | document_view uniquement) alors que l'onboarding freelance_it et le palier Pro le promettent.
Reco : PAS RENTRÉ (priorité mobile-first BTP-first) — mais retirer ou masquer immédiatement la promesse « CRA / Régie & TJM / TMA » de l'onboarding avant publication : recruter un consultant sur un module inexistant le bloque à sa première fin de mois.

### B10 — PV de réception de chantier / bon d'intervention signé [M]
Spec : Document « réception » (avec/sans réserves) rattaché au chantier, signé via le pad existant (SignQuote accepte déjà une signature interne sans token), archivé au coffre ; déclenche garantie de parfait achèvement (art. 1792-6 c. civ.) et date la restitution de la retenue.
Reco : PAS RENTRÉ strict V1 (le PV papier reste possible et légal) ; remonte à RENTRÉ si la retenue de garantie rentre, car la restitution des 5 % se date à la réception — sinon V1.1 rapide, toutes les briques (signature, coffre, chantiers) sont réutilisables.

## GROUPE C — V1.1 DÉFENDABLE

- Dupliquer un devis existant (S) — attendu standard du marché (Obat, Tolteck, Batappli) ; use case trivial réutilisant create-quote depuis le snapshot d'une pièce ; V1.1 défendable grâce au catalogue + brouillons + voix, quick-win V1 si un créneau se libère.
- CGV par entreprise, jointes au devis et référencées dans les mentions (M) — fusion des deux angles ; modèle pré-rempli par métier, éditable, joint à l'envoi du lien de signature ; late-penalties.ts suppose déjà leur existence pour le « taux stipulé aux CGV » ; obligation L441-1 de communication sur demande satisfiable hors app en attendant.
- Facturation récurrente TMA / abonnement / retainer (M) — devient contournable manuellement dès que la facture directe (B1) et la duplication existent ; commencer V1.1 par un simple rappel « refacturer X » sur l'infra jobs multi-tenant existante avant toute génération automatique.
- Devoir de vigilance URSSAF donneur d'ordre (S) — typage « attestation de vigilance » au coffre + suivi de validité 6 mois + nudge au premier chantier sous-traité ≥ 5 000 € HT (art. L8222-1 c. trav.) ; obligation réelle mais conditionnelle et administrable hors app, pas un préalable à la publication.
- DAS2 (M) — fléchage honoraires/commissions/rétrocessions par bénéficiaire sur les dépenses + état annuel de cumul (art. 240 CGI, seuil 1 200 €/an/bénéficiaire) ; première échéance début 2027, le compte 622 existe déjà au plan de comptes.

## ÉLIMINÉS (avec raison)

- « Mentions B2C manquantes » (angle btp) — doublon intégral : fusionné dans A2 (médiateur) et A3 (rétractation) ; son volet décennale rejoint A1 (la mention est déjà générée côté facture par buildMentions).
- « Facture directe régie TJM » (angle it/services) — même besoin que la facture directe dépannage/syndics : fusionné en B1.
- « Échéancier multi-jalons 30/40/30 » (angle it/services) — même mécanique que les situations de travaux (enum 'situation', déduction composite déjà codées) : fusionné en B2.
- « Conditions de prestation / CGV annexées au devis » (angle it/services) — doublon des CGV : fusionné dans l'item CGV du groupe C.
- Pièce jointe de l'attestation décennale au devis — confort : la mention L243-2 imprimée (A1) suffit légalement, la pièce jointe n'est pas exigée par le texte.
- Facturation en devises — non bloquant : facturer en EUR un client étranger est légal ; seul le volet TVA intracom/export est une obligation (traité en B6), déjà acté par l'angle lui-même.

## IMPACT PLANNING

Aucune des 8 affirmations lourdes re-vérifiées dans le code ne s'est révélée fausse — la liste est fiable. Groupe A complet (4 S + 4 M) ≈ 2 à 2,5 semaines : il converge en un seul épic « pièces conformes » — A1/A2/A6 partagent la même surface (brancher buildMentions au devis et enrichir le bloc émetteur), A3 s'appuie sur le bloc devis d'A1, A4/A5 sont deux correctifs localisés (facturx.ts, pdf-renderer.ts), A7 une migration + rendu, A8 réutilise l'archivage factures existant. Recommandations B rentrées (B1 facture directe, B2 situations, B3 remises, B4 conditions de paiement, B5 retenue de garantie, B9 débours, + garde-fou client international de B6) ≈ 2,5 à 3,5 semaines en second épic « facturation terrain », avec B2+B5 dans le même chantier et B1 qui rend la récurrence (groupe C) contournable. Total : +4 à 6 semaines de dev avant publication V1, parallélisable en 2 pistes (≈ 3-4 semaines calendaires), zéro dépendance externe côté code. Deux actions non-code obligatoires avant publication : (1) acter le partenaire Plateforme Agréée et l'inscription annuaire avant le 01/09/2026 — échéance légale dure à ~6 semaines ; (2) tenir ou retirer les deux promesses d'onboarding non implémentées (retenue de garantie → tenue si B5 rentre ; CRA → à masquer). Compatible avec le cap feature-freeze : cette liste fermée EST l'arbitrage à soumettre au binôme Claude+GPT, rien d'autre ne doit s'y ajouter.