Audit complete. Full report below.

## Audit — Écran Compte (`apps/mobile/app/compte.tsx`) vs exigences stores

**Périmètre couvert** : `apps/mobile/app/compte.tsx`, `apps/mobile/app/profil-fiscal.tsx`, `apps/mobile/app/reglages-facturation.tsx`, `apps/mobile/src/data/auth.tsx`, `apps/mobile/src/data/session-cleanup.ts`, `apps/mobile/src/screens/LoginScreen.tsx`, `apps/mobile/app/auth/recovery.tsx`, `apps/mobile/app.json`, `apps/api/src/api.controllers.ts` (1489 lignes, tous les `@Controller`), `apps/api/src/backend.service.ts` (getSubscription/startCheckout/billingPortal), `apps/api/prisma/schema.prisma` (contraintes FK), `apps/landing/app/*`, `packages/i18n/src/index.ts`. Un doc interne confirme indépendamment ces constats : `design_handoff_bob_pro/PROGRAMME_V1_PUBLICATION.md` §B1 (lignes 19-22, 30-31, D.2).

### 1. Suppression de compte — MANQUANT (bloquant Apple 5.1.1(v))
Aucune trace nulle part : pas de bouton dans `compte.tsx`, pas d'écran dédié, pas d'endpoint API. Recherche exhaustive côté API : les 44 controllers de `apps/api/src/api.controllers.ts` (`CustomersController`, `OnboardingController`, `CompanyLookupController` avec seulement `GET lookup`/`GET me`, `ProfileController` en `GET` seul, etc.) ne contiennent **aucun** `@Delete` sur compte/société/utilisateur — les seuls `@Delete` du codebase concernent des sous-ressources métier (ligne de devis, brouillon de facture, invitation cabinet, appel realtime, device push). `backend.service.ts` n'a ni `deleteAccount` ni `deleteCompany` ni `deleteUser`. Aucun appel à l'admin API Supabase (`auth.admin.deleteUser`) bien que `SUPABASE_SERVICE_ROLE_KEY` soit déjà configuré (`apps/api/src/config/env.ts:81`), ce qui aurait été le prérequis technique.
Complexité réelle si construit : `schema.prisma` a la plupart des relations `Company → *` en `onDelete: Restrict` (factures, devis, écritures comptables, dossiers documents…) — un hard-delete brut échouerait sur les FK, et en plus la loi française impose la conservation des pièces comptables/factures 10 ans (Code de commerce), donc « supprimer le compte » ≠ purge SQL simple : il faut une stratégie d'anonymisation du compte utilisateur + rétention légale des pièces, pas juste un cascade delete.

### 2. Déconnexion — OK, propre et complète
`apps/mobile/app/compte.tsx:452-458` : bouton visible si `authEnabled`. `apps/mobile/src/data/auth.tsx:443-457` : `signOut` exécute `runBeforeSignOutCleanups()` (révocation push token, best-effort borné 1,5s), purge les compteurs `bob.paywall.pressure.*` d'AsyncStorage, puis `supabase.auth.signOut()`. Sur l'événement `SIGNED_OUT` (`auth.tsx:333-338`), `queryClient.clear()` vide tout le cache React Query — anti-fuite inter-utilisateur explicitement commentée. Rien à corriger.

### 3. CGU / Politique de confidentialité — MANQUANT (bloquant Apple + Google + RGPD)
Zéro lien in-app trouvé dans tout le monorepo (mobile, landing, api). Vérifié : pas de mention dans `compte.tsx`, pas de case à cocher CGU sur `LoginScreen.tsx` (signup), pas de page dédiée dans `apps/landing/app/` (seulement `layout.tsx`, `page.tsx`, `nav.tsx`, `hero.tsx`, `pricing-faq.tsx`, `phone.tsx`, `scrolly.tsx` — aucune route legal/privacy/cgu). Aucune clé i18n `account.legal*`/`account.privacy*` n'existe même à l'état de scaffolding inutilisé dans `packages/i18n/src/index.ts`. Aucune mention du droit RGPD de suppression/export de données. C'est actuellement un vide total, pas un placeholder — même une URL provisoire manque.

### 4. Gestion d'abonnement — OK pour le statut, minimum correct pour V1 sans IAP
Le statut réel est bien affiché : `compte.tsx` consomme `useSubscription()` → `GetSubscriptionStatus` (`packages/core/src/application/subscription/get-subscription-status.ts:53`) via `backend.service.ts:2184` `getSubscription()`, rendu honnêtement en « Accès anticipé » (`account.offerEarlyBody`), grille de prix avec CTA **désactivés** (`disabled` ligne 547) et diff gains/pertes factuel — aucune fausse souscription. C'est conforme à la doctrine documentée en tête de fichier.
Pas de « restaurer mes achats » : recherche confirmée vide (`react-native-iap`, StoreKit, `restaurer` — rien). C'est correct pour une V1 sans IAP : Apple n'exige la restauration d'achats que s'il y a effectivement des achats in-app StoreKit ; ici il n'y en a pas (`startCheckout`/`billingPortal` existent côté `backend.service.ts:2357-2368` comme abstraction gateway mais ne sont appelés par aucun écran — CTA gelés). Minimum requis pour V1 early-access : rien de plus à ajouter côté "restore purchases" tant qu'aucun IAP réel n'est activé — mais il faudra le réintroduire dès l'ouverture de la facturation V1.1.

### 5. Mentions légales éditeur / version app / contact support — MANQUANT
- Mentions légales éditeur (raison sociale, SIREN, adresse) : absentes de tout écran.
- Version de l'app affichée dans l'UI : absente. `apps/mobile/app.json:6` définit `"version": "1.0.0"` côté build mais rien ne l'affiche à l'utilisateur (pas de `expo-application`/`Constants.expoConfig.version` utilisé dans `app/` ou `src/`).
- Contact support : aucun écran Aide/Support/FAQ/Contact n'existe dans `apps/mobile/app/` (liste complète vérifiée : 20 routes, aucune ne correspond). Aucune adresse `support@`/`contact@`/`bonjour@` en dur nulle part dans mobile/api — cohérent avec la note de la tâche : `bonjour@bobpro.fr` pas encore actif, et le doc interne le liste en **D.2 bloqué fondateur** (domaine + adresse email requis avant publication, pas seulement côté code).

### 6. Profil fiscal — OK, bien accessible
`compte.tsx:333-374` : carte cliquable « Mon profil fiscal » avec sous-titre dynamique (nombre de champs en attente via `useFiscalProfileFlow`), route vers `/profil-fiscal`. L'écran cible (`apps/mobile/app/profil-fiscal.tsx`, 195 lignes) est un écran complet et réel : liste des champs `FISCAL_PROFILE_FIELDS`, statut textuel (Confirmé/À confirmer/Manquant — jamais couleur seule, donc bon point accessibilité aussi), édition via bottom sheet, parité vocale. Rien à corriger ici.

---

## Manques BLOQUANTS DE SOUMISSION (à traiter avant tout dépôt store)

| # | Manque | Fichiers concernés | Taille estimée |
|---|---|---|---|
| 1 | Suppression de compte in-app (Apple 5.1.1(v)) — UI + endpoint `DELETE /account` (ou `/company`) + admin Supabase `deleteUser` + stratégie de rétention légale des pièces comptables (anonymisation, pas purge brute vu les `onDelete: Restrict`) | `apps/mobile/app/compte.tsx` (nouvelle UI/flow confirmation), nouveau `AccountController`/méthode `backend.service.ts`, nouveau use case `@bob/core`, migration Prisma si anonymisation, appel Supabase Admin API | **L** (2-4 j) — la partie légale/rétention comptable est le vrai risque, pas le bouton |
| 2 | Liens CGU + Politique de confidentialité in-app (même en placeholder URL hébergé) + mention RGPD droit de suppression/export | `apps/mobile/app/compte.tsx` (footer/section légale), pages statiques côté `apps/landing` ou `apps/web`, rédaction du contenu (hors code) | **S-M** (0,5-1 j code + rédaction/hébergement des pages, dépend du domaine bobpro.fr bloqué fondateur) |
| 3 | Contact support in-app (email ou lien) — au minimum une ligne dans `compte.tsx` pointant vers l'email support, même si `bonjour@bobpro.fr` pas encore actif il faut au moins l'adresse réservée | `apps/mobile/app/compte.tsx` | **XS** (< 0,5 j) une fois l'adresse email disponible (dépendance externe D.2) |
| 4 | Mentions légales éditeur + version de l'app affichées | `apps/mobile/app/compte.tsx`, `expo-application` à ajouter | **XS** (quelques heures) |

## Manques RECOMMANDÉS (non bloquants soumission mais attendus V1 sérieuse)
- Case à cocher / lien CGU explicite au moment du signup (`apps/mobile/src/screens/LoginScreen.tsx`) plutôt que seulement dans Compte — meilleure conformité et clarté légale. **S** (quelques heures, dépend du contenu CGU du point 2).
- Ré-ouvrir « restaurer mes achats » dès que l'IAP/paywall V1.1 est activé (`startCheckout`/`billingPortal` déjà en place côté gateway, juste désactivés en UI) — pas à faire maintenant.

Note de cohérence : ces constats recoupent exactement `design_handoff_bob_pro/PROGRAMME_V1_PUBLICATION.md` §B1 items 1 et 5, déjà jugés « indispensable » par les auteurs du programme avant cet audit — aucune divergence, l'audit confirme et précise (fichiers/lignes) ce qui était pressenti.
