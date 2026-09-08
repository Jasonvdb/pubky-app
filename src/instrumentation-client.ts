import * as Sentry from '@sentry/nextjs';
import { getSentryInitBase, shouldEnableSentry } from '@/libs/observability/sentry';
import {
  getSentryReplaysOnErrorSampleRate,
  getSentryReplaysSessionSampleRate,
} from '@/libs/runtime-config/runtime-config';

// Safe to read runtime config here: ContainerRoot emits `window.__PUBKY_CONFIG__` with
// next/script strategy="beforeInteractive", which Next injects into <head> before app bundles.
if (shouldEnableSentry()) {
  Sentry.init({
    ...getSentryInitBase(),
    replaysSessionSampleRate: getSentryReplaysSessionSampleRate(),
    replaysOnErrorSampleRate: getSentryReplaysOnErrorSampleRate(),
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
        maskAllInputs: true,
        networkCaptureBodies: false,
      }),
    ],
  });
}

// Pulse is deliberately NOT initialized here. `next/dist/client/app-next.js` requires this
// module at its own top level, BEFORE it calls `appBootstrap()` — and `appBootstrap` is what runs
// the `beforeInteractive` script queue that assigns `window.__PUBKY_CONFIG__`. At this point the
// runtime config does not exist yet, so the Pulse gate would read as "disabled" and no event
// would ever be sent. `initPulse()` therefore runs from `@/atoms/PulseInit/PulseInit`, which the
// root layout mounts and which is evaluated during hydration. See docs/pulse.md.

/**
 * Next.js framework convention export — discovered by name from this module.
 *
 * Next.js's App Router instrumentation invokes `onRouterTransitionStart` on every client-side
 * route transition; Sentry's `captureRouterTransitionStart` wires that signal into tracing so
 * navigation transactions stitch with the originating click/back-forward event. There is no
 * static import of this symbol in the codebase by design — it's a framework hook.
 *
 * See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
