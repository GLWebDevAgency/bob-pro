/**
 * RÔLES DE COULEUR DÉDIÉS — rendu (Lot 5, arbitrage TONS RECYCLÉS) : StatusBadge et
 * IconTile acceptent un rôle {ink, bg} tokens (`journal.*`, `expenseCategory.*`) et le
 * peignent EXACTEMENT (ink → texte, bg → fond — un échange serait un mutant mort).
 * Témoins en littéraux : `journal.achats` = ambre B2C d'aujourd'hui (adoption iso-visuelle,
 * lot0-roles.test.ts) — mais le CODE ne prononce plus jamais « particulier ».
 * Le chemin variante/tone reste inchangé au pixel (non-régression success).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { journal } from '@bob/tokens';
import { ThemeProvider } from '../theme';
import { StatusBadge } from './status-badge';
import { statusBadgeRoleColors } from './status-badge.logic';
import { IconTile } from './icon-tile';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
}));

function renderNode(node: React.ReactElement): string {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return JSON.stringify(renderer.toJSON());
}

describe('statusBadgeRoleColors — pure', () => {
  it('ink → fg, bg → bg — jamais l’inverse', () => {
    expect(statusBadgeRoleColors({ ink: '#C77A12', bg: '#FBF0DF' })).toEqual({
      fg: '#C77A12',
      bg: '#FBF0DF',
    });
  });
});

describe('StatusBadge role — le badge cesse de mentir sur la typologie', () => {
  it('role journal.achats ⇒ texte #C77A12 sur fond #FBF0DF (littéraux du rôle, pas une variante)', () => {
    const rendered = renderNode(<StatusBadge label="Achats" role={journal.achats} />);
    expect(rendered).toContain('"color":"#C77A12"');
    expect(rendered).toContain('"backgroundColor":"#FBF0DF"');
  });

  it('non-régression : variant success garde son pastel historique', () => {
    const rendered = renderNode(<StatusBadge label="Payée" variant="success" />);
    expect(rendered).toContain('"color":"#0E7C5A"');
    expect(rendered).toContain('"backgroundColor":"#EAF2EC"');
  });
});

describe('IconTile role — la pastille peint le rôle', () => {
  it('role journal.banque ⇒ fond #EAF2EC (journal.banque.bg)', () => {
    const rendered = renderNode(<IconTile role={journal.banque} />);
    expect(rendered).toContain('"backgroundColor":"#EAF2EC"');
  });

  it('role journal.od ⇒ fond #EDEAFE — l’OD n’est plus un « b2g »', () => {
    const rendered = renderNode(<IconTile role={journal.od} />);
    expect(rendered).toContain('"backgroundColor":"#EDEAFE"');
  });
});
