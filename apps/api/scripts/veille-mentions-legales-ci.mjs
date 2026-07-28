import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * RAPPORTEUR DE CI DE LA VEILLE DES MENTIONS LÉGALES — le canal de l'ÉTAGE 1.
 *
 * POURQUOI CE SCRIPT, ET POURQUOI CE CANAL-LÀ. Le régime d'alarme (@bob/core,
 * `veille-mentions-legales.ts`) a deux étages : le préavis doit être IMPOSSIBLE À RATER sans
 * empêcher qui que ce soit de travailler, l'échéance atteinte doit BLOQUER. Le second étage est
 * déjà porté par le test-sentinelle, qui vit dans `pnpm test` et casse la CI pour de bon. Le
 * premier n'avait aucun canal : le rendre bloquant aurait mis le dépôt au rouge pendant les
 * 90 jours du préavis, et une alarme permanente finit désactivée par le premier qui en a besoin.
 *
 * Ce que ce dépôt offre réellement comme canal fiable et non bloquant (audit de .github/workflows) :
 *  • le job `verify` de ci.yml tourne sur CHAQUE pull request et sur CHAQUE push de main — c'est le
 *    seul endroit que TOUT changement traverse, et c'est exactement l'audience visée ;
 *  • les ANNOTATIONS GitHub (`::warning::`) remontent en tête de l'onglet « Checks » d'une PR sans
 *    la faire échouer, et le RÉSUMÉ DE RUN (`$GITHUB_STEP_SUMMARY`) rend le geste et les sources
 *    lisibles sans dérouler 20 000 lignes de log. Aucun des deux ne coûte une minute de runner ;
 *  • aucun autre workflow n'a la même couverture : `api-artifact` ne tourne pas sur les PR internes,
 *    les workflows Railway/Vercel/EAS sont des déploiements, et bob-live-native est borné par paths.
 * Le troisième canal — le journal au démarrage de l'API (`apps/api/src/main.ts`) — reste en place
 * pour l'instance déployée qui tourne des mois sans qu'une PR repasse.
 *
 * CE SCRIPT NE DÉCIDE RIEN. Le régime (`information` / `avertissement` / `blocage`) est calculé par
 * le domaine, seul juge : deux canaux qui décideraient chacun de leur côté finiraient par ne pas
 * bloquer le même jour. Ici on ne fait que RENDRE — et sortir en 1 quand le domaine dit `blocage`.
 *
 * IL N'Y A AUCUN INTERRUPTEUR ICI, et c'est délibéré : pas de variable d'environnement, pas de
 * `--force`, pas de mot-clé de commit. Le seul moyen d'apaiser un préavis est de mettre à jour la
 * date `verifieLe` de l'échéance dans le registre — un geste daté, revuable en diff, qui ré-arme
 * l'alarme tout seul au bout de 30 jours.
 */

export const TITRE_ANNOTATION = 'Veille des mentions légales';

/** Commande d'annotation GitHub par régime. `information` reste visible : un apaisement muet serait un interrupteur. */
const COMMANDE_PAR_REGIME = {
  blocage: 'error',
  avertissement: 'warning',
  information: 'notice',
};

/**
 * Échappement des commandes de workflow GitHub : un message multiligne non échappé est tronqué à
 * la première ligne, et le geste à faire (la seule chose qui compte) disparaîtrait.
 */
export function echapperAnnotation(message) {
  return String(message)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

/** Régime le plus fort présent dans les alertes — c'est lui qui décide du rendu et du code de sortie. */
export function regimeDominant(alertes) {
  if (alertes.some((a) => a.regime === 'blocage')) return 'blocage';
  if (alertes.some((a) => a.regime === 'avertissement')) return 'avertissement';
  if (alertes.some((a) => a.regime === 'information')) return 'information';
  return 'silence';
}

function ligneResume(alerte) {
  const etat = alerte.regime === 'blocage'
    ? `**ÉCHUE — BLOQUANT** (depuis ${-alerte.joursRestants} jour(s))`
    : alerte.regime === 'avertissement'
      ? `**PRÉAVIS** — dans ${alerte.joursRestants} jour(s), non bloquant`
      : `APAISÉE jusqu’au ${alerte.reArmementLe} — échéance dans ${alerte.joursRestants} jour(s)`;
  return [
    `#### \`${alerte.echeance.id}\` — échéance ${alerte.echeance.echeance}`,
    '',
    `- État : ${etat}`,
    `- Objet : ${alerte.echeance.objet}`,
    `- **À faire** : ${alerte.echeance.aFaire}`,
    `- Vérifié le : ${alerte.echeance.verifieLe} (il y a ${alerte.joursDepuisVerification} jour(s))`,
    `- Sources : ${alerte.echeance.sources.map((s) => `\`${s}\``).join(' · ')}`,
    '',
  ].join('\n');
}

/**
 * Rapport complet : ce qui s'écrit dans le log, ce qui devient annotation, ce qui devient résumé de
 * run, et le code de sortie. Fonction PURE — c'est elle qui est testée, pas les effets de bord.
 */
export function rapport(alertes, message, aujourdHui) {
  const regime = regimeDominant(alertes);
  if (regime === 'silence') {
    return {
      regime,
      code: 0,
      annotation: null,
      resume: null,
      journal: `Veille des mentions légales au ${aujourdHui} : aucune échéance en fenêtre de préavis.`,
    };
  }
  const commande = COMMANDE_PAR_REGIME[regime];
  const titre = regime === 'blocage'
    ? `${TITRE_ANNOTATION} — ÉCHÉANCE ATTEINTE (bloquant)`
    : regime === 'avertissement'
      ? `${TITRE_ANNOTATION} — préavis (non bloquant)`
      : `${TITRE_ANNOTATION} — apaisée (vérification datée)`;
  const resume = [
    `### ${titre}`,
    '',
    `Évaluée au ${aujourdHui} (jour métier Paris).`,
    '',
    ...alertes.map(ligneResume),
    '> Pour apaiser un préavis : mettre `verifieLe` de l’entrée concernée à la date du jour dans',
    '> `ECHEANCES_MENTIONS_LEGALES` (packages/core/src/domain/services/veille-mentions-legales.ts).',
    '> C’est le seul chemin — il est daté, il se relit en diff, et l’alarme se ré-arme seule 30 jours',
    '> plus tard. Ne fabriquez JAMAIS une rédaction de mention pour faire taire ce message : une',
    '> mention est figée à l’émission, une pièce fausse le reste pour toujours.',
    '',
  ].join('\n');
  return {
    regime,
    // Étage 2 et lui seul : le préavis n'a jamais le droit de faire échouer une PR.
    code: regime === 'blocage' ? 1 : 0,
    annotation: `::${commande} title=${titre}::${echapperAnnotation(message)}`,
    resume,
    journal: message,
  };
}

async function main() {
  // Import dynamique : les fonctions de rendu ci-dessus restent testables par `node --test` sans
  // exiger que `packages/core/dist` soit construit.
  const { messageVeilleMentions, parisDateOnly, veilleMentionsLegales } = await import('@bob/core');
  const aujourdHui = parisDateOnly();
  const alertes = veilleMentionsLegales(aujourdHui);
  const { annotation, code, journal, resume } = rapport(
    alertes,
    messageVeilleMentions(alertes),
    aujourdHui,
  );
  process.stdout.write(`${journal}\n`);
  if (annotation !== null) process.stdout.write(`${annotation}\n`);
  if (resume !== null && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${resume}\n`);
  }
  process.exitCode = code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
