'use client';
/**
 * ROUTE ERROR BOUNDARY.
 *
 * Without this, any unhandled render error is a blank white page — and the
 * deck is still safe in localStorage, so the user has lost nothing but has no
 * way to know that. This says so explicitly and offers recovery that does not
 * require discarding their work.
 */
import { useEffect } from 'react';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[render error]', error);
  }, [error]);

  return (
    <div className="h-screen w-screen grid place-items-center bg-neutral-900 p-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-lg font-medium text-neutral-100">Something broke in the editor</h1>
        <p className="text-sm text-neutral-400">
          Your deck is saved in this browser and was not lost. Reloading usually fixes it.
        </p>
        <pre className="text-left text-[11px] text-neutral-500 bg-neutral-950 border border-neutral-800 rounded p-2 overflow-auto max-h-32">
          {error.message || 'Unknown error'}
        </pre>
        <div className="flex gap-2 justify-center">
          <button
            onClick={reset}
            className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs"
          >
            Reload page
          </button>
        </div>
        {/* Last resort: a corrupt persisted deck would otherwise crash on every
            load, leaving no way back in through the UI. */}
        <button
          onClick={() => {
            if (confirm('Discard the saved deck and start fresh? This cannot be undone.')) {
              try {
                localStorage.removeItem('ppt-builder-deck');
              } catch {
                /* private mode — nothing to clear */
              }
              window.location.reload();
            }
          }}
          className="text-[11px] text-neutral-600 hover:text-neutral-400 underline"
        >
          Still broken? Clear the saved deck
        </button>
      </div>
    </div>
  );
}
