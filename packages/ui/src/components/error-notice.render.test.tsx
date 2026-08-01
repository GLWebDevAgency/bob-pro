/**
 * ErrorNotice — RENDU des deux faces (SPEC_SYSTEME_ERREUR §6). La logique pure est couverte par
 * error-notice.test.ts ; ici on prouve le COMPORTEMENT rendu : face utilisateur seule au départ,
 * révélation de la face développeur à l'appui long, et bouton Partager composant un texte SANS
 * PII. `react-native` est intégralement mocké (View/Text/Pressable → simples balises string) —
 * aucun pont natif requis sous vitest, seul l'arbre rendu importe.
 *
 * Règle du témoin : avant chaque assertion, on prouve que le composant a bien rendu quelque chose
 * d'exploitable (arbre non vide + jalon attendu présent) — sinon une assertion `not.toContain`
 * passerait à vide sur un composant qui ne rend rien.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../theme';
import { ErrorNotice, type ErrorNoticeProps } from './error-notice';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));

// Un SIRET dans le MESSAGE : légitime face utilisateur (l'artisan voit sa propre saisie), il ne
// doit JAMAIS ressortir dans le texte de partage (canal technique — P5 / §6 « sans PII »).
const SIRET = '73282932000074';
const CORRELATION = '98f73810-1111-4222-8333-444455556666';
const MESSAGE = `SIRET ${SIRET} introuvable à l’annuaire.`;

function renderNotice(overrides: Partial<ErrorNoticeProps> = {}): {
  renderer: ReactTestRenderer;
  onShareReport: ReturnType<typeof vi.fn>;
} {
  const onShareReport = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ThemeProvider>
        <ErrorNotice
          message={MESSAGE}
          code="BOB-SIRET-404"
          correlationId={CORRELATION}
          kind="not_found"
          at="2026-07-31T14:03:00.000Z"
          onShareReport={onShareReport}
          {...overrides}
        />
      </ThemeProvider>,
    );
  });
  return { renderer, onShareReport };
}

const tree = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

function buttons(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityRole === 'button',
  );
}

describe('ErrorNotice — rendu des deux faces', () => {
  it('(a) affiche la SEULE face utilisateur au départ : message + code, aucun détail développeur', () => {
    const { renderer } = renderNotice();
    const rendered = tree(renderer);

    // Témoin : le composant a bel et bien rendu un arbre exploitable.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain(MESSAGE); // face utilisateur : le message actionnable
    expect(rendered).toContain('BOB-SIRET-404'); // code court discret en chip
    expect(rendered).toContain('▾'); // chevron FERMÉ : la face dev est repliée

    // Face développeur ABSENTE tant qu'on n'a pas déplié : ni corrélation complète, ni DetailRow.
    expect(rendered).not.toContain(CORRELATION);
    expect(rendered).not.toContain('Corrélation');
    // Un seul bouton (le repli) ; le bouton Partager n'existe pas encore.
    expect(buttons(renderer)).toHaveLength(1);
  });

  it('(b) l’appui long révèle la face développeur : corrélation complète, kind, DetailRow', () => {
    const { renderer } = renderNotice();

    // Témoin : avant l'interaction, la face dev n'est pas là (l'assertion discrimine vraiment).
    expect(tree(renderer)).not.toContain(CORRELATION);
    const toggle = renderer.root.findAll(
      (node) => (node.type as unknown) === 'Pressable' && typeof node.props.onLongPress === 'function',
    )[0];
    expect(toggle).toBeDefined(); // témoin : la cible d'appui long existe

    act(() => {
      toggle!.props.onLongPress();
    });
    const opened = tree(renderer);

    // Témoin : l'arbre a bien changé et rend toujours le message.
    expect(opened).toContain(MESSAGE);
    expect(opened).toContain('▴'); // chevron OUVERT
    expect(opened).toContain(CORRELATION); // corrélation COMPLÈTE (face dev)
    expect(opened).toContain('98f73810'); // forme courte préfixée aussi présente
    expect(opened).toContain('not_found'); // kind en DetailRow
    expect(opened).toContain('Corrélation'); // libellé de la DetailRow corrélation
  });

  it('(d) face SOMBRE (Lot 0) : matière danger sombre du kit ; le défaut reste la face claire', () => {
    // Défaut (light) : fond pastel historique #FBEAE8, jamais la matière sombre.
    const { renderer: light } = renderNotice();
    const lightTree = tree(light);
    expect(lightTree).toContain('#FBEAE8'); // semantic.dangerBg
    expect(lightTree).not.toContain('#351312');

    // appearance="dark" : surfaceTint.dark.danger — flat #351312, border #622825, ink #FADDD9.
    const { renderer: dark } = renderNotice({ appearance: 'dark' });
    const darkTree = tree(dark);
    expect(darkTree).toContain('#351312');
    expect(darkTree).toContain('#622825');
    expect(darkTree).toContain('#FADDD9');
    expect(darkTree).not.toContain('#FBEAE8');
  });

  it('(c) le bouton Partager compose un rapport SANS PII (code + corrélation + kind + heure)', () => {
    const { renderer, onShareReport } = renderNotice();

    act(() => {
      const toggle = renderer.root.findAll(
        (node) =>
          (node.type as unknown) === 'Pressable' && typeof node.props.onLongPress === 'function',
      )[0];
      toggle!.props.onLongPress();
    });

    // Témoin : la face dev dépliée fait apparaître un SECOND bouton (Partager).
    const all = buttons(renderer);
    expect(all).toHaveLength(2);
    const share = all.find((node) => typeof node.props.onLongPress !== 'function');
    expect(share).toBeDefined();

    act(() => {
      share!.props.onPress();
    });

    // Témoin : le partage a bien été déclenché avec un texte non vide.
    expect(onShareReport).toHaveBeenCalledTimes(1);
    const shared = onShareReport.mock.calls[0]?.[0] as string;
    expect(shared.length).toBeGreaterThan(0);

    // Composition fermée : les faits techniques, jamais le message ni la donnée saisie.
    expect(shared).toContain('BOB-SIRET-404');
    expect(shared).toContain(CORRELATION);
    expect(shared).toContain('not_found');
    // La PII du message (le SIRET saisi) ne franchit JAMAIS le canal de partage.
    expect(shared).not.toContain(SIRET);
    expect(shared).not.toContain('introuvable');
  });
});
