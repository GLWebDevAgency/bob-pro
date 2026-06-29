# Bob Pro — Pricing & verticalisation métier

> Panel multi-agents (économiste pricing, verticalisation/packaging, architecte produit, critique adverse) + recherche concurrents live. Comps vérifiés (mensuel HT) : Indy 0/12/28/59 · Pennylane 14/24/79 · Abby 0/11/19/39 · Tiime 0/17,99/24,99 · Sellsy 39/user. Prime IA marché : +20-37 % de WTP. Coût marginal Bob (Haiku/GLM) ~1-5 $/mois/user actif → marge IA >80 % même illimité à 29 €.

## 1. Prix trop bas ?
Solo bien calibré · **Pro nettement sous-valué** · Business un peu bas.

| Palier | Actuel | Recommandé | Raison |
|---|---|---|---|
| Découverte | 0 € | **0 €** | coût d'entrée obligatoire (tous les concurrents ont un gratuit) |
| Solo | 14 € | **14 €** | ancre basse parfaite (= Pennylane 14, > Abby/Indy) — ne pas bouger |
| Pro | 29 € | **39 €** (36 si frileux) | c'est là que vit Bob (IA illimitée) ; tarifé comme une commodité sans IA. +10-15 € = exactement la prime IA marché |
| Business | 59 € | **69 €** | équipe = segment le moins sensible au prix ; tu offres plus qu'Abby 64,99 |

**Garde-fous :** hausse **sur les nouveaux clients seulement** (grandfathering des anciens à 29 €) ; « illimité » → **illimité fair-use** + rate-limit doux ; **ne pas monter Solo** (l'ancre qui rend 39 lisible). Annuel −20 % conservé.

## 2. Prix par métier ? NON (unanimité)
- **Injustice perçue** : « pourquoi je paie plus parce que je suis plombier ? » — le métier est une *identité*, pas une *consommation*.
- **Gaming trivial** : métier auto-déclaré (9 choix dont « autre ») → un tap pour payer moins.
- **Illisible** : 4 paliers × 9 métiers = 36 prix ; « ça dépend de ton métier » = signal d'arnaque, tue SEO/bouche-à-oreille. Aucun concurrent ne le fait.
- **Anti-archi** : coupler `Trade` (company) à `priceCents` (subscription).

**Règle d'or : on facture ce que le client UTILISE, jamais ce qu'il EST.**

## 3. Produit par métier ? OUI — la vraie dette
Aujourd'hui `TRADE_PROFILES.modules` est **cosmétique** (affichage onboarding). On promet « Chantiers/Retenue de garantie » au plombier, « Missions/TJM/CRA » au consultant… puis on livre la même app générique → **onboarding qui ment + produit indifférenciable**. Pourtant la conformité métier est déjà câblée (`isBtp`, `requiresAutoliquidation`, `build-mentions`, `diagnostic`).

| Axe | Quoi | Gratuit/Payant |
|---|---|---|
| Vocabulaire/UI | Mission/TJM/CRA (consultant), Séances/Forfaits (coach), Chantiers/Situations (BTP) | **Gratuit, tous paliers** |
| Modules pertinents/masqués | cacher « Retenue de garantie » à un coach | **Gratuit** |
| Défauts TVA | BTP → 10 %, autres → 20 % (déjà amorcé) | **Gratuit** (overridable) |
| Conformité | décennale, autoliquidation, mentions | **Gratuit, transversal — jamais paywall** |
| Modules métier lourds (BTP) | situations, retenue de garantie auto, bibliothèque d'ouvrages | **Payant** (§5) |

Le BTP paie déjà 2-3× ailleurs (Tolteck 19-25, Obat 25-79, Batappli 35+) pour ces fonctions chantier → la verticalisation **justifie/relève** le prix (un prix bas *disqualifie* : « 14 € = jouet »).

## 4. Implémentation (Clean Arch / DDD) — sans jamais toucher `priceCents`
1. **Promouvoir `TradeProfile`** (`trade-profile.ts`) : `modules: string[]` → `ModuleKey` (union fermée ~6-10 : CHANTIERS, RETENUE_GARANTIE, SITUATIONS_TRAVAUX, ACOMPTES, CRA, TJM, FRAIS_REFACTURES, FORFAITS, ABONNEMENTS, CESSION_DROITS) + `vocabulary` + `defaults` (vatRate, lineCategories).
2. **Point de vérité unique** : `resolveTradeConfig(company): TradeConfig` (`domain/services/`), consommé par mobile ET web.
3. **Séparer « pertinent » et « débloqué »** : `tradeModules(company)` (UX, gratuit, piloté par Trade) ∩ `planEntitlements(tier)` (gate prix, piloté par tier). Un écran s'affiche si `tradeRelevant ET (gratuit OU planCan(tier, feature))`. **`Trade` ne touche jamais le prix.**
4. **Onboarding honnête** (`onboarding.tsx`) : modules réellement actifs au palier courant + teaser « débloqués en Pro ».
5. **Conformité hors modules** : reste transversale, jamais gatée.

## 5. Monétiser la verticalisation
- **Option A (d'abord, simple)** : ranger les modules de niche dans les paliers existants (chantier de base dès Solo ; situations/retenue/CRA/forfaits dès Pro). Plombier et consultant ont des raisons *différentes* de monter en Pro, au *même* prix.
- **Option B (gisement BTP, quand A a de la traction)** : add-on **« Pack Chantier BTP » +9-12 €/mois** sur Pro (inclus dans Business). Situations, retenue de garantie auto, bibliothèque d'ouvrages, suivi photos. Upsell **contextuel** déclenché par `trade ∈ BTP_TRADES` (le métier *guide*, l'achat reste volontaire). Code : `AddOn = 'vertical_btp'` + `Feature` dédiée dans `plan.ts` ; entitlement `planCan(tier,f) OU addOnCan(addons,f)` ; persister `addOns` (mappers/Prisma).
- **Frontière** : conformité = gratuite ; seuls les **workflows de confort** sont payants. **Un seul pack vertical (BTP)** tant qu'une autre verticale ne prouve pas complexité + WTP.

## 6. Grille finale
| Palier | Mensuel | Inclus |
|---|---|---|
| Découverte | 0 € | réception 2026, facturation limitée, Bob quota, vocabulaire+conformité métier |
| Solo | 14 € | facturation illimitée, OCR, émission 2027, modules métier de base |
| Pro | **39 €** | + Bob illimité (fair-use) + relances IA + tréso prévisionnelle + modules métier à valeur |
| Business | **69 €** | + équipe + avance + paiement en ligne + assurance + support + Pack BTP inclus |
| Add-on Pack BTP | +9-12 € | sur Pro (inclus Business) |

Version prudente : `0/14/36/59` + add-on. Annuel −20 %.

## Séquencement (important)
1. **Onboarding honnête + modules métier réels (Option A)** — AVANT toute hausse (sinon la hausse amplifie « je paie des modules promis mais absents »).
2. Monter **Pro 39 / Business 69 sur les nouveaux** (grandfathering).
3. Mesurer conversion Free→Pro + churn par métier.
4. Lancer le **Pack BTP** (Option B) une fois la WTP confirmée.

**Fichiers** : `trade-profile.ts` (refactor), nouveau `resolve-trade-config.ts`, `plan.ts` (AddOn + Feature BTP + hausse prix), `onboarding.tsx`, mappers/Prisma (persistance `addOns`).
