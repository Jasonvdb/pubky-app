'use client';

import { useEffect } from 'react';
import { initPulse } from '@/libs/observability/pulse';

/**
 * PulseInit
 *
 * Initializes Pubky Pulse (product analytics). Renders nothing.
 *
 * Placement is load-bearing. `src/instrumentation-client.ts` cannot do this:
 * `next/dist/client/app-next.js` evaluates that module at its own top level, BEFORE it calls
 * `appBootstrap()` — and `appBootstrap` is what runs the `next/script strategy="beforeInteractive"`
 * queue that assigns `window.__PUBKY_CONFIG__` in `ContainerRoot`. There, the runtime config does
 * not exist yet, so the Pulse gate reads as "disabled" and never recovers.
 *
 * A client component module is evaluated during hydration, which happens inside `appBootstrap`
 * after that queue has run, so the runtime config is reliably present by the time this effect
 * fires. See `docs/pulse.md`.
 *
 * Mounted once in the root layout, not on the graph route: the SDK's automatic page-view tracking
 * is the denominator for the graph funnels, so it has to cover every route. `initPulse()` is
 * idempotent, so a React StrictMode double-invoke or a remount configures the SDK at most once.
 */
export function PulseInit() {
  useEffect(() => {
    initPulse();
  }, []);

  return null;
}
