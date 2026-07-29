import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEEP_LINKS_OBLIGATOIRES,
  analyseRedirection,
  ciblesAttendues,
  normaliseCible,
  pointeVersLocalhost,
  profilsSondables,
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
