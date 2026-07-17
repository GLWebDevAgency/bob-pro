import type { CSSProperties } from 'react';

// Palette reprise des pages publiques existantes (signature/consultation) pour rester cohérent
// avec le design déjà en production sur ce même sous-domaine sign-web.
export const palette = {
  bg: '#F4F6F9',
  navy: '#0C2340',
  body: '#2E3A46',
  gray: '#5B6B7B',
  lightGray: '#8A97A6',
  border: '#E6EAEF',
  amber: '#B9781B',
  amberBg: '#FDF3E0',
  white: '#fff',
};

export const shell: CSSProperties = {
  maxWidth: 720,
  margin: '32px auto',
  padding: '32px 28px 28px',
  background: palette.white,
  borderRadius: 16,
  boxShadow: '0 6px 24px rgba(12,35,64,0.08)',
};

export const h1Style: CSSProperties = {
  fontSize: 26,
  lineHeight: 1.3,
  margin: '0 0 6px',
  color: palette.navy,
};

export const h2Style: CSSProperties = {
  fontSize: 19,
  lineHeight: 1.35,
  margin: '30px 0 10px',
  color: palette.navy,
};

export const h3Style: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.4,
  margin: '16px 0 6px',
  color: palette.navy,
};

export const pStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.7,
  color: palette.body,
  margin: '0 0 14px',
};

export const ulStyle: CSSProperties = {
  margin: '0 0 14px',
  paddingLeft: 22,
};

export const liStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.7,
  color: palette.body,
  marginBottom: 6,
};

export const hrStyle: CSSProperties = {
  border: 'none',
  borderTop: `1px solid ${palette.border}`,
  margin: '26px 0',
};

export const blockquoteStyle: CSSProperties = {
  margin: '16px 0',
  padding: '14px 16px',
  background: palette.bg,
  borderLeft: `3px solid ${palette.navy}`,
  borderRadius: 8,
  color: palette.gray,
  fontSize: 13.5,
  lineHeight: 1.6,
};

export const tableWrapStyle: CSSProperties = {
  overflowX: 'auto',
  margin: '10px 0 18px',
};

export const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
  minWidth: 480,
};

export const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  background: palette.bg,
  color: palette.navy,
  borderBottom: `2px solid ${palette.border}`,
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

export const tdStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  borderBottom: `1px solid ${palette.border}`,
  color: palette.body,
  verticalAlign: 'top',
};

export const waitingStyle: CSSProperties = {
  background: palette.amberBg,
  color: palette.amber,
  padding: '0 4px',
  borderRadius: 4,
  fontWeight: 600,
};

export const linkStyle: CSSProperties = {
  color: palette.navy,
  fontWeight: 600,
};
