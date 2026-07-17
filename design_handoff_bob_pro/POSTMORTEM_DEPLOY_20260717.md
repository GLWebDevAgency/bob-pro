# POSTMORTEM — panne serveur de test, 17/07/2026 (~3 h, 9 déploiements)

## Cascade (7 causes emboîtées, chacune masquant la suivante)
1. Le serveur tournait FIGÉ au 15/07 : AUCUN auto-deploy n'existe (croyance erronée —
   les 403 du garde d'auth ressemblaient à des routes existantes).
2. Les migrations jouées (nécessaires pour l'APK) ont fait CRASHER l'ancien code au
   redémarrage → down complet.
3-5. TROIS commits partiels de lanes croisées cassaient le build : bob-agent vs type
   source rétréci ; expense-payment-command importé jamais committé ; doubles mémoire
   realtime dans l'artefact (garde anti-fixture). Chaque « fix » committait la moitié
   d'une lane en mouvement.
6. Boot : 4 vars realtime requises absentes ; puis la config Stripe EXIGÉE en mode live
   alors que la V1 est early-access sans paiement (+ new URL(undefined) hors condition) ;
   puis l'URL cabinet refusée par la doctrine anti-démo.
7. FINALE : le CMD du Dockerfile lançait dist/apps/api/src/main.js — la structure
   d'émission tsc était passée À PLAT (dist/main.js) avec clean-build-output : le
   conteneur crashait avant tout healthcheck, sur TOUS les déploiements.

## Leçons (opposables aux deux lanes)
1. LA VALIDATION REINE : `railway run --service X --environment prod node dist/main.js`
   — boot local avec l'env EXACT de prod. Elle a trouvé les causes 6 et validé la 7.
   Obligatoire avant tout déploiement désormais.
2. La CI doit builder L'ARTEFACT COMPLET (build + garde d'artefact + boot smoke) sur
   chaque push — elle aurait attrapé 3-5 et 7 avant tout déploiement.
3. JAMAIS de commit d'une lane croisée sans `pnpm --filter "@bob/api..." build` local.
4. Toute variable requise ajoutée à env.ts = poser la valeur sur Railway DANS LE MÊME
   geste (checklist de PR).
5. Le CMD Docker suit la structure d'émission : tout changement de tsconfig.build/
   scripts de build vérifie le chemin d'entrée.
6. TOPOLOGIE À ACTER : staging = branche de travail (déploiements + migrations
   automatiques), production = main via cabinet-release (V1 publiée) ; l'APK preview
   pointera staging.
