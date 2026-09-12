/**
 * Server entry for the editor.
 *
 * `await connection()` opts the route into dynamic rendering, which the
 * nonce-based CSP requires: Next can only stamp its inline hydration scripts
 * with a nonce it read off the incoming request, and a build-time prerender has
 * no request. Without this the page ships nonce-less inline scripts, the
 * browser blocks them, and nothing on the page is interactive.
 *
 * All the actual UI is in EditorShell, which is a client component.
 */
import { connection } from 'next/server';
import { EditorShell } from '@/components/editor/EditorShell';

export default async function Home() {
  await connection();
  return <EditorShell />;
}
