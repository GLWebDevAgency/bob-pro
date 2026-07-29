# Décisions d'architecture de l'expérience mobile

> Statut du registre : **Proposed**
> Portée : décisions préparatoires du programme mobile experience
>
> **Amendement A6 — 2026-07-29.** Les lignes D07 et D08 sont amendées pour refléter A1 à A3
> (doctrine « matière Bob », retombée `ProgressiveBlurBob`, comportement de la tab bar). Le cycle
> de décision, les deux axes de statut, les owners et les cibles sont **inchangés** ; aucune
> décision ne passe de statut. Voir le [journal des amendements](../README.md#journal-des-amendements).

Ces ADR locaux évitent d'entrer en collision avec les ADR produit/runtime actifs dans `docs/adr`.
Ils peuvent être promus plus tard dans le registre global après acceptation et résolution des
numéros. Tant qu'ils restent `Proposed`, ils n'autorisent aucune implémentation.

## Cycle de décision sans circularité

Un ADR possède deux axes séparés :

1. **statut de décision** : `Proposed → Decision-ready → Accepted|Rejected → Deprecated|Superseded` ;
2. **statut d'implémentation** : `Not started → In progress → Implemented → Verified|Rolled back`.

Une dépendance externe, une option ou une priorité n'est jamais encodée comme un troisième statut.
Elle reste décrite dans le résultat attendu, la cible ou les IDs bloqués. Cette règle rend le
registre filtrable sans traduction implicite de termes comme « open », « optional » ou « blocked ».

`Decision-ready` exige uniquement la section **Preuves minimales pour accepter la décision**,
produite par les spikes non publiés de `WP-0004`. Quand les décideurs signent, l'ADR devient
`Accepted` et les WP produit peuvent devenir `Ready`. Les cases **Critères de vérification de
l'implémentation** sont remplies après le code ; elles ne conditionnent jamais l'acceptation
initiale de l'ADR. Ainsi, aucune boucle ADR→code→ADR n'est possible.

## Registre opérable des décisions

`Owner nommé` reste volontairement vide tant qu'une personne n'a pas accepté la responsabilité. Une
ligne sans owner nommé ne peut pas passer à `Decision-ready`.

| ID | Décision / résultat attendu | Record d'autorité | Statut décision · implémentation | Owner rôle · owner nommé | Cible | WP/IDs bloqués |
|---|---|---|---|---|---|---|
| D00 | Cap de publication canonique intégré ; rescoping du freeze UX encore à signer. | [Cap publication](../../../design_handoff_bob_pro/OBJECTIFS_SPECS_DOD_PUBLICATION.md) + [ADR-0004](../../adr/0004-gpt-realtime-publication-mistral-v3-post-v1.md). | Proposed · Not started | Fondateur/release owner · **à affecter** | Avant GATE-PUBLICATION | WP-0001 et tout le programme |
| D01 | Runtime motion hybride ou alternative retenue. | [UX-ADR-001](UX-ADR-001-motion-runtime.md) | Proposed · Not started | Mobile tech lead · **à affecter** | Vague 0 / WP-0004 | WP-0201–0210, G04–G09, G13–G15, G21–G22 |
| D02 | Architecture Expo Router, push/modal/sheet et stratégie tabs. | [UX-ADR-002](UX-ADR-002-navigation-surfaces.md) | Proposed · Not started | Mobile tech lead · **à affecter** | Vague 0 / WP-0004 | WP-0301–0308, G07, G10–G12, G16 |
| D03 | Projection Bob provider-neutral et sans autorité. | [UX-ADR-003](UX-ADR-003-bob-live-visual-projection.md) | Proposed · Not started | Bob Live owner · **à affecter** | Vague 0 / WP-0004 | WP-0501–0509, V01–V14, S05, S32 |
| D04 | Cible finale thème adaptatif complet, force-light seulement transitoire. | [UX-ADR-004](UX-ADR-004-adaptive-appearance.md) | Proposed · Not started | Design owner + Accessibility · **à affecter** | Vague 0 / WP-0004 | WP-0101–0102, WP-0304, G01–G02 |
| D05 | Budgets, instrumentation allowlistée et rollback. | [UX-ADR-005](UX-ADR-005-performance-observability.md) | Proposed · Not started | QA/performance owner · **à affecter** | Vague 0 / WP-0004 | WP-0002, WP-0006, WP-0210, G21 |
| D06 | Haptique Expo sémantique, bornée et sûre pour l'audio. | [UX-ADR-006](UX-ADR-006-haptic-feedback.md) | Proposed · Not started | Mobile + Bob Live owners · **à affecter** | Vague 0 / WP-0004 | WP-0204, G06 |
| D07 | Renderer de tabs final : custom Bob ou Native Tabs certifié ; choix figé au démarrage. **(amendé A3 · 2026-07-29 : le renderer retenu doit porter les cinq comportements normatifs de la barre ; `UITabBar` iOS 26 s'effondrant sur une seule icône au repli, elle ne peut pas les satisfaire.)** | Décision consignée dans UX-ADR-002 ou ADR de supersession. | Proposed · Not started | Product/Design/Mobile · **à affecter** | Avant WP-0303 | WP-0303, G11 |
| D08 | ~~Verre/blur activé ou non par capability~~ **(amendé A1/A2 · 2026-07-29)** Le verre système est **hors doctrine** : il n'y a plus de décision à prendre sur lui. Ce qui reste à décider est borné : **activer ou non le mode flouté** de `ProgressiveBlurBob` sur fond photographique, sachant que le mode teinté sans flou est le défaut livrable. | Décision consignée dans UX-ADR-004 (§ Algorithme de surface) et budget dans [10 — Performance](../10-performance-observability.md). | Proposed · Not started | Design/Mobile/A11y · **à affecter** | Avant WP-0307 | WP-0307, G20 uniquement |
| D09 | Disponibilité des événements outil et amplitudes entrée/sortie ; fallback exact. | Contrat d'événements joint à UX-ADR-003. | Proposed · Not started | Bob Live/runtime owner · **à affecter** | Avant WP-0501/0503 | V03, V05, V06 |
| D10 | Maintien, façade ou dépréciation de `/voix`. | ADR de compatibilité à créer si suppression. | Proposed · Not started | Product + Bob Live owner · **à affecter** | Avant WP-0509-02 en Vague 6 | S32 uniquement ; ne bloque pas le pilote S05 |
| D11 | Politique des surfaces auth agrégées vs routes dédiées. | Route matrix acceptée sous WP-0301. | Proposed · Not started | Auth/Mobile owner · **à affecter** | Avant WP-1104 | S30, S31, S33 |
| D12 | Appareils, seuils calibrés et taux de rafraîchissement certifié. | Artefact `PERF-CALIBRATION` défini dans le document performance. | Proposed · Not started | QA/performance owner · **à affecter** | Avant GATE-FOUNDATION | WP-0002, WP-0210, G14, G21 |

## Mise à jour du registre

- Toute transition de statut indique date, décideurs, lien vers preuve et résultat dans cette table.
- Le caractère optionnel de D08 limite son blocage à WP-0307/G20 ; son statut suit néanmoins le
  même cycle que les autres décisions et le programme conserve son fallback opaque.
- Un ADR `Accepted` n'est pas réécrit pour changer sa décision. Un nouvel ADR le supersède en liant
  l'ancien et en expliquant la migration.
- Après implémentation, le statut d'implémentation et le [registre de preuves](../18-evidence-register.md)
  sont mis à jour dans le même lot.
