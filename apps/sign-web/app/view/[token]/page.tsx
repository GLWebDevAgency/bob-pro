'use client';

import { useEffect, useState, use } from 'react';

/**
 * NEXT_PUBLIC_API_URL est inlinée au build (Vercel). Le repli localhost n'existe QU'EN dev
 * local : un build de production sans la variable affiche une erreur explicite au lieu de
 * viser silencieusement localhost (audit URLs/redirections 2026-07).
 */
const API =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null);

interface DocumentLineView {
  label: string;
  qty: number;
  unitPriceHT: number;
  vatRate: number;
}

interface DocumentTotalsView {
  ht: number;
  vat: number;
  ttc: number;
  netToPay: number;
}

type DocumentPublicView =
  | {
      kind: 'quote';
      number: string | null;
      companyName: string;
      customerName: string;
      status: string;
      signed: boolean;
      validUntil: string | null;
      lines: DocumentLineView[];
      totals: DocumentTotalsView;
    }
  | {
      kind: 'invoice';
      number: string | null;
      companyName: string;
      customerName: string;
      status: string;
      issuedAt: string | null;
      dueAt: string | null;
      paid: number;
      lines: DocumentLineView[];
      totals: DocumentTotalsView;
      mentions: string[];
    };

const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: 'Brouillon',
  sent: 'Envoyé',
  viewed: 'Vu',
  signed: 'Signé',
  refused: 'Refusé',
  expired: 'Expiré',
};

const INVOICE_STATUS_LABEL: Record<string, string> = {
  draft: 'Brouillon',
  issued: 'Émise',
  partially_paid: 'Partiellement payée',
  paid: 'Payée',
  late: 'En retard',
  cancelled: 'Annulée',
};

const eur = (cents: number): string => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

function frDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed);
}

const card: React.CSSProperties = {
  maxWidth: 560,
  margin: '32px auto',
  padding: 24,
  background: '#fff',
  borderRadius: 16,
  boxShadow: '0 6px 24px rgba(12,35,64,0.08)',
};
const primaryBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: '14px 16px',
  borderRadius: 12,
  border: 'none',
  background: '#0C2340',
  color: '#fff',
  fontSize: 16,
  fontWeight: 600,
  textAlign: 'center',
  textDecoration: 'none',
  cursor: 'pointer',
};
const badge = (tone: 'neutral' | 'success' | 'warning' | 'danger'): React.CSSProperties => {
  const palette: Record<typeof tone, { bg: string; fg: string }> = {
    neutral: { bg: '#EEF1F5', fg: '#5B6B7B' },
    success: { bg: '#E8F6EE', fg: '#1E7E47' },
    warning: { bg: '#FDF3E0', fg: '#B9781B' },
    danger: { bg: '#FDEEE6', fg: '#B9531B' },
  };
  const { bg, fg } = palette[tone];
  return {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 999,
    background: bg,
    color: fg,
    fontSize: 12,
    fontWeight: 700,
  };
};

function quoteTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'signed') return 'success';
  if (status === 'refused' || status === 'expired') return 'danger';
  if (status === 'sent' || status === 'viewed') return 'warning';
  return 'neutral';
}

function invoiceTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'paid') return 'success';
  if (status === 'late' || status === 'cancelled') return 'danger';
  if (status === 'issued' || status === 'partially_paid') return 'warning';
  return 'neutral';
}

export default function ViewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [doc, setDoc] = useState<DocumentPublicView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!API) {
      setError('Service momentanément indisponible. Réessayez plus tard.');
      return;
    }
    let active = true;
    fetch(`${API}/public/view/${encodeURIComponent(token)}`, {
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
      .then(async (r) => {
        if (!r.ok) throw new Error('Document introuvable ou lien expiré.');
        const data = (await r.json()) as DocumentPublicView;
        if (active) setDoc(data);
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : 'Erreur'));
    return () => {
      active = false;
    };
  }, [token]);

  if (error && !doc) {
    return (
      <main style={card}>
        <h1 style={{ fontSize: 22 }}>Lien indisponible</h1>
        <p style={{ color: '#C0392B' }}>{error}</p>
      </main>
    );
  }
  if (!doc) {
    return (
      <main style={card}>
        <p style={{ color: '#5B6B7B' }}>Chargement du document…</p>
      </main>
    );
  }

  const title = doc.kind === 'quote' ? 'Devis' : 'Facture';
  const statusLabel =
    doc.kind === 'quote' ? (QUOTE_STATUS_LABEL[doc.status] ?? doc.status) : (INVOICE_STATUS_LABEL[doc.status] ?? doc.status);
  const tone = doc.kind === 'quote' ? quoteTone(doc.status) : invoiceTone(doc.status);
  const remaining = doc.kind === 'invoice' ? Math.max(0, doc.totals.netToPay - doc.paid) : 0;
  const pdfUrl = `${API}/public/view/${encodeURIComponent(token)}/pdf`;

  return (
    <main style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p style={{ color: '#5B6B7B', margin: 0 }}>{doc.companyName}</p>
        <span style={badge(tone)}>{statusLabel}</span>
      </div>
      <h1 style={{ fontSize: 24, margin: '4px 0 2px' }}>
        {title} {doc.number ?? ''}
      </h1>
      <p style={{ color: '#5B6B7B', marginTop: 0 }}>Pour {doc.customerName}</p>

      <div style={{ borderTop: '1px solid #E6EAEF', margin: '16px 0', paddingTop: 12 }}>
        {doc.lines.map((l, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
            <span>
              {l.label} <span style={{ color: '#8A97A6' }}>· {l.qty} × {eur(l.unitPriceHT)} (TVA {l.vatRate} %)</span>
            </span>
            <span style={{ fontWeight: 600 }}>{eur(Math.round(l.qty * l.unitPriceHT))}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 700 }}>
        <span>Total TTC</span>
        <span>{eur(doc.totals.ttc)}</span>
      </div>

      {doc.kind === 'quote' ? (
        doc.validUntil ? (
          <p style={{ color: '#8A97A6', fontSize: 13 }}>Valable jusqu&apos;au {frDate(doc.validUntil)}</p>
        ) : null
      ) : (
        <>
          {doc.dueAt ? <p style={{ color: '#8A97A6', fontSize: 13 }}>Échéance : {frDate(doc.dueAt)}</p> : null}
          {doc.paid > 0 ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#5B6B7B' }}>
              <span>Déjà réglé</span>
              <span>{eur(doc.paid)}</span>
            </div>
          ) : null}
          {remaining > 0 && doc.paid > 0 ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700 }}>
              <span>Reste dû</span>
              <span>{eur(remaining)}</span>
            </div>
          ) : null}
          {doc.mentions.length > 0 ? (
            <div style={{ borderTop: '1px solid #E6EAEF', margin: '16px 0 0', paddingTop: 12 }}>
              {doc.mentions.map((mention) => (
                <p key={mention} style={{ color: '#8A97A6', fontSize: 11.5, lineHeight: 1.5, margin: '2px 0' }}>
                  {mention}
                </p>
              ))}
            </div>
          ) : null}
        </>
      )}

      <a href={pdfUrl} target="_blank" rel="noreferrer" style={{ ...primaryBtn, marginTop: 20 }}>
        Télécharger le PDF
      </a>
    </main>
  );
}
