# RÉUNION CLAUDE+GPT — ARCHITECTURE DE COMPRÉHENSION VOCALE (ordre fondateur 16/07)

DÉCLENCHEUR (tests device fondateur) : « ajoute deux heures de main-d'œuvre » dans le
wizard devis → ①classifié unknown par mistral-small (hors-scope poli) ; ②même reconnu,
AUCUNE extraction de slots (la pop-up redemande tout au lieu de pré-remplir qty=2/unit=h/
label=main-d'œuvre et de ne demander QUE le prix). Exigence fondateur : « beaucoup plus
costaud et intelligent » — challenger l'archi entière, pas patcher.

## ARCHITECTURE ACTUELLE (constats logs + code)
Pipeline : STT (Voxtral) → texte → classifieur d'intents (mistral-small-latest, étiquette
parmi une liste dont « contexte_ecran ») → si contexte_ecran : matchers regex/mots-clés
des affordances de l'écran → handler. Parallèlement : le flow devis LOCAL (flows/devis.ts)
a un parseur de lignes dédié testé (qty/unit/label/prix) — mais le chemin serveur ne
l'exploite pas pour l'extraction.

## FAIBLESSES STRUCTURELLES (position Claude)
1. CLASSIFICATION PAR ÉTIQUETTE avec un petit modèle = fragile par construction : le
   modèle doit deviner une catégorie abstraite sans voir les capacités réelles de l'écran.
2. EXTRACTION SÉPARÉE du routage : même quand le routage gagne, les slots sont perdus →
   dialogues répétitifs (anti-papa-vocal).
3. DOUBLE SYSTÈME : parseur local riche (flows/devis) vs matchers d'affordances pauvres —
   la qualité dépend du chemin emprunté, imprévisible pour l'utilisateur.

## PROPOSITION CLAUDE À CHALLENGER : passer au TOOL CALLING NATIF
Remplacer classifieur-par-étiquette + matchers par LE pattern standard des stacks agents :
exposer au modèle les OUTILS = affordances de l'écran actif (schémas JSON typés : addLine
{label, qty, unit, unitPriceHT?}, setDeposit {pct}, …) + les intents globaux — le modèle
choisit l'outil ET extrait les arguments EN UN APPEL (function calling Mistral, supporté
par mistral-small). Avantages : ①le routage voit les vraies capacités (fini unknown sur
une capacité existante) ; ②l'extraction est gratuite et typée ; ③slot-filling générique :
argument manquant → LE dialogue demande uniquement ce champ ; ④escalade de modèle simple
si besoin (mistral-small → medium/large = un paramètre) SANS changer l'architecture ;
⑤provider-neutre (tool calling standard OpenAI/Mistral/Anthropic).
Garde-fous inchangés : autonomy confirm_all, proposition→validation tap, argument
d'outil ≠ exécution (le plancher financier ne bouge pas d'un millimètre).
Transition : garder le parseur local flows/devis comme FAST-PATH offline/latence zéro
(il est bon), le tool calling serveur comme chemin général — mêmes schémas partagés.

## QUESTIONS POUR GPT (challenge attendu)
1. Tool calling mistral-small : fiabilité réelle vs classification (ton expérience gateway
   v2 — tu as des évals transcript-level) ? Seuil d'escalade de modèle ? Coût/latence par
   tour (budget métrologie : ai.ask actuel ~400-600 ms) ?
2. Le contrat d'affordances typées (schémas JSON par écran) : où vit la source de vérité
   (core ? packages/ai ?) pour rester parité manuel↔vocal et provider-neutre ?
3. Slot-filling multi-tours : état de dialogue côté serveur ou client ? Interaction avec
   ta gateway realtime v2 (les tours) ?
4. Migration : big-bang ou écran par écran (wizard devis d'abord — le cas fondateur) ?
5. Ce qu'on a OUBLIÉ selon toi (la question du fondateur) : évals systématiques d'un
   corpus de phrases artisan réelles ? bias STT (contexte métier au Voxtral via
   MISTRAL_STT_CONTEXT_BIAS déjà en env !) ? autre étape manquante ?
RÉPONSE ATTENDUE : verdict + amendements → on fige et j'implémente (le fix tactique du
bug immédiat part indépendamment — agent en cours).

## EXIGENCE FONDATEUR ÉLARGIE (16/07 soir) : LA FLUIDITÉ « CLAUDE CODE »
Le fondateur veut la fluidité des agents type Claude Code/Codex : capter l'intention,
ENCHAÎNER les étapes une à une sans s'arrêter, valider aux bons moments, aller chercher
l'information manquante de lui-même. Explication versée au dossier (architecture réelle
de ces agents) :
1. AUCUN classifieur d'intents — le modèle reçoit TOUT (system prompt riche, historique,
   état, OUTILS typés) et répond par texte OU par appels d'outils.
2. LA BOUCLE AGENTIQUE : chaque résultat d'outil revient au modèle qui décide de la
   suite — l'enchaînement multi-étapes ÉMERGE du raisonnement, il n'est pas programmé
   dans une machine d'états externe.
3. VALIDATIONS : double couche — instructions (« destructif → confirmer ») + HARNESS
   externe qui bloque indépendamment (notre équivalent EXISTE : autonomy confirm_all +
   propositions opaques → c'est notre force, on la garde telle quelle).
4. CHERCHER L'INFO : le modèle décide seul de lire/explorer quand il lui manque du
   contexte — parce que la boucle le permet.
5. POURQUOI C'EST FLUIDE : UN SEUL cerveau voit tout à chaque tour. Notre pipeline
   fragmenté (classifieur → matcher → handler) perd de l'information à chaque étage —
   c'est le défaut structurel, pas le modèle.
CONSÉQUENCE SUR LA PROPOSITION : le tool calling (§précédent) devient l'ÉTAPE 1 d'une
cible « boucle agentique vocale » : modèle avec outils typés + system prompt métier +
état de dossier, qui BOUCLE sur les résultats (multi-étapes sans re-prompt utilisateur),
sous le plancher confirm_all inchangé. CONTRAINTE VOCALE spécifique (vs Claude Code qui
peut réfléchir 30 s) : latence conversationnelle < 2 s → architecture HYBRIDE : fast-path
local (parseur devis, commandes fréquentes) + boucle agentique pour le multi-étapes,
+ feedback vocal de progression (« je crée le devis… j'ajoute les lignes… »).
QUESTION 6 POUR GPT : dimensionnement modèle de la boucle (mistral-small tool-calling
suffit-il en boucle ? large aux tours complexes ? routage par complexité ?) et budget
latence/coût par tour multi-étapes vs la métrologie existante.
