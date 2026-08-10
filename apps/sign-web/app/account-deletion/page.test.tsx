import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AccountDeletionPage, { metadata } from './page';
import { buildDeletionRequestMailto, DEFAULT_SUPPORT_EMAIL, resolveSupportEmail } from './content';

describe('/account-deletion', () => {
  it('rend une demande publique Bob Pro complète sans formulaire ni champ secret', () => {
    const html = renderToStaticMarkup(<AccountDeletionPage />);

    expect(html).toContain('Suppression de votre compte Bob Pro');
    expect(html).toContain('Zone sensible');
    expect(html).toContain('Demander la suppression par email');
    expect(html).toContain(`mailto:${DEFAULT_SUPPORT_EMAIL}`);
    expect(html).toContain('/legal/confidentialite');
    expect(html).toContain('href="/account-deletion"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Ce qui est supprimé ou conservé');
    expect(html).toContain('N’envoyez jamais votre mot de passe');
    expect(html).toContain('La demande par email n’est pas une suppression automatique');
    expect(html).toContain('préférences, historiques et brouillons');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('type="password"');
  });

  it('publie des métadonnées indexables dédiées à la suppression', () => {
    expect(metadata.title).toBe('Bob Pro — Suppression de compte');
    expect(metadata.robots).toEqual({ index: true, follow: true });
  });

  it('accepte une adresse de marque au build et refuse une valeur mal formée', () => {
    expect(resolveSupportEmail(' support@bobpro.fr ')).toBe('support@bobpro.fr');
    expect(resolveSupportEmail(undefined)).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(() => resolveSupportEmail(undefined, { requireConfigured: true })).toThrow(
      'NEXT_PUBLIC_SUPPORT_EMAIL est requis pour un build Vercel distribué.',
    );
    expect(() => resolveSupportEmail('pas-un-email')).toThrow(
      'NEXT_PUBLIC_SUPPORT_EMAIL doit être une adresse email valide.',
    );
  });

  it('préremplit une demande minimale et interdit les secrets dans le premier message', () => {
    const mailto = new URL(buildDeletionRequestMailto('support@bobpro.fr'));

    expect(mailto.protocol).toBe('mailto:');
    expect(mailto.pathname).toBe('support@bobpro.fr');
    expect(mailto.searchParams.get('subject')).toBe('Demande de suppression de compte Bob Pro');
    expect(mailto.searchParams.get('body')).toContain('Email utilisé pour le compte');
    expect(mailto.searchParams.get('body')).toContain('ni mot de passe, ni token');
    expect(mailto.searchParams.get('body')).not.toContain('SIRET');
  });
});
