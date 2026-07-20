import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  blockquoteStyle,
  h1Style,
  h2Style,
  h3Style,
  hrStyle,
  liStyle,
  linkStyle,
  pStyle,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
  ulStyle,
  waitingStyle,
} from './styles';

/**
 * Rendu markdown minimal et dédié au sous-ensemble utilisé par les documents légaux
 * (design_handoff_bob_pro/legal/*.md) : titres #/##/###, listes à puces, tableaux, citations,
 * séparateurs, gras/italique/liens. Pas de dépendance externe — le contenu source reste en dur
 * dans les fichiers content.ts de chaque page (aucun pipeline markdown, aucune lib ajoutée).
 */

const INLINE_PATTERN =
  /(\[EN ATTENTE[^\]]*\])|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(\*[^*]+\*)/g;

function resolveHref(href: string): string {
  if (href.endsWith('politique-confidentialite.md')) return '/legal/confidentialite';
  if (href.endsWith('conditions-utilisation.md')) return '/legal/conditions-utilisation';
  return href;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let count = 0;
  INLINE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [full, waiting, bold, link, italic] = match;
    const key = `${keyPrefix}-${count++}`;
    if (waiting) {
      nodes.push(
        <mark key={key} style={waitingStyle}>
          {waiting}
        </mark>,
      );
    } else if (bold) {
      nodes.push(<strong key={key}>{bold.slice(2, -2)}</strong>);
    } else if (link) {
      const parsed = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(link);
      if (parsed) {
        const [, label, href] = parsed;
        const resolved = resolveHref(href);
        nodes.push(
          resolved.startsWith('/') ? (
            <Link key={key} href={resolved} style={linkStyle}>
              {label}
            </Link>
          ) : (
            <a key={key} href={resolved} style={linkStyle} target="_blank" rel="noreferrer">
              {label}
            </a>
          ),
        );
      }
    } else if (italic) {
      nodes.push(<em key={key}>{italic.slice(1, -1)}</em>);
    }
    lastIndex = match.index + full.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function renderBlock(block: string, index: number): ReactNode {
  const lines = block.split('\n');
  const first = lines[0] ?? '';
  const key = `b${index}`;

  if (lines.length === 1 && first.trim() === '---') {
    return <hr key={key} style={hrStyle} />;
  }
  if (first.startsWith('### ')) {
    return (
      <h3 key={key} style={h3Style}>
        {renderInline(first.slice(4), key)}
      </h3>
    );
  }
  if (first.startsWith('## ')) {
    return (
      <h2 key={key} style={h2Style}>
        {renderInline(first.slice(3), key)}
      </h2>
    );
  }
  if (first.startsWith('# ')) {
    return (
      <h1 key={key} style={h1Style}>
        {renderInline(first.slice(2), key)}
      </h1>
    );
  }
  if (lines.every((line) => line.startsWith('>'))) {
    const text = lines.map((line) => line.replace(/^>\s?/, '')).join(' ');
    return (
      <blockquote key={key} style={blockquoteStyle}>
        {renderInline(text, key)}
      </blockquote>
    );
  }
  if (first.trim().startsWith('|')) {
    const rows = lines.map(parseTableRow).filter((cells) => !isSeparatorRow(cells));
    const [headerRow, ...bodyRows] = rows;
    if (!headerRow) return null;
    return (
      <div key={key} style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              {headerRow.map((cell, i) => (
                <th key={i} style={thStyle}>
                  {renderInline(cell, `${key}-h${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} style={tdStyle}>
                    {renderInline(cell, `${key}-${r}-${c}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (first.trim().startsWith('- ')) {
    const items: string[] = [];
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('- ')) items.push(trimmedLine.slice(2));
      else if (items.length > 0) items[items.length - 1] += ` ${trimmedLine}`;
    }
    return (
      <ul key={key} style={ulStyle}>
        {items.map((item, i) => (
          <li key={i} style={liStyle}>
            {renderInline(item, `${key}-${i}`)}
          </li>
        ))}
      </ul>
    );
  }
  const text = lines.map((line) => line.trim()).join(' ');
  return (
    <p key={key} style={pStyle}>
      {renderInline(text, key)}
    </p>
  );
}

export function Markdown({ source }: { source: string }): ReactNode {
  const blocks = source.trim().split(/\n{2,}/);
  return <>{blocks.map((block, i) => renderBlock(block, i))}</>;
}
