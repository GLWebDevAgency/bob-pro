# Bob = service vocal complet (Jarvis) + stockage documents — ADR & roadmap commune

> Décision conjointe **Claude (Opus) + Codex (GPT-5.5)** — co-audit croisé, convergence indépendante.
> Statut : **archi tranchée, en attente du feu vert user sur les questions ouvertes** avant implémentation M0.
> Invariant produit : tout ce qu'on ajoute au backend a une **contrepartie mobile** consommant `@bob/api-client` + `@bob/tokens`/`@bob/ui` (zéro couleur/typo en dur), fidèle à la **direction artistique** (marine + palette `ai` indigo pour Bob, cartes squircle, ombres bleutées, Schibsted/Hanken Grotesk).

## 1. Constat (vérifié dans le code)
- **Voix** : STT uniquement (natif + Whisper cloud). **Pas de TTS** → Bob ne parle pas. Pas de boucle de session, pas de turn-taking. La voix n'est qu'un canal d'entrée.
- **Actions** : `BobActions` = 4 méthodes (payout, brouillon relance, liste impayés, encaisser). L'app fait ~21 use cases (devis créer/envoyer/signer/refuser/expirer, facture générer/émettre/lien paiement, OCR, dépense, chantier, lookup SIRET, TVA, adresse, PDF/Factur-X). **Parité d'actions loin de la parité applicative.**
- **Documents** : **aucun stockage durable**. Ni modèle `Document`, ni `DocumentStoragePort`, ni adapter objet. PDF/Factur-X générés à la volée puis perdus ; l'image OCR d'origine est jetée ; l'onglet `documents` est un mock statique.
- **Fiabilité** : runtime (journal/dry-run/replay/permissions) en place mais **`JournalStore` seulement in-memory** (pas d'audit durable).

## 2. Décision d'architecture — Stockage documents (ADR)
**Deux couches**, derrière des ports (`packages/core` reste framework-free ; Supabase n'apparaît que dans l'adapter `apps/api`) :

1. **Métadonnées → Postgres/Prisma sous RLS** (`bob_app` non-superuser, déjà certifié).
   - `documents` : id, companyId, kind, origin, status, filename, mimeType, byteSize, **sha256**, storageKey, linkedEntityType, linkedEntityId, documentDate/issuedAt, createdAt, createdBy, **retentionUntil**, deletedAt.
   - `document_versions` : id, documentId, version, storageKey, sha256, mimeType, byteSize, createdAt, reason. → **immutabilité par versioning** (une correction = nouvelle version, jamais d'écrasement).
2. **Binaires → Supabase Storage, bucket privé `bob-documents`** (eu-west-3, souverain FR/EU).
   - Clé : `companies/{companyId}/documents/{documentId}/v{version}/{sha256}.{ext}` — `companyId` **toujours 1er segment** (frontière tenant).
   - **Accès médiatisé par l'API** : jamais de confiance au path seul ni d'accès bucket direct depuis le mobile en v1. L'API vérifie le tenant via DB/RLS **puis** renvoie une URL signée courte ou streame les octets. Double barrière (policy Storage + prefixe + vérif applicative).

**Pourquoi Supabase Storage** : déjà dans la stack (auth + Postgres + Storage même région), S3-compatible, RLS-aware, même identité JWT que le mobile, zéro nouvelle infra, souveraineté FR/EU. Le `DocumentStoragePort` rend une bascule future vers **S3 Object Lock (WORM)** triviale si un besoin d'immutabilité légale forte apparaît (aucune ligne de core à changer).

**Contrat (à co-signer, gelé avant impl)**
```ts
// packages/core/src/application/ports
interface DocumentStoragePort {
  put(i: { companyId: string; key: string; bytes: Uint8Array; contentType: string }):
    Promise<{ key: string; sizeBytes: number; sha256: string }>;      // refuse d'écraser une clé existante (WORM applicatif)
  get(companyId: string, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  getSignedUrl(companyId: string, key: string, ttlSeconds: number): Promise<string>;
  stat(companyId: string, key: string): Promise<{ sizeBytes: number; contentType: string } | null>;
  remove(companyId: string, key: string): Promise<void>;             // purge légale uniquement (post-retention)
}
interface DocumentRepository {
  save(d: Document): Promise<void>;
  findById(companyId: string, id: string): Promise<Document | null>;
  findByEntity(companyId: string, entityType: string, entityId: string): Promise<Document[]>;
  listByCompany(companyId: string): Promise<Document[]>;
  listExpired(now: Date): Promise<Document[]>;
}
// Use cases : StoreDocument, AttachDocumentTo{Invoice,Quote,Expense}, GetDocumentDownloadUrl
```
**Conservation** : 10 ans (factures, Factur-X XML, devis signés — art. L123-22 C. com. / L102 B LPF) ; reçus de dépense 6 ans (ou alignés 10 ans si liés à une facture). Purge = job planifié → suppression Storage + soft-delete métadonnées + **entrée au journal d'audit** ; **jamais** de hard-delete avant `retentionUntil` (legal hold), même à la demande user.

## 3. Roadmap jalonnée — chaque jalon a son reflet mobile (DA)

| Jalon | But | Backend / core | **Reflet mobile (DA)** | Lane |
|---|---|---|---|---|
| **M0 — Socle stockage** | Persistance durable des docs (racine de tout) | ports + `Document`/`document_versions` + Prisma + migration + RLS + bucket + adapters (InMemory/Supabase/PrismaRepo) + **test isolation cross-tenant** | (infra — façonne le futur onglet Documents) | **joint** |
| **M1 — Journal durable + archivage auto** | Audit crash-safe + archiver chaque doc | `PrismaJournalStore` ; `IssueInvoice`/`SignQuote`/`RecordExpense` → rendre+hasher+stocker ; `POST /documents/upload` | Onglet **`documents`** = vraie bibliothèque : liste par type, **badges statut** (couleurs sémantiques), aperçu via URL signée — cartes squircle, ombres bleutées | codex |
| **M2 — Voix bidirectionnelle** | Bob **parle** + confirmation vocale | `TtsPort` (natif expo-speech défaut + cloud Pro) ; parser de consentement oral explicite ; intégration `BobAgent.confirm()` + dry-run | **`assistant.tsx`** session vocale : FAB dégradé **`ai`**, waveform, indicateur « Bob parle », **carte de confirmation vocale** (palette `ai`) | **claude** |
| **M3 — Parité d'actions** | Toute action app = outil vocal (mêmes use cases) | `BobActions`+registry étendus (créer/émettre/envoyer devis-facture, dépense-scan, client/chantier) ; `NotificationPort` mailer/SMS ; extraction LLM devis dicté | Chaque action = **écran manuel** (parité) **+** carte d'action Bob ; devis dicté → `devis/new` prérempli | codex |
| **M4 — Dialogue multi-tours** | Vraie conversation + résilience | état de session (entités mémorisées) ; désambiguation vocale ; retry/backoff + fallback multi-provider ; AppError → phrases FR actionnables | Choix (chips) tap **et** voix ; messages d'erreur voice-friendly | **joint** |
| **M5 — Mains-libres (Jarvis)** | Always-on + garde-fous par tier | autonomie `hands_free_vocal` (low direct / high confirmé voix) ; autonomie liée au tier (14/39/69) ; wake-word on-device ; STT streaming ; e2e vocaux | UI micro mains-libres : waveform animée, REC, timer, **accessibilité/lecteur d'écran** | **joint** |

## 4. Répartition Claude / Codex (convergente)
- **Claude (moi)** : ADR + roadmap (ce doc) ; `TtsPort` + confirmation vocale + templates oraux (packages/ai) ; garde-fous conformité (rétention 10 ans, legal hold, mapping erreurs FR) ; extraction LLM devis dictés ; autonomie liée au pricing ; **revue** des PR core/api de Codex ; fidélité **DA/UX mobile**.
- **Codex** : adapters réels (SupabaseStorage, PrismaDocumentRepository, PrismaJournalStore, TTS natif/cloud, mailer/SMS) ; modèles Prisma + migrations + policies RLS/Storage ; intégration stockage dans les use cases + wiring `backend.service` ; endpoints ; retry/STT streaming/machine à états audio ; suite e2e.
- **Joint** : ce ADR ; contrats de ports (Document/Storage/Tts) gelés avant impl ; modèle `Document`/versioning ; mode `hands_free_vocal` + seuils compliance ; plan de tests d'isolation multi-tenant.

## 5. Premier pas : **M0** (contrainte archi explicite du user + racine des dépendances)
1. [joint] geler `DocumentStoragePort` + `DocumentRepository` + type `Document`/`document_versions` + convention de chemins (ci-dessus).
2. [codex] modèle Prisma + migration + RLS FORCE `bob_app` ; bucket privé + policies Storage (company_id JWT = 1er segment).
3. [codex] adapters `InMemoryDocumentStorage` (démo/tests) + `SupabaseStorageAdapter` + `PrismaDocumentRepository`.
4. [joint] **test d'isolation cross-tenant** qui DOIT échouer à lire le companyId d'un autre tenant.
Aucun use case modifié à ce stade (on pose le port + adapters + table + isolation, comme `JournalStore`/`SttPort` l'ont été).

## 6. Questions ouvertes (décision user)
1. **TTS** : natif on-device par défaut (gratuit, latence faible) + cloud premium réservé Pro ? Provider cloud : **Mistral Voxtral (souverain FR)** vs AWS Polly (eu-west-3) ? Voix fr-FR par défaut.
2. **Stockage** : on confirme **Supabase Storage** ? Exigence d'immutabilité légale forte (WORM S3 Object Lock) dès maintenant, ou immutabilité applicative (versioning + refus d'écrasement) suffit en v1 ?
3. **Mailer/SMS** (envoi relances/devis) : provider (**Brevo FR** / Mailjet / Postmark) ? Email seul en v1 ou + SMS ?
4. **Autonomie ↔ pricing** : mapping `Solo→confirm_all`, `Pro→confirm_outbound`, `Business→auto` sur les tiers 14/39/69 ?
5. **Wake-word** : vrai always-on (impacts batterie/RGPD micro) en M5, ou déclenchement au tap suffit ?
6. **Rétention reçus** : 6 ans stricts ou alignés 10 ans (simplicité) ?
7. **Audios bruts** : conservés (rejeu/qualité) ou seulement la transcription texte (RGPD) ?

## 7. Décisions user confirmées (2026-07-01)
- **Stockage** : ✅ Supabase Storage privé + **immutabilité par versioning applicatif** (bascule S3 WORM repoussée). → M0 débloqué.
- **TTS** : ✅ voix native par défaut + **Mistral Voxtral (souverain FR)** en premium palier Pro. → M2.
- **Mailer** : ✅ **Brevo (FR)**, email seul en v1 (SMS plus tard). → M3.
- **Défauts non bloquants** (sauf objection) : wake-word repoussé en M5 (tap en attendant) ; reçus alignés 10 ans ; audios = **transcription texte seulement** conservée (RGPD).

## 8. Modèle autonomie ↔ pricing (proposition à co-décider Claude+Codex, à confirmer user)
**Principe : découpler l'ACCÈS à Bob et son NIVEAU D'AUTONOMIE.** L'autonomie par défaut monte avec le palier (valeur up-market), MAIS s'achète aussi **à la carte** (un solo n'a pas besoin de Business pour l'auto).

- **Défaut par palier** : Solo 14€ → `confirm_all` · Pro 39€ → `confirm_outbound` · Business 69€ → `auto`.
- **Module « Bob Autonomie » (dès Solo)** : +2€/mo → `confirm_outbound` ; +5€/mo → `auto`. *(Solo 14€ + 5€ = 19€ obtient l'auto sans acheter Business.)*
- **Plancher de sécurité INVIOLABLE** (quel que soit le niveau/add-on) : les actions qui **bougent de l'argent** (encaissement) ou **sortent vers un tiers** (envoi devis/facture/relance) demandent **toujours** une confirmation (tap ou voix). L'`auto` accélère l'interne réversible, jamais le sensible → vendre l'auto pas cher reste sûr.
- **Prérequis** : Bob (assistant) devient accessible **dès Solo** (en `confirm_all`) — ajuste le gating actuel (ai_assistant Pro+). **Option A retenue** (Claude+Codex).
- **Faisabilité mobile/web** : entitlements pilotés par le **web (Stripe) = source de vérité** ; l'app mobile **lit** l'entitlement (pattern subscription déjà en place). **Pas d'achat in-app (IAP)** pour débloquer des fonctions SaaS B2B tant que non validé côté Apple → **checkout/gestion abonnement sur le web/portail**.

### Convergence Claude+Codex (2026-07-01, msg refs 02:04)
- ✅ Découplage autonomie/palier ; Option A (Bob dès Solo `confirm_all`) ; add-on autonomie = entitlement Stripe séparé (+2€ `confirm_outbound` / +5€ `auto`) ; Business inclut `auto`.
- ✅ **Plancher de sécurité ÉTENDU** (inviolable même en `auto`, confirmation toujours requise) : mouvement d'argent (encaissement), **envoi vers un tiers** (devis/facture/relance), **suppression/purge de document**, **tout changement à portée légale/fiscale** (émission, mentions, numérotation).
- ✅ **Segmentation des paliers — RÉCONCILIÉE Claude+Codex** (handoffs 0416/0426), voir §9.

## 9. Segmentation des paliers — position unifiée (Claude + Codex)
**Principe** : les paliers dimensionnent Bob selon la **maturité opérationnelle** ; l'autonomie règle sa **vitesse d'exécution** dans le périmètre déjà acheté. **Trois axes distincts** (Codex) : `ai_quota` (quantité) · `ai_capabilities` (quels outils Bob sait utiliser) · `autonomy_level` (mode : confirm_all/confirm_outbound/auto).

| Palier | Phrase | Persona | Bob | Débloque |
|---|---|---|---|---|
| **Free** | « Je découvre » | prospect, test | quota découverte | conformité |
| **Solo 14€** | « Je bosse seul » | artisan/freelance seul, activité simple, faible volume | **Bob Essentials** — *réactif* (fait ce que je demande), `confirm_all`, quota + OCR limités | facture illimitée, actions vocales simples |
| **Pro 39€** | « Je délègue mon back-office » | indépendant qui facture bcp, artisan avec volume | **Bob Operations** — *proactif* (anticipe), `confirm_outbound` défaut, quotas hauts (fair use) | relances auto/planifiées, prévisionnel tréso, **paiement en ligne**, voix Voxtral, workflows docs |
| **Business 69€** | « Je pilote une équipe + des contrôles » | TPE/agence avec équipe/compta | **Bob Control** — *gouverné*, `auto` inclus | multi-user, rôles, **audit exportable**, validations, policies par rôle/montant, gros volumes, intégrations |

**Ligne de partage Solo↔Pro (clarification Claude)** : Solo = Bob **réactif** (je demande, Bob fait) ; Pro = Bob **proactif** (Bob anticipe : relance, prévoit, planifie). Plus clair qu'un simple seuil de quota.

**Changements vs catalogue actuel (à acter)** — 2 challenges de Codex, acceptés :
- **Paiement en ligne : Business → Pro** (levier d'encaissement fort pour indépendants ; Business vend la gouvernance, pas le paiement).
- **Assurance + avance de facture** : sortent du **cœur** Business → deviennent des **add-ons/partenariats** orthogonaux.

**Anti-cannibalisation (règle d'or, Codex)** : l'add-on autonomie change le **MODE d'exécution**, pas le **PÉRIMÈTRE métier**. Un Solo+auto (19€) = un Solo plus fluide (moins de confirmations sur l'interne réversible), **jamais** un Business low-cost (ni relances auto, ni prévisionnel, ni paiement en ligne, ni équipe, ni audit). Garde-fous : quotas par palier + outils Pro/Business exclusifs + plancher de sécurité (§8).

**Anti-complexité (risque #1 de Codex)** : chaque palier = **une phrase** (ci-dessus). Le Module Autonomie = **un seul interrupteur** (« Bob agit plus vite, dans les limites de ton plan ») à 2 crans (+2€ confirmer-envoi / +5€ auto). Wording : « accélération contrôlée », jamais « tout automatique ».

