# PROMPT POUR CLAUDE CODE — Audit Bob Pro × exigences Fly Services (bêta n°1)

> Copie tout ce fichier dans Claude Code, à la racine du repo Bob Pro.

---

Tu travailles dans le monorepo **Bob Pro** (« Ton bureau pro dans la poche » — copilote administratif
& financier des artisans, indépendants et TPE ; Expo/React Native + NestJS + Prisma, Clean
Architecture + DDD + SOLID, règle de dépendance absolue vers `packages/core`).

## Contexte de la mission

Notre **premier utilisateur bêta** sera **Fly Services** (SASU, SIREN 820 195 857) : entreprise de
maintenance **fontaines à eau + froid professionnel** (modules frigorifiques de réfectoire, frigos,
chambres froides) + multi-services, ~22 factures et 18 devis sur 8 mois, en cours de reprise et
d'expansion Paris → Rouen. C'est un client **B2B/B2G de maintenance récurrente**, pas un artisan du
BTP : son quotidien va stresser Bob Pro exactement là où un vrai client TPE le stressera.

Profil d'usage réel (extrait de son activité 2025-2026) :

- Clients **grands comptes multi-sites** : 8 entités RATP/RATP CAP différentes, chacune avec son
  adresse de facturation, ses contacts, son circuit de commande et son délai de paiement.
- Deux circuits de facturation RATP distincts : **RATP CAP (SAS)** = facture PDF par email avec
  **n° de bon de commande obligatoire**, paiement 45 j fin de mois ; **RATP EPIC** = dépôt sur
  **portail Cegedim (« SY by Cegedim »)**, paiement 60 j. Plus des clients **publics** (caisse des
  écoles, collège, hôpital) → **Chorus Pro (B2G)** à terme.
- Cœur du revenu = **contrats de maintenance annuels récurrents** (400 €/équipement/an, 2 passages
  par an, reconduction tacite, résiliation 1 mois) sur un **parc d'équipements** identifiés
  (modules frigorifiques, fontaines) répartis par site.
- Chaque passage produit une **fiche d'intervention signée sur place** + un **certificat**
  (désinfection/détartrage/changement de filtre) que le client conserve pour ses obligations
  sanitaires (loi AGEC, HACCP).
- Douleur n°1 constatée : **l'encaissement** (2 % encaissé au dernier pointage !) — factures émises
  jamais envoyées, relances jamais faites, une facture jamais créée 7 mois après le BC. Bob Pro doit
  rendre cette négligence **impossible**.

## Exigences métier à auditer (la « checklist Fly Services »)

Pour CHACUNE des exigences ci-dessous : statut **✅ implémenté / 🟡 partiel / ❌ absent**, avec
**preuves** (chemins de fichiers, modèles Prisma, use cases, écrans mobile), et ce qui manque
précisément. Ne te fie **pas** au README ni aux docs (ils peuvent être en retard sur le code, dans
les deux sens) : audite le code réel (`packages/core`, `apps/api` dont `prisma/schema.prisma`,
`apps/mobile`, `apps/sign-web`, `apps/web`).

### A. Parc, sites & contrats récurrents

1. **Client multi-sites** : un client (ex. « RATP ») avec N établissements/sites de service, chacun
   avec adresse, contacts multiples (demandeur, valideur, comptabilité) et notes d'accès.
2. **Parc d'équipements (assets)** : équipement rattaché à un site (type, marque, n° de série,
   emplacement « réfectoire 1er étage », date de pose, garantie — ex. module reconditionné garanti
   1 an), avec historique complet des interventions.
3. **Contrat de maintenance récurrent** : N équipements × tarif unitaire/an, périodicité des visites
   (ex. 2/an), date anniversaire, **reconduction tacite** avec préavis, indexation tarifaire,
   génération (semi-)automatique de la **facture annuelle** et des **visites planifiées** à
   l'échéance. Alertes « contrat à renouveler dans 60/30 j ».
4. **Devis d'expiration** : validité 30 j affichée, relance automatique des devis sans réponse
   (J+15/J+30), alerte « devis > 30 j sans BC ».

### B. Terrain : interventions & preuve

5. **Fiche d'intervention numérique** (mobile, hors-ligne) : site + équipement + opérations
   effectuées (checklist par type : désinfection, détartrage, filtre, contrôle T°…), photos
   avant/après, remarques, **signature du client sur l'écran**, horodatage — génération d'un
   **PDF de fiche + certificat d'intervention** envoyé au contact du site et archivé sur
   l'équipement. C'est LE document qui déclenche la facturation sans délai.
6. **Planning des interventions** : vue planning des visites (contractuelles + dépannages),
   **synchronisation Google Calendar** (deux techniciens : père en IDF, fils à Rouen — deux
   agendas), rappels la veille, replanification simple.
7. **Dépannage → devis → BC → facture** : sur le terrain, transformer un diagnostic en devis en
   < 2 min à partir d'un **catalogue de prestations** (déplacement 80-100 €, MO 80 €/h, charge de
   gaz 130 €, ventilateur 120 €, maintenance 400 €/unité/an…).

### C. Facturation grands comptes & conformité France

8. **Références de commande** : champ **n° de BC client obligatoire** (blocage configurable par
   client : « ne pas émettre sans BC »), rappel du BC sur la facture, lien devis→BC→facture.
9. **Conditions par client** : délai de paiement paramétrable (comptant, 30 j, **45 j fin de mois**,
   60 j), mode d'envoi par client (email, **portail tiers — au minimum statut « à déposer sur
   portail X » avec lien et suivi**, Chorus Pro B2G), adresse de facturation ≠ adresse du site.
10. **Avoirs & refacturation** : avoir total/partiel lié à la facture d'origine (cas réel : 3
    factures refacturées sur une autre entité RATP après erreur de destinataire), traçabilité propre.
11. **Facturation électronique 2026/2027** : état réel du routage PDP / Chorus Pro / e-reporting
    (le schéma et `core` semblent le modéliser — qu'est-ce qui est branché de bout en bout ?).
12. **Relances automatiques** : séquence paramétrable (J+15 courtoise, J+30 ferme, J+45 **mise en
    demeure** avec pénalités L441-10 et indemnité 40 €), envoi email avec la facture jointe,
    journal des relances par facture, tableau « impayés » par ancienneté (aging 30/60/90).
    Vérifier ce que `RelancePlan` couvre déjà et ce qui manque côté envoi réel + UI.
13. **Tableau de bord encaissement** : facturé vs encaissé, DSO, top retards, revenus récurrents
    (MRR/ARR de contrats) vs ponctuels — les 5 KPI que le dirigeant regarde chaque lundi.

### D. Confort quotidien

14. **Envoi effectif des documents** : bouton « envoyer » (email pro du client + copie),
    accusé/traçage des envois, statut « émise mais jamais envoyée » **impossible à rater** (alerte).
15. **Exports** : PDF conformes (mentions légales OK — vérifier), export comptable (FEC déjà là ?),
    export CSV factures/règlements pour l'expert-comptable.
16. **Multi-utilisateurs léger** : 2 comptes (père/fils) sur la même société, rôles simples.

## Ta mission (dans l'ordre)

1. **Cartographie** : liste ce qui existe déjà dans le code en face de chaque exigence (modèles
   Prisma : `Customer`, `Chantier`, `Quote`, `Invoice`, `Payment`, `RelancePlan`,
   `CataloguePrestation`, `StoredDocument`… ; use cases de `packages/core` ; écrans de
   `apps/mobile` ; `sign-web`). Signale aussi les briques proches à étendre plutôt qu'à créer
   (ex. `Chantier` → intervention ? `ChantierPhoto` → photos de fiche ?).
2. **Gap analysis** : tableau exigence → statut → preuve → effort estimé (S/M/L) → risque.
3. **Roadmap priorisée pour le lancement bêta avec Fly Services**, en 3 vagues :
   - **P0 — bloquant bêta** (sans ça, Fly Services ne peut pas quitter Henrri + Excel) ;
   - **P1 — dans les 30 j de la bêta** ;
   - **P2 — différable**.
   Justifie chaque priorité par l'usage réel décrit plus haut. Attention au piège du scope : Bob Pro
   vise les indépendants/artisans au sens large — pour chaque exigence « grand compte », propose la
   version **minimale généralisable** (ex. : pas d'intégration Cegedim spécifique, mais un statut
   « dépôt portail » générique avec lien + rappel).
4. **Conception** : pour les exigences ❌ retenues en P0/P1, propose l'extension du domaine dans le
   respect strict des règles du repo (agrégats/VOs dans `packages/core` sans framework, ports + use
   cases, adapters Prisma/NestJS, parité outil-IA ↔ use case, machines à états pour
   contrat/intervention). Schéma des nouveaux modèles + états, avant tout code.
5. **Livrables** : `docs/strategy/beta-fly-services-gap-analysis.md` (rapport complet) +
   `docs/superpowers/plans/beta-fly-services-roadmap.md` (plan d'exécution découpé en PR petites et
   testables). Ne commence à coder qu'après validation du plan.

Contraintes : TypeScript strict, tests Vitest pour tout nouveau use case (y compris les invariants
de contrat récurrent et de numérotation), zéro dépendance framework dans le domaine, offline-first
côté mobile pour la fiche d'intervention (le technicien est souvent en sous-sol de dépôt de bus —
sans réseau).

## ARCHITECTURE CIBLE (décision produit — 26/07/2026)

La réponse aux exigences ci-dessus se fait **dans Bob Pro**, avec cette répartition :

- **`apps/crm-web` (NOUVELLE app Next.js)** — le poste de pilotage web de l'entreprise :
  dashboard encaissement/DSO, clients multi-sites & circuits de facturation, contrats de
  maintenance récurrents, file de relances, planning. Consomme l'API NestJS **exclusivement via
  `packages/api-client` (`HttpBobClient`)** — aucun accès direct Prisma/DB, aucune logique métier
  côté front. Déploiement Vercel. Design : design system Bob Pro (`packages/tokens`) + theming
  léger par entreprise (logo/accent) — PAS la charte d'un client en dur.
  Spec UI de référence : les 6 maquettes de `~/development/fly-services/design/crm/`
  (dashboard, client-grand-compte, contrat-maintenance, planning, relances,
  fiche-intervention-mobile) + les écrans CRM du projet Claude Design « Fly Services ».
- **`apps/mobile` = le compagnon terrain** : intervention du jour, fiche d'intervention
  hors-ligne (checklist, photos, signature, certificat PDF), devis express sur site. Pas de
  duplication du pilotage web sur mobile — chaque surface a son job.
- **INTERDIT : un second backend.** Pas de base séparée pour le CRM, pas d'écriture hors use
  cases. Un seul domaine (`packages/core`), une seule vérité. La sync Google Calendar est un
  adapter côté API (port `CalendarSyncPort`), jamais un appel direct depuis les fronts.
- L'app web existante (`apps/web`) reste le portail **cabinet** (audience expert-comptable) —
  ne pas y mélanger l'espace entreprise.

Intègre cette architecture dans la gap analysis et la roadmap : chaque exigence P0/P1 précise sa
surface (crm-web / mobile / api / core) et le scaffolding d'`apps/crm-web` fait partie du plan.
