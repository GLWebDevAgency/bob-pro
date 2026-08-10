# Bob Pro — notes de sources de la stratégie de lancement

Instantané revu le 2 août 2026. Le rapport applique la règle du dépôt : `specified`, `implemented`, `certified` et `released` ne sont pas interchangeables. Une route ou un écran présent dans le code n'est pas considéré comme publiable sans preuve reproductible.

## Sources internes principales

- Autorité de publication : `design_handoff_bob_pro/OBJECTIFS_SPECS_DOD_PUBLICATION.md`, notamment les objectifs O1–O8, la DoD de publication et le registre de preuves.
- Flags/environnements : `design_handoff_bob_pro/MATRICE_FLAGS_V1.md` et `apps/mobile/eas.json`.
- Promesse actuelle : `design_handoff_bob_pro/STORE_LISTING.md`.
- Prix codés : `packages/core/src/domain/subscription/plan.ts` (0/19/39/79 €, fonctionnalités et quotas).
- Stratégies tarifaires historiques contradictoires : `docs/strategy/2026-pricing-strategy.md` et `docs/strategy/2026-pricing-verticalisation.md`.
- Pages légales réellement rendues : `apps/sign-web/app/legal/confidentialite/content.ts` et `apps/sign-web/app/legal/conditions-utilisation/content.ts`.
- Compte/suppression : `apps/mobile/app/compte.tsx`, `apps/mobile/src/components/account/close-account-sheet.tsx`, `packages/core/src/application/account/close-account.ts`, `apps/api/src/api.controllers.ts`, `apps/sign-web/app/account-deletion/`, `design_handoff_bob_pro/SPEC_STORE_ACCOUNT_DELETION_WEB.md` et `design_handoff_bob_pro/SPEC_ACCOUNT_DELETION_LIFECYCLE.md`.
- Candidate lifecycle O7 : migration `20260802090000_account_deletion_lifecycle`, rôle/ACL/certificat SQL, worker `account-auth-deletion`, tests de concurrence PostgreSQL et garde release importé par `test:release-flags`.
- État mobile et domaines : routes `apps/mobile/app`, hooks `apps/mobile/src/data/hooks.ts`, domaines/use cases sous `packages/core/src`, adaptateurs sous `apps/api/src` et `packages/api-client/src`.
- Plans futurs : `design_handoff_bob_pro/SPEC_POST_V1.md`, `design_handoff_bob_pro/SPEC_AVENANTS.md`, `design_handoff_bob_pro/PLAN_DA_ECRANS_PAR_LOTS_20260801.md`, `docs/superpowers/plans/beta-fly-services-roadmap.md`.
- Ops : workflows `.github/workflows`, configuration Railway/Vercel/Supabase et `docs/deploiement/urls-et-redirections.md`.

## Preuves live et CI consultées

- CI `main` au SHA `da9e5dc1a3b77cb71edbb477a414eb42b34ef82b` : run GitHub Actions `30728892899`, verte pour typecheck, tests, build, lint, Factur-X, RLS et certificats PostgreSQL ciblés.
- Pendant l'audit, `origin/main` a avancé au SHA `8b4301a0773f087aa98d922802231e8241b471c8` avec le correctif O6 fail-closed financier (PR 57). Sa CI `30740861687` est verte : typecheck, tests, build, lint, Factur-X, RLS et certificats PostgreSQL ciblés. Le worktree partagé a ensuite été basculé extérieurement sur `claude/fix-ttl-fixture-push@bf66091f` ; l'audit O7 a préservé ce branchement, n'a ni committé ni déployé, et sa candidate locale n'est donc pas un SHA publiable.
- Drift topologique Railway au même SHA : run `30737310831`, vert pour staging et production en replica unique.
- `GET https://bob-pro-api-production.up.railway.app/health/ready` : HTTP 200 et `ready:true`, mais `release.sha` et `release.environment` nuls au contrôle.
- `GET https://bob-pro-api-staging.up.railway.app/health/ready` : HTTP 200 au second contrôle ; SHA servi `fa8c2f58d5e1bb4b7979dbc9dabc49878efb9ad9`, environnement `staging`. Ce SHA est antérieur au `origin/main` courant : la disponibilité est prouvée, pas encore la promotion du dernier lot.
- Pages production CGU et confidentialité : HTTP 200, avec les placeholders `[EN ATTENTE: …]` visibles dans le HTML.
- `https://bob-pro-sign-web.vercel.app/account-deletion` : HTTP 404 au contrôle. Le lot local `STORE-DELETE-01` est désormais `implemented` pour AC1–AC8 : 4/4 tests, typecheck, build Vercel avec contact explicite et réponse HTTP 200 sur le serveur de production local. Aucun déploiement n'a été effectué ; la production reste donc non conforme sur ce point.
- La candidate locale du cycle complet possède maintenant : clôture/outbox atomiques, retry Auth durable, `404` idempotent, minimisation du sujet après acquittement, annulation/minimisation des notifications, fences email/push fail-closed, binding propriétaire, garde Cabinet, RLS/ACL et timeouts SQL. Les preuves locales sont vertes : certificat PostgreSQL O7 **5/5** sous runtime non-superuser ; suites PostgreSQL voisines **32/32** ; gate release **723 pass, 0 fail, 2 skip** ; typecheck et suites ciblées verts. Elle n'est toutefois ni committée sur `main`, ni exécutée en CI d'un SHA publié, ni rejouée sur Supabase staging, ni déployée.
- Les AC9–AC10 restent non certifiés : URL production toujours 404, aucun audit des bindings Auth legacy, aucun parcours opérateur/email/confirmation exercé et aucune matrice complète pour clients/contacts, devis par état, documents/OCR/Storage, dépenses, préférences, journaux IA/realtime, logs, backups et sous-traitants. `subjectHash` et `companyId` restent pseudonymes. Un appel fournisseur email/push autorisé avant le commit de clôture peut aussi finir après celui-ci ; le protocole garantit le refus des nouvelles autorisations post-commit, pas l'annulation magique d'un réseau déjà parti.

## Sources externes officielles

- Facturation électronique et rôle exclusif des plateformes agréées : https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees
- Calendrier 2026/2027 : https://www.economie.gouv.fr/tout-savoir-sur-la-facturation-electronique-pour-les-entreprises
- Liste des plateformes agréées : https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees
- Apple Developer Program, 99 USD/an et nom vendeur individuel : https://developer.apple.com/programs/enroll/
- Apple App Review Guidelines : les betas relèvent de TestFlight ; le binaire App Store et ses métadonnées doivent être complets et factuels : https://developer.apple.com/app-store/review/guidelines/
- Suppression de compte Apple : https://developer.apple.com/support/offering-account-deletion-in-your-app/
- Google Play, inscription 25 USD : https://support.google.com/googleplay/android-developer/answer/6112435?hl=en
- Google Play, suppression in-app + ressource web : https://support.google.com/googleplay/android-developer/answer/13327111?hl=en-EN
- Google Play, 12 testeurs pendant 14 jours pour certains nouveaux comptes personnels : https://support.google.com/googleplay/android-developer/answer/14151465?hl=en
- Expo EAS : https://expo.dev/pricing (le plan gratuit inclut actuellement 15 builds Android et 15 iOS par mois et la soumission stores).
- Supabase : https://supabase.com/pricing (Pro à partir de 25 USD/mois).
- Railway : https://docs.railway.com/pricing (Pro à partir de 20 USD/mois ; Hobby 5 USD).
- Vercel : https://vercel.com/pricing et https://vercel.com/docs/plans/hobby (Pro 20 USD/mois ; Hobby réservé au non-commercial).
- OpenAI GPT Realtime : https://developers.openai.com/api/docs/models/gpt-realtime
- Mistral API/OCR/audio : https://mistral.ai/pricing/api/

## Benchmark concurrentiel

- Abby : https://abby.fr/tarifs
- Tiime : https://www.tiime.fr/tarifs
- Indy : https://www.indy.fr/prix/
- Shine Facture : https://help.shine.fr/shine-facture/fr/articles/13419459-quelles-sont-les-offres-disponibles
- Tolteck : https://www.tolteck.com/fr-fr/tarifs/
- Obat : https://www.obat.fr/tarifs/

Les prix concurrents sont ceux affichés le 2 août 2026. Certains sont promotionnels, facturés annuellement ou dépendent du statut ; ils servent à situer la valeur perçue, pas à calculer un prix moyen comparable.

## Méthode et chart map

- `launch_strategy_analysis.sql` contient les lignes revues rendues dans le rapport ; `artifact.json` en embarque le même snapshot borné.
- Le graphique `budget_chart` utilise uniquement `launch_budget.category` et `launch_budget.budget_eur`. Il répond à la question : comment respecter le plafond de 1 000 € sans acheter de publicité avant preuve de rétention ?
- Les tableaux sont des inventaires décisionnels, pas des extractions de données utilisateurs.
- Le budget de 1 000 € couvre les P0, une bêta fermée, un lancement limité et environ trois mois d'infrastructure. Il exclut un accompagnement juridique complet, un contrat PA, l'achat d'un iPhone si aucun appareil n'est possédé/emprunté et les opérations après M3. Le burn attendu après M3 est une hypothèse de 70–140 €/mois selon modèles et trafic ; le rollout s'arrête si le financement n'est pas disponible, si le coût variable dépasse 30 % du prix ou si le support public dépasse 10 min par compte actif et par mois sans concierge payant.
- Les données de facturation réelles, les factures fournisseurs cloud, le type/date des comptes stores, les contrats DPA, les tests physiques et les devis PA n'étaient pas accessibles ; ils restent explicitement non vérifiés.
