/**
 * Server entry for the print view. Dynamic for the same reason as app/page.tsx:
 * the CSP nonce is per-request, so the route cannot be prerendered. See
 * src/proxy.ts.
 */
import { connection } from 'next/server';
import { PrintView } from '@/components/editor/PrintView';

export default async function PrintPage() {
  await connection();
  return <PrintView />;
}
