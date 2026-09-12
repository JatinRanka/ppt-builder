'use client';
/**
 * TOOL CALL DETAIL — shows exactly what the agent did.
 *
 * The point of this component is auditability. The assignment is graded on
 * agentic tool use and diff-based edits, and both claims are only credible if
 * you can SEE them: which tool ran, what arguments the model produced, which
 * slide was targeted, and what ops resulted. A one-line summary hides all of
 * that, and during testing it actively misled us — the model reported
 * "shortened the table to three rows" while the underlying patch no-opped.
 *
 * Rendered collapsed by default so a 12-call generation does not bury the
 * conversation, expandable per call.
 */
import { useState } from 'react';
import type { ChatToolCall } from '@/lib/state/store';
import { describeOp, type DeckOp } from '@/lib/state/ops';

/** Which tools are diffs vs. structural, for the badge colour. */
const TOOL_KIND: Record<string, string> = {
  patch_block: 'diff',
  update_slide: 'diff',
  set_blocks: 'fill',
  add_slide: 'add',
  delete_slide: 'remove',
  reorder_slides: 'move',
  change_layout: 'layout',
};

export function ToolCallList({ calls }: { calls: ChatToolCall[] }) {
  const [open, setOpen] = useState(false);
  const errors = calls.filter((c) => c.status === 'error').length;

  return (
    <div className="mt-2 border-t border-(--app-border) pt-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 text-[10px] text-(--app-muted) transition-colors hover:text-(--app-fg)"
      >
        <span className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="font-medium">
          {calls.length} tool call{calls.length === 1 ? '' : 's'}
        </span>
        {errors > 0 && <span className="text-(--app-warn)">· {errors} rejected</span>}
        <span className="flex-1" />
        <span className="text-(--app-faint)">{open ? 'hide' : 'details'}</span>
      </button>

      {open && (
        <ol className="mt-1.5 space-y-1.5">
          {calls.map((c, i) => (
            <ToolCallRow key={i} call={c} index={i + 1} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ToolCallRow({ call, index }: { call: ChatToolCall; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const failed = call.status === 'error';
  const kind = TOOL_KIND[call.name] ?? 'tool';

  return (
    <li
      className={`rounded-[10px] border text-[10px] overflow-hidden transition-colors ${
        failed ? 'border-amber-200 bg-(--app-warn-soft)' : 'border-(--app-border) bg-(--app-surface)'
      }`}
    >
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left px-2 py-1.5 flex items-start gap-1.5 transition-colors hover:bg-(--app-subtle)"
      >
        <span className="text-(--app-faint) tabular-nums shrink-0">{index}.</span>
        <span className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="flex items-center gap-1.5 flex-wrap">
            <code className={`font-medium ${failed ? 'text-(--app-warn)' : 'text-(--app-accent)'}`}>
              {call.name}
            </code>
            <span className="px-1.5 rounded-full bg-(--app-subtle) border border-(--app-border) text-(--app-muted)">
              {kind}
            </span>
            {call.phase && (
              <span className="px-1.5 rounded-full bg-(--app-subtle) text-(--app-faint)">
                {call.phase}
              </span>
            )}
            {failed && <span className="text-(--app-warn) font-medium">rejected</span>}
          </span>
          <span className={`${failed ? 'text-(--app-warn)' : 'text-(--app-muted)'} break-words`}>
            {call.summary}
          </span>
        </span>
        <span className="text-(--app-faint) shrink-0">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="px-2 pb-2 space-y-2 border-t border-(--app-border) pt-1.5 bg-(--app-subtle)">
          {failed && call.error && (
            <Field label="Why it was rejected">
              <p className="text-(--app-warn) whitespace-pre-wrap break-words">{call.error}</p>
            </Field>
          )}

          {call.args && Object.keys(call.args).length > 0 && (
            <Field label="Arguments from the model">
              <pre className="text-(--app-muted) whitespace-pre-wrap break-words font-mono leading-relaxed">
                {JSON.stringify(call.args, null, 1)}
              </pre>
            </Field>
          )}

          {call.ops && call.ops.length > 0 && (
            <Field label={`Applied ${call.ops.length} op${call.ops.length === 1 ? '' : 's'}`}>
              <ul className="space-y-0.5">
                {call.ops.map((op, i) => (
                  <li key={i} className="text-(--app-muted) flex gap-1.5">
                    <code className="text-emerald-600 shrink-0 font-medium">{op.t}</code>
                    <span className="text-(--app-muted) break-words">
                      {describeOp(op)}
                      <TargetHint op={op} />
                    </span>
                  </li>
                ))}
              </ul>
            </Field>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Names the slide/block an op touched. This is the detail that makes the
 * diff-based-edit claim verifiable: you can see one op hitting one block
 * rather than a whole-deck rewrite.
 */
function TargetHint({ op }: { op: DeckOp }) {
  const target =
    'slideId' in op ? op.slideId : 'id' in op ? op.id : null;
  const block = 'blockId' in op ? op.blockId : null;
  if (!target && !block) return null;
  return (
    <span className="text-(--app-faint)">
      {target ? ` · slide ${target}` : ''}
      {block ? ` · block ${block}` : ''}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wider text-(--app-faint) mb-0.5">{label}</p>
      {children}
    </div>
  );
}
