'use client';
/**
 * BLOCK DISPATCHER — the single switch over the discriminated union.
 *
 * Because Block is a discriminated union, the `never` check in the default case
 * makes this switch EXHAUSTIVE at compile time: adding a block type to the
 * schema breaks the build here until it is handled. That is the schema
 * enforcing its own contract on the UI.
 *
 * The same component tree renders the editor, the print/export view, and
 * thumbnails — only `editable` and scale differ. One renderer means the PDF
 * cannot drift from what the user saw on screen.
 */
import dynamic from 'next/dynamic';
import type { Block } from '@/lib/schema/deck';
import { useDeckStore } from '@/lib/state/store';
import { EditableText } from './EditableText';
import { resolveImageUrlSeeded } from '@/lib/images';

// Recharts measures DOM nodes, so it must not render on the server.
const ChartBlockView = dynamic(
  () => import('./ChartBlock').then((m) => m.ChartBlockView),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full grid place-items-center text-xs opacity-40">
        loading chart…
      </div>
    ),
  }
);

interface Props {
  block: Block;
  slideId: string;
  themeName: string;
  editable: boolean;
}

export function BlockRenderer({ block, slideId, themeName, editable }: Props) {
  const dispatch = useDeckStore((s) => s.dispatch);

  /** Manual edits go through the SAME dispatch as AI edits, marked manual. */
  const patch = (p: Record<string, unknown>) =>
    dispatch({ t: 'patch_block', slideId, blockId: block.id, patch: p }, { manual: true });

  switch (block.type) {
    case 'heading':
      return editable ? (
        <EditableText
          as={block.level === 2 ? 'h2' : 'h3'}
          value={block.text}
          onCommit={(text) => patch({ text })}
          slideId={slideId}
          blockId={block.id}
          field="text"
          className={block.level === 2 ? 'text-[1.5em] font-semibold' : 'text-[1.2em] font-semibold'}
        />
      ) : block.level === 2 ? (
        <h2 className="text-[1.5em] font-semibold">{block.text}</h2>
      ) : (
        <h3 className="text-[1.2em] font-semibold">{block.text}</h3>
      );

    case 'paragraph':
      return editable ? (
        <EditableText
          as="p"
          multiline
          value={block.text}
          onCommit={(text) => patch({ text })}
          slideId={slideId}
          blockId={block.id}
          field="text"
          className="leading-relaxed"
        />
      ) : (
        <p className="leading-relaxed">{block.text}</p>
      );

    case 'bullets': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List
          className={`space-y-[0.5em] ${
            block.ordered ? 'list-decimal' : 'list-disc'
          } pl-[1.2em] leading-relaxed`}
          style={{ '--marker': 'var(--slide-accent)' } as React.CSSProperties}
        >
          {block.items.map((item, i) => (
            <li key={i} className="marker:text-[var(--slide-accent)]">
              {editable ? (
                <EditableText
                  as="span"
                  value={item}
                  onCommit={(next) => {
                    const items = [...block.items];
                    if (next) items[i] = next;
                    else items.splice(i, 1); // emptying a bullet removes it
                    patch({ items });
                  }}
                  slideId={slideId}
                  blockId={block.id}
                  field={`items.${i}`}
                />
              ) : (
                item
              )}
            </li>
          ))}
          {editable && (
            <li className="list-none -ml-[1.2em]">
              <button
                onClick={() => patch({ items: [...block.items, 'New point'] })}
                className="text-[0.75em] opacity-40 hover:opacity-100 transition-opacity"
                style={{ color: 'var(--slide-accent)' }}
              >
                + add bullet
              </button>
            </li>
          )}
        </List>
      );
    }

    case 'quote':
      return (
        <blockquote
          className="border-l-4 pl-[1em] italic text-[1.15em] leading-relaxed"
          style={{ borderColor: 'var(--slide-accent)' }}
        >
          {editable ? (
            <EditableText
              as="p"
              multiline
              value={block.text}
              onCommit={(text) => patch({ text })}
              slideId={slideId}
              blockId={block.id}
              field="text"
            />
          ) : (
            <p>{block.text}</p>
          )}
          {block.attribution && (
            <footer className="text-[0.75em] not-italic mt-[0.6em]" style={{ color: 'var(--slide-muted)' }}>
              — {block.attribution}
            </footer>
          )}
        </blockquote>
      );

    case 'metrics':
      return (
        <div
          className="grid gap-[1em] w-full"
          style={{ gridTemplateColumns: `repeat(${Math.min(block.items.length, 4)}, minmax(0,1fr))` }}
        >
          {block.items.map((m, i) => (
            <div key={i} className="flex flex-col gap-[0.2em]">
              <span className="text-[2.2em] font-bold leading-none tabular-nums"
                style={{ color: 'var(--slide-accent)' }}>
                {m.value}
              </span>
              <span className="text-[0.8em]" style={{ color: 'var(--slide-muted)' }}>
                {m.label}
              </span>
            </div>
          ))}
        </div>
      );

    case 'table':
      return (
        <div className="w-full overflow-hidden text-[0.85em]">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {block.columns.map((c, i) => (
                  <th
                    key={i}
                    className="text-left font-semibold py-[0.5em] px-[0.6em] border-b-2"
                    style={{ borderColor: 'var(--slide-accent)', color: 'var(--slide-fg)' }}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className="py-[0.45em] px-[0.6em] border-b align-top"
                      style={{ borderColor: 'var(--slide-border)' }}
                    >
                      {editable ? (
                        <EditableText
                          as="span"
                          value={cell}
                          onCommit={(next) => {
                            const rows = block.rows.map((rr) => [...rr]);
                            rows[r][c] = next;
                            patch({ rows });
                          }}
                          slideId={slideId}
                          blockId={block.id}
                          field={`rows.${r}.${c}`}
                        />
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'chart':
      // grow-block: charts must claim the leftover column height, otherwise
      // ResponsiveContainer measures a collapsed parent and renders nothing.
      return (
        <div className="grow-block min-h-0 flex-1 w-full">
          <ChartBlockView block={block} themeName={themeName} />
        </div>
      );

    case 'image': {
      // The model supplies keywords; the url is resolved deterministically.
      const src = block.url ?? resolveImageUrlSeeded(block.query, block.id);
      return (
        <div className="grow-block flex-1 w-full h-full min-h-0 overflow-hidden rounded-lg"
          style={{ background: 'var(--slide-bg-alt)' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={block.alt}
            className="w-full h-full"
            style={{ objectFit: block.fit }}
            loading="lazy"
          />
        </div>
      );
    }

    default: {
      // Exhaustiveness guard: if a new block type is added to the schema and
      // not handled above, this line fails to compile.
      const _exhaustive: never = block;
      void _exhaustive;
      return null;
    }
  }
}
