# Stratégie de monétisation — Bob Pro

> Produite par un panel multi-agents (packaging SaaS, growth/PLG, psychologie des prix, marché TPE FR + recherche concurrents live, critique adverse) → synthèse. Prix concurrents vérifiés : Indy ~12 €, Abby ~12 €, Pennylane ~14 €, Shine ~9 €, Henrri gratuit, Tiime gratuit.

*Copilote administratif & financier pour artisans, indépendants et TPE — fenêtre réglementaire 2026/2027*

---

## 1. VERDICT sur l'idée « web gratuit sans IA / Solo = mobile »

**À REMPLACER. On garde l'intuition, on jette la mécanique.**

### Ce qui est JUSTE (à garder)
- **Un gratuit comme moteur d'acquisition** : indispensable. Les concurrents qui gagnent l'acquisition (Indy, Tiime, Henrri, Abby, Shine) sont tous gratuits à l'entrée. Sans gratuit crédible, Bob Pro est invisible.
- **L'IA « Bob » derrière le paywall** : seul vrai différenciateur + seule fonction à coût marginal réel (tokens + OCR). La rendre payante est la décision juste de l'intuition.
- **Land-and-expand** (entrer gratuit, monter en gamme).

### Ce qui est FAUX : le gating par appareil
1. **L'appareil n'est pas une value metric** (ne corrèle ni à la valeur ni à la capacité de payer ; personne ne facture « par device » en FR).
2. **Punit le cas d'usage phare** : l'artisan vit sur mobile (photo facture chantier, signature client, facturation camionnette). Cacher le mobile derrière le paywall = inverser la valeur perçue.
3. **Détruit un actif payé** : la parité web/mobile construite serait sabotée.
4. **Trivialement contournable** (web sur navigateur mobile) → paywall intenable, message inexplicable → CAC ↑, conversion ↓, churn ↑.

### Piège secondaire : « gratuit = tout le non-IA »
Si le gratuit inclut devis→facture→Factur-X→encaissement **illimités**, l'artisan faible volume ne paiera jamais (*free trap*). On donnerait la commodité (déjà offerte par Henrri) et on garderait payant le facile à copier.

### Incohérences code à corriger
`packages/core/src/domain/subscription/plan.ts` : `ai_assistant` dans les 3 paliers (contredit la stratégie) ; prix 19/39/79 € (2–3× au-dessus du marché) ; aucun palier `Gratuit`.

> **Décision : freemium multi-plateforme (web ET mobile gratuits, parité conservée). Segmentation par VALEUR + VOLUME + IA, jamais par appareil. On vend l'intelligence et le temps gagné, pas un device.**

---

## 2. Modèle recommandé

**Axe :** « **Conformité gratuite, intelligence payante.** » Le socle réglementaire (subi, obligatoire) est gratuit pour acquérir ; Bob l'IA + l'automatisation (désirés) sont payants.

**Value metric (3 axes) :** VOLUME (bas de gamme) · AUTOMATISATION (milieu) · IA Bob + ÉQUIPE/PAIEMENT (premium).

| Palier | Mensuel | Annuel (équiv./mois) | Cible | Inclus | Débloque |
|---|---|---|---|---|---|
| **Découverte** (Gratuit) | 0 € | 0 € | Poussé par l'obligation 2026, faible volume | Web **+ mobile** (parité), devis→facture **~10/mois**, **réception** e-facture 2026, signature à distance (**3/mois**), diagnostic conformité, 1 user, **quota Bob 10–15 msg/mois** | — (aimant réglementaire) |
| **Solo** | 14 € HT | 12 € (144 €/an) | Indépendant facturant régulièrement | Découverte **sans plafond**, **émission** e-facture 2027, OCR dépenses (~50/mois), tréso de base, relances semi-auto, signature illimitée | Plafonds volume + OCR + émission |
| **Pro** ⭐ | 29 € HT | 24 € (288 €/an) | Artisan qui veut piloter & déléguer | Solo + **Bob l'IA illimité (fair use)** : OCR auto, relances rédigées IA, **trésorerie prévisionnelle**, diagnostic avancé, export comptable | **Bob illimité** + automatisation |
| **Business** | 59 € HT | 49 € (588 €/an) | TPE avec équipe/sous-traitants | Pro + **multi-utilisateurs/rôles**, accès comptable, **paiement en ligne + avance sur facture**, support prioritaire | Équipe + paiement/financement (ancre haute) |

- **Pro 29 € = palier cible.** Business 59 € = ancre/décoy. Solo 14 € au niveau Indy/Abby.
- **−20 % annuel** (« 2 mois offerts »). Tous les paliers web + mobile.

---

## 3. Palier GRATUIT « Découverte »

**À METTRE :** web+mobile (parité), réception e-facture 2026 (obligation universelle 1ᵉʳ sept. 2026 = raison d'ouvrir un compte), devis→factures Factur-X plafonnés ~10/mois, signature à distance 3/mois (viral B2B2B), diagnostic conformité (+ version no-signup en lead magnet SEO), quota Bob 10–15 msg/mois, 1 user.

**À NE PAS METTRE (payant) :** Bob au-delà du quota, OCR auto, trésorerie prévisionnelle, relances auto, émission e-facture 2027, volume illimité, paiement en ligne, multi-users.

**Pourquoi ça acquiert sans cannibaliser :** la conformité gratuite + parité mobile + amorce IA donnent une raison d'ouvrir un compte ; le plafond de volume + l'absence des automatisations à coût marginal verrouillent la conversion. Cible **2–5 %** de conversion freemium B2B (sous 2 % = gratuit déficitaire).

---

## 4. Place de l'IA et des fonctions à forte valeur

On facture ce qui a un coût marginal visible + une valeur métier ; on offre la commodité réglementaire.

- **Gratuit :** réception Factur-X · quota Bob (10–15 msg) · diagnostic.
- **Solo :** émission 2027 · OCR limité · volume illimité.
- **Pro :** **Bob illimité** · relances rédigées IA · trésorerie prévisionnelle · OCR illimité.
- **Business :** multi-users · paiement en ligne + avance · accès comptable.

> **Règle d'or IA :** quota au gratuit, illimité **fair-use** dès Pro (garde-fous anti-power-user pour la marge). Toujours validation humaine + parité « marche aussi sans IA ».

---

## 5. Playbook marketing & psychologie

**Positionnement :** « **Bob Pro — votre copilote admin & financier. Conforme 2026/2027, gratuitement. Bob fait le reste.** » On vend du temps rendu + la tranquillité réglementaire.

**Accroches :** « Prêt pour l'obligation du 1ᵉʳ sept. 2026 ? Vérifiez en 2 min. » · « 2h de paperasse en moins/semaine. » · « 1 impayé relancé par Bob = 6 mois d'abonnement. »

**Leviers :**
- Aversion à la perte réglementaire (diagnostic révèle les manques ; amende 15 €/facture mentionnée sans anxiogéner).
- Ancrage : Business 59 € à droite → Pro 29 € « raisonnable » ; ancrer sur le coût d'un comptable / d'un retard, pas sur les concurrents.
- Décoy : Business = leurre ; Pro marqué « Le plus choisi ».
- Dotation/perte : essai Bob complet **14 j**, puis retour au gratuit (« Bob a détecté 3 factures à relancer… »).
- Teasing grisé du gratuit (« Bob aurait rédigé cette relance »).
- Prix décomposé (Solo « 0,40 €/jour »). **Pas de dark patterns** (cible à fort bouche-à-oreille).

**Boucles virales :** signature de devis (client final exposé à la marque) ; footer « Facture conforme générée avec Bob Pro — vérifiez votre conformité 2026 ».

**Essai + freemium :** freemium permanent (acquisition + lock-in données) **et** essai Bob 14 j déclenché à l'inscription (conversion de l'aspirationnel).

**Mensuel/annuel :** annuel par défaut, mensuel-équivalent en gros + « 2 mois offerts ».

---

## 6. Entonnoir

Visiteur (SEO « logiciel facture électronique 2026 gratuit ») → **diagnostic conformité no-signup** (lead magnet viral) → inscription (web OU mobile, zéro friction) + essai Bob 14 j → activation (3 aha : 1ʳᵉ facture < 2 min · devis signé à distance · OCR→tréso) → usage gratuit (lock-in données) → paywalls **contextuels** au point de douleur (10ᵉ facture, 5ᵉ relance manuelle, pile de dépenses, fin de quota Bob) → conversion Solo/Pro/Business → expansion Solo→Pro (Bob illimité) → Pro→Business (équipe/paiement).

**Priorité temporelle :** capter SEO + bouche-à-oreille MAINTENANT — la fenêtre se referme à sept. 2026 (réception) / sept. 2027 (émission). Récupérer les orphelins QuickBooks (départ de France).

---

## 7. Plan 90 jours + métriques

- **J0–30 (pricing & socle) :** corriger `plan.ts` (ajouter `FREE`, retirer `ai_assistant` de Solo, recalibrer 14/29/59 + annuel, Bob en quota au gratuit / illimité dès Pro) ; plafonds gratuits (10 factures, 3 signatures, quota Bob) ; essai Bob 14 j + garde-fous fair-use ; diagnostic no-signup.
- **J31–60 (acquisition/activation) :** SEO « facturation électronique 2026/2027 », footer viral, lien de signature brandé, paywalls contextuels, A/B plafond factures (10 vs 15). Cible activation > 40 %, time-to-value < 2 min.
- **J61–90 (conversion/expansion) :** optimiser fin d'essai, séquence email réglementaire, Pro « recommandé ». Cibles : conversion free→payant **2–5 %**, churn payant < 4 %, **NRR > 100 %**, **LTV/CAC > 3**, marge IA/compte positive, coefficient viral signatures.

---

## Synthèse en une phrase
**Abandonner le gate par appareil ; garder le gratuit et l'IA premium. Offrir la conformité (web + mobile, parité totale) pour acquérir massivement avant sept. 2026, plafonner le volume pour ne pas cannibaliser, et vendre Bob l'IA + l'automatisation à 14/29/59 € avec Pro comme palier cible.**
