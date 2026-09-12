'use client';
/**
 * The app shell: editor on the left, chat on the right.
 *
 * Both panels read the same Zustand store, so an AI op arriving over the wire
 * and a manual edit in the canvas are indistinguishable to the renderer — which
 * is the point.
 *
 * Split out of app/page.tsx so that page can be a server component: the CSP
 * nonce in src/proxy.ts only exists per-request, so the route has to render
 * per-request. See the note there.
 */
import { useEffect } from 'react';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { DeckCanvas } from '@/components/editor/DeckCanvas';
import { SlideThumbRail } from '@/components/editor/SlideThumbRail';
import { Toolbar } from '@/components/editor/Toolbar';
import { DeckTitle } from '@/components/editor/DeckTitle';

export function EditorShell() {
  // Lock document scroll for the shell only, and release it on unmount so
  // navigating to /print (which needs to scroll) is unaffected.
  useEffect(() => {
    document.documentElement.classList.add('app-locked');
    return () => document.documentElement.classList.remove('app-locked');
  }, []);

  return (
    <main className="h-screen w-screen flex overflow-hidden bg-(--app-bg)">
      <section className="flex-1 flex flex-col min-w-0">
        <DeckTitle />
        <Toolbar />
        <div className="flex-1 flex min-h-0">
          <SlideThumbRail />
          <DeckCanvas />
        </div>
      </section>
      <ChatPanel />
    </main>
  );
}
