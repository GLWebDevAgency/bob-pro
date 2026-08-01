/**
 * IconTile — RENDU du tone additif 'document' (Lot 0) : fond documentTile.bg (#F1F4F7,
 * neutre papier), et NON une teinte de typologie client ; les tones StatusBadge restent
 * inchangés au pixel (témoin : success → #EAF2EC).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../theme';
import { IconTile } from './icon-tile';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
}));

function renderTile(tone: Parameters<typeof IconTile>[0]['tone']): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ThemeProvider>
        <IconTile tone={tone} />
      </ThemeProvider>,
    );
  });
  return renderer;
}

describe('IconTile — tone document (Lot 0)', () => {
  it("tone 'document' → fond neutre papier #F1F4F7 (documentTile.bg), pas une typologie client", () => {
    const rendered = JSON.stringify(renderTile('document').toJSON());
    expect(rendered.length).toBeGreaterThan(0); // témoin
    expect(rendered).toContain('"backgroundColor":"#F1F4F7"');
  });

  it("non-régression : tone 'success' garde son pastel historique #EAF2EC", () => {
    const rendered = JSON.stringify(renderTile('success').toJSON());
    expect(rendered).toContain('"backgroundColor":"#EAF2EC"');
  });
});
