# AIPD — Assistant vocal Jarvis (Bob Pro) — SQUELETTE

- **Date** : 2026-08-18 · **Statut** : SQUELETTE (pré-rempli avec les décisions actées ; les sections `[À COMPLÉTER — U1]` attendent la spécification du lot U1)
- **Exigence source** : [FD-2026-0817-09](../DECISION_JARVIS_UNIVERSEL_20260817.md) — « AIPD requise avant activation large » (voix + données de tiers + échelle). L'AIPD **complète et validée** est un gate d'activation large, pas un document d'accompagnement.
- **Méthode** : structure CNIL (description, nécessité/proportionnalité, mesures, risques).
- **Pourquoi une AIPD** (art. 35 RGPD, critères CNIL/CEPD) : ≥ 2 critères réunis — données à grande échelle, collecte de données de tiers non-utilisateurs (clients des artisans mentionnés à la voix), usage innovant (assistant vocal LLM temps réel), données financières.

## 1. Description du traitement

| Élément | Contenu |
|---|---|
| Nature | Assistance vocale duplex temps réel pour la gestion administrative et financière (dictée d'intentions, propositions d'actions, confirmations selon la grille R0–R4) |
| Support technique | OpenAI Realtime (WebRTC, `openai-native-webrtc-v1`), flux audio bidirectionnel, aucun enregistrement audio |
| Finalité principale | Exécution du service souscrit par l'artisan : opérer son application par la voix |
| Finalités exclues | Prospection (interdite, FD-01) ; entraînement de modèles sur les données clients (garanti par ZDR) ; profilage |
| Personnes concernées | (a) l'utilisateur artisan ; (b) **tiers** : ses clients, contacts et fournisseurs mentionnés à la voix ou présents dans les données manipulées |
| Périmètre des actions | Le catalogue versionné `PublicActionSurfaceManifest` — liste exacte : `[À COMPLÉTER — U1]` |

## 2. Acteurs et responsabilités

| Acteur | Qualification | Base |
|---|---|---|
| Artisan utilisateur | **Responsable de traitement** de ses données clients | art. 4.7 |
| Bob Pro (GLWebDev Agency) | **Sous-traitant** de l'artisan ; responsable de traitement pour les données de compte | art. 28 |
| OpenAI | **Sous-traitant ultérieur nommé** (traitement voix) | art. 28.4 |
| Supabase / Railway / Brevo | Sous-traitants ultérieurs (hébergement auth/DB, API, e-mail) | art. 28.4 |

`[À COMPLÉTER — U1]` : DPA signés et versions, référent RGPD interne, registre des sous-traitants ultérieurs finalisé.

## 3. Licéité

- Utilisateur : **art. 6.1.b** (exécution du contrat de service).
- Données de tiers évoquées à la voix : **art. 6.1.f** (intérêt légitime de l'artisan à gérer sa relation commerciale) — l'analyse de mise en balance est celle, classique, de la gestion clientèle ; la voix n'ajoute pas de finalité nouvelle, seulement un canal.
- Aucune donnée d'article 9 recherchée ; la voix n'est **pas** utilisée à des fins biométriques d'identification (la biométrie de step-up R3 est **locale à l'appareil** — BiometricPrompt/LocalAuthentication — et ne transite jamais).

## 4. Données et durées

| Donnée | Traitement | Rétention |
|---|---|---|
| Flux audio (deux sens) | Temps réel, transit OpenAI | **Zéro conservation** (FD-09) — aucun enregistrement côté Bob ; ZDR côté OpenAI |
| Transcriptions / commandes liées à un **acte** (facture émise, envoi…) | Conservées dans le run (reprise + audit) | Durée légale de l'acte auquel elles se rattachent |
| Runs sans acte | Conversationnel éphémère | **Purge 90 jours** |
| Voice Trace (audit technique) | Pseudonymisé, accès restreint | `[À COMPLÉTER — U1]` (durée à chiffrer) |
| Reçus d'actes (work items, intents) | État persisté autoritaire | Durée légale des pièces (art. 17.3.b : survivent à l'effacement du conversationnel) |

## 5. Information et droits

- Information : politique de confidentialité + **écran de première activation vocale** nommant OpenAI comme sous-traitant (FD-09) ; pédagogie in-app au point de décision (doctrine LegalHint).
- Droits : accès/rectification via l'app ; **effacement** = purge du conversationnel à la demande, les reçus d'actes légaux survivent et **cela est expliqué à l'utilisateur** ; portabilité via les exports.
- Tiers : information par le responsable de traitement (l'artisan) via sa relation contractuelle — mention type fournie par Bob `[À COMPLÉTER — U1]`.

## 6. Nécessité et proportionnalité

- Minimisation : le moteur ne reçoit que le contexte nécessaire au tour (pas de dump du tenant) — contours exacts `[À COMPLÉTER — U1]` ; les chiffres restitués sont **dérivés des autorités**, jamais saisis librement (FD-08).
- Proportionnalité du canal voix : mêmes garde-fous que l'interface manuelle, renforcés (grille R0–R4 : aucun acte engageant sans écran, step-up biométrique local pour le critique) — la voix n'élargit **aucun** droit d'action.

## 7. Mesures

**Techniques** : résidence **UE** + **Zero Data Retention** OpenAI = gate d'activation (FD-09, non négociable) ; TLS/DTLS-SRTP de bout en bout ; bearer capturé au train Auth (jamais résolu après signOut) ; RLS Supabase par tenant ; reçus typés `screen_ack`/step-up ; fail-closed sur la voix, jamais sur le compte ; zéro fallback silencieux.
**Organisationnelles** : catalogue d'actions fermé versionné ; décisions fondatrices tracées (`founderDecisionId`) ; canary sur compte fondateur avant toute ouverture (FD-10) ; revues adversariales croisées Claude/GPT ; journal d'audit `legacy_audit_event_v1` en lecture seule.

## 8. Risques (grille CNIL : gravité × vraisemblance)

| Risque | Scénario | Mesures ci-dessus | Résiduel |
|---|---|---|---|
| Accès illégitime | Tiers dans la pièce déclenche un acte | R2 écran obligatoire + R3 biométrie → un « oui » capté ne suffit jamais | Faible |
| Accès illégitime (réseau) | Interception du flux | DTLS-SRTP, résidence UE, ZDR | Faible |
| Modification non désirée | Le LLM propose un acte erroné | Intention-avant-effet, validation humaine, chiffres dérivés des autorités | Modéré → `[À COMPLÉTER — U1]` mesures de recette par action |
| Disparition de données | Perte du run en vol | Work items durables, reprise après interruption | Faible |
| Détournement de finalité | Usage des données par le fournisseur de modèle | ZDR contractuel, pas d'entraînement | Faible sous gate ; **inacceptable sans le gate** |

## 9. Gates de sortie de l'AIPD

1. Endpoint OpenAI résidence UE + ZDR **actifs et prouvés** (capture de configuration).
2. Écran d'information première activation livré.
3. Durées §4 implémentées (purge 90 j vérifiable).
4. Liste d'actions U1 figée dans le manifeste et reportée en §1.
5. Avis du référent RGPD + validation fondateur — `[À COMPLÉTER]`.

*Squelette rédigé par Claude (contre-expertise) en avance de phase du lot U1 ; il n'engage aucune activation. Toute divergence constatée entre ce document et le code réel se résout par correction de l'un ou de l'autre AVANT activation large.*
