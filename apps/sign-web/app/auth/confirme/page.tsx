'use client';

/**
 * Page relais de confirmation de compte (bug « email de confirmation → localhost », 2026-07).
 *
 * Cible http(s) du `emailRedirectTo` d'inscription mobile : GoTrue vérifie l'email PUIS
 * redirige ici avec, selon le flux, `?code=` (PKCE), `#access_token…` (implicite) ou des
 * paramètres d'erreur (`error_code=otp_expired`…). La page :
 *   1. relaie TOUS les paramètres vers le deep link de l'app (`bobpro:///auth/callback`,
 *      ou `bobpro:///auth/recovery` si un fallback Site URL portait `type=recovery`) ;
 *   2. tente d'ouvrir l'app automatiquement, avec bouton + repli texte si rien ne s'ouvre
 *      (email lu sur un ordinateur : le compte est confirmé, la connexion se fait sur mobile) ;
 *   3. nettoie immédiatement l'URL du navigateur (le code/les jetons ne restent ni dans
 *      l'historique ni dans la barre d'adresse).
 * Doit être allowlistée dans Supabase Auth → Redirect URLs (voir
 * docs/deploiement/urls-et-redirections.md).
 */

import { useEffect, useState } from 'react';

type Outcome =
  | { kind: 'confirmed'; deepLink: string }
  | { kind: 'recovery'; deepLink: string }
  | { kind: 'expired'; deepLink: string }
  | { kind: 'invalid'; deepLink: string };

function analyzeLocation(search: string, hash: string): Outcome {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const read = (name: string): string | null => params.get(name) ?? fragment.get(name);

  // Relais fidèle : query et fragment repartent tels quels vers l'app — la page ne consomme
  // jamais la preuve elle-même (le code PKCE n'est échangeable que par l'app qui a signé up),
  // et les paramètres d'erreur voyagent aussi pour que l'app affiche la MÊME issue.
  const forwardedQuery = params.toString();
  const forwardedHash = fragment.toString();
  const suffix = `${forwardedQuery ? `?${forwardedQuery}` : ''}${forwardedHash ? `#${forwardedHash}` : ''}`;
  // `type=recovery` ne peut arriver ici que par le repli Site URL d'un email de reset : on
  // renvoie alors vers la route native de récupération, pas vers la confirmation.
  const deepLink =
    read('type') === 'recovery'
      ? `bobpro:///auth/recovery${suffix}`
      : `bobpro:///auth/callback${suffix}`;

  const errorCode = `${read('error_code') ?? ''} ${read('error') ?? ''}`.trim().toLowerCase();
  if (errorCode.length > 0) {
    return /expired|otp_expired|access_denied/.test(errorCode)
      ? { kind: 'expired', deepLink }
      : { kind: 'invalid', deepLink };
  }
  if (read('type') === 'recovery') return { kind: 'recovery', deepLink };
  return { kind: 'confirmed', deepLink };
}

const card: React.CSSProperties = {
  maxWidth: 560,
  margin: '32px auto',
  padding: 24,
  background: '#fff',
  borderRadius: 16,
  boxShadow: '0 6px 24px rgba(12,35,64,0.08)',
};
const btn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '14px 16px',
  borderRadius: 12,
  border: 'none',
  background: '#0C2340',
  color: '#fff',
  fontSize: 16,
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'center',
  textDecoration: 'none',
  boxSizing: 'border-box',
};

export default function AuthConfirmPage() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    const analyzed = analyzeLocation(window.location.search, window.location.hash);
    // La preuve ne doit survivre ni dans la barre d'adresse ni dans l'historique du navigateur.
    window.history.replaceState(null, '', window.location.pathname);
    setOutcome(analyzed);
    if (analyzed.kind === 'confirmed' || analyzed.kind === 'recovery') {
      // Ouverture automatique de l'app ; sans app installée (ordinateur), rien ne se passe et
      // la page reste lisible avec le bouton + le repli texte.
      window.location.href = analyzed.deepLink;
    }
  }, []);

  if (!outcome) {
    return (
      <main style={card}>
        <p style={{ color: '#5B6B7B' }}>Vérification en cours…</p>
      </main>
    );
  }

  if (outcome.kind === 'expired' || outcome.kind === 'invalid') {
    return (
      <main style={card}>
        <h1 style={{ fontSize: 22 }}>
          {outcome.kind === 'expired' ? 'Ce lien a expiré' : 'Ce lien ne fonctionne pas'}
        </h1>
        <p style={{ color: '#5B6B7B', lineHeight: 1.5 }}>
          {outcome.kind === 'expired'
            ? 'Pas de panique : ouvrez l’app Bob Pro, connectez-vous avec votre email et votre mot de passe — un nouvel email de confirmation vous sera proposé.'
            : 'Ce lien est invalide ou a déjà été utilisé. Ouvrez l’app Bob Pro et connectez-vous ; si besoin, un nouvel email de confirmation vous sera proposé.'}
        </p>
        <a style={btn} href={outcome.deepLink}>
          Ouvrir Bob Pro
        </a>
      </main>
    );
  }

  const recovery = outcome.kind === 'recovery';
  return (
    <main style={card}>
      <h1 style={{ fontSize: 22 }}>
        {recovery ? 'Réinitialisation du mot de passe' : 'Compte confirmé ✓'}
      </h1>
      <p style={{ color: '#5B6B7B', lineHeight: 1.5 }}>
        {recovery
          ? 'Retournez dans l’app Bob Pro pour choisir votre nouveau mot de passe.'
          : 'Votre email est vérifié. Retournez dans l’app Bob Pro pour vous connecter.'}
      </p>
      <a style={btn} href={outcome.deepLink}>
        Ouvrir Bob Pro
      </a>
      <p style={{ color: '#8A97A5', fontSize: 13, lineHeight: 1.5, marginTop: 16 }}>
        Rien ne s’ouvre ? Vous lisez sans doute cet email sur un ordinateur : prenez votre
        téléphone, ouvrez l’app Bob Pro et connectez-vous — votre compte est prêt.
      </p>
    </main>
  );
}
