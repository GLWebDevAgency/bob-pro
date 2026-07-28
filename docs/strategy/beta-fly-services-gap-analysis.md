# Bêta Fly Services — Analyse d'écart (audit du code réel)

> **Base auditée** : monorepo Bob Pro, branche `main` (dceaf6e4), 26 juillet 2026. Méthode : lecture exclusive du code réel — schéma Prisma (`apps/api/prisma/schema.prisma`), domaine et use cases (`packages/core/src`), API NestJS (`apps/api/src`), écrans mobile (`apps/mobile/app`). Jamais les README ni les docs.

> **AMENDEMENT LÉGAL — 28/07/2026 (revue juridique adversariale du train PR-20)** : cet audit a été
> écrit le 26/07/2026 et daté comme tel ; il n'est pas réécrit. Une de ses affirmations est
> néanmoins devenue **fausse** et les lignes concernées sont corrigées sur place avec la marque
> *[amendé 28/07/2026]*. La « dette CIBS avant le 01/09/2026 » n'existe pas : le transfert de la TVA
> dans le CIBS, fixé au 01/09/2026 par l'ordonnance n° 2025-1247 du 17/12/2025, est **reporté au
> 01/01/2027** par l'ordonnance n° 2026-671 du 27/07/2026 (JORF n° 0174 du 28/07/2026), et la
> tolérance des anciennes références au CGI passe du 31/12/2027 au **30/06/2028**. Surtout, l'audit
> décrivait comme un acquis une « bascule CIBS au 01/09/2026 » présente dans `build-mentions.ts` :
> c'était un **défaut**, pas une preuve — cette bascule imprimait au 1er septembre une rédaction
> sans base légale, sur une date depuis reportée. Elle a été retirée ; la rédaction post-bascule
> relèvera d'un décret **non paru** et n'est ni connue ni fabriquée. Les échéances de facturation
> électronique (réception 01/09/2026, art. 289 bis CGI) ne sont **pas** touchées par ce report et
> restent exactes dans ce document. Vérifié le 28/07/2026 (JORF + compte rendu du conseil des
> ministres du 27/07/2026).

## Le client, en réel

Fly Services (SASU 820 195 857) : maintenance de fontaines à eau et froid professionnel, B2B/B2G récurrent, deux techniciens (père en Île-de-France, fils à Rouen), ~22 factures / 18 devis sur 8 mois. Ce qui structure son quotidien :

- **8 entités RATP** facturées séparément, multi-sites (adresses, contacts, circuits distincts) : RATP CAP = PDF par email + **n° de bon de commande obligatoire** + 45 j fin de mois ; RATP EPIC = **dépôt portail** (Cegedim) + 60 j ; clients publics → Chorus Pro.
- **Cœur du revenu** : contrats de maintenance annuels récurrents (≈ 400 €/équipement/an, 2 passages/an, tacite reconduction, préavis 1 mois) sur un **parc d'équipements par site** ; chaque passage = fiche d'intervention signée sur place + certificat sanitaire.
- **Douleur n°1 : l'encaissement — 2 % encaissé.** Des factures jamais envoyées, des relances jamais faites.

## Résumé exécutif

Le socle facturation/conformité de Bob Pro est déjà au-dessus de Henrri pour Fly Services : conditions de règlement par client validées L441-10 (45 j fin de mois compris), canal d'envoi par entité (email, Chorus, portail générique), n° de bon de commande porté du devis à la facture jusqu'au BT-13 du Factur-X, relances réelles avec mise en demeure encadrée — 1 exigence ✅ et 10 🟡 sur 16 se règlent par des extensions courtes de briques déjà en production. En revanche, le cœur du métier de mainteneur n'existe pas encore dans le code : parc d'équipements, contrat de maintenance récurrent, fiche d'intervention signée hors-ligne, planning et second utilisateur sont 5 ❌ francs — aujourd'hui c'est Excel, pas Henrri, qui reste irremplacé. La douleur n°1 (2 % encaissé) est pourtant la plus rapide à traiter : l'app ne sait pas envoyer une facture par email et « émise mais jamais transmise » est invisible — combler ce trou (effort M) plus quatre extensions S (garde BC, relances devis, cadence paramétrable, carte encaissement) change la trajectoire d'encaissement avant même de toucher au métier.

**Décompte** : 1 ✅ · 10 🟡 · 5 ❌ (parc, contrats, fiche d'intervention, planning, multi-utilisateurs).

## Tableau de synthèse

| # | Exigence | Statut | Preuve clé (code réel) | Effort | Risque |
|---|----------|--------|------------------------|--------|--------|
| 1 | Client multi-sites (établissements, contacts multiples, notes d'accès) | 🟡 | `Chantier` = site de fait (schema.prisma:599-620) mais `Quote`/`Invoice` sans `chantierId` ; un seul contact par `Customer` (:526-575) | M | Moyen |
| 2 | Parc d'équipements/assets | ❌ | Aucun modèle `Equipment` (seul hit grep = enum comptable :166) ; squelettes `ChantierNote`/`ChantierPhoto` (:622-655) | M | Faible (périmètre) |
| 3 | Contrat de maintenance récurrent | ❌ | Zéro modèle contrat/récurrence ; module `'abonnements'` = label sans implémentation (trade-profile.ts:19-122) ; cron 6 h + outbox prêts (relance.service.ts:63-66) | L | Moyen-élevé |
| 4 | Devis : validité 30 j, relances J+15/J+30, alerte BC | 🟡 | `validUntil` de bout en bout + `ExpireQuote` + BC saisissable à la voix (devis/[id].tsx:482-489) ; aucun palier de relance devis (moteur = factures uniquement) | S | Faible |
| 5 | Fiche d'intervention numérique hors-ligne | ❌ | Aucune entité intervention ; signature sur place limitée aux devis (SignOnsiteSheet.tsx:1-56) ; runtime « exclusivement distant » (client.tsx:14-27) | L | Élevé |
| 6 | Planning des interventions + rappels + Google Calendar | ❌ | Aucune date planifiée sur `Chantier` (:599-620) ; zéro dépendance calendrier ; infra rappels planifiés prête (notification-jobs.ts:26-33) | M | Moyen |
| 7 | Dépannage→devis→BC→facture < 2 min depuis catalogue | 🟡 | Catalogue CRUD + wizard 6 étapes + signature sur place + facture directe + canal transmission ; pas de duplication de devis ni de catégorie abonnement | S | Faible |
| 8 | N° de BC client obligatoire (blocage) | 🟡 | Colonnes + use cases + chip PDF + BT-13 Factur-X (attach-purchase-order.ts:80-222) ; aucune garde bloquante dans `IssueInvoice` | S | Faible |
| 9 | Conditions par client (délais, canal, adresse livraison) | ✅ | `paymentTermsDays/EndOfMonth` validés L441-10 à l'émission (issue-invoice.ts:247-276) + 3 canaux + `deliveryAddress` A7 (:757) | S (finitions) | Très faible |
| 10 | Avoirs & refacturation | 🟡 | Avoir TOTAL idempotent (create-credit-note.ts:18-39) ; partiel structurellement impossible (@@unique :836) ; refacturation non tracée | M | Moyen |
| 11 | Facturation électronique 2026/2027 | 🟡 | Factur-X EN16931 + PDF/A-3 + archive probante branchés (backend.service.ts:6121-6123) ; connecteur PA/PDP absent, agrégat `EinvoiceTransmission` non persisté | L | Élevé (tiers agréé) |
| 12 | Relances automatiques + MED L441-10 + 40 € | 🟡 | Moteur J+3/J+10/J+20/MED réel (cron 6 h, Brevo, MED jamais auto) ; cadence non paramétrable, facture ni jointe ni liée dans l'email | S | Faible |
| 13 | Tableau de bord encaissement (DSO, MRR/ARR) | 🟡 | Facturé vs encaissé + DSO + balance âgée (derive-business-review.ts:78-123) ; ni % encaissé explicite ni MRR (aucun modèle contrat) | S (+ contrats) | Faible |
| 14 | Envoi effectif des documents (« émise jamais envoyée ») | 🟡 | Outbox + Brevo + envoi devis réels (backend.service.ts:1384-1479) ; AUCUN kind d'envoi de FACTURE, badge unique « Émise » (invoice-badge.logic.ts:20-27) | M | Moyen |
| 15 | Exports (PDF mentions, FEC, CSV comptable) | 🟡 | Mentions sourcées figées + FEC A47 A-1 en ISO 8859-15 (export-fec.ts:49-330) ; CSV factures/règlements inexistant ; *[amendé 28/07/2026]* pas de « dette CIBS avant le 01/09/2026 » — échéances réelles 01/01/2027 puis 30/06/2028, veille armée dans le code | S | Faible (veille armée) |
| 16 | Multi-utilisateurs léger (père/fils) | ❌ | `registerCompany` = société déterministe `company-<userId>` (backend.service.ts:8535-8623), aucun rattachement possible ; pattern Cabinet complet transposable (schema:2199-2317) | L | Élevé |

*Effort : S = 1 PR courte · M = quelques PR · L = chantier multi-PR avec conception préalable.*

---

## Exigence 1 — Client multi-sites (établissements, contacts multiples, notes d'accès) — 🟡

**Preuves (code réel)**
- `Customer` = UNE adresse plate, UN email, UN téléphone, UN `contactName` (schema.prisma:526-575) ; aucune entité Site/Établissement dans le schéma ; `Address = {line1, zip, city}` sans liste de contacts (packages/core/src/shared-kernel/contact.ts:13-17).
- La brique la plus proche d'un « site » : `Chantier` (schema.prisma:599-620 — par client, nom, adresse, notes, statut open/closed), dont `notes` est documenté « contexte, accès, consignes » (packages/core/src/domain/chantier/chantier.ts:12-13) — les notes d'accès existent déjà. La fiche client liste et crée les chantiers (apps/mobile/app/client/[id].tsx:1277-1344).
- Mais un site ne porte aucune pièce : `chantierId` n'existe que sur `ChantierNote` (:628), `ChantierPhoto` (:645) et `Expense` (:1026) — jamais sur `Quote` ni `Invoice`.
- Les 8 entités RATP se modélisent dès aujourd'hui en 8 fiches `Customer` aux canaux distincts : canal de facturation par client email | chorus + code service | portail + nom + URL (customer.ts:32-44 ; apps/mobile/src/components/CustomerBillingSections.tsx:1-10) et « 45 j fin de mois » représentable (`paymentTermsDays` + `endOfMonth`, schema:548-550 ; customer.ts:16-20).
- Le module chantiers est gaté par palier/métier avec vocabulaire adaptatif chantier/mission/projet (trade-profile.ts:38 ; worksite-terminology.ts).

**Ce qui manque précisément** : devis/factures non filtrables par site (pas de `chantierId` sur `Quote`/`Invoice`) ; pas de contacts typés multiples (demandeur/valideur/compta) ; `Chantier.address` en chaîne libre ; aucun regroupement « donneur d'ordre » entre les 8 fiches RATP (encours consolidé impossible) ; gating du module à revoir pour les métiers de maintenance.

**Brique proche à étendre** : `Chantier` (déjà site de fait) + `chantierId` NULLABLE sur `Quote`/`Invoice` (migration additive) + picker site au wizard devis + liste de contacts libres `{label, nom, email, tél}` sur `Customer` ; `CustomerBillingSections` reste le canal par entité facturée.

**Version minimale généralisable** : pas d'entité « établissement grand compte » dédiée. (1) `Chantier` devient le site générique (la terminologie par métier fait le reste), (2) `chantierId` nullable sur les pièces, (3) contacts multiples libres non typés (le label porte « valideur », « compta »…). Zéro hiérarchie de groupe : la convention « RATP — CAP Bastille » suffit en V1.

**Effort M · Risque moyen** (toucher, même de façon additive, des agrégats aux invariants légaux serrés et à révision optimiste ; collision sémantique chantier BTP vs site récurrent, mitigée par la terminologie adaptative).

---

## Exigence 2 — Parc d'équipements/assets — ❌

**Preuves (code réel)**
- `grep -iE 'equipment|equipement|asset|parc'` sur le schéma → unique hit ligne 166 : valeur d'enum `AccountingAccountKind.asset` (actif comptable, hors sujet). Aucun répertoire equipment/asset dans `packages/core/src/domain` ni `application` (inventaire exhaustif vérifié).
- « intervention » dans le core = uniquement l'« intervention urgente » L221-10 code conso (create-quote.ts:120 ; retractation.ts:269-308) : concept légal, pas d'entité.
- Squelettes réutilisables : `ChantierNote` journal append-only horodaté (schema:622-636), `ChantierPhoto` via `DocumentStoragePort` (:638-655), `CataloguePrestation` pour le tarif « 400 €/équipement/an » (:577-595), signature `onsite_draw` sur le téléphone du client — pour les devis uniquement (signature.ts:5 ; sign-quote.ts:201).

**Ce qui manque précisément** : tout le modèle — entité Equipment (type, marque, n° série, emplacement, pose, garantie) rattachée à un site ; historique d'interventions PAR équipement ; fiche d'intervention signée sur place ; certificat sanitaire par passage.

**Brique proche à étendre** : Equipment rattaché à `Chantier` ; `equipmentId` NULLABLE sur `ChantierNote`/`ChantierPhoto` = historique et photos par équipement sans nouvelle table de journal ; `StoredDocument` + `linkedEntityType` (schema:105-136) pour garanties/certificats ; le pad de signature existant pour la future fiche.

**Version minimale généralisable** : UNE table Equipment minimale (`chantierId`, label/type libre, marque?, serial?, emplacement?, installedAt?, garantie?, notes) + 2 colonnes nullables. Générique chauffagiste/climaticien/ascensoriste/informatique — aucune taxonomie « fontaines à eau » codée en dur ; le certificat sanitaire = un `StoredDocument` lié, pas un modèle dédié.

**Effort M · Risque faible techniquement** (purement additif, aucune pièce légale touchée, RLS/FK composites à reproduire à l'identique) ; le vrai risque est le périmètre (cap V1 : accord Claude+GPT requis) et la sur-modélisation.

---

## Exigence 3 — Contrat de maintenance récurrent — ❌

**Preuves (code réel)**
- `grep -iE 'contrat|recurr|maintenance|anniversaire|tacite|reconduction'` sur le schéma → zéro modèle métier (seuls des commentaires techniques realtime/voix).
- Le module `'abonnements'` est déclaré au catalogue des métiers (trade-profile.ts:19,31,46,95,110,122 — unlock pro, listé paysagiste/freelance IT/coach) mais AUCUNE autre occurrence hors `dist/` : un label sans une ligne d'implémentation.
- Aucun générateur de factures récurrentes ni de visites dans `apps/api/src/jobs` (digest, relance factures, document-archive, notification-delivery, tenant-directory, voice-trace-purge).
- L'infrastructure, elle, est prête : cron quotidien 6 h multi-tenant (relance.service.ts:63-66), `NotificationJob` avec `dedupeKey` unique + `notBefore` (livraison planifiée prouvée par `embargo-scheduled-payment` J+7, notification-jobs.ts:26-34,60-69), pattern « priorité dérivée de l'état réel » (derive-today-priorities.ts:275-283), pipeline pièce-mère → factures dérivées (`Quote.generatedInvoices`, schema:719-721).

**Ce qui manque précisément** : TOUT le cœur — modèle MaintenanceContract (équipements × tarif, périodicité des visites, anniversaire, tacite reconduction + préavis, indexation) ; facture annuelle (semi-)auto ; planification des 2 passages/an ; alertes J-60/J-30 ; le lien contrat→équipements dépend de l'exigence 2.

**Brique proche à étendre** : `deriveTodayPriorities` (nouvelle priorité pure « contrat à facturer/renouveler ») ; `NotificationJob` planifié pour les alertes ; cron 6 h pour matérialiser les échéances ; `CataloguePrestation` pour la ligne annuelle ; `Customer.paymentTerms` déjà appliqué à l'émission ; `ComposeStandaloneInvoice`/`CreateQuote` pour produire la facture PRÉ-REMPLIE (les invariants légaux restent couverts).

**Version minimale généralisable** : UN modèle minimal (customerId, chantierId?, label, lignes, montant annuel HT, anniversaryDate, noticeDays, visitsPerYear) + dérivations pures : « facture annuelle à émettre » (brouillon en un tap, jamais envoyé seul) et « renouvellement dans 60/30 j ». Indexation et tournées fines = post-V1 (champ notes). Donne enfin corps au module `'abonnements'` déjà vendu dans trois profils métier.

**Effort L · Risque moyen-élevé** (plus gros ajout du bloc, en plein feature freeze V1 ; danger principal = construire un moteur de récurrence générique au lieu du minimum ; JAMAIS d'envoi auto sans validation, cohérent avec la MED jamais auto).

---

## Exigence 4 — Devis : validité 30 j, relances J+15/J+30, alerte devis signé sans BC — 🟡

**Preuves (code réel)**
- `validUntil` de bout en bout (schema:669 ; quote.ts:40,119-121 ; create-quote.ts:93-98), défaut 30 j réglable (devis/new.tsx:1202-1210 ; reglages-facturation.tsx:691-707), affiché partout (ventes.tsx:739-742 ; client/[id].tsx:799 ; mention PDF build-mentions.ts:217-218).
- Expiration : statut `expired` + use case `ExpireQuote` (borne calendrier Paris) + garde de signature publique — devis périmé ⇒ bascule `expired`, signature refusée, pas de lien émis (backend.service.ts:2613-2625 ; create-quote-signature-token.ts:56-60).
- BC (B8) : colonnes sur `Quote` (schema:705-708, vérifié) ET `Invoice` (:823-826), endpoints PUT/DELETE dédiés (api.controllers.ts:2572-2583, 2796-2807), UI + action VOCALE « ajoute le bon de commande » (devis/[id].tsx:482-489,621-676).
- Relances : moteur EXCLUSIVEMENT factures (relance-plan.ts ; derive-relance-plan.ts:157-166 ; cron relance.service.ts ; aucun kind `quote-relance` dans l'outbox — vérifié notification-jobs.ts:29-34). Seule priorité devis : `devis_a_transmettre` quand l'email client manque (derive-today-priorities.ts:101-111, vérifié).

**Ce qui manque précisément** : relances devis J+15/J+30 (aucun palier, aucune copy, aucun cron) ; bascule `expired` uniquement LAZY (pas de sweep quotidien, un devis dépassé reste affiché `sent`) ; AUCUN croisement `signedAt` × `purchaseOrderNumber null` (alerte « signé sans BC » inexistante) ; les seuils doivent s'ancrer sur `issuedAt`/`validUntil` réels (le devis n'a pas de date métier avant envoi, schema:665-667).

**Brique proche à étendre** : `deriveTodayPriorities` — deux dérivations PURES sur le modèle exact de `devis_a_transmettre` : `devis_a_relancer` (sent/viewed + seuils sur `issuedAt`, éteinte dès signed/refused/expired) et `bc_manquant` (signed + BC null + client b2g ou canal chorus/portail) ; `deriveRelancePlan` comme patron de paliers, `buildRelance` comme patron de copy ; sweep `ExpireQuote` adossé au cron 6 h ; kind `NotificationJob` additionnel si push.

**Version minimale généralisable** : deux cartes de briefing dérivées + relance devis MANUELLE pré-rédigée en un tap (jamais envoyée seule) ; l'alerte BC ne se déclenche que sur signal réel (b2g ou canal chorus/portail — jamais de règle spécifique RATP) ; l'expiration proactive = simple sweep réutilisant `ExpireQuote` tel quel.

**Effort S · Risque faible** (dérivations pures additives ; ne jamais inventer de date d'ancrage — devis legacy sans `issuedAt` exclus, fail-closed ; dédupliquer par palier via `dedupeKey`).

---

## Exigence 5 — Fiche d'intervention numérique mobile HORS-LIGNE — ❌

**Preuves (code réel)**
- Aucune entité intervention/visite/checklist/certificat (grep exhaustif ; liste des modèles Prisma schema:280-2508 sans Intervention ni Equipment).
- Le site existe via `Chantier` + `ChantierNote` append-only + `ChantierPhoto` (schema:599-655) — sans tag avant/après ni lien à une visite. Écran réel : notes manuelles ET vocales, grille photos, plein écran, suppression (chantier/[id].tsx:1-17), octets via `WorksiteMediaStorage` sur le port commun au coffre (worksite-media.ts:12-30 ; api-client client.ts:1325-1331).
- Signature sur écran DÉJÀ EN PROD mais devis uniquement : pad `@bob/ui`, `SignOnsiteSheet` « passage client » plein écran (sortie propriétaire par appui long 1,5 s, micro Bob suspendu — SignOnsiteSheet.tsx:1-56), preuve serveur SHA-256 `{method:'onsite_draw', sha256, capturedAt}` persistée (schema:677-680 ; sign-quote.ts).
- PDF pdf-lib + PDF/A-3 Factur-X (pdf-renderer.ts:1-40 ; pdfa3.ts) et archivage `StoredDocument` extensible (kinds + `linkedEntityType` incluant chantier, schema:105-136). Envoi email par outbox — aucun kind fiche d'intervention (notification-jobs.ts:29-38, vérifié).
- HORS-LIGNE ABSENT : « le runtime Bob standard est exclusivement distant » (client.tsx:14-27) ; zéro persistQueryClient/NetInfo/outbox dans le mobile ; retry borné 2 tentatives/5 s puis échec affiché (query-retry-policy.ts:1-23) ; brouillon devis = slot SERVEUR (schema:442-458). Et aucun pont site→facture (`Quote`/`Invoice` sans `chantierId`).

**Ce qui manque précisément** : modèle Intervention (site + type + résultat checklist + horodatages début/fin + technicien) ; référentiel parc ; tag avant/après + rattachement photo→intervention ; `SignIntervention` réutilisant le pad et le patron `signatureProof` ; template PDF fiche de passage/certificat ; envoi + archivage ; CTA « intervention terminée → facturer » ; et TOUTE la couche offline (cache persisté, outbox de mutations idempotentes rejouable, upload photos différé avec reprise).

**Brique proche à étendre** : `Chantier` = le site ; `ChantierPhoto` (+ phase + interventionId) ; `ChantierNote` = journal d'exécution ; pad + patron `quotes.signatureProof` à répliquer tel quel ; pdf-renderer + `StoredDocument` (kind dédié) ; `NotificationJob` pour l'envoi ; l'idempotence client existante (api-client `quote-idempotency.ts`) est la base saine d'un outbox.

**Version minimale généralisable** : « fiche de passage » générique tous métiers — chantier + client + type libre + checklist LIBRE (template JSON par société, aucun moteur par métier) + photos avant/après + signature réutilisée + PDF unique au titre paramétrable (« certificat sanitaire » = un libellé) + envoi au contact + CTA facturer pré-rempli catalogue. Équipement V1 = libellé texte (« fontaine accueil R+2 »). Offline minimal : persistQueryClient sur AsyncStorage + UN outbox local limité au flux fiche — jamais un offline généralisé de l'app.

**Effort L · Risque élevé** (la synchro offline est le vrai chantier : conflits de révision, idempotence, reprise d'upload ; valeur probante à garder « signature simple » eIDAS ; fort risque de sur-modélisation parc/checklist ; feature freeze V1).

---

## Exigence 6 — Planning des interventions (rappels veille, 2 agendas) — ❌

**Preuves (code réel)**
- Aucun écran ni entité planning ; grep calendar/planning/agenda/rdv → uniquement le calendrier FISCAL (fiscal-calendar, hooks.ts:517-528 ; argent.tsx:217) et `CalendarIcon`.
- `Chantier` ne porte que `openedAt` + statut open|closed (schema:599-620, enum :263-266) — aucune date planifiée, aucune récurrence. Google Calendar : zéro dépendance googleapis/ICS/CalDAV.
- Les rails des rappels existent sans usage planning : `NotificationJob.nextAttemptAt` + précédent de job à échéance (`embargo-scheduled-payment` J+7, notification-jobs.ts:26-33), push Expo réel (Device/PushInstallation schema:1342-1382 ; push.tsx:39), fil notifications C25, weekly-digest.
- `derive-today-priorities` ne connaît aucune notion de visite du jour ; 2 techniciens non modélisables (Company = artisan unique, aucune table d'équipe côté tenant — `CabinetMember` réservé au web cabinet, schema:2221).

**Ce qui manque précisément** : entité Visite planifiée (chantier, plannedAt, durée, technicien, statut planifié/fait/replanifié, dépannage vs contractuel) ; génération récurrente depuis un contrat ; vue planning mobile ; rappel veille ; replanification tracée ; synchro calendrier externe.

**Brique proche à étendre** : `NotificationJob` + push = rappel J-1 direct (kind `visit-reminder`, dedupeKey visite+date, patron déjà écrit) ; `derive-today-priorities` = « visites du jour » en tête de Home ; fiscal-calendar = patron d'échéancier trié servi par l'API ; `Chantier` = ancre lieu/client ; `ChantierNote` = trace automatique de replanification.

**Version minimale généralisable** : PAS de synchro Google 2 voies (OAuth lourd, spécifique grand compte). V-min : dates de visite posées sur le site + liste « À venir » + section « aujourd'hui » + rappel push J-1 + replanifier = changer la date (note automatique). Généralisation calendrier : **export ICS lecture seule par URL abonnable** (Google/Apple/Outlook sans intégration) — les 2 agendas des techniciens s'abonnent au même flux filtré par label technicien. Récurrence contractuelle V1 = bouton « replanifier dans 6 mois » à la clôture, pas un moteur.

**Effort M · Risque moyen** (le moteur de récurrence est facile à sur-spécifier — hors V1 ; fuseau Paris ; sans multi-utilisateur, l'affectation père/fils reste un label texte).

---

## Exigence 7 — Dépannage→devis→BC→facture < 2 min depuis un catalogue — 🟡

**Preuves (code réel)**
- Catalogue réel : `CataloguePrestation` (label/category/unit/unitPriceHt/vatRate/revision, zéro seed production — schema:577-595), CRUD complet (client.ts:1307-1317 ; catalogue-items.ts), écran de gestion (catalogue.tsx, 827 l.) — les tarifs Fly Services (déplacement 80-100 €, MO 80 €/h, gaz 130 €) s'y saisissent tels quels. Catégories limitées à labor|supply|travel (derive-catalogue.ts:10-12) : pas d'abonnement.
- Wizard devis 6 étapes piloté par la machine core (devis/new.tsx:1-41 ; flows/devis.ts) : suggestions catalogue au fil de la saisie, picker dédié, ajout de ligne À LA VOIX ; urgence L221-10 posée au wizard et à la voix (:667-697 ; schema:693-696) ; signature SUR PLACE à l'étape 5 puis chaîne à checkpoints createQuote→sendQuote→signQuote résumable — un devis signé sur place en < 2 min est déjà réaliste.
- BC saisi UNE FOIS sur le devis (aussi à la voix), REPRIS sur la facture dérivée, PDF archivable au coffre (schema:702-708 vérifié, :823-826).
- Facture depuis devis (acompte/finale/situations) et facture DIRECTE dépannage sans devis (facture/new.tsx:1-18 ; garde fail-closed B2C sans urgence qualifiée, compose-standalone-invoice.ts:22-28) ; flux vocal complet C20. Transmission générique prête pour RATP/Chorus (canaux par client + `recordInvoiceTransmission` + écran transmission).

**Ce qui manque précisément** : duplication d'un devis (« refaire le même ») — aucun use case ; catégorie/unité abonnement au catalogue ; `chantierId` optionnel sur les pièces pour tracer le site ; saisie du BC dès le wizard (assumé hors tranche : le BC RATP arrive après le devis).

**Brique proche à étendre** : tout étendre, rien créer — `CATALOGUE_CATEGORIES` + `'subscription'` (`LineCategory` l'a déjà, schema:77-83) ; use case duplicate-quote trivial sur l'agrégat existant ; `chantierId` nullable en copiant la FK composite d'`Expense` (:1026-1027) ; `PurchaseOrderForm` déjà factorisé.

**Version minimale généralisable** : le socle est déjà générique (catalogue par tenant sans seed, dépôt portail neutre nom+URL+statut — jamais d'intégration Cegedim). V-min : « Refaire ce devis » sur l'historique client + catégorie abonnement + rappel du canal de transmission à l'émission.

**Effort S · Risque faible** (machine devis largement testée ; la duplication doit repasser par `CreateQuote` — revalidation TVA — et ne JAMAIS copier les faits légaux horodatés : urgence, signature).

---

## Exigence 8 — N° de BC client obligatoire (blocage, rappel, lien devis→BC→facture) — 🟡

**Preuves (code réel)**
- Colonnes complètes sur `Quote` (schema:702-708, FK composite anti-IDOR vers `StoredDocument` — vérifié sur pièce) et `Invoice` (:821-828, « repris du devis, FIGÉ à l'émission », trigger `invoices_legal_traceability`).
- Use cases `AttachPurchaseOrderToQuote/ToInvoice/Detach` (attach-purchase-order.ts:80-222 — révision optimiste, tenant-scoped, redirection « devis déjà facturé → attache à la facture ») + VO `PurchaseOrderRef`.
- Chip « Bon de commande n° X du … » imprimée sur la facture (pdf-renderer.ts:1408-1412) ; le n° voyage en BT-13 du Factur-X (facturx.test.ts:513) ; checklist Chorus « Numéro d'engagement attaché » — signalée, jamais bloquante (billing-transmission.ts:52-53).
- UI mobile complète + parité voix (PurchaseOrderSection ; bob-purchase-order-voice.test.ts). MAIS `issue-invoice.ts` : AUCUNE occurrence purchaseOrder — pas de garde à l'émission.

**Ce qui manque précisément** : le blocage configurable « ne pas émettre sans BC » — aucun champ sur `Customer`, aucune garde dans `IssueInvoice`. Pas de `StoredDocumentKind` dédié pour le PDF du BC (part en `other`).

**Brique proche à étendre** : `Customer.requiresPurchaseOrder Boolean?` (NULL = non exigé) + garde fail-closed dans `IssueInvoice`, même pattern que la résolution B4 des conditions (issue-invoice.ts:247-276) ; `LegalHint` côté UI ; le coffre reçoit déjà le PDF du BC.

**Version minimale généralisable** : un booléen par client « Ce client exige un n° de commande » + refus à l'émission avec CTA « saisir le BC maintenant » et override confirmé journalisé. Utile à tout indépendant grands comptes/collectivités, zéro spécifique RATP.

**Effort S · Risque faible** (garde additive sur un flux déjà verrouillé — transaction + lockById ; message d'erreur actionnable pour ne pas bloquer l'artisan sans BC sous la main).

---

## Exigence 9 — Conditions par client (délai, canal, adresse facturation ≠ site) — ✅

**Preuves (code réel)**
- `Customer.paymentTermsDays/EndOfMonth/Label` (CHECK 3 ensemble) + `billingChannelType` email|chorus|portail + code service Chorus + nom/URL portail (CHECK par type) — schema:544-557.
- Plafonds L441-10 (60 j / 45 j fin de mois) validés à l'enregistrement ET revalidés à l'émission, fail-closed (payment-terms-legal.ts:20-59 ; issue-invoice.ts:267-276) ; résolution 3 priorités terms explicites > client > défaut société, aucune source → refus (issue-invoice.ts:46-62, 247-263) ; `dueDateFrom` gère +N jours puis fin de mois — le « 45 j FDM » RATP CAP est couvert (payment-terms.ts:20-29).
- `deriveTransmissionGuide` : checklists honnêtes par canal, portail générique nom+URL — jamais d'intégration Cegedim (billing-transmission.ts:35-95) ; suivi déclaratif déposée/acceptée sous verrou (record-invoice-transmission.ts ; schema:807-808).
- UI fiche client avec LegalHint + aperçu live d'échéance + écran transmission avec actions réelles (CustomerBillingSections ; facture/transmission/[id].tsx). `Invoice.deliveryAddress` (A7) : adresse de site distincte, figée à l'émission, proposée depuis le chantier lié (schema:757 ; issue-invoice.ts:67-70).

**Manques mineurs** : pas de rappel automatique « émise non déposée sur le portail » ; les sites multiples d'une entité ne sont pas des objets nommés (contournement réel = 1 fiche par entité RATP + adresse de site par pièce — exactement l'usage Fly Services) ; « comptant » (days=0) produit une pièce SANS échéance, la sortant des relances.

**Brique proche à étendre** : `NotificationJob` (dedupeKey `invoice:{id}:transmission`) pour le rappel de dépôt ; `PaymentTerms.dueDateFrom` à ajuster pour le comptant.

**Version minimale généralisable** : déjà généralisable telle quelle ; ajouter uniquement le rappel J+2 après émission si canal portail/chorus sans `transmissionDepositedAt` — vaut pour tout fournisseur de grands comptes.

**Effort S (finitions) · Risque très faible** (additif sur rails éprouvés).

---

## Exigence 10 — Avoirs & refacturation — 🟡

**Preuves (code réel)**
- `CreateCreditNote` : avoir TOTAL uniquement, idempotent par facture source (create-credit-note.ts:18-39) ; `creditNoteFor` : miroir monétaire immuable, gardes faits fiscaux figés, émission par `IssueInvoice` (numéro A-, écriture comptable inverse) — invoice.ts:501-536.
- Trace légale immuable `sourceInvoiceId/Kind/Number/IssuedAt` + `@@unique(companyId, sourceInvoiceId)` : UN SEUL avoir par facture — **le partiel est structurellement impossible aujourd'hui** (schema:760-767, 836). `InvoicePredecessor` trace les pièces antérieures d'une finale (:855-871). Les avoirs comptent en négatif dans la balance âgée (derive-aged-balance.ts).

**Ce qui manque précisément** : avoir PARTIEL (aucun use case, aucune sélection de lignes, contrainte unique bloquante en base) ; refacturation sur une autre entité (aucun lien, aucun pré-remplissage). Le cas réel Fly Services — facture émise sur la mauvaise entité RATP → avoir + refacture à la bonne — est aujourd'hui 100 % manuel et non tracé (mais POSSIBLE via avoir total + facture directe).

**Brique proche à étendre** : étendre `CreateCreditNote`/`creditNoteFor` avec lignes sélectionnées — le pattern de traçabilité ligne→ligne existe (`LineItem.sourceQuoteLineId`, schema:948-950) ; garde de cumul Σ avoirs ≤ facturé sur le modèle de la garde B2 « acompte+situations ≤ marché » ; refacturation = `compose-standalone-invoice` pré-rempli depuis l'avoir + colonne additive `rebilledFromInvoiceId`.

**Version minimale généralisable** : avoir partiel par sélection de lignes/quantités plafonné au reste avoirable + bouton « Refacturer à un autre client » = brouillon pré-rempli portant la référence de l'avoir en mention. Aucune notion de « groupe d'entités » : le lien passe par les pièces.

**Effort M · Risque moyen** (relâcher `uniq_credit_note_source_invoice` en gardant l'anti-doublon du total ; miroir comptable partiel au centime ; cumul sous verrou contre le sur-avoir concurrent).

---

## Exigence 11 — Facturation électronique 2026/2027 — 🟡

**Preuves (code réel)**
- BRANCHÉ : générateur XML CII profil EN16931 injecté à chaque rendu de pièce émise (facturx.ts:15-16,239 ; backend.service.ts:6121-6123) ; enveloppe PDF/A-3b réelle (profil ICC authentifié SHA-256, XMP — pdfa3.ts ; pdf-renderer.ts:22,1314) ; faits figés à l'émission (`vatTreatmentAtIssuance`, `frenchBillingModeAtIssuance` BT-23, `archiveAudienceAtIssuance` — schema:814-820) + attestation par version (:1241-1257) ; archive probante avec worker cron */5 min et rails V1→V2 (:1258+, :888) ; réception fournisseur par import Factur-X + contrôles (api.controllers.ts:3341-3348 ; parse-facturx.ts).
- MODÉLISÉ SEULEMENT : agrégat `EinvoiceTransmission` (issued→transmitted→received→accepted/refused→paid) SANS modèle Prisma ni endpoint — le suivi réel est déclaratif (einvoice-transmission.ts).
- ABSENT : aucun connecteur PA/PDP, aucune API Chorus Pro (dépôt manuel guidé), e-reporting = pédagogie uniquement. EN ATTENTE : cutover archive/settlement V2 non activé (feu vert prod restant, cf. audit du 25/07).

**Ce qui manque précisément** : le dernier kilomètre réglementaire — transmission automatique via Plateforme Agréée (obligation réception sept. 2026 ; émission PME/micro sept. 2027), statuts de cycle de vie remontés, e-reporting B2C/paiements, activation des rails V2 en prod.

**Brique proche à étendre** : persister l'agrégat `EinvoiceTransmission` (modèle Prisma miroir) ; `Customer.billingChannel` = le routage par client existe ; le payload conforme est déjà produit et archivé ; alimenter `transmissionDepositedAt/AcceptedAt` par le connecteur au lieu du déclaratif.

**Version minimale généralisable** : V1 = statu quo assumé (émission Factur-X conforme + guide de dépôt + suivi déclaratif) — déjà au-dessus du marché. Post-V1 : UN port `EinvoiceTransmissionPort` + un connecteur PA générique unique mutualisé pour tous les tenants — jamais une intégration par portail acheteur.

**Effort L · Risque élevé** (dépendance à un tiers agréé : contrat, sandbox, homologation ; échéances légales dures — mitigé par le fait que le plus difficile est déjà réel et testé).

---

## Exigence 12 — Relances automatiques + MED L441-10 + 40 € — 🟡

**Preuves (code réel)**
- Moteur unique J+3 cordial / J+10 neutre / J+20 ferme / J+30 MED, messages immuables par palier (dédup cron), pénalités chiffrées + indemnité 40 € + prescription (derive-relance-plan.ts:44-49,150-245) ; MED au régime légal exact du débiteur — b2b L441-10+D441-5, b2c art. 1344 sans 40 €, b2g L2192-12/13 BCE+8 (build-relance.ts:49-98).
- Cron RÉEL quotidien 6 h, outbox transactionnelle dédupliquée par palier, MED JAMAIS envoyée sans validation humaine ; gating plan `auto_dunning` (relance.service.ts:63-66,102-124,149-156). Envoi email réel Brevo, fail-closed si clé absente (notifier.ts:46-96). Envoi ciblé validé POST /invoices/:id/relance, même endpoint pour l'action vocale (api.controllers.ts:2627-2630).
- Journal via `NotificationJob` + fil GET /notifications + écran mobile ; aging complet par tranches et par client (derive-aged-balance.ts:19-77 ; argent.tsx:1481-1521) ; digest hebdo avec attribution « récupéré après relance ».

**Ce qui manque précisément** : 1) cadence NON paramétrable (`DEFAULT_RELANCE_POLICY` en dur — le J+15/J+30/J+45 de Fly Services impossible à configurer) ; 2) email SANS la facture (ni pièce jointe ni lien public dans le corps — notifier.ts:58-67) ; 3) pas d'historique des relances sur la fiche facture ; 4) pas de pause/opt-out par client.

**Brique proche à étendre** : `CompanyBillingSettings` (revision/CAS en place — y ajouter la cadence 3 paliers + switch auto) ; `createInvoiceViewLink` EXISTE déjà (PublicAccessToken `document_view`) : insérer le lien est trivial ; port Notification à étendre avec `attachments[]` (Brevo les supporte) via l'archive `invoice_pdf` ; `NotificationJob` requêtable par `dedupeKey invoice:{id}:relance:*` pour l'historique par pièce.

**Version minimale généralisable** : réglage société (pas par client) des 3 paliers + ON/OFF auto, lien public de la facture dans chaque relance (zéro pièce jointe), section « Relances » de la fiche facture = filtre du fil existant. Du plombier au consultant, sans machinerie grand compte.

**Effort S · Risque faible** (additif sur l'outbox éprouvée ; préférer le lien public au PDF joint — taille du payload, doctrine « aucun sortant sans commande »).

---

## Exigence 13 — Tableau de bord encaissement (facturé vs encaissé, DSO, MRR/ARR) — 🟡

**Preuves (code réel)**
- Série mensuelle facturé HT (écritures 70x) vs encaissé TTC (paiements), DSO 90 j avec raisons null assumées, top clients + alerte concentration, SIG, ratios (derive-business-review.ts:78-123 ; écran pilotage.tsx:509).
- Balance âgée totale + par client triée du plus gros dû = top retards, avec CTA « laisse l'assistant relancer » (derive-aged-balance.ts ; argent.tsx:594-619) ; position de trésorerie scénarios × horizons (derive-cash-position.ts ; GET /cashflow) ; briques « une seule vérité pour l'écran et pour Bob ».
- `LineCategory.subscription` existe (schema:77-83) mais n'alimente aucune métrique ; grep MRR/ARR/contrat récurrent sur le core : AUCUN résultat métier.

**Ce qui manque précisément** : 1) MRR/ARR récurrent vs ponctuel — la notion même de contrat n'existe pas ; 2) pas de taux d'encaissement explicite (%) ni de vue « factures émises jamais transmises » : la douleur n°1 (2 % encaissé) n'est visible qu'indirectement — `Invoice` n'a pas de statut « envoyée », seul le déclaratif `transmissionDepositedAt` existe.

**Brique proche à étendre** : `BusinessReview` est le point d'extension naturel (une carte de plus, même honnêteté temporelle) ; « émises non suivies » est 100 % dérivable des données existantes (status issued + depositedAt null + aucun job d'envoi) dans `deriveTodayPriorities` ; le MRR attend la brique Contrat — le chiffrer avant serait un mensonge de données, contraire à la doctrine du core.

**Version minimale généralisable** : carte « Encaissement » dans Pilotage — % encaissé sur facturé 90 j + encours échu (déjà calculé) + liste « émises sans envoi constaté » avec CTA transmission/relance. MRR/ARR uniquement après une brique Contrat générique (maintenance, TMA, entretien, abonnement) — jamais un module fontaines à eau.

**Effort S** (dérivations pures ; MRR = dépend de la brique contrats) · **Risque faible**.

---

## Exigence 14 — Envoi effectif des documents (« émise jamais envoyée » impossible à rater) — 🟡

**Preuves (code réel)**
- `sendQuote` : numérotation + lien sign-web + email client en outbox, retour `deliveryStatus 'queued'|'sent'|'skipped'` au mobile (backend.service.ts:1384-1479) ; `BrevoEmailNotifier` réel + fail-closed hors démo (notifier.ts:46-118) ; outbox `NotificationJob` (statuts, attempts, `dedupeKey` unique — schema:1311-1338) ; worker cron */5 min avec backoff + push Expo (notification-delivery.service.ts:22-60) ; relances email automatiques + manuelles, MED jamais auto.
- Priorité `devis_a_transmettre` dérivée de l'état réel, éteinte d'elle-même (derive-today-priorities.ts:93-111, vérifié sur pièce — doctrine explicite : on n'invente AUCUN statut, on dérive) ; carte « À régler aujourd'hui » + partage natif (rien ne part si Share annulé) ; fil serveur des jobs done/failed/pending ; suivi MANUEL générique de dépôt portail/Chorus (2 taps) ; lien public de consultation + PDF (scope `document_view`).
- MANQUE PROUVÉ : aucun kind d'outbox pour livrer une FACTURE (kinds vérifiés : quote-signature, invoice-relance, weekly-digest, retractation-acknowledgment, embargo-scheduled-payment — notification-jobs.ts:29-34) ; badge unique « Émise » (invoice-badge.logic.ts:20-27) ; carte transmission exclue pour le canal email (facture/[id].tsx:435) ; `markViewed` jamais appelé (statut viewed mort, quote.ts:436).

**Ce qui manque précisément** : 1) l'envoi EMAIL de la FACTURE n'existe pas — la pièce émise n'est jamais livrée par le serveur (partage manuel non tracé uniquement) : pour Fly Services (2 % encaissé), **c'est LE trou** ; 2) « émise jamais envoyée » ratable (aucun badge, aucune priorité, aucun état dérivé pour le canal email) ; 3) ni copie artisan ni replyTo (réponses clients perdues chez le sender Brevo global), pas de PDF joint ; 4) échec Brevo non rebranché sur la carte Aujourd'hui ; 5) accusé d'ouverture non exploité.

**Brique proche à étendre** : tout est là — kind `invoice-delivery` sur l'outbox + `NotificationDeliveryService`, Brevo étendu (attachments + replyTo + cc), pattern `deliveryStatus` de `sendQuote` répliqué sur POST /invoices/:id/send, lien public + PDF déjà servis, priorité `facture_a_transmettre` calquée sur `devis_a_transmettre`, suivi déclaré étendu au canal email (« envoyée le »), archive `invoice_pdf` pour la pièce jointe, `markViewed` + `lastUsedAt` pour l'accusé.

**Version minimale généralisable** : un bouton « Envoyer la facture » sur toute pièce émise (outbox : lien public + PDF joint, copie à `Company.email`, replyTo artisan) + statut dérivé « émise, jamais transmise » (aucun job réussi ET depositedAt null) en badge ambre + priorité Aujourd'hui — même mécanique pour TOUS les canaux : email (envoi direct), chorus/portail (guide existant + rappel tant que « Déposée le » n'est pas déclaré). Zéro intégration Cegedim.

**Effort M · Risque moyen** (sortants réels : délivrabilité à soigner — replyTo, DMARC si envoi « au nom de » ; l'envoi reste opérationnel, pas légal ; ne jamais casser le critère « annuler le partage = rien n'est parti » : l'email facture = geste confirmé, jamais un effet de bord de l'émission).

---

## Exigence 15 — Exports (PDF mentions légales, FEC, CSV comptable) — 🟡

**Preuves (code réel)**
- Mentions légales réellement complètes et sourcées (forme/capital R123-238, « EI » R526-27, TVA intracom, SIREN client B2B/B2G réforme, médiateur conso, rabais L441-9, franchise 293 B — *[amendé 28/07/2026 : la « bascule CIBS au 01/09/2026 » qui figurait ici n'était pas un acquis mais un DÉFAUT — rédaction sans base légale sur une date depuis reportée ; elle a été retirée, la mention est désormais le verbatim de l'art. 293 E, II à toute date]* —, autoliquidation BTP, taux réduits certifiés, escompte/pénalités BCE+10 & 40 €, régime B2G BCE+8, décennale L243-2 — build-mentions.ts), FIGÉES à l'émission (`Invoice.legalMentions`, trigger — issue-invoice.ts:564 ; schema:809), dessinées verbatim sur facture ET devis (pdf-renderer.ts:1150-1170).
- FEC conforme art. A47 A-1 LPF : 18 colonnes, nommage SIRENFECAAAAMMJJ.txt + descriptif, auxiliaires E7 (export-fec.ts:49-330), **encodage ISO 8859-15** (latin9.ts — un FEC UTF-8 peut être rejeté), endpoints + gating Pro+ honnête, partage natif vers le comptable (comptabilite.tsx:106-171 ; share-fec.ts).
- Grand livre auto-alimenté (émission, encaissement, achats) + balance, compte de résultat, bilan, SIG, dossier de clôture texte partagé.

**Ce qui manque précisément** : 1) CSV factures/règlements INEXISTANT (aucun toCsv/text/csv dans le repo) — l'expert-comptable qui ne veut pas du FEC n'a rien, alors que GET /payments et listInvoices servent déjà le JSON ; 2) *[amendé 28/07/2026 — les deux dettes de `build-mentions` sont soldées]* l'article CIBS n'est plus « à confirmer sur le décret définitif » : le décret qui portera la rédaction n'est **pas paru**, la bascule automatique est retirée et l'échéance est armée par une veille testée (test-sentinelle + signal au démarrage) au lieu d'être présumée ; l'option pour les débits est traitée par sa mention littérale (art. 242 nonies A, I-11° bis de l'annexe II au CGI) derrière un point d'extension explicite, aucun champ du domaine ne la portant encore ; 3) dossier de clôture en texte brut (pas un PDF).

**Brique proche à étendre** : use case pur `export-sales-csv.ts` calqué sur `export-fec.ts` (même gabarit deps/period) + pattern `share-text.ts` ; `build-mentions.ts` est LE point unique pour les dettes ; `pdf-renderer` sait déjà tout dessiner pour un dossier PDF.

**Version minimale généralisable** : un export « Pour mon comptable » à deux fichiers génériques — `factures.csv` (numéro, date, client, HT/TVA/TTC/netToPay, statut, échéance) et `reglements.csv` (date, facture, montant, moyen) — période sélectionnable comme le FEC, partagé par la même feuille native. Le FEC reste l'export probant ; le CSV est le confort quotidien.

**Effort S · Risque faible** techniquement (échapper séparateurs, BOM UTF-8 pour Excel FR, montants en euros virgule). *[amendé 28/07/2026]* Il n'y a plus de « veille à planifier avant le 01/09/2026 » : cette date est fausse (report au 01/01/2027, ord. n° 2026-671 du 27/07/2026) et une veille planifiée dans un document n'est pas une veille. Les deux échéances réelles — 01/01/2027 (entrée en vigueur) et 30/06/2028 (fin de tolérance des références CGI, seule date après laquelle la mention actuelle deviendrait non conforme) — sont **armées dans le code** : `packages/core/src/domain/services/veille-mentions-legales.ts`, à **deux étages** *[amendé 28/07/2026 — la formulation précédente, « fait échouer la CI 90 j puis 180 j avant », décrivait un dispositif intenable : trois mois de CI rouge sur des PR sans rapport finissent par une désactivation]* : le préavis (90 j / 180 j) **avertit sans bloquer** (annotation GitHub + résumé de run à chaque PR, signal au démarrage de l'API) et seule l'**échéance atteinte** casse la CI. Un préavis ne s'apaise qu'en mettant `verifieLe` à jour dans le registre — daté, relu en diff, ré-armé seul après 30 jours.

---

## Exigence 16 — Multi-utilisateurs léger (2 comptes père/fils) — ❌

**Preuves (code réel)**
- `Company` sans relation membres, sans modèle User (« l'identité personnelle est entièrement dans Supabase Auth », schema:280-377) ; principal `{userId, companyId}` sans notion de rôle (auth.guard.ts:122-155).
- `registerCompany` : id DÉTERMINISTE `company-<userId>` — le fils qui s'inscrit obtient SA PROPRE société ; aucun endpoint d'invitation/rattachement (backend.service.ts:8535-8623) ; seule écriture du lien user→company : `setUserCompanyId` au provisioning (supabase-admin.ts:35-59) ; le digest INVERSE `company-<userId>` pour retrouver LE propriétaire unique — un 2e membre ne recevrait jamais rien (digest.service.ts:550-566).
- MAIS : brique multi-membres COMPLÈTE dans le bounded context Cabinet — `CabinetMember` (rôles), `CabinetInvitation` (tokenHash, expiry), `CabinetInvitationDelivery` (outbox AEAD), garde SQL « toujours ≥ 1 admin actif » (schema:2199-2317) ; feature `'team'` déjà au catalogue des plans, tier business (plan.ts:19,119) ; teaser « Équipe — Bientôt » assumé à l'écran Compte ; `PushInstallation` déjà per (userId, companyId) ; toute l'isolation RLS est par companyId — un 2e userId sur le même tenant ne casserait pas l'anti-IDOR data.

**Ce qui manque précisément** : tout le chemin produit — modèle CompanyMember + garde « toujours 1 owner » ; invitation email dont l'acceptation écrit `app_metadata.company_id` du fils SANS passer par `registerCompany` ; résolution digest/emails pour N membres ; écrans mobile ; règles simples (clôture de compte Apple 5.1.1(v), abonnement Stripe, réglages = owner) ; attribution des gestes dans l'audit (« fait par Papa/Fils »). Sans ça, père IDF + fils Rouen = double saisie ou partage de mot de passe.

**Brique proche à étendre** : NE PAS créer de système neuf — transposer le pattern Cabinet éprouvé (modèles, outbox chiffrée, garde SQL, révocation) au tenant Company avec 2 rôles seulement ; `setUserCompanyId` est déjà le mécanisme de rattachement ; le gating Business est prêt.

**Version minimale généralisable** : « 2e utilisateur » pour tout duo d'artisans (conjoint collaborateur, associé, apprenti) — `CompanyMember` avec DEUX rôles (owner|member), le member a la parité d'actions métier complète (philosophie parité humain↔Bob), seuls réglages société/abonnement/clôture restent owner ; invitation email via l'outbox cabinet ; badge « par X » dans le fil. Pas de RBAC fin.

**Effort L · Risque élevé** — frontière de sécurité (`app_metadata.company_id` multi-attribuable, revalidation email via GoTrue Admin live comme le fait le Cabinet), digest cassé silencieusement, clôture de compte ambiguë, sièges Stripe. À séquencer APRÈS la publication V1 (cap feature freeze) sauf accord Claude+GPT.
