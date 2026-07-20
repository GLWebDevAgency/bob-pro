/**
 * B9 — parité vocale « retrouve/affiche/cherche les devis|factures de {client} {période} »,
 * affordance GLOBALE enregistrée à la fois depuis l'écran Ventes et depuis l'écran Accueil
 * (chaque écran publie sa PROPRE AgentSurface — cf. apps/mobile/src/agent/agent-context.tsx,
 * seule la surface de l'écran focalisé est active : il n'existe pas de registre vraiment
 * cross-écran, donc CE hook est appelé deux fois, une par écran, et retourne un objet identique).
 *
 * Le parseur de période (parseFrenchPeriod) ET le matcher client (matchSpokenCustomer) vivent
 * TOUS DEUX dans @bob/core, déjà testés isolément — ce module ne fait QUE les combiner et les
 * relier à la navigation (deep link /ventes?...) + au compte instantané (searchSalesDocumentsInMemory,
 * calculé sur les données déjà en cache local — aucune attente réseau avant que Bob parle).
 */
import { useMemo, useRef } from 'react';
import { useRouter } from 'expo-router';
import {
  matchSpokenCustomer,
  normalizeVoiceText,
  parisDateOnly,
  parseFrenchPeriod,
  searchSalesDocumentsInMemory,
  type PeriodLabel,
  type SalesDocumentSearchScope,
} from '@bob/core';
import { t, type Personality } from '@bob/i18n';
import type { QuoteView, InvoiceView } from '@bob/api-client';
import { type AgentAffordance } from './agent';
import { useCustomers, useInvoices, useQuotes } from './data/hooks';
import { isFreshSalesVoiceSnapshot } from './data/sales-voice-query-policy';

function periodLabelToPhrase(label: PeriodLabel, personality: Personality): string {
  if (label === 'thisMonth') return t('ventes.period.thisMonth', { personality });
  if (label === 'lastMonth') return t('ventes.period.lastMonth', { personality });
  if (label === 'thisWeek') return t('ventes.period.thisWeek', { personality });
  if (label === 'today') return t('ventes.period.today', { personality });
  if (label === 'thisYear') return t('ventes.period.thisYear', { personality });
  const lastN = /^last(\d+)Months$/.exec(label);
  if (lastN?.[1] !== undefined) return t('ventes.period.lastNMonths', { personality, params: { n: Number(lastN[1]) } });
  if (label.startsWith('since:')) return t('ventes.period.since', { personality, params: { month: label.slice(6) } });
  return '';
}

function detectScope(normalized: string): SalesDocumentSearchScope {
  const wantsQuotes = /\bdevis\b/.test(normalized);
  const wantsInvoices = /\bfactures?\b/.test(normalized);
  if (wantsQuotes && !wantsInvoices) return 'quote';
  if (wantsInvoices && !wantsQuotes) return 'invoice';
  return 'all';
}

function scopeKindLabel(scope: SalesDocumentSearchScope, personality: Personality): string {
  if (scope === 'quote') return t('ventes.voiceSearchKindQuotes', { personality });
  if (scope === 'invoice') return t('ventes.voiceSearchKindInvoices', { personality });
  return t('ventes.voiceSearchKindAll', { personality });
}

/** Gate du déclenchement : un verbe de recherche + devis/facture(s) quelque part dans l'énoncé —
 * sans ce gate, l'affordance locale plus simple (ventes.search, filtre substring) reste seule
 * responsable des énoncés génériques ("chauffe-eau" tout court, sans période ni client visé). */
const TRIGGER_RE = /\b(retrouve|affiche|cherche|trouve|montre)\w*\b.*\b(devis|factures?)\b/;

export function useSalesDocumentVoiceAffordance(personality: Personality): AgentAffordance {
  const router = useRouter();
  const quotes = useQuotes();
  const invoices = useInvoices();
  const customers = useCustomers();
  const dataRef = useRef({
    quotes: quotes.data ?? ([] as QuoteView[]),
    invoices: invoices.data ?? ([] as InvoiceView[]),
    customers: customers.data ?? [],
    ready: isFreshSalesVoiceSnapshot(quotes, invoices, customers),
  });
  dataRef.current = {
    quotes: quotes.data ?? [],
    invoices: invoices.data ?? [],
    customers: customers.data ?? [],
    ready: isFreshSalesVoiceSnapshot(quotes, invoices, customers),
  };
  const routerRef = useRef(router);
  routerRef.current = router;
  const personalityRef = useRef(personality);
  personalityRef.current = personality;

  // Identité STABLE (useMemo, deps []) : les données vivantes passent par dataRef/routerRef/
  // personalityRef ci-dessus (même recette que le reste de ventes.tsx), jamais par les deps —
  // sinon l'AgentSurface parente (elle-même mémoïsée) serait recalculée à chaque rendu.
  return useMemo<AgentAffordance>(() => ({
    id: 'sales-documents.voiceSearch',
    match: (utterance) => {
      // Une absence de réponse réseau n'est jamais un portefeuille vide. Tant que les trois
      // sources tenant-scoped n'ont pas livré une valeur, cette affordance ne répond pas et ne
      // prononce surtout pas « aucun résultat » à partir de tableaux de chargement.
      if (!dataRef.current.ready) return null;
      const normalized = normalizeVoiceText(utterance);
      if (!TRIGGER_RE.test(normalized)) return null;
      const today = parisDateOnly();
      const period = parseFrenchPeriod(utterance, today);
      const { quotes: qs, invoices: is, customers: cs } = dataRef.current;
      const customerId = matchSpokenCustomer(normalized, cs);
      // Ni période ni client reconnu : trop faible pour naviguer — l'affordance locale
      // (recherche texte simple, reste sur l'écran) prend le relais.
      if (period === null && customerId === null) return null;

      return () => {
        const scope = detectScope(normalized);
        const customerName = customerId !== null ? (cs.find((c) => c.id === customerId)?.name ?? null) : null;

        const toPiece = (id: string, number: string | null, pieceCustomerId: string, status: string, date: string | null, lines: readonly { label: string }[], totals: { ht: number; vat: number; ttc: number; netToPay: number; vatByRate: Record<string, number> }) =>
          ({ id, number, customerId: pieceCustomerId, status, date, lines, totals });
        const count = searchSalesDocumentsInMemory({
          query: '',
          scope,
          ...(customerId !== null ? { customerId } : {}),
          ...(period !== null ? { from: period.from, to: period.to } : {}),
          customers: cs.map((c) => ({ id: c.id, name: c.name })),
          quotes: qs.map((q) => toPiece(q.id, q.number, q.customerId, q.status, null, q.lines, q.totals)),
          invoices: is.map((i) => toPiece(i.id, i.number, i.customerId, i.status, i.issuedAt ?? null, i.lines, i.totals)),
        }).totalCount;

        routerRef.current.push({
          pathname: '/ventes',
          params: {
            type: scope,
            ...(customerId !== null ? { customerId } : {}),
            ...(period !== null ? { from: period.from, to: period.to } : {}),
          },
        });

        if (count === 0) return { say: t('ventes.voiceSearchNoResults', { personality: personalityRef.current }) };
        const kind = scopeKindLabel(scope, personalityRef.current);
        const periodPhrase = period !== null ? periodLabelToPhrase(period.label, personalityRef.current) : '';
        if (customerName !== null && period !== null) {
          return {
            say: t('ventes.voiceSearchResultWithCustomerAndPeriod', {
              personality: personalityRef.current,
              params: { kind, customer: customerName, period: periodPhrase, count },
            }),
          };
        }
        if (customerName !== null) {
          return {
            say: t('ventes.voiceSearchResultWithCustomer', {
              personality: personalityRef.current,
              params: { kind, customer: customerName, count },
            }),
          };
        }
        return {
          say: t('ventes.voiceSearchResultWithPeriod', {
            personality: personalityRef.current,
            params: { kind, period: periodPhrase, count },
          }),
        };
      };
    },
  }), []);
}
