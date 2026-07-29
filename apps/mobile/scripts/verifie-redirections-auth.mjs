#!/usr/bin/env node
/**
 * Garde des redirections d'authentification — « l'e-mail de confirmation ramène sur localhost ».
 *
 * Ce bug est tombé DEUX fois. Le 18/07/2026 sur le projet de production : la Site URL était
 * restée au défaut `http://localhost:3000` et `signUp` n'envoyait aucun `emailRedirectTo`
 * (corrigé par `src/auth-confirmation/email-confirmation.ts` + configuration du dashboard).
 * Puis le 29/07/2026 sur le projet de staging, créé par db53eb67 (« appliquer la loi des
 * environnements aux builds preview ») sans que la configuration Auth du dashboard suive : même
 * symptôme exact, sur un projet neuf. La cause commune n'est pas le code — versionné, testé,
 * propagé — mais le fait que l'autre moitié de la solution vit dans un dashboard Supabase, hors
 * du dépôt, invisible à la revue comme aux tests.
 *
 * La sonde ferme ce trou. GoTrue ne redirige `/auth/v1/verify` vers le `redirect_to` demandé que
 * si celui-ci figure dans l'allowlist du projet ; sinon il retombe sur la Site URL. Un jeton
 * volontairement invalide suffit donc à LIRE la configuration réelle de chaque projet : sans
 * dashboard, sans jeton d'administration, et sans jamais rien écrire ni consommer.
 *
 * Usage : `node scripts/verifie-redirections-auth.mjs [profil…]` (défaut : tous ceux d'eas.json
 * qui déclarent une URL Supabase). Agrège les refus de tous les profils puis sort non nul.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Deep links de retour codés en dur dans l'application : ils doivent TOUJOURS être autorisés. */
export const DEEP_LINKS_OBLIGATOIRES = Object.freeze([
  { cible: 'bobpro://auth/callback', type: 'signup', role: "repli de confirmation d'inscription" },
  { cible: 'bobpro://auth/recovery', type: 'recovery', role: 'réinitialisation du mot de passe' },
]);

export const SONDE_TIMEOUT_MS = 8_000;

const HOTES_LOCAUX = Object.freeze(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * Ramène une URL de redirection à sa forme comparable : sans query ni fragment, et avec le
 * `scheme:///chemin` réduit à `scheme://chemin`. La forme double-slash est la cible canonique
 * générée par Expo et acceptée par le dashboard Supabase ; le repli garde la compatibilité avec
 * les anciens liens triple-slash déjà émis.
 */
export function normaliseCible(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  const sansFragment = url.split('#')[0].split('?')[0];
  return sansFragment.replace(/:\/\/\/+/, '://').replace(/\/+$/, '');
}

/**
 * Vrai si l'URL désigne une machine locale — donc inatteignable depuis le téléphone d'un client.
 * Le parsing passe par `URL` : découper la chaîne à la main écrase les adresses IPv6 littérales
 * (`http://[::1]:3000` se réduit à `[` si l'on coupe naïvement sur le deux-points).
 */
export function pointeVersLocalhost(url) {
  const normalisee = normaliseCible(url);
  if (normalisee === '') return false;
  try {
    return HOTES_LOCAUX.includes(new URL(normalisee).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Verdict pur sur une sonde : GoTrue a-t-il honoré la cible demandée ?
 * Rend `{ ok: true }` ou `{ ok: false, refus, message }` — le motif est NOMMÉ, jamais générique,
 * pour qu'un échec dise quoi corriger et où (convention `assert-named-refusals`).
 */
export function analyseRedirection({ profil, role, cibleDemandee, redirectionObtenue }) {
  const obtenue = normaliseCible(redirectionObtenue);
  if (obtenue === '') {
    return {
      ok: false,
      refus: 'REDIRECTION_ABSENTE',
      message:
        `[${profil}] ${role} : GoTrue n'a renvoyé aucune redirection pour ${cibleDemandee}. ` +
        `Projet injoignable ou réponse inattendue — vérifier EXPO_PUBLIC_SUPABASE_URL.`,
    };
  }
  if (pointeVersLocalhost(obtenue)) {
    return {
      ok: false,
      refus: 'RETOUR_LOCALHOST',
      message:
        `[${profil}] ${role} : le lien e-mail ramène sur ${obtenue} — une adresse locale, ` +
        `injoignable depuis le téléphone d'un client. La Site URL du projet est restée au défaut ` +
        `Supabase et « ${cibleDemandee} » n'est pas dans les Redirect URLs. ` +
        `Corriger dans Authentication → URL Configuration (voir docs/deploiement/urls-et-redirections.md §2).`,
    };
  }
  if (obtenue !== normaliseCible(cibleDemandee)) {
    return {
      ok: false,
      refus: 'CIBLE_NON_AUTORISEE',
      message:
        `[${profil}] ${role} : « ${cibleDemandee} » a été refusée par GoTrue, qui est retombé sur ` +
        `${obtenue} (la Site URL). Ajouter la cible aux Redirect URLs du projet.`,
    };
  }
  return { ok: true };
}

/**
 * La Site URL est le filet de sécurité de GoTrue : toute cible absente/refusée y retombe.
 * « Pas localhost » ne suffit donc pas. Elle doit être exactement la cible web versionnée dans
 * le profil EAS, faute de quoi un ancien domaine ou un mauvais environnement recevrait les
 * paramètres d'authentification tout en produisant un faux certificat vert.
 */
export function analyseSiteUrl({ profil, cibleAttendue, redirectionObtenue }) {
  const attendue = normaliseCible(cibleAttendue);
  const obtenue = normaliseCible(redirectionObtenue);
  if (attendue === '') {
    return {
      ok: false,
      refus: 'SITE_URL_ATTENDUE_ABSENTE',
      message:
        `[${profil}] EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL est absente : impossible de ` +
        'certifier la Site URL exacte de ce projet.',
    };
  }
  if (obtenue === '') {
    return {
      ok: false,
      refus: 'REDIRECTION_ABSENTE',
      message:
        `[${profil}] Site URL : GoTrue n'a renvoyé aucune redirection. Projet injoignable ou ` +
        'réponse inattendue — vérifier EXPO_PUBLIC_SUPABASE_URL.',
    };
  }
  if (pointeVersLocalhost(obtenue)) {
    return {
      ok: false,
      refus: 'SITE_URL_LOCALHOST',
      message:
        `[${profil}] Site URL = ${obtenue} — le filet de sécurité du projet renvoie sur une ` +
        'adresse locale. Toute redirection refusée y atterrit : l’inscription et la ' +
        'réinitialisation de mot de passe sont inutilisables pour un vrai client.',
    };
  }
  if (obtenue !== attendue) {
    return {
      ok: false,
      refus: 'SITE_URL_INATTENDUE',
      message:
        `[${profil}] Site URL = ${obtenue}, attendu exactement ${attendue}. Corriger ` +
        'Authentication → URL Configuration avant de distribuer ce build.',
    };
  }
  return { ok: true };
}

/** Les cibles qu'un profil doit voir acceptées, déduites de ses variables EAS + des deep links. */
export function ciblesAttendues(env = {}) {
  const cibles = [];
  const relais = env.EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL;
  if (typeof relais === 'string' && relais.trim() !== '') {
    cibles.push({ cible: relais, type: 'signup', role: "page relais de confirmation d'inscription" });
  }
  cibles.push(...DEEP_LINKS_OBLIGATOIRES);
  return cibles;
}

/** Profils d'eas.json qui déclarent un projet Supabase — les seuls qu'on puisse sonder. */
export function profilsSondables(easJson, filtre = []) {
  return Object.entries(easJson?.build ?? {})
    .map(([profil, config]) => ({ profil, env: config?.env ?? {} }))
    .filter(({ profil, env }) => {
      if (typeof env.EXPO_PUBLIC_SUPABASE_URL !== 'string' || env.EXPO_PUBLIC_SUPABASE_URL === '') {
        return false;
      }
      return filtre.length === 0 || filtre.includes(profil);
    });
}

/**
 * Sonde bornée : jeton volontairement invalide, redirection NON suivie, rien n'est consommé.
 * Toute panne réseau devient un refus fini et nommé ; le rituel ne peut pas rester suspendu.
 */
export async function sonde(
  supabaseUrl,
  type,
  redirectTo,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = SONDE_TIMEOUT_MS,
  } = {},
) {
  let signal;
  try {
    signal = AbortSignal.timeout(timeoutMs);
    const url = new URL('/auth/v1/verify', supabaseUrl);
    url.searchParams.set('token', 'sonde-de-configuration-invalide');
    url.searchParams.set('type', type);
    if (redirectTo !== undefined) url.searchParams.set('redirect_to', redirectTo);
    const reponse = await fetchImpl(url, { redirect: 'manual', signal });
    return { ok: true, redirection: reponse.headers.get('location') ?? '' };
  } catch (error) {
    const errorName =
      typeof error === 'object' && error !== null && 'name' in error
        ? error.name
        : null;
    const timeout =
      signal?.aborted === true || errorName === 'TimeoutError' || errorName === 'AbortError';
    return {
      ok: false,
      refus: timeout ? 'SONDE_TIMEOUT' : 'SONDE_INJOIGNABLE',
    };
  }
}

function refusDeSonde({ profil, role, resultat }) {
  const timeout = resultat.refus === 'SONDE_TIMEOUT';
  return {
    ok: false,
    refus: resultat.refus,
    message:
      `[${profil}] ${role} : ${timeout
        ? `la sonde a dépassé ${SONDE_TIMEOUT_MS / 1_000} secondes`
        : 'le projet Supabase est injoignable'} — aucune conformité n’est déclarée. ` +
      'Vérifier le réseau et EXPO_PUBLIC_SUPABASE_URL, puis relancer.',
  };
}

async function main() {
  const racineMobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const easJson = JSON.parse(await readFile(path.join(racineMobile, 'eas.json'), 'utf8'));
  const profils = profilsSondables(easJson, process.argv.slice(2));

  if (profils.length === 0) {
    console.error('Aucun profil sondable : eas.json ne déclare aucune EXPO_PUBLIC_SUPABASE_URL.');
    process.exitCode = 1;
    return;
  }

  const refus = [];
  for (const { profil, env } of profils) {
    const supabaseUrl = env.EXPO_PUBLIC_SUPABASE_URL;
    console.log(`\n▸ ${profil} — ${supabaseUrl}`);

    // Le filet de sécurité : toute cible refusée ou absente retombe ici. Jamais localhost.
    const siteUrlSonde = await sonde(supabaseUrl, 'signup', undefined);
    if (!siteUrlSonde.ok) {
      const verdict = refusDeSonde({
        profil,
        role: 'Site URL',
        resultat: siteUrlSonde,
      });
      refus.push(verdict);
      console.log(`  ✗ Site URL — ${verdict.refus}`);
      // Une indisponibilité projet rendrait les sondes suivantes redondantes et bruyantes.
      continue;
    }
    const siteUrlVerdict = analyseSiteUrl({
      profil,
      cibleAttendue: env.EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL,
      redirectionObtenue: siteUrlSonde.redirection,
    });
    console.log(
      `  ${siteUrlVerdict.ok ? '✓' : '✗'} Site URL — ${
        siteUrlVerdict.ok
          ? normaliseCible(siteUrlSonde.redirection)
          : siteUrlVerdict.refus
      }`,
    );
    if (!siteUrlVerdict.ok) refus.push(siteUrlVerdict);

    for (const { cible, type, role } of ciblesAttendues(env)) {
      const resultat = await sonde(supabaseUrl, type, cible);
      if (!resultat.ok) {
        const verdict = refusDeSonde({ profil, role, resultat });
        console.log(`  ✗ ${cible} — ${verdict.refus}`);
        refus.push(verdict);
        continue;
      }
      const verdict = analyseRedirection({
        profil,
        role,
        cibleDemandee: cible,
        redirectionObtenue: resultat.redirection,
      });
      console.log(`  ${verdict.ok ? '✓' : '✗'} ${cible}${verdict.ok ? '' : ` — ${verdict.refus}`}`);
      if (!verdict.ok) refus.push(verdict);
    }
  }

  if (refus.length > 0) {
    console.error(`\n${refus.length} redirection(s) d'authentification non conforme(s) :\n`);
    for (const { message } of refus) console.error(`  • ${message}\n`);
    process.exitCode = 1;
    return;
  }
  console.log('\nToutes les redirections d\'authentification sont conformes.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
