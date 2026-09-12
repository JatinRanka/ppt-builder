'use client';
/**
 * GLOBAL ERROR BOUNDARY — catches failures in the root layout itself, which
 * `error.tsx` cannot. It must render its own <html>/<body>.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          height: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#171717',
          color: '#e5e5e5',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 420, padding: 24 }}>
          <h1 style={{ fontSize: 18, fontWeight: 500 }}>The app failed to start</h1>
          {/* Show the raw message in dev only. Next already redacts SERVER
              error messages in production, but this boundary also catches
              client errors, whose messages are not redacted and can carry
              internal detail. The digest is enough to find it in the logs. */}
          <p style={{ fontSize: 13, color: '#a3a3a3' }}>
            {process.env.NODE_ENV === 'development'
              ? error.message || 'Unknown error'
              : 'An unexpected error occurred. Reloading usually fixes it.'}
          </p>
          {error.digest && (
            <p style={{ fontSize: 11, color: '#525252', fontFamily: 'monospace' }}>
              ref: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: 12, padding: '6px 12px', borderRadius: 4, border: 0,
              background: '#0284c7', color: '#fff', fontSize: 12, cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
