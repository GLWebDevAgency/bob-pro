# Content design, statuts et ton

> Statut : **Proposed**
> IDs liés : T01–T08 et toutes les interfaces asynchrones
> Autorité : complète `VOICE_AND_TONE.md`, ne le remplace pas

## Objectif

Rendre chaque état compréhensible, honnête et actionnable. La personnalité change le ton et la
longueur ; elle ne change jamais un fait, une obligation, un montant ni une conséquence.

## Sources de vérité

- `VOICE_AND_TONE.md` reste la source de Bob Pote/Pro/Direct.
- Les use cases et résultats typés définissent le sens métier.
- L'état autoritaire définit pending/success/error.
- Les textes légaux validés ne sont pas paraphrasés librement.
- Le LLM ne génère pas la microcopy critique à l'exécution.

## Architecture d'un message

Ordre standard :

1. **Conclusion** : ce qui se passe.
2. **Impact** : ce qui est sûr ou bloqué.
3. **Action** : ce que l'utilisateur peut faire.
4. **Détail** : preuve ou diagnostic secondaire.

Exemple :

> L'analyse du document a échoué. L'original est bien conservé. Relancer Bob. Voir les détails
> techniques.

## Glossaire de statuts

| Statut canonique | Libellé utilisateur | Usage interdit |
| --- | --- | --- |
| `idle` | Prêt / aucune action en cours. | « En ligne » si seule une dépendance réseau répond. |
| `authorizing` | Ouverture du micro / autorisation. | « J'écoute » avant permission et capture. |
| `connecting` | Connexion sécurisée… | « Je réfléchis ». |
| `pending` | Enregistrement / envoi / vérification en cours. | « Fait » ou check vert. |
| `processing` | Formulation spécifique ou « Analyse en cours ». | Phase décorative sans source. |
| `success` | Résultat concret : « Paiement enregistré ». | Célébration avant ACK. |
| `recoverable_error` | Cause + état préservé + retry. | « Une erreur est survenue » seul. |
| `terminal_error` | Cause sûre + alternative/fermeture. | Retour silencieux à idle. |
| `offline` | Action indisponible ou mise en attente selon contrat. | Afficher zéro/données anciennes comme fraîches. |
| `unknown` | « Je vérifie si l'action a été prise en compte. » | Deviner succès/échec. |
| `reconnecting` | Reconnexion… | « Bob réfléchit ». |

## T01 — Vérité des statuts

Chaque clé critique documente :

- événement/source ;
- préconditions ;
- personnalité ;
- annonce accessible ;
- action disponible ;
- fallback si l'état n'est pas connu.

Les statuts réseau, disponibilité Assistant, disponibilité voix, capture et playback sont séparés.

## T02 — Ton financier et sensible

### Règles

- Nommer l'objet, le montant ou la date utile.
- Distinguer préparé, émis, envoyé, payé et rapproché.
- Éviter emoji/confetti pour émission, paiement, suppression, fiscalité et clôture.
- Ne jamais dire « conforme » si le périmètre certifié est plus étroit.
- Préciser lorsqu'une action est réversible ou attend une confirmation.

| Situation | Pote | Pro | Direct |
| --- | --- | --- | --- |
| Paiement confirmé | « Paiement enregistré. » | « Le paiement a été enregistré. » | « Paiement enregistré. » |
| Facture préparée | « La facture est prête à vérifier. » | « La facture est prête pour vérification. » | « Facture prête. » |
| Facture émise | « La facture est émise. » | « La facture a été émise. » | « Facture émise. » |
| Dossier prêt | « Ton dossier est prêt à exporter. » | « Votre dossier est prêt à être exporté. » | « Dossier prêt. » |
| Action incertaine | « Je vérifie si ça a bien été pris en compte. » | « Vérification de la prise en compte en cours. » | « Vérification… » |

## T03 — Abstraction technique

Le premier niveau parle du travail utilisateur. Les détails techniques restent accessibles pour le
support et l'audit.

| Interne | Premier niveau | Détail facultatif |
| --- | --- | --- |
| Révision serveur obsolète | « Le document a changé. Rechargez-le avant de continuer. » | Révision attendue/observée, corrélation. |
| Idempotence/replay | « Je vérifie si l'action a déjà été effectuée. » | Invocation et statut technique. |
| OCR timeout | « La lecture prend trop de temps. L'original est conservé. » | Moteur, durée, identifiant support. |
| Reconnexion WSS | « Reconnexion à Bob… » | Route, tentative, cause normalisée sans secret. |
| RLS/autorisation | « Vous n'avez pas accès à cet élément. » | Code de policy pour support autorisé. |

Les détails ne contiennent ni secret, ni audio, ni transcript, ni donnée d'un autre tenant.

## T04 — Action-first

### Titres

- Bon : « 1 facture bloque la clôture ».
- Moins bon : « Contrôles de cohérence » comme titre principal.
- Bon : « 2 documents à vérifier ».
- Moins bon : « File de validation ».

### CTA

- Nommer le résultat : « Envoyer la relance », « Ouvrir la facture », « Relancer l'analyse ».
- Éviter « Continuer » lorsqu'une conséquence précise peut être nommée.
- Conserver « Continuer » pour une simple progression sans effet.
- Ne pas changer un CTA en succès avant le résultat réel.

### Cartes

Une carte possède : un statut, un titre, une justification courte et une action principale. Les
actions secondaires vont dans un menu ou une toolbar.

## T05 — Pérennité temporelle

- Aucun millésime figé dans un CTA durable.
- Les échéances proviennent de la donnée ou d'une configuration versionnée.
- Tester 31 décembre/1er janvier et fuseau Europe/Paris.
- Les campagnes peuvent mentionner une année ; les labels de navigation non.
- Remplacer « Prêt pour 2026 ? » par « Vérifier ma conformité e-facturation » ou un statut calculé.
- Le texte précise la date de fraîcheur lorsqu'une valeur est observée/estimée.

## T06 — Erreurs réparables

| Famille | Forme | Action primaire | État à préserver |
| --- | --- | --- | --- |
| Réseau | « Connexion interrompue. Vos données saisies sont conservées. » | Réessayer | Brouillon/champs. |
| Permission | « Le micro n'est pas autorisé. » | Ouvrir les réglages | Contexte/texte. |
| Validation | Champ précis + correction attendue. | Corriger | Tous les autres champs. |
| Conflit | « Cet élément a été modifié ailleurs. » | Recharger/comparer | Aucun overwrite silencieux. |
| Timeout inconnu | « Je vérifie si l'action a été prise en compte. » | Vérifier | Idempotency key. |
| Indisponibilité | « Cette action est temporairement indisponible. » | Continuer autrement | Consultation possible. |
| Terminal | Cause sûre, support si utile. | Fermer/contacter | Preuves non sensibles. |

Une erreur ne culpabilise pas, ne promet pas un retry certain et ne révèle pas l'existence d'un
compte dans les parcours auth.

## T07 — Personnalités Bob

### Peut varier

- tutoiement/vouvoiement ;
- chaleur ;
- longueur ;
- présence rare d'un emoji en Pote ;
- formulation de l'action.

### Ne varie pas

- statut et temporalité ;
- montant, date, client et référence ;
- conséquence juridique/financière ;
- nécessité d'une confirmation ;
- disponibilité d'une action ;
- gravité de l'erreur ;
- instructions de sécurité.

Les phrases critiques possèdent des snapshots i18n dans les trois personnalités.

## T08 — Succès autoritaire

```text
Tap/voix → commande locale → pending → ACK/relecture → success
                               └→ unknown/recovery
                               └→ error
```

- Le tap peut donner un feedback tactile immédiat, pas une confirmation métier.
- `success` cite le résultat obtenu.
- Un optimisme UI reste visuellement pending jusqu'à réconciliation.
- Un résultat perdu déclenche une vérification idempotente.
- Un toast ne constitue pas la seule preuve d'une action sensible.

## Bob conversationnel

- Une idée par phrase.
- Une question à la fois.
- Le plan est annoncé seulement s'il aide réellement.
- Une réponse longue arrive par blocs/phrases, pas caractères.
- Les montants sont lus depuis des données structurées.
- Une ambiguïté présente des options gelées et numérotées.
- Le transcript n'est jamais reformulé comme consentement.
- La réponse vocale et la carte utilisent le même sens, même si leur longueur diffère.

## États vides

Un empty state explique :

1. ce qui est vide ;
2. pourquoi cela peut être normal ;
3. la meilleure première action ;
4. ce qui apparaîtra ensuite.

Il ne simule jamais de données de démonstration dans un artefact de production.

## Notifications et toasts

- Le toast confirme une action courte et non ambiguë.
- Une action réversible propose Undo assez longtemps et accessible.
- Une information importante persiste dans la page/centre de notifications.
- Un toast n'empile pas plusieurs messages Bob simultanés.
- Les annonces accessibles ne répètent pas le même contenu dans le toast et la page.

## Critères d'acceptation

- [ ] Mapping source → statut → clé i18n documenté.
- [ ] Les trois personnalités conservent exactement le même sens.
- [ ] Aucun statut “en ligne”, “fait”, “payé” ou “conforme” sans source exacte.
- [ ] Chaque erreur indique impact et action.
- [ ] Les détails techniques sont disponibles sans dominer.
- [ ] Aucun millésime durable figé.
- [ ] Les phrases sensibles sont testées en snapshot.
- [ ] Les annonces accessibles sont dédupliquées.
- [ ] Aucun texte génératif non validé dans une confirmation ou un statut critique.
- [ ] Revue finance/juridique des actions d'émission, paiement, clôture et suppression.
