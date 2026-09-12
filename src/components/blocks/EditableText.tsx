'use client';
/**
 * INLINE EDITING — the manual half of "manual and AI edits must coexist".
 *
 * Two behaviours make coexistence safe:
 *
 * 1. LOCALLY BUFFERED. Keystrokes update the DOM only; a DeckOp is dispatched
 *    on blur (or Enter). Dispatching per keystroke would spam the history stack
 *    and fight any in-flight AI patch.
 *
 * 2. REGISTERS FOCUS. On focus it records {slideId, blockId, field} in the
 *    store. An AI op targeting that exact field is then DEFERRED (not dropped)
 *    until blur, so the user's typing always wins and the AI's change is
 *    replayed afterwards rather than lost.
 *
 * contentEditable is used rather than <textarea> so text renders with real
 * slide typography while being edited; a textarea would need a separate styling
 * path and would not wrap identically to the rendered output.
 *
 * All element access goes through event targets rather than the ref, because
 * reading a ref inside a closure created during render is invalid in React 19.
 * The ref exists solely for the external-sync effect below.
 */
import { useEffect, useRef, useState } from 'react';
import { useDeckStore } from '@/lib/state/store';

type Tag = 'div' | 'span' | 'h1' | 'h2' | 'h3' | 'p';

interface Props {
  value: string;
  onCommit: (next: string) => void;
  slideId: string;
  blockId: string | null;
  field: string;
  className?: string;
  placeholder?: string;
  as?: Tag;
  multiline?: boolean;
}

export function EditableText({
  value,
  onCommit,
  slideId,
  blockId,
  field,
  className = '',
  placeholder = 'Click to edit',
  as = 'div',
  multiline = false,
}: Props) {
  const ref = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const setEditingField = useDeckStore((s) => s.setEditingField);

  // Sync external (AI-driven) changes into the DOM, but never while the user is
  // typing — that would move the caret and fight the input.
  useEffect(() => {
    const el = ref.current;
    if (!editing && el && el.textContent !== value) {
      el.textContent = value;
    }
  }, [value, editing]);

  const props = {
    contentEditable: true,
    suppressContentEditableWarning: true,
    role: 'textbox',
    tabIndex: 0,
    'aria-label': field,
    'data-placeholder': placeholder,
    // The focus ring uses the SLIDE accent, not the app accent: this element
    // sits on the slide surface, so it has to read on every theme.
    className: `editable outline-none rounded-[3px] transition-shadow focus:shadow-[0_0_0_2px_var(--slide-accent)] ${className}`,
    onFocus: () => {
      setEditing(true);
      setEditingField({ slideId, blockId, field });
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      const next = (e.currentTarget.textContent ?? '').trim();
      setEditing(false);
      setEditingField(null); // flushes any deferred AI ops for this field
      if (next !== value) onCommit(next);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        // Abandon the edit: restore the committed value, then leave the field.
        e.currentTarget.textContent = value;
        e.currentTarget.blur();
      }
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
    // The initial text; subsequent external updates go through the effect.
    children: value,
  };

  // An explicit switch rather than createElement: it keeps the ref properly
  // typed per tag and satisfies the react-hooks/refs rule.
  switch (as) {
    case 'span':
      return <span {...props} ref={ref as React.Ref<HTMLSpanElement>} />;
    case 'h1':
      return <h1 {...props} ref={ref as React.Ref<HTMLHeadingElement>} />;
    case 'h2':
      return <h2 {...props} ref={ref as React.Ref<HTMLHeadingElement>} />;
    case 'h3':
      return <h3 {...props} ref={ref as React.Ref<HTMLHeadingElement>} />;
    case 'p':
      return <p {...props} ref={ref as React.Ref<HTMLParagraphElement>} />;
    default:
      return <div {...props} ref={ref as React.Ref<HTMLDivElement>} />;
  }
}
