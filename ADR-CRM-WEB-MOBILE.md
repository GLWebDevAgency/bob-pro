# ADR — Architecture crm-web × mobile × abonnements (Bob Pro)

> Décisions d'architecture actées le 26/07/2026. À lire avec
> `PROMPT-BOB-PRO-EXIGENCES-FLY-SERVICES.md`. Style : Clean Architecture + DDD + SOLID,
> règle de dépendance absolue vers `packages/core`. Statut : **accepté** (à challenger en PR si
> un fait nouveau l'exige, jamais en silence).

---

## ADR-001 — Une seule API modulaire. Pas de gateway, pas de service BFF.

**Décision.** `apps/api` (NestJS) reste l'unique backend : un **monolithe modulaire** organisé par
bounded contexts (Identity/Company · CRM clients-sites · Contrats · Interventions · Facturation ·
Relances · Planning · Documents · Subscriptions). Web et mobile **tapent les mêmes endpoints**
versionnés (`/v1/...`).

**Pourquoi pas de gateway/BFF service.** Un gateway (Kong…) se justifie pour du multi-services ;
un BFF séparé se justifie quand des équipes distinctes servent des clients aux besoins divergents.
Ici : 1 développeur + agents, 1 domaine, 2 surfaces. Un service de plus = latence, déploiement,
auth et monitoring en double — zéro bénéfice.

**Comment on obtient quand même les bénéfices d'un BFF :**
- **Read models par surface (CQRS-lite)** : les écrans lourds du CRM ont leurs endpoints de
  lecture agrégés (`GET /v1/pilotage/dashboard` → payload exact de l'écran « lundi matin » ;
  `GET /v1/clients/:id/vue-360`). Commandes = use cases de `packages/core` (invariants) ;
  requêtes = query handlers côté infra, optimisés librement (Prisma direct autorisé en lecture,
  derrière un port pour la testabilité). Un écran = un appel, pas douze.
- **Next.js comme BFF-in-the-front** : les Server Components / Route Handlers de `apps/crm-web`
  appellent l'API côté serveur (token httpOnly, cache, zéro secret dans le navigateur). C'est le
  rôle BFF sans service supplémentaire.

**Règles de coexistence web/mobile sur la même API** (c'est ça qui évite les problèmes, pas un
BFF) :
1. **Évolution additive uniquement** sur `/v1` : on ajoute des champs/endpoints, on ne casse
   jamais — le mobile passe par la review des stores et vit plus vieux que le web. Un breaking
   change = `/v2` + période de cohabitation. Les `ReleaseFlag` existants gèrent l'activation
   progressive par version de client.
2. **Contrat unique via `packages/api-client`** : toute méthode consommée par une surface existe
   dans `BobClient` (source de vérité typée, contract tests contre l'API). Même principe que la
   parité outil-IA ⇄ use case : un écran ne peut pas exister sans méthode de client équivalente.
3. **Idempotence des mutations** : chaque commande porte un UUID généré client
   (`Idempotency-Key`) — indispensable avec le mobile offline qui rejoue sa file à la reconnexion.
   Conflits : le serveur gagne sur les documents financiers émis, le client gagne sur ses brouillons.
4. **Auth unifiée** : même IdP (JWT Supabase, guards NestJS). Web = cookie httpOnly via
   middleware Next ; mobile = secure storage. RBAC par société : `dirigeant` / `technicien`
   (+ `cabinet` existant). Un technicien ne voit pas le pilotage financier.
5. CORS par origine, rate limiting par token : config du monolithe, pas une raison de gateway.

---

## ADR-002 — Theming multi-tenant (white-label léger)

**Décision.** Chaque société cliente personnalise **logo + couleur d'accent** (et rien d'autre au
départ), appliqués sur : crm-web, mobile, et les **PDF émis** (devis, factures, certificats
d'intervention — c'est là que le white-label a le plus de valeur pour une boîte de maintenance).

**Modèle.** `CompanyBranding` (ou extension de `CompanyBillingSettings`) : `logoUrl` (storage),
`accentPreset` parmi une **palette curée de presets validés** (contraste AA garanti — même
philosophie que l'enum `InvoicePdfAccentColor` déjà présent : des choix sûrs, pas un color-picker
libre qui produit du texte illisible). Option « couleur custom » plus tard, derrière un
validateur de contraste automatique.

**Application.**
- `packages/tokens` reste **figé** : il définit les rôles sémantiques (`--accent`,
  `--accent-contrast`, surfaces, encres, statuts). Le branding tenant ne peut surcharger qu'une
  **whitelist de rôles** (accent + logo). Les couleurs de statut (erreur/succès/alerte), les
  encres et les surfaces ne sont JAMAIS thémables — accessibilité et cohérence produit.
- Distribution : `GET /v1/company/branding` (payload minuscule, caché). crm-web : variables CSS
  injectées au layout côté serveur (zéro flash). Mobile : `ThemeProvider` au-dessus des tokens,
  payload persisté localement pour les démarrages hors-ligne. PDF : le même branding alimente le
  générateur de documents.
- DDD : le branding est de la **configuration de présentation** (couche application/infra) —
  il n'entre pas dans `packages/core`.

---

## ADR-003 — Abonnements : vente sur le web (Stripe), l'app mobile est un compagnon

**Décision.** L'abonnement Bob Pro se **souscrit et se gère exclusivement sur le web**
(`crm-web` → espace compte) via **Stripe Billing + Customer Portal** (CB + **prélèvement SEPA**,
adapté aux TPE françaises ; facturation TVA via Stripe Tax). L'app mobile est un **compagnon**
qui se connecte à un compte existant — le pattern Netflix/Spotify/B2B SaaS. C'est ce qui évite
la commission IAP (15-30 %) au profit des frais Stripe (~2-3 %).

**Règles de conformité stores (à vérifier à CHAQUE soumission — ça bouge vite)** :
- Le montage « compte créé et payé sur le web, app = connexion » est le chemin **sûr et
  intemporel**, valable sur tous les storefronts.
- Les **liens externes d'achat dans l'app** sont désormais possibles selon le storefront
  (US post-arrêt Epic ; UE sous DMA avec conditions/frais Apple propres) — c'est un **bonus
  optionnel par marché**, pas le socle. Ne jamais en dépendre ; vérifier les règles du moment
  avant de l'activer.
- Dans l'app iOS : afficher l'état de l'abonnement, sans CTA d'achat par défaut.

**Architecture (store-agnostique par construction).**
- `packages/core` : agrégat `Subscription` + `EntitlementPolicy` (qui a droit à quoi), **sans
  aucune connaissance de Stripe**. Port `SubscriptionProviderPort`.
- `apps/api` : adapter Stripe (checkout session, webhooks `checkout.session.completed`,
  `invoice.paid`, `customer.subscription.updated/deleted` → use case `SyncSubscriptionState`,
  idempotent, via l'outbox existante) ; l'enum `SubscriptionStore` garde {STRIPE_WEB, APPLE_IAP,
  GOOGLE_PLAY} — si un jour un segment consommateur justifie l'IAP, on ajoute un adapter, pas
  une refonte.
- **Enforcement** : les guards d'entitlement protègent l'API (donc web ET mobile d'un coup) —
  jamais de logique d'abonnement dupliquée dans les fronts.

---

## ADR-004 — Ports & adapters pour toutes les intégrations

`CalendarSyncPort` (Google Calendar — adapter API, jamais d'appel direct depuis un front) ·
`MailerPort` (envoi factures/relances avec traçage) · `PdfPort` (fiches, certificats, factures) ·
`StoragePort` (logos, photos d'intervention) · `SubscriptionProviderPort` (Stripe).
Chaque port a un fake en mémoire pour les tests et le mode démo (cohérent avec `DEMO_MODE`
existant). Webhooks entrants : vérification de signature + idempotence + outbox.

## Critères d'acceptation transverses

- `pnpm typecheck` intégral vert ; tests Vitest sur tout nouvel agrégat/use case (contrat,
  intervention, subscription) ; contract tests api-client ⇄ API.
- Aucune dépendance framework dans `packages/core` ; aucune logique métier dans les fronts.
- Un écran CRM = 1 endpoint de lecture agrégé (pas de cascade d'appels).
- Toute mutation rejouable sans double effet (idempotence prouvée par test).

## Anti-patterns explicitement interdits

Second backend ou base séparée pour le CRM · appels Prisma depuis un front · logique
d'entitlement dans le front · theming par fork du design system · breaking change silencieux
sur `/v1` · achat in-app comme unique canal de souscription.
