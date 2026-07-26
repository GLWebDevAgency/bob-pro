# Bêta Fly Services — Feuille de route en 3 vagues

> Compagnon d'exécution de `docs/strategy/beta-fly-services-gap-analysis.md`. Chaque vague est justifiée par l'usage réel de Fly Services, découpée en PR petites et testables. Gouvernance : nous sommes en **cap V1 / feature freeze** — chaque ajout ci-dessous suppose l'accord commun Claude+GPT puis le GO fondateur ; PR → staging validé → prod (loi des environnements) ; aucun build EAS sans GO explicite.

## Boussole

- **Douleur n°1 = l'encaissement (2 % encaissé)** : des factures jamais envoyées, des relances jamais faites. P0 ne traite QUE ça.
- **Ce qu'on remplace** : Henrri (facturation) meurt avec P0 ; Excel (parc, contrats, passages) meurt avec P1.
- **Doctrine** : étendre les briques existantes, ne jamais créer quand on peut étendre ; jamais d'intégration spécifique client (pas de Cegedim : dépôt portail générique nom + URL + suivi) ; version minimale généralisable à tous les indépendants.

## Contraintes transverses (non négociables)

1. **TypeScript strict** partout ; le nouveau domaine vit dans `packages/core` **sans framework** (zéro import Nest/Prisma/React dans le domaine et les use cases).
2. **Vitest sur tout nouveau use case** + rituel `tsc -p tsconfig.json` complet (le build exclut les tests, vitest ne type-checke pas).
3. **Migrations additives uniquement** ; FK composites `(companyId, …)` anti-IDOR et RLS reproduites à l'identique des tables chantier.
4. **Aucun sortant sans geste confirmé** (« annuler le partage = rien n'est parti ») ; la MED reste jamais-auto ; tout nouvel envoi (facture, fiche de passage) est un geste explicite, jamais un effet de bord.
5. **Parité outil-IA ↔ use case** (philosophie « papa vocal ») : chaque nouveau use case est exposé à Bob par le MÊME endpoint que l'UI.
6. **Offline-first pour la fiche d'intervention** (technicien en sous-sol sans réseau) — offline limité à ce flux, jamais généralisé.
7. **Pédagogie légale au point de décision** (LegalHint) pour toute nouvelle règle appliquée ; **exigence visuelle premier plan** sur tout nouvel écran (reduce-motion respecté).
8. Priorités dérivées de l'état réel, jamais de statut inventé ni de donnée fabriquée (doctrine du core, cf. `devis_a_transmettre`).

---

## Vague P0 — « Encaisser » (avant l'onboarding de Fly Services)

**Justification par l'usage réel** : 2 % encaissé parce que les factures ne partent pas et que personne ne relance. RATP CAP rejette toute facture sans n° de BC ; RATP EPIC ne paie que ce qui est déposé au portail. Sans P0, Bob Pro est un Henrri plus joli : Fly Services ne migre pas. Aucune exigence ❌ en P0 : tout est extension S/M de briques déjà en production.

### PR-01 — Envoi email réel de la facture
- **Périmètre** : use case pur `SendInvoice` (gardes fail-closed : pièce émise uniquement, destinataire résolu — email client ou contact choisi, refus actionnable sinon) ; kind d'outbox `invoice-delivery` ; email = lien public `document_view` + PDF joint depuis l'archive `invoice_pdf` + `replyTo` artisan + copie à `Company.email` ; endpoint POST `/invoices/:id/send` renvoyant `deliveryStatus` (patron `sendQuote`) ; bouton confirmé côté mobile ; parité voix (« envoie la facture »).
- **Couches/fichiers** : `packages/core/src/application/billing/send-invoice.ts` (nouveau) ; `apps/api/src/persistence/notification-jobs.ts` (union `kind`) ; `apps/api/src/notifications/notifier.ts` (attachments/replyTo/cc) ; `apps/api/src/api.controllers.ts`, `backend.service.ts` ; `packages/api-client/src/client.ts` ; `apps/mobile/src/components/DocumentActions.tsx`, `app/facture/[id].tsx`.
- **Tests exigés** : Vitest use case (brouillon refusé, sans destinataire refusé, dedupe par `dedupeKey invoice:{id}:delivery:*`) ; test notifier (payload Brevo avec pièce jointe + replyTo) ; test contrôleur (deliveryStatus) ; `tsc -p` complet.

### PR-02 — « Émise jamais transmise » impossible à rater
- **Périmètre** : état DÉRIVÉ (status issued + aucun job `invoice-delivery` réussi + `transmissionDepositedAt` null) — aucun statut inventé ; priorité Aujourd'hui `facture_a_transmettre` calquée sur `devis_a_transmettre` (extinction par l'état réel) ; badge ambre dans la liste ventes ; suivi déclaré étendu au canal email (« envoyée le »).
- **Couches/fichiers** : `packages/core/src/application/today/derive-today-priorities.ts` ; `apps/mobile/src/components/invoice-badge.logic.ts`, `app/ventes.tsx`, `app/(tabs)/index.tsx` ; `record-invoice-transmission.ts` (canal email).
- **Tests exigés** : dérivation pure (émise sans envoi → priorité ; éteinte dès job done OU dépôt déclaré) ; badge logic ; snapshot des priorités existantes inchangées.

### PR-03 — Rappel de dépôt portail/Chorus J+2
- **Périmètre** : au cron 6 h, `NotificationJob` push/fil (dedupeKey `invoice:{id}:transmission-reminder`) pour toute facture émise canal chorus/portail sans `transmissionDepositedAt` après 2 jours. Répond au cas RATP EPIC (dépôt Cegedim oublié = 60 j perdus).
- **Couches/fichiers** : `apps/api/src/jobs/relance.service.ts` (ou job dédié), `notification-jobs.ts`.
- **Tests exigés** : dédup (un seul rappel), extinction dès dépôt déclaré, aucun rappel canal email.

### PR-04 — Garde « BC obligatoire » à l'émission
- **Périmètre** : `Customer.requiresPurchaseOrder Boolean?` (migration additive) ; garde fail-closed dans `IssueInvoice` (pattern résolution B4) : refus avec CTA « saisir le BC maintenant » + override confirmé JOURNALISÉ ; toggle fiche client avec LegalHint ; parité voix (l'émission vocale reçoit le même refus actionnable). Cas RATP CAP : plus jamais une facture sans n° d'engagement.
- **Couches/fichiers** : `apps/api/prisma/schema.prisma` + migration ; `packages/core/src/application/billing/issue-invoice.ts` ; `packages/core/src/domain/customer/customer.ts` ; `apps/mobile/src/components/CustomerBillingSections.tsx`.
- **Tests exigés** : émission refusée si flag et BC absent ; override tracé ; flag null = comportement inchangé (non-régression sur tout le corpus issue-invoice).

### PR-05 — Relances devis + alerte « signé sans BC » + sweep d'expiration
- **Périmètre** : dérivations pures `devis_a_relancer` (sent/viewed, seuils J+15/J+30 ancrés sur `issuedAt` réel — legacy sans `issuedAt` exclus, fail-closed ; éteinte dès signed/refused/expired) et `bc_manquant` (signed + `purchaseOrderNumber` null + client b2g ou canal chorus/portail) ; relance MANUELLE pré-rédigée en un tap (patron `buildRelance`, ton cordial, jamais envoyée seule) ; sweep quotidien `ExpireQuote` au cron 6 h (la bascule cesse d'être lazy).
- **Couches/fichiers** : `derive-today-priorities.ts` ; `packages/core/src/domain/services/build-relance.ts` (copy devis) ; `apps/api/src/jobs/relance.service.ts` (sweep) ; mobile carte Aujourd'hui + fiche devis.
- **Tests exigés** : paliers et extinctions (toutes transitions de statut) ; exclusion fail-closed des devis sans date d'ancrage ; sweep idempotent (borne calendrier Paris) ; dedupe notifications par palier.

### PR-06 — Cadence de relance paramétrable + facture liée dans l'email
- **Périmètre** : 3 paliers + switch auto dans `CompanyBillingSettings` (revision/CAS existant), défaut = `DEFAULT_RELANCE_POLICY` inchangée ; insertion du lien public de la facture dans chaque email de relance (`createInvoiceViewLink` existant) ; section « Relances » de la fiche facture = filtre du fil par `dedupeKey invoice:{id}:relance:*`.
- **Couches/fichiers** : schema + migration `CompanyBillingSettings` ; `derive-relance-plan.ts` (policy injectée) ; `relance.service.ts` ; `notifier` (corps) ; `apps/mobile/app/reglages-facturation.tsx`, `app/facture/[id].tsx`.
- **Tests exigés** : policy personnalisée respectée par le plan ET le cron ; snapshot défaut inchangé ; lien présent dans le corps ; historique par pièce filtré correctement.

### PR-07 — Carte « Encaissement » dans Pilotage
- **Périmètre** : % encaissé sur facturé 90 j, encours échu (déjà calculé), liste « émises sans envoi constaté » avec CTA transmission/relance — même honnêteté temporelle que le DSO (null assumé si historique insuffisant).
- **Couches/fichiers** : `packages/core/src/application/pilotage/derive-business-review.ts` (extension pure) ; `apps/mobile/app/pilotage.tsx`.
- **Tests exigés** : calcul du taux (bornes, avoirs en négatif), honnêteté données (null si période incomplète), non-régression BusinessReview.

**Critères de sortie P0** : Fly Services peut émettre, ENVOYER, suivre et relancer chaque facture depuis le téléphone ; zéro pièce « émise jamais transmise » de plus de 7 jours sans alerte ; plus aucune facture RATP CAP émise sans BC.

---

## Vague P1 — « Le métier de la maintenance » (30 premiers jours de bêta)

**Justification par l'usage réel** : le revenu de Fly Services = contrats annuels sur un parc d'équipements par site, matérialisés par des passages signés sur place (souvent en sous-sol, sans réseau). C'est Excel qu'on remplace ici. Quatre exigences ❌ sont retenues (2, 3, 5, 6) : la conception du domaine ci-dessous précède TOUT code.

### Conception domaine (avant tout code)

#### C1 — Parc d'équipements (exigence 2)

- **Agrégat** `Equipment` (`packages/core/src/domain/equipment/equipment.ts`, zéro framework). Invariants : `label` non vide ; `warrantyUntil ≥ installedAt` si les deux présents ; rattachement à un `chantierId` du même tenant. Cycle simple `active | retired` (pas de machine lourde : un parc tourne, il ne « workflow » pas).
- **VOs** : `EquipmentId` ; réutilisation de `DateOnly` du shared-kernel. Aucune taxonomie métier codée en dur : `kind` est un libellé libre.
- **Esquisse Prisma** (la migration réelle reproduit FK composites + RLS des tables chantier) :

```prisma
model Equipment {
  id            String    @id
  companyId     String
  chantierId    String    // FK composite (companyId, chantierId) -> Chantier
  label         String    // « Fontaine accueil R+2 »
  kind          String?   // type libre, jamais d'enum métier
  brand         String?
  serialNumber  String?
  location      String?
  installedAt   DateTime? @db.Date
  warrantyUntil DateTime? @db.Date
  status        String    @default("active") // active | retired
  notes         String?
}
// + ChantierNote.equipmentId String?  et  ChantierPhoto.equipmentId String?
//   (FK composites (companyId, equipmentId), historique/photos PAR équipement sans nouvelle table)
```

- **Ports & use cases** : `EquipmentRepository` (getById tenant-scoped, listByChantier, save) ; `CreateEquipment`, `UpdateEquipment`, `RetireEquipment` ; historique dérivé (notes + photos + interventions par `equipmentId`). Certificats/garanties = `StoredDocument` lié, pas de modèle dédié.
- **Parité IA** : outils Bob « ajoute un équipement au site X », « montre-moi l'historique de la fontaine Y » = mêmes use cases, mêmes endpoints.

#### C2 — Contrat de maintenance (exigence 3)

- **Agrégat** `MaintenanceContract` (`packages/core/src/domain/contract/maintenance-contract.ts`). Machine à états :

```
draft ──activer──▶ active ──résilier(trace: date+motif, préavis AFFICHÉ non bloquant)──▶ terminated
                     │ ▲
                     └─┘ reconduire (tacite : anniversaryDate += 1 an, événement journalisé)
```

- **Invariants** : montant annuel = Σ lignes ; `noticeDays ≥ 0` ; reconduction impossible hors `active` ; la résiliation subie par l'artisan est TRACÉE, jamais interdite (fail-closed sur l'intégrité des données uniquement).
- **Esquisse Prisma** :

```prisma
model MaintenanceContract {
  id               String    @id
  companyId        String
  customerId       String    // FK composite
  chantierId       String?   // FK composite, site couvert
  label            String
  status           String    // draft | active | terminated
  anniversaryDate  DateTime  @db.Date
  noticeDays       Int       @default(30)
  visitsPerYear    Int       @default(2)
  tacitRenewal     Boolean   @default(true)
  billedThrough    DateTime? @db.Date  // idempotence de la facture annuelle par période
  terminatedAt     DateTime?
  terminationNote  String?
  notes            String?   // indexation etc. = texte en V1
  revision         Int       // CAS, patron existant
}
model MaintenanceContractLine {  // miroir du patron LineItem
  id, companyId, contractId, catalogueItemId?, label, quantity, unitPriceHtCents, vatRate
}
model MaintenanceContractEquipment { companyId, contractId, equipmentId } // FK composites (après C1)
```

- **Dérivations pures, pas de moteur** : `deriveContractPriorities(contracts, today)` → « facture annuelle à émettre » (fenêtre anniversaire, éteinte quand `billedThrough` couvre la période) et « renouvellement dans 60/30 j » ; matérialisation par le cron 6 h en `NotificationJob` (dedupeKey `contract:{id}:renewal:{année}:{palier}`).
- **Use cases** : `CreateMaintenanceContract`, `ActivateContract`, `TerminateContract`, `RecordContractRenewal`, `PrepareAnnualInvoiceDraft` — ce dernier passe par `ComposeStandaloneInvoice` (les invariants légaux, conditions client 45/60 j et mentions restent couverts par les rails existants) et produit un BROUILLON en un tap, jamais envoyé seul.
- **Parité IA** : « crée le contrat de maintenance RATP CAP Bastille », « quels contrats à renouveler ? » = mêmes use cases.

#### C3 — Intervention / fiche de passage + planning (exigences 5 et 6)

- **Agrégat** `Intervention` (`packages/core/src/domain/intervention/intervention.ts`). Machine à états :

```
scheduled ──démarrer(startedAt)──▶ in_progress ──terminer(finishedAt, checklist figée)──▶ completed
    │                                                            │
    └──────────────── annuler ──▶ cancelled                      └──signer──▶ signed (fiche verrouillée)
```

- **Invariants** : signature possible uniquement depuis `completed` ; après `signed`, checklist/photos/horodatages IMMUABLES (même doctrine que `quotes.signatureProof`) ; client absent = `completed` sans signature, mention honnête sur le PDF ; `technicianLabel` libre (pas de multi-utilisateur en V1 : « Papa » / « Fils »).
- **VOs** : `ChecklistItem {label, done, note?}` — template JSON LIBRE par société, aucun moteur par métier ; preuve de signature répliquée du patron devis `{method:'onsite_draw', sha256, capturedAt}`.
- **Esquisse Prisma** :

```prisma
model Intervention {
  id              String    @id
  companyId       String
  chantierId      String    // le site (FK composite)
  customerId      String
  contractId      String?   // visite contractuelle vs dépannage
  equipmentId     String?   // ou equipmentLabel String? tant que le parc n'est pas saisi
  kind            String    // 'contract_visit' | 'repair' | libre
  status          String    // scheduled | in_progress | completed | signed | cancelled
  plannedAt       DateTime? // planning minimal (C3 couvre l'exigence 6)
  technicianLabel String?
  startedAt       DateTime?
  finishedAt      DateTime?
  checklist       Json      @default("[]")
  summary         String?
  signatureProof  Json?     // patron quotes.signatureProof
  reportDocumentId String?  // StoredDocument kind intervention_report (FK composite)
  revision        Int
}
// + ChantierPhoto.interventionId String? et ChantierPhoto.phase String? ('before'|'after')
```

- **PDF & envoi** : `renderInterventionReport` dans `pdf-renderer` — titre PARAMÉTRABLE par société (« Certificat sanitaire » = un libellé, pas un modèle) ; archive `StoredDocument` (nouveau kind `intervention_report`, linkedEntity chantier/équipement) ; envoi au contact du site par l'outbox (kind `intervention-report`), geste confirmé, jamais auto ; CTA « Facturer ce passage » → facture directe pré-remplie catalogue (référence de l'intervention en libellé de ligne).
- **Planning minimal (exigence 6)** : `plannedAt` + liste « À venir » + « visites du jour » dans `deriveTodayPriorities` + rappel push J-1 (`NotificationJob` kind `visit-reminder`, dedupeKey `intervention:{id}:reminder:{date}`, `notBefore` = J-1 — patron `embargo-scheduled-payment`) ; replanifier = changer `plannedAt` (ChantierNote automatique) ; **export ICS lecture seule** par URL à jeton (`PublicAccessToken` scope `calendar_feed`, filtre `technicianLabel`) — Google/Apple/Outlook s'abonnent sans OAuth : les 2 agendas père/fils = 2 abonnements filtrés.
- **Offline (le vrai chantier)** — limité au flux fiche, jamais généralisé :
  1. Cache lecture : `persistQueryClient` sur AsyncStorage (interventions du jour, sites, équipements, catalogue).
  2. Outbox local FIFO de mutations idempotentes (id d'intervention généré CÔTÉ CLIENT, patron `quote-idempotency.ts` généralisé) : créer/démarrer/terminer/signer + notes ; rejouée sur reconnexion (NetInfo), CAS par `revision` — un conflit s'AFFICHE, ne s'écrase jamais.
  3. Photos : file d'upload différé avec reprise (octets en cache local, enregistrement serveur au rejeu) ; états UI explicites « en attente de synchro / synchronisé / en échec ».
  4. Signature capturée hors-ligne : sha256 calculé sur l'appareil, `capturedAt` = heure du geste, synchronisation ultérieure tracée.
- **Ports** : `InterventionRepository` ; réutilisation `WorksiteMediaStorage`/`DocumentStoragePort`, port Notification, renderer. **Parité IA** : « commence l'intervention chez X », « passage terminé, fais signer » = mêmes use cases.

### PR de la vague P1

- **PR-08 — Sites sur les pièces** : `chantierId` NULLABLE sur `Quote`/`Invoice` (FK composite copiée d'`Expense`, schema:1026-1027) + picker site au wizard devis et à la facture directe + pièces du site sur la fiche chantier. Tests : anti-IDOR (chantier d'un autre tenant refusé), dérivation liste, non-régression create-quote.
- **PR-09 — Contacts multiples client** : table `CustomerContact {label, nom, email?, tél?}` + UI fiche client + choix du destinataire à l'envoi (réutilise PR-01). Tests : CRUD use case, envoi vers contact choisi, fallback email client.
- **PR-10 — Module chantiers pour les métiers de maintenance** : gating `trade-profile` révisé + vocabulaire « site » (frigoriste/mainteneur). Tests : snapshot trade-profile.
- **PR-11 — Parc d'équipements (C1)** : modèle + repo + use cases + écran parc du site + `equipmentId` sur notes/photos + outil vocal. Tests : Vitest invariants, migration RLS/FK, historique par équipement dérivé.
- **PR-12 — Contrats (C2), modèle + machine + écran** : use cases + fiche contrat (client/site) + priorité « facture annuelle à émettre » + brouillon en un tap via `ComposeStandaloneInvoice`. Tests : transitions interdites, idempotence `billedThrough`, le brouillon repasse par TOUS les invariants d'émission, catégorie `'subscription'` posée sur les lignes.
- **PR-13 — Alertes renouvellement J-60/J-30** : cron 6 h + `NotificationJob` dédupliqué + priorité Aujourd'hui. Tests : dédup annuelle, extinction si résilié, aucun envoi client (alerte interne uniquement).
- **PR-14 — Catalogue `'subscription'` + « Refaire ce devis »** : nouvelle catégorie (LineCategory l'a déjà) + duplication repassant par `CreateQuote` — revalidation TVA, faits légaux horodatés (urgence, signature) JAMAIS copiés. Tests : duplication propre, TVA resuggérée, non-copie prouvée.
- **PR-15 — Intervention : domaine + API (C3)** : modèle + machine + `Create/Start/Complete/SignIntervention` + photos taguées (interventionId, phase). Tests : machine complète, patron signatureProof sha256, verrouillage post-signature, RLS.
- **PR-16 — Fiche de passage PDF + envoi + archive** : renderer + `StoredDocument` kind `intervention_report` + titre paramétrable + outbox kind `intervention-report` + CTA facturer. Tests : rendu (snapshot), archive liée équipement/site, envoi = geste confirmé.
- **PR-17 — Mobile fiche d'intervention OFFLINE** (la PR la plus risquée — spike réseau réel exigé avant merge) : persistQueryClient + outbox local du flux fiche + file photos avec reprise + états de synchro. Tests : outbox pur (rejeu idempotent, ordre, clé client), conflit de révision → échec VISIBLE jamais silencieux, reprise d'upload simulée.
- **PR-18 — Planning minimal** : liste « À venir », « visites du jour » sur la Home, rappel push J-1, replanification tracée. Tests : dérivation du jour (fuseau Paris), dédup rappel, note automatique.
- **PR-19 — Export ICS lecture seule** : GET `/calendar/:token.ics` (scope `calendar_feed`, filtre technicien, révocable). Tests : contenu ICS conforme (échappement), jeton révoqué → 404, zéro fuite inter-tenant.
- **PR-20 — Jalon légal CIBS (avant le 01/09/2026)** : confirmer l'article exact au décret définitif et corriger `build-mentions.ts:141` (point unique devis+facture+sign-web) ; traiter l'option « TVA sur les débits » (:206-208) ou la documenter honnêtement. Tests : corpus mentions complet re-déroulé.

**Séquencement indicatif** : semaine 1 = PR-08→10 + PR-14 ; semaines 1-2 = PR-11→13 ; semaines 2-4 = PR-15→17 ; semaine 4 = PR-18/19 ; PR-20 dès publication du décret. Pendant la bêta, le duo père/fils travaille sur UN compte, le fils identifié par `technicianLabel` — le vrai multi-utilisateur est en P2, assumé.

---

## Vague P2 — Différable en connaissance de cause

| Sujet | Exigence | Pourquoi différable | Effort |
|-------|----------|---------------------|--------|
| Avoir partiel + refacturation tracée (`rebilledFromInvoiceId`, garde Σ avoirs ≤ facturé, relâchement contrôlé de la contrainte unique) | 10 | Le cas « mauvaise entité RATP » est DÉJÀ soluble à la main : avoir total (existant) + facture directe ; le partiel est du confort tracé | M |
| Multi-utilisateurs léger owner|member (transposition du pattern Cabinet : membres, invitations, outbox AEAD, garde « toujours 1 owner » ; digest et clôture de compte à refondre) | 16 | Frontière de sécurité (app_metadata multi-attribuable) → APRÈS publication V1 ; contournement bêta = 1 compte + technicianLabel | L |
| CSV « Pour mon comptable » (`factures.csv` + `reglements.csv`, gabarit export-fec, BOM UTF-8 Excel FR) | 15 | Le FEC probant + dossier de clôture couvrent déjà l'EC ; le CSV est un confort mensuel | S |
| Connecteur Plateforme Agréée : port `EinvoiceTransmissionPort` unique mutualisé + persistance de l'agrégat existant + statuts remontés | 11 | Dépend d'un tiers agréé (contrat/homologation) ; l'émission Factur-X conforme + guide de dépôt tiennent la bêta — fenêtre légale à surveiller (réception sept. 2026, émission PME sept. 2027) | L |
| MRR/ARR récurrent vs ponctuel dans Pilotage | 13 | N'a de sens qu'une fois les contrats (PR-12) vivants et remplis — avant, ce serait une donnée fabriquée | S (après P1) |
| Accusés d'ouverture (`markViewed` + `PublicAccessToken.lastUsedAt`), échéance « comptant » (days=0 → échéance = émission, réintégrée aux relances), dossier de clôture en PDF, synchro calendrier 2 voies | 14, 9, 15, 6 | Raffinements sans impact sur l'encaissement immédiat ; l'ICS lecture seule (PR-19) couvre le besoin calendrier | S–M |

## Jalons et garde-fous

- **01/09/2026** : décret CIBS — PR-20 obligatoire avant cette date (risque de mention légale fausse sinon).
- **Sept. 2026 / sept. 2027** : échéances facturation électronique — décision connecteur PA à instruire pendant P1 pour ne pas subir le calendrier.
- **Gouvernance** : cap V1/feature freeze — chaque PR de ce plan passe par l'accord commun Claude+GPT puis le GO fondateur ; PR → staging validé → prod ; builds EAS uniquement sur GO explicite (1 build par train complet).
- **Critères de succès bêta (mesurables)** : taux d'encaissement Fly Services > 80 % à 60 j d'émission ; zéro facture « émise jamais transmise » > 7 j ; 100 % des passages avec fiche signée synchronisée ; les 8 entités RATP saisies avec canal + conditions + BC exigé ; contrats saisis avec alertes de renouvellement actives.

Prochaine étape : validation fondateur avant tout code.
