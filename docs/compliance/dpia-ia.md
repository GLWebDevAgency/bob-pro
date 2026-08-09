# DPIA — Traitements algorithmiques (IA, OCR, voix)

**Statut : analyse technique mise à jour ; validation juridique et publication bloquées.**

Cette analyse couvre les traitements IA, OCR et vocaux de Bob Pro/Nico. Elle suit la méthode AIPD de
la CNIL : décrire le traitement, vérifier nécessité/proportionnalité, apprécier les risques puis
documenter les mesures. Elle ne remplace pas la validation du responsable de traitement ou du DPO.

## 1. Description et périmètre

| Traitement | Entrée | Sortie | Canal / destinataire | Décision automatisée ? |
|---|---|---|---|---|
| Classification d'intention | Texte de commande minimisé | Intention + références métier | Mistral ; Anthropic pour les tâches critiques | **Non** — proposition puis confirmation/domaine déterministe |
| OCR de pièces | Image du justificatif | Champs extraits | Mistral principal ; Anthropic secours documentaire | Non — validation utilisateur |
| Dictée classique | Audio microphone | Texte | Recognizer strictement local de l'appareil | Non |
| Synthèse classique | Texte issu du domaine | Audio | Service TTS système, sans appel au backend Bob | Non |
| Voix V1 historique (anciens binaires) | Enregistrement micro / texte de réponse | Transcription / audio | Mistral — Voxtral tour-par-tour, routes serveur encore actives selon configuration | Non |
| Bob Live — cible de publication, actuellement `OFF` | Flux microphone + contexte nécessaire | Texte/action proposée + réponse audio | OpenAI — GPT Realtime ; hors UE possible | Non — mêmes confirmations métier |
| Mistral/Voxtral V3 — différé, `OFF` | Aucun flux public | Aucun | Aucun tant que la voie reste différée | Non |
| Crash reporting | Exception et contexte technique filtrés | Événement de diagnostic | Sentry, DSN région DE | Non |
| Performance mobile | Durées + métadonnées appareil/app + identifiant d'installation | Métriques et sessions | Expo / EAS Observe | Non |

La dictée classique exige un moteur local français. Android est fermé sous l'API 33 ou sans modèle
`fr-FR`; iOS est fermé sans recognizer local `fr-FR`. Il n'existe aucun repli réseau silencieux : le
texte reste disponible. Sur Android, la synthèse ne choisit qu'une voix française marquée sans réseau ;
sur iOS elle dépend du service TTS configuré par le système et ne doit pas être présentée comme une
garantie hors-ligne absolue.

Cette fermeture concerne le **client courant**, pas tout le parc. Les routes serveur V1 de
transcription/synthèse restent inchangées conformément à l'autorité de publication et peuvent encore
être appelées par un ancien binaire. Elles transmettent alors l'enregistrement ou le texte de réponse
à Mistral. Leur information préalable, DPA, région, rétention et parc actif ne sont pas certifiés.

Bob Live est un canal distinct. S'il est ultérieurement activé, le PCM microphone transite vers le
serveur puis OpenAI mais n'est pas persisté par Bob. L'audio de réponse est un artefact privé disponible
dans le fil pendant 15 minutes via des URL signées valables au plus 30 secondes ; ses métadonnées peuvent rester 30 jours. La purge de l'objet en
production n'est pas certifiée, donc la capacité publique demeure `OFF`.

**Aucune décision produisant des effets juridiques n'est exclusivement automatisée** : l'IA propose,
l'utilisateur confirme et le domaine déterministe exécute. Facturation, encaissement et envoi à un
tiers conservent leur confirmation obligatoire.

## 2. Nécessité et proportionnalité

- **Finalité** : réduire la charge administrative sans se substituer à la décision de l'artisan.
- **Minimisation** : texte strictement nécessaire et PII masquées sur le chemin textuel ; audio limité
  au canal explicitement ouvert ; aucune base clients complète transmise au fournisseur vocal.
- **Alternative** : saisie texte et parcours manuels disponibles ; indisponibilité locale ferme la
  voix au lieu d'élargir silencieusement le traitement.
- **Choix IA textuelle** : l'utilisateur peut ne pas lancer l'Assistant et employer les parcours
  manuels. Aucun interrupteur global ni moteur IA local n'est actuellement disponible ; la notice ne
  doit pas en promettre.
- **Séparation des finalités** : dictée classique locale et Bob Live réseau sont deux capacités
  distinctes. La préférence du client courant `cloud` est migrée vers le local ; les routes V1
  historiques demeurent un troisième flux tant qu'elles ne sont pas fermées atomiquement.
- **Durées** : aucun objet audio Bob pour la dictée classique ; pour Bob Live, objet de réponse dans le fil 15 min, URL signée ≤ 30 s,
  métadonnées 30 jours, durée objet à certifier ; durées exactes des logs à arrêter.

La base légale et la mise en balance de l'intérêt légitime doivent être validées séparément pour
chaque finalité. L'ouverture du microphone ne vaut pas consentement à un transfert international.

## 3. Risques et mesures

| Risque | Gravité | Mesures actuelles | Dette / gate |
|---|---|---|---|
| Repli ASR réseau invisible | Élevée | Gate OS + locale, flag on-device, patch natif fail-closed, sortie texte | Preuve appareils iOS/Android requise |
| Callback natif tardif / micro orphelin | Élevée | Lease process-wide, générations JS/natives, barrière abort attendue, tests de courses | Build natif et tests appareils requis |
| Transfert Bob Live hors UE non encadré | Élevée | Bob Live public `OFF` | **[BLOQUÉ FONDATEUR : DPA OpenAI, CCT, mesures complémentaires, information préalable]** |
| Conservation excessive de la réponse audio | Élevée | Stockage privé, objet/feed 15 min, URL signée ≤ 30 s, métadonnées 30 jours | Purge objet production à livrer et certifier avant activation |
| Voix/TTS Android réseau | Élevée | Sélection uniquement si `networkConnectionRequired=false` | Build Android exact + appareil sans voix locale |
| Fuite de PII vers le LLM textuel | Élevée | `redactPII`, texte seul, confirmations métier | Audit fournisseur/configuration production |
| Hallucination d'un montant | Élevée | Montants issus du domaine ; garde de rendu ; évals | Certification CI de la version publiée |
| Injection / action sensible sans accord | Élevée | Confirmation obligatoire et plancher de sécurité | Évals adversariales exact SHA |
| Indisponibilité vocale excluant certains appareils | Moyenne | Handoff texte, annonce lecteur d'écran, CTA clavier | Tests VoiceOver/TalkBack et appareils physiques |
| Réactivation par rollback d'une préférence cloud | Moyenne | Migration `cloud` → `native`, runtime mobile cloud supprimé | Politique OTA empêchant le retour à un binaire incompatible |
| Ancien binaire appelant STT/TTS V1 | Élevée | Client courant local-only ; aucune bascule silencieuse depuis ce client | Inventorier le parc, certifier information/choix + DPA/région/rétention Mistral, ou fermer par décision atomique |
| Prestataires IA/OCR mal déclarés | Élevée | Registre aligné sur Mistral principal et Anthropic critique/secours | DPA, régions et rétentions bloquent la publication commerciale |
| Contexte personnel résiduel dans un crash | Élevée | Scrubbing par liste blanche, `sendDefaultPii=false`, corps/utilisateur exclus, traces coupées | Tests scrubbing exact-SHA + DPA/rétention Sentry |
| Télémétrie performance sans information/opt-out | Moyenne | Données techniques, identifiant aléatoire d'installation, aucun événement métier personnalisé | DPA/région/durée maximale EAS + mise en balance/opposition à décider |
| Clôture présentée comme effacement | Élevée | Copy mobile et politique distinguent désormais fermeture d'accès et données conservées | Classifier les catégories, fixer les durées, livrer purge/anonymisation + reprise Auth durable, puis certifier |

## 4. Information, droits et traçabilité

- La politique réellement servie par `apps/sign-web` doit rester identique à la source légale et
  annoncer le fournisseur effectivement activé avant ouverture du microphone.
- L'utilisateur peut ne pas utiliser Bob Live et conserver dictée locale, texte ou parcours manuel
  selon les capacités de son appareil.
- Accès, rectification, effacement, limitation, portabilité et opposition suivent le processus décrit
  dans la politique, sous réserve des obligations légales de conservation comptable.
- Les diagnostics vocaux ne journalisent que des codes normalisés et un entier natif éventuel, jamais
  le message libre du moteur ni la transcription.
- Les décisions/actions du moteur agent restent traçables dans le journal métier prévu par le projet.

## 5. Décision et conditions d'ouverture

Le chemin de dictée classique peut atteindre le statut `implemented` après tests et builds locaux ; il
n'est `certified` qu'après preuve sur appareils et CI exacte. Bob Live ne peut pas être publié tant que
les risques résiduels élevés ci-dessus ne sont pas ramenés à un niveau accepté et documenté.

Gates binaires avant activation publique de Bob Live :

1. **[BLOQUÉ FONDATEUR : identité légale, contact droits/DPO, prestataires et régions définitifs]** ;
2. **[BLOQUÉ FONDATEUR : DPA OpenAI, CCT et mesures complémentaires de transfert]** ;
3. purge des objets `bob-live-audio` déployée et vérifiée en production ;
4. information utilisateur/version de politique et mécanisme d'opposition certifiés ;
5. build iOS/Android exact SHA, tests appareils, VoiceOver/TalkBack et rollback validés ;
6. révision de cette DPIA et consultation de la CNIL si un risque résiduel élevé subsiste.

Gates transverses avant publication commerciale : DPA et rétention Sentry ; DPA, région et durée
maximale EAS Observe ; mise en balance documentée et décision sur le mécanisme d'opposition ou la
fermeture ; lifecycle exécutable de purge/anonymisation après clôture et reprise durable de la
suppression Auth. La documentation officielle Expo indique une conservation des métriques d'au moins
60 jours, ce qui ne suffit pas à établir une durée maximale.

Références officielles : [méthode AIPD de la CNIL](https://www.cnil.fr/fr/ce-quil-faut-savoir-sur-lanalyse-dimpact-relative-la-protection-des-donnees-aipd),
[article 35 du RGPD](https://www.cnil.fr/fr/reglement-europeen-protection-donnees/chapitre4) et
[consultation préalable en cas de risque résiduel élevé](https://www.cnil.fr/fr/services-en-ligne/soumettre-une-analyse-dimpact-relative-la-protection-des-donnees-aipd-la-cnil).
Références prestataires : [régions Sentry](https://docs.sentry.io/api/) et
[traitement/rétention EAS Observe](https://docs.expo.dev/eas/observe/reference/metrics/).
