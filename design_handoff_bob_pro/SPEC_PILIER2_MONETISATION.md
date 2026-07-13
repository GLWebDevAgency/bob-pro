# SPEC PILIER 2 — Monétisation, plans & rétention (arrêtée le 2026-07-14)

Ordre fondateur : « pilier 2 en 100 % prod ultra abouti avec les meilleurs patterns mondiaux ».
Conception issue d'un panel 3 angles (pricing psychology / rétention / UX premium) × 2 juges
(fondateur exigeant, artisan sceptique). Doctrine : **zéro dark pattern — la confiance EST la
rétention** sur la cible artisan (marché où tout le monde se parle au dépôt de matériaux).

## Décisions arrêtées (consensus des juges)

1. **Reverse trial 14 j** : Pro complet à l'inscription, SANS carte bancaire. Atterrissage
   doux sur Découverte (données conservées, conformité facturation jamais bloquée).
   → `startReverseTrial/trialPhase/trialEffectiveTier` (@bob/core, livré).
2. **Bilan de fin d'essai** avec recommandation CALCULÉE depuis l'usage réel, **downsell
   inclus** (« Vu ton mois, Solo te suffit ») ; 3 issues présentées à poids égal.
   → `buildTrialReport` (@bob/core, livré).
3. **Paywall contextuel au moment du geste** : jamais générique, jamais d'interruption
   mid-action (on gate le geste SUIVANT), UN plan proposé (celui qui débloque), données
   RÉELLES de l'artisan affichées (montant d'impayés réel). Déblocage le MOINS CHER
   légitime (add-on avant palier). → `decidePaywall` (@bob/core, livré).
4. **Gouvernance de pression UNIFIÉE** (structurelle, pas à la discrétion des écrans) :
   sourdine 14 j après 2 rejets même source ; refus VOCAL = 30 j de silence tous canaux ;
   1 upsell proactif/semaine max. → `paywall-pressure` (@bob/core, livré).
5. **Digest de valeur « le lundi de Bob »** (lundi 7 h 30, avant le chantier) : faits réels
   uniquement (encaissé, recouvré post-relance, documents, canal vocal), temps = estimation
   annoncée, accroche UNIQUE argent > temps > volume, **digest sans substance = null**
   (contrainte codée « jamais une notif sans montant/échéance réels »). Orientation ACTION
   (« 2 340 € dehors, 3 relances prêtes »). → `buildValueDigest` (@bob/core, livré).
6. **Win-back sur valeur dormante** : un seul crochet chiffré/daté (devis qui expire,
   impayé), cooldown 14 j, zéro « tu nous manques », zéro remise secrète.
   → `decideWinBack` (@bob/core, livré).
7. **Diff « tu gagnes / tu perds »** avant tout changement de plan, calculé depuis
   PLAN_CATALOG, downgrade honnête (économie affichée). → `diffPlanChange` (livré).
8. **Grille C26** : Solo 19 / Pro 39 / Business 79 (source unique PLAN_CATALOG), Pro héros
   « le plus choisi » SEULEMENT si c'est factuel ; annuel en « mois offerts », JAMAIS
   pré-coché ; rappel renouvellement J-30 (au-delà loi Châtel) avec bilan de valeur joint.
9. **Compteur d'usage honnête** : actions IA + minutes Live visibles, alerte à 80 %,
   JAMAIS de coupure mid-action (invariant monitoré `was_mid_action=false`), la CONFORMITÉ
   (émettre une facture légale, exporter) n'est JAMAIS bloquée par un quota.
10. **Jamais d'achat 100 % vocal** : tout engagement payant se confirme par un TAP avec
    montant affiché (cohérent avec le plancher de consentement BOB LIVE). Bob peut PARLER
    le paywall (une phrase), un « non » vocal = silence 30 j.
11. **Analytics produit** : schéma typé sans PII, funnel d'activation 5 jalons
    (north star : premier devis vocal prêt < 180 s), paywall_viewed/converted par source,
    méthodologie du value ledger VERSIONNÉE. → `analytics.ts` (@bob/core, livré) ;
    adapters PostHog côté hôtes À FAIRE (pattern error-reporter.ts).

## Tués par les juges (NE JAMAIS implémenter)
- Decoy assumé (Business « ancre haute ») — Business n'existe que comme vrai produit équipe.
- Grandfathering « prix bloqué à vie » — prix voice_live PAS fixé (métrologie en cours).
- Témoignages fictifs (« Karim, électricien ») — pratique trompeuse (Omnibus/DGCCRF) tant
  qu'il n'y a pas de clients réels consentants et sourcés.
- Streaks/gamification UI (métrique analytics interne OK, affichage JAMAIS).
- Teaser « travail préparé retenu en otage » (relances rédigées mais verrouillées) —
  montrer SES données (montants réels), pas un travail kidnappé.
- Remise win-back secrète (churn stratégique + prix à deux vitesses).
- Features en « lecture seule » nageuses post-essai (nagging visuel permanent).
- Promesse « prix identiques web/mobile » sans stratégie IAP (commission 15-30 %).

## Reste à implémenter (ordre)
1. **i18n** : catalogue `catalogs/monetization.ts` ×3 humeurs (pattern cabinet).
2. **Mobile** : `useEntitlement(feature)` typé Feature (remplace les `.includes()` épars —
   attention à la politique fail-open/fail-closed incohérente relevée par l'exploration) ;
   `PaywallSheet` réutilisable (pattern ConfirmSheet + Sheet @bob/ui, kit @bob/ui PAS le
   shim legacy ventes) ; écran plans compte.tsx (CTA réels quand billing ouvert) ; carte
   digest sur Aujourd'hui ; modales dans le Stack racine `_layout.tsx` presentation:'modal'.
3. **API** : table Prisma `subscriptions` + branchement `subscriptionFor()`
   (backend.service.ts:578 — LE point unique documenté, tous les gatings suivent) ;
   job digest hebdo (pattern relance.service.ts + outbox kind 'weekly-digest', dedupeKey
   `digest:{companyId}:{isoWeek}:{POLICY_VERSION}`, flag env DIGEST_WORKER_ENABLED off) ;
   deriveValueDigest branché sur les données réelles (paiements receivedAt TTC — JAMAIS
   mélanger les assiettes HT/TTC, cf. règles derive-business-review) ; relances comptées
   sur notification_jobs.status='done' UNIQUEMENT (queued surestime) ; endpoints
   paywall/trial/diff + writer analytics (pattern ANALYTICS Symbol + Noop, opt-out RGPD).
4. **Enforcement serveur manquant** (relevé exploration) : accounting_operations,
   auto_dunning, team, monthlyActions (quota IA) ne sont gated NULLE PART — à combler
   avec le paywall serveur (`appForbidden` + message d'upsell, pattern ai_assistant).
5. Webhook Stripe + persistance checkout (aujourd'hui décoratif) — au moment de l'ouverture
   billing réelle (early-access C26 : tous business/0 € affiché honnêtement).

## Références code (exploration 14/07)
- Billing hook unique : `apps/api/src/backend.service.ts:578` (subscriptionFor).
- Gating exemplaire : ai_assistant :1538-1541 ; voice_live :1646-1653 (+ RealtimeEntitlementPort).
- Job multi-tenant : `apps/api/src/jobs/relance.service.ts:36-140` ; outbox kind union
  `apps/api/src/persistence/notification-jobs.ts:9` (colonne String, pas de migration).
- Deep links notifs : `apps/api/src/notifications/notification-route.ts:8-14`.
- Hooks mobile : `apps/mobile/src/data/hooks.ts` (useSubscription :61, keys :50-59).
- Paywalls ad hoc existants à unifier : pilotage.tsx:93/532, comptabilite.tsx:106,
  cloture.tsx:104, assistant.tsx:267/793.
- i18n : catalogue à spreader dans `packages/i18n/src/index.ts` (pattern cabinetFr).
