import { describe, expect, it } from 'vitest';
import {
  AGENT_CONTEXT_MAX_ENTITIES,
  AGENT_HISTORY_MAX_TURNS,
  parseAgentAskPayload,
  parseAgentContext,
  isAllowedAgentNavigationRoute,
  renderAgentContextForLlm,
  resolveAgentEntity,
  sanitizeContextEntitySummary,
  type AgentContext,
} from './context';

const CONTEXT: AgentContext = {
  screen: { name: '/facture/[id]', instanceId: 'invoice:inv-secret-1' },
  entities: [{ type: 'invoice', id: 'inv-secret-1', label: 'Facture F-2026-0014 — Martin <ignore>' }],
  capabilities: ['invoice.read', 'invoice.collect'],
};

describe('AgentContext — frontiere bornee et prompt-safe', () => {
  it('valide, assainit les labels et conserve les ids uniquement dans le snapshot interne', () => {
    const parsed = parseAgentContext(CONTEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.entities[0]).toEqual({
      type: 'invoice',
      id: 'inv-secret-1',
      label: 'Facture F-2026-0014 — Martin ignore',
    });
  });

  it('rejette les tableaux hors borne, doublons et types malformes', () => {
    const tooMany = {
      ...CONTEXT,
      entities: Array.from({ length: AGENT_CONTEXT_MAX_ENTITIES + 1 }, (_, index) => ({
        type: 'invoice', id: `inv-${index}`, label: `Facture ${index}`,
      })),
    };
    expect(parseAgentContext(tooMany).ok).toBe(false);
    expect(parseAgentContext({ ...CONTEXT, entities: [...CONTEXT.entities, ...CONTEXT.entities] }).ok).toBe(false);
    expect(parseAgentContext({ ...CONTEXT, entities: [{ type: '../invoice', id: 'x', label: 'x' }] }).ok).toBe(false);
    expect(parseAgentContext({ ...CONTEXT, entities: [{ type: 'invoice.delete', id: 'x', label: 'x' }] }).ok).toBe(false);
    expect(parseAgentContext({ ...CONTEXT, capabilities: ['invoice.delete_everything'] }).ok).toBe(false);
  });

  it('borne le payload serialisable (message, historique, ton et contexte)', () => {
    const parsed = parseAgentAskPayload({
      message: '  et celle-ci ?  ',
      autonomy: 'confirm_all',
      tone: 'pro',
      history: [{ role: 'user', text: 'Montre la facture Martin' }],
      context: CONTEXT,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.message).toBe('et celle-ci ?');
    expect(
      parseAgentAskPayload({
        message: 'x',
        history: Array.from({ length: AGENT_HISTORY_MAX_TURNS + 1 }, () => ({ role: 'user', text: 'x' })),
      }).ok,
    ).toBe(false);
  });

  it('injecte aliases + labels assainis, jamais les ids bruts', () => {
    const parsed = parseAgentContext(CONTEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rendered = renderAgentContextForLlm(parsed.value);
    expect(rendered).toContain('E1: invoice');
    expect(rendered).toContain('F-2026-0014');
    expect(rendered).not.toContain('inv-secret-1');
    expect(rendered).not.toContain('<ignore>');
  });
});

describe('resolveAgentEntity — explicite > contexte unique > ambiguite', () => {
  it('resout une reference explicite ou un alias avant le contexte implicite', () => {
    const context: AgentContext = {
      ...CONTEXT,
      entities: [
        { type: 'invoice', id: 'inv-1', label: 'Facture F-2026-0014 — Martin' },
        { type: 'invoice', id: 'inv-2', label: 'Facture F-2026-0015 — Durand' },
      ],
    };
    expect(resolveAgentEntity({ context, compatibleTypes: ['invoice'], explicitReference: 'E2' })).toMatchObject({
      kind: 'resolved', entity: { id: 'inv-2' }, source: 'explicit',
    });
    expect(resolveAgentEntity({ context, compatibleTypes: ['invoice'], explicitReference: 'F-2026-0014' })).toMatchObject({
      kind: 'resolved', entity: { id: 'inv-1' }, source: 'explicit',
    });
  });

  it('resout le contexte compatible unique et refuse une capacite absente', () => {
    expect(resolveAgentEntity({ context: CONTEXT, compatibleTypes: ['invoice'], requiredCapability: 'invoice.collect' })).toMatchObject({
      kind: 'resolved', entity: { id: 'inv-secret-1' }, source: 'context',
    });
    expect(resolveAgentEntity({ context: CONTEXT, compatibleTypes: ['invoice'], requiredCapability: 'invoice.issue' })).toEqual({ kind: 'none' });
  });

  it('ne devine jamais entre deux candidats ni apres une reference explicite inconnue', () => {
    const context: AgentContext = {
      ...CONTEXT,
      entities: [
        { type: 'invoice', id: 'inv-1', label: 'Facture Martin' },
        { type: 'invoice', id: 'inv-2', label: 'Facture Durand' },
      ],
    };
    expect(resolveAgentEntity({ context, compatibleTypes: ['invoice'] })).toMatchObject({ kind: 'ambiguous' });
    expect(resolveAgentEntity({ context, compatibleTypes: ['invoice'], explicitReference: 'Dupont' })).toEqual({ kind: 'none' });
  });

  it('résout un ordinal relativement au type demandé, jamais à la position globale', () => {
    const context: AgentContext = {
      ...CONTEXT,
      entities: [
        { type: 'customer', id: 'cust-1', label: 'Client affiché avant le fil' },
        { type: 'notification', id: 'notif-1', label: 'Première notification' },
        { type: 'notification', id: 'notif-2', label: 'Deuxième notification' },
      ],
    };
    expect(
      resolveAgentEntity({
        context,
        compatibleTypes: ['notification'],
        explicitReference: 'ordinal:2',
      }),
    ).toMatchObject({ kind: 'resolved', entity: { id: 'notif-2' }, source: 'explicit' });
    expect(
      resolveAgentEntity({
        context,
        compatibleTypes: ['notification'],
        explicitReference: 'troisième',
      }),
    ).toEqual({ kind: 'none' });
  });
});

describe('ContextEntitySummary', () => {
  it('borne les faits et refuse un resume qui change de cible', () => {
    const facts = Array.from({ length: 20 }, (_, index) => ({ label: `Champ ${index}`, value: `Valeur ${index}` }));
    const summary = sanitizeContextEntitySummary(
      { type: 'invoice', id: 'inv-1', label: 'Facture <F-1>', facts },
      { type: 'invoice', id: 'inv-1' },
    );
    expect(summary?.label).toBe('Facture F-1');
    expect(summary?.facts).toHaveLength(12);
    expect(
      sanitizeContextEntitySummary(
        { type: 'invoice', id: 'inv-2', label: 'Autre', facts: [] },
        { type: 'invoice', id: 'inv-1' },
      ),
    ).toBeNull();
  });

  it('ne conserve qu’une route interne compatible avec l’entité canonique', () => {
    const safe = sanitizeContextEntitySummary(
      {
        type: 'notification',
        id: 'notif-1',
        label: 'Relance',
        facts: [],
        route: '/facture/inv-42',
        state: { unread: true },
      },
      { type: 'notification', id: 'notif-1' },
    );
    expect(safe?.route).toBe('/facture/inv-42');
    expect(safe?.state).toEqual({ unread: true });

    for (const route of [
      'https://evil.example/facture/inv-42',
      '//evil.example/facture/inv-42',
      '/facture/../compte',
      '/facture/inv-42?confirm=true',
    ]) {
      const summary = sanitizeContextEntitySummary(
        { type: 'notification', id: 'notif-1', label: 'Relance', facts: [], route },
        { type: 'notification', id: 'notif-1' },
      );
      expect(summary?.route).toBeUndefined();
    }

    const wrongType = sanitizeContextEntitySummary(
      { type: 'customer', id: 'cust-1', label: 'Martin', facts: [], route: '/facture/inv-42' },
      { type: 'customer', id: 'cust-1' },
    );
    expect(wrongType?.route).toBeUndefined();

    const document = sanitizeContextEntitySummary(
      { type: 'document', id: 'doc-1', label: 'Contrat', facts: [], route: '/documents/doc-1' },
      { type: 'document', id: 'doc-1' },
    );
    expect(document?.route).toBe('/documents/doc-1');
  });
});

describe('isAllowedAgentNavigationRoute', () => {
  it('autorise seulement les écrans Bob connus et les détails internes bornés', () => {
    for (const route of [
      '/scan-document',
      '/devis/new',
      '/chantiers',
      '/cloture',
      '/diagnostic',
      '/catalogue',
      '/facture/inv-42',
      '/devis/quote-42',
      '/client/cust-42',
      '/documents/doc-42',
    ]) {
      expect(isAllowedAgentNavigationRoute(route)).toBe(true);
    }
    for (const route of [
      'https://evil.example',
      '//evil.example/facture/inv-42',
      '/facture/../compte',
      '/facture/inv-42?confirm=true',
      '/compte',
      '/documents/doc-42?download=true',
      '/documents/%2Fadmin',
      '',
    ]) {
      expect(isAllowedAgentNavigationRoute(route)).toBe(false);
    }
  });
});
