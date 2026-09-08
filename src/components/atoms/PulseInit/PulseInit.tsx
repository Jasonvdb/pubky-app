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
 * The screen name is redacted against this allow-list rather than by guessing from a segment's
 * shape: a segment nobody declared is an id — a pubky, a post id, an invite code — and a screen
 * name may carry counts, kinds and route words only, never an identifier.
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
    // Static directories under `src/app` that `routes.ts` carries as no route value of its own.
    '/invite',
    '/offline',
  ].flatMap((route) => route.split('/').filter(Boolean)),
);

/** The route shape of a pathname: `/profile/<pubky>` → `/profile/*`. Exported for the tests. */
export function toSafeScreenName(pathname: string): string {
  return redactPathSegments(pathname, (segment) => STATIC_ROUTE_SEGMENTS.has(segment));
}

/**
 * PulseInit
 *
 * Initializes Pubky Pulse (product analytics) and reports every page view. Renders nothing.
 *
 * Placement is load-bearing: `src/instrumentation-client.ts` is evaluated before `appBootstrap()`
 * runs the `beforeInteractive` queue that assigns `window.__PUBKY_CONFIG__`, so the Pulse gate
 * would read as disabled there and never recover. A client component is evaluated during
 * hydration, after that queue has run.
 *
 * Mounted in the root layout, not on the graph route: page views are the denominator for the
 * graph funnels, so they have to cover every route.
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
