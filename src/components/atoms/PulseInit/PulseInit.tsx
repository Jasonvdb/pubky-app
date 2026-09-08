'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
  APP_ROUTES,
  AUTH_ROUTES,
  COLLECTION_ROUTES,
  COPYRIGHT_ROUTES,
  DEV_ROUTES,
  ONBOARDING_ROUTES,
  POST_ROUTES,
  PROFILE_ROUTES,
  SETTINGS_ROUTES,
} from '@/app/routes';
import { initPulse, pulseScreen, redactPathSegments } from '@/libs/observability/pulse';

/**
 * Every literal path segment that appears in a route declared in `src/app/routes.ts`.
 *
 * The screen name is built against this allow-list rather than against a list of known
 * dynamic routes: a segment nobody declared is an id — a pubky, a post id, a collection id,
 * an invite code — and §Privacy in `docs/pulse.md` forbids all of them. Over-redacting an
 * undeclared static route costs a little fidelity; under-redacting ships an identifier.
 */
const STATIC_ROUTE_SEGMENTS: ReadonlySet<string> = new Set(
  [
    ...Object.values(ONBOARDING_ROUTES),
    ...Object.values(AUTH_ROUTES),
    ...Object.values(APP_ROUTES),
    ...Object.values(COLLECTION_ROUTES),
    ...Object.values(PROFILE_ROUTES),
    ...Object.values(SETTINGS_ROUTES),
    ...Object.values(POST_ROUTES),
    ...Object.values(COPYRIGHT_ROUTES),
    ...Object.values(DEV_ROUTES),
    // Static route directories under `src/app` that `routes.ts` carries only as a literal
    // inside `isDynamicPublicRoute` (`/invite/[inviteCode]`) or not at all (`/offline`).
    '/invite',
    '/offline',
  ].flatMap((route) => route.split('/').filter(Boolean)),
);

/**
 * The screen name for a pathname: the route shape, with every dynamic segment replaced.
 *
 * `/profile/<pubky>` → `/profile/*` and `/invite/<code>` → `/invite/*`; both segments of
 * `/collections/<userId>/<postId>` go the same way. Exported for
 * `src/libs/observability/pulse.test.ts`.
 */
export function toSafeScreenName(pathname: string): string {
  return redactPathSegments(pathname, (segment) => STATIC_ROUTE_SEGMENTS.has(segment));
}

/**
 * PulseInit
 *
 * Initializes Pubky Pulse (product analytics) and reports every page view. Renders nothing.
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
 * Mounted once in the root layout, not on the graph route: page views are the denominator for
 * the graph funnels, so they have to cover every route. They are reported here rather than by
 * the SDK's own `trackPageViews`, which would send `location.pathname` verbatim — this app has
 * routes like `/profile/<pubky>` and `/invite/<code>`, so the raw pathname is an identifier.
 *
 * `initPulse()` is idempotent, so a React StrictMode double-invoke or a remount configures the
 * SDK at most once. The effects fire in declaration order, so the first screen is reported
 * after `initPulse()` has run.
 */
export function PulseInit() {
  const pathname = usePathname();

  useEffect(() => {
    initPulse();
  }, []);

  useEffect(() => {
    if (!pathname) return;
    pulseScreen(toSafeScreenName(pathname));
  }, [pathname]);

  return null;
}
