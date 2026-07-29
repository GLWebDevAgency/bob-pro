import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEEP_LINKS_OBLIGATOIRES,
  analyseRedirection,
  analyseSiteUrl,
  ciblesAttendues,
  normaliseCible,
  pointeVersLocalhost,
  profilsSondables,
  sonde,
} from './verifie-redirections-auth.mjs';

/** La redirection exacte observée par le fondateur le 29/07/2026 sur le projet de staging. */
const REDIRECTION_DU_BUG =
  'http://localhost:3000/#error=access_denied&error_code=otp_expired' +
  '&error_description=Email+link+is+invalid+or+has+expired&sb=';

const RELAIS = 'https://bob-pro-sign-web.vercel.app/auth/confirme';

test('la redirection du bug fondateur est refusée, et le motif nomme la cause', () => {
  const verdict = analyseRedirection({
    profil: 'preview',
    role: "page relais de confirmation d'inscription",
    cibleDemandee: RELAIS,
    redirectionObtenue: REDIRECTION_DU_BUG,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.refus, 'RETOUR_LOCALHOST');
  assert.match(verdict.message, /adresse locale/);
  assert.match(verdict.message, /Redirect URLs/);
});

test('GoTrue normalise bobpro:///chemin en bobpro://chemin : ce n\'est PAS un refus', () => {
  const verdict = analyseRedirection({
    profil: 'production',
    role: 'réinitialisation du mot de passe',
    cibleDemandee: 'bobpro:///auth/recovery',
    // Réponse réelle du projet de production : le triple slash revient en double.
    redirectionObtenue: 'bobpro://auth/recovery#error=access_denied&error_code=otp_expired',
  });

  assert.deepEqual(verdict, { ok: true });
});

test('une cible refusée qui retombe sur une Site URL saine est quand même un refus', () => {
  const verdict = analyseRedirection({
    profil: 'preview',
    role: 'réinitialisation du mot de passe',
    cibleDemandee: 'bobpro:///auth/recovery',
    redirectionObtenue: `${RELAIS}#error=access_denied`,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.refus, 'CIBLE_NON_AUTORISEE');
});

test('la Site URL doit être exactement le relais versionné, pas seulement distante', () => {
  assert.deepEqual(
    analyseSiteUrl({
      profil: 'preview',
      cibleAttendue: RELAIS,
      redirectionObtenue: `${RELAIS}#error=access_denied`,
    }),
    { ok: true },
  );

  const ancienne = analyseSiteUrl({
    profil: 'preview',
    cibleAttendue: RELAIS,
    redirectionObtenue: 'https://ancien-bob.example/auth',
  });
  assert.equal(ancienne.ok, false);
  assert.equal(ancienne.refus, 'SITE_URL_INATTENDUE');
  assert.match(ancienne.message, /attendu exactement/);

  const mauvaisChemin = analyseSiteUrl({
    profil: 'preview',
    cibleAttendue: RELAIS,
    redirectionObtenue: 'https://bob-pro-sign-web.vercel.app/mauvaise-route',
  });
  assert.equal(mauvaisChemin.refus, 'SITE_URL_INATTENDUE');
});

test('une Site URL attendue absente ou locale échoue fermé avec un motif exact', () => {
  assert.equal(
    analyseSiteUrl({
      profil: 'preview',
      cibleAttendue: '',
      redirectionObtenue: RELAIS,
    }).refus,
    'SITE_URL_ATTENDUE_ABSENTE',
  );
  assert.equal(
    analyseSiteUrl({
      profil: 'preview',
      cibleAttendue: RELAIS,
      redirectionObtenue: 'http://localhost:3000',
    }).refus,
    'SITE_URL_LOCALHOST',
  );
});

test('une absence de redirection est nommée, jamais confondue avec un succès', () => {
  for (const vide of ['', '   ', undefined, null]) {
    const verdict = analyseRedirection({
      profil: 'preview',
      role: 'sonde',
      cibleDemandee: RELAIS,
      redirectionObtenue: vide,
    });
    assert.equal(verdict.refus, 'REDIRECTION_ABSENTE');
  }
});

test('la cible honorée est acceptée, fragment d\'erreur compris', () => {
  const verdict = analyseRedirection({
    profil: 'production',
    role: "page relais de confirmation d'inscription",
    cibleDemandee: RELAIS,
    redirectionObtenue: `${RELAIS}#error=access_denied&error_code=otp_expired&sb=`,
  });

  assert.deepEqual(verdict, { ok: true });
});

test('toutes les formes d\'adresse locale sont reconnues', () => {
  for (const local of [
    'http://localhost:3000/#error=x',
    'http://127.0.0.1:8081/auth',
    'https://0.0.0.0/',
    'http://[::1]:3000/',
  ]) {
    assert.equal(pointeVersLocalhost(local), true, local);
  }
  for (const distant of [RELAIS, 'bobpro://auth/callback', 'https://localhost.bobpro.fr/auth']) {
    assert.equal(pointeVersLocalhost(distant), false, distant);
  }
});

test('normaliseCible retire query et fragment sans toucher au chemin', () => {
  assert.equal(normaliseCible(`${RELAIS}?a=1#b=2`), RELAIS);
  assert.equal(normaliseCible('bobpro:///auth/callback'), 'bobpro://auth/callback');
  assert.equal(normaliseCible(`${RELAIS}/`), RELAIS);
});

test('la sonde ne suit pas la redirection et transmet un signal borné', async () => {
  let options;
  const resultat = await sonde(
    'https://staging.supabase.co',
    'signup',
    RELAIS,
    {
      fetchImpl: async (_url, receivedOptions) => {
        options = receivedOptions;
        return { headers: new Headers({ location: `${RELAIS}#error=access_denied` }) };
      },
      timeoutMs: 25,
    },
  );

  assert.deepEqual(resultat, {
    ok: true,
    redirection: `${RELAIS}#error=access_denied`,
  });
  assert.equal(options.redirect, 'manual');
  assert.equal(options.signal instanceof AbortSignal, true);
});

test('timeout et panne réseau rendent deux refus finis et nommés', async () => {
  const timeout = await sonde(
    'https://staging.supabase.co',
    'signup',
    RELAIS,
    {
      fetchImpl: async () => {
        throw Object.assign(new Error('ne doit pas fuiter'), { name: 'TimeoutError' });
      },
    },
  );
  assert.deepEqual(timeout, { ok: false, refus: 'SONDE_TIMEOUT' });

  const indisponible = await sonde(
    'https://staging.supabase.co',
    'signup',
    RELAIS,
    {
      fetchImpl: async () => {
        throw new Error('secret réseau non affiché');
      },
    },
  );
  assert.deepEqual(indisponible, { ok: false, refus: 'SONDE_INJOIGNABLE' });
});

test('le timeout interrompt réellement une requête suspendue via le signal transmis', async () => {
  const debut = Date.now();
  const timeout = await sonde(
    'https://staging.supabase.co',
    'signup',
    RELAIS,
    {
      fetchImpl: async (_url, { signal }) =>
        await new Promise((_resolve, reject) => {
          // `AbortSignal.timeout()` utilise un timer non référencé dans Node 24 : sans une garde
          // référencée, un faux test vert local peut être annulé par le runner CI avant l'abort.
          // Cette garde maintient le test vivant et échoue explicitement si le signal ne part pas.
          const garde = setTimeout(
            () => reject(new Error('le signal de timeout ne s’est pas déclenché')),
            1_000,
          );
          if (signal.aborted) {
            clearTimeout(garde);
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(garde);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      timeoutMs: 20,
    },
  );

  assert.deepEqual(timeout, { ok: false, refus: 'SONDE_TIMEOUT' });
  assert.ok(Date.now() - debut < 1_000, 'la requête suspendue doit être interrompue, pas attendre');
});

test('une URL Supabase invalide échoue comme projet injoignable, sans stack brute', async () => {
  const resultat = await sonde('pas une URL', 'signup', RELAIS);
  assert.deepEqual(resultat, { ok: false, refus: 'SONDE_INJOIGNABLE' });
});

test('les deux deep links de retour sont exigés même sans page relais configurée', () => {
  const cibles = ciblesAttendues({}).map((c) => c.cible);
  assert.deepEqual(cibles, DEEP_LINKS_OBLIGATOIRES.map((c) => c.cible));

  const avecRelais = ciblesAttendues({ EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL: RELAIS });
  assert.equal(avecRelais.length, 3);
  assert.equal(avecRelais[0].cible, RELAIS);
});

test('seuls les profils déclarant un projet Supabase sont sondés', () => {
  const eas = {
    build: {
      development: {},
      preview: { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://staging.supabase.co' } },
      production: { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://prod.supabase.co' } },
    },
  };

  assert.deepEqual(
    profilsSondables(eas).map((p) => p.profil),
    ['preview', 'production'],
  );
  assert.deepEqual(
    profilsSondables(eas, ['production']).map((p) => p.profil),
    ['production'],
  );
});

test('les profils réels d\'eas.json restent sondables (garde anti-dérive)', async () => {
  const { readFile } = await import('node:fs/promises');
  const eas = JSON.parse(
    await readFile(new URL('../eas.json', import.meta.url), 'utf8'),
  );
  const profils = profilsSondables(eas).map((p) => p.profil);

  assert.ok(profils.includes('preview'), 'le profil preview doit rester sondable');
  assert.ok(profils.includes('production'), 'le profil production doit rester sondable');
});
