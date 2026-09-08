import { Pulse } from '@synonymdev/pubky-pulse-web';
import { Env } from '@/libs/env/env';
import { Logger } from '@/libs/logger/logger';
import { getPulseClientKey, getTestnet } from '@/libs/runtime-config/runtime-config';

/**
 * Single source of truth for Pubky Pulse (product analytics) in the browser.
 *
 * Containment rule — do NOT import `@synonymdev/pubky-pulse-web` outside of:
 * - `src/instrumentation-client.ts` (the one place that calls `initPulse()`)
 * - this file (the capture funnel every feature call goes through)
 *
 * Feature code imports the taxonomy wrappers in `pulse.graph.ts`, or the helpers below.
 * That keeps the SDK swappable and keeps the "disabled" path in exactly one place.
 *
 * Pulse ships dark: with no client key configured — the default in dev, test, CI and any deploy
 * that has not opted in — nothing is configured, no listener is installed, and no request
 * leaves the browser. See `docs/pulse.md`.
 */

/** Bundle id of the Pulse app record that owns these events. Immutable once events exist. */
const PULSE_BUNDLE_ID = 'graph.pubky.app';

/** Every Pulse browser key carries this prefix; anything else is a misconfiguration. */
const CLIENT_KEY_PREFIX = 'pulse_client_';

/**
 * True only after `Pulse.configure()` returned without throwing.
 *
 * The SDK has no "is configured" accessor of its own, so this module owns the flag. A throw
 * inside `initPulse()` deliberately leaves it false, which makes every helper below a
 * permanent no-op for the life of the page rather than a repeated failed call.
 */
let configured = false;

/**
 * A tracked operation as call sites see it: start it, then finish it exactly once.
 *
 * Structurally a subset of the SDK's `PulseOperation`, so `pulseOperation()` can hand back
 * either the real handle (wrapped so a terminal call can never throw into app code) or the
 * shared no-op below — and no call site needs an `if (enabled)` branch.
 */
export interface PulseOp {
  complete(attrs?: Record<string, string>): void;
  fail(error: unknown, attrs?: Record<string, string>): void;
  cancel(attrs?: Record<string, string>): void;
}

/** Returned whenever Pulse is inactive. Shared and frozen: it holds no per-operation state. */
const NOOP_OPERATION: PulseOp = Object.freeze({
  complete: () => {},
  fail: () => {},
  cancel: () => {},
});

/**
 * Run one SDK call, swallowing anything it throws.
 *
 * Telemetry is never load-bearing: an ingest failure, a quota trip or an SDK bug must not
 * escape into the feature code that emitted the event. Swallowing silently (rather than
 * logging) is deliberate — these calls sit on hot paths like node expansion.
 */
function safely(call: () => void): void {
  try {
    call();
  } catch {
    // Intentionally ignored: analytics must never break the surface it measures.
  }
}

/**
 * Whether Pulse should be initialized in the current runtime.
 * False during tests, testnet deployments, and when no client key is configured.
 *
 * Mirrors `shouldEnableSentry()` gate-for-gate, including the `!Env` circular-dependency
 * guard and the try/catch around runtime-config resolution: a misconfigured deploy whose
 * `PUBKY_RUNTIME_*` cannot resolve means "Pulse disabled", never a throw.
 *
 * The `pulse_client_` prefix check lives here rather than in the runtime-config schema on
 * purpose: `runtimeConfigValueSchema.parse()` backs every consumer of the runtime config, so
 * rejecting a malformed analytics key there would turn an analytics typo into a boot failure.
 */
export function shouldEnablePulse(): boolean {
  if (!Env) return false;
  if (Env.NODE_ENV === 'test') return false;
  if (Env.VITEST) return false;
  try {
    if (getTestnet()) return false;
    const key = getPulseClientKey();
    if (!key) return false;
    if (!key.startsWith(CLIENT_KEY_PREFIX)) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Configure the SDK. The ONLY caller of `Pulse.configure()`, and called from exactly one
 * place (`src/instrumentation-client.ts`).
 *
 * Never call `configure()` at module scope: `pulse.graph.ts` is imported by Application-layer
 * code that also runs on the server, and an accidental server-side import of this module must
 * not be able to start a browser SDK.
 *
 * Non-default options, and why:
 * - `consoleLogging: false` — the SDK default (true) would mirror every event to the
 *   production console.
 * - `captureUnhandled: false` — app-wide `error` / `unhandledrejection` listeners would
 *   duplicate what Sentry's `globalHandlers` integration already reports.
 *
 * Everything else is deliberately left at its SDK default: `endpoint` (hosted ingest),
 * `isDev` (resolves localhost / 127.0.0.1 / file: correctly), `trackPageViews` (true — the
 * denominator for every graph funnel), `networkTracking` (false — the graph fires many
 * fetches and per-request events are pure noise), and `propagateSessionTo` /
 * `supportedLanguages` (nexus is a separate Rust service, and the language list belongs to
 * the server-side app record).
 */
export function initPulse(): void {
  if (configured) return;
  if (!shouldEnablePulse()) return;

  try {
    Pulse.configure({
      apiKey: getPulseClientKey()!,
      bundleId: PULSE_BUNDLE_ID,
      appVersion: Env.NEXT_PUBLIC_APP_VERSION,
      consoleLogging: false,
      captureUnhandled: false,
    });
  } catch (error) {
    // `Pulse.configure()` throws on invalid values. Report it as a warning, NOT through an
    // `Err.*` factory: those route to Sentry, and a telemetry misconfiguration must not file
    // a production issue. `configured` stays false, so every helper below stays a no-op.
    Logger.warn('Pulse configuration failed; analytics disabled for this session', error);
    return;
  }

  configured = true;
}

/** Whether events emitted right now will actually reach Pulse. */
export function isPulseActive(): boolean {
  return configured;
}

/** Record a product event at info level. */
export function pulseEvent(name: string, attrs?: Record<string, string>): void {
  if (!configured) return;
  safely(() => Pulse.info(name, attrs));
}

/** Record a degraded-but-not-broken outcome at warn level. */
export function pulseWarn(name: string, attrs?: Record<string, string>): void {
  if (!configured) return;
  safely(() => Pulse.warn(name, attrs));
}

/**
 * Record a failure at error level.
 *
 * The non-Error wrap is load-bearing: `Pulse.error` is overloaded, and passing a string as
 * the first argument selects the logger overload, which shifts every later argument into the
 * wrong slot (the event name would be read as attributes).
 */
export function pulseCaptureError(err: unknown, name: string, attrs?: Record<string, string>): void {
  if (!configured) return;
  const error = err instanceof Error ? err : new Error(String(err));
  safely(() => Pulse.error(error, name, attrs));
}

/** Record one funnel step. Step names are never normalized server-side — a typo is a new step. */
export function pulseStep(step: string, attrs?: Record<string, string>): void {
  if (!configured) return;
  safely(() => Pulse.step(step, attrs));
}

/** Report a screen the SDK's own page-view tracking cannot see (a modal, a canvas mode). */
export function pulseScreen(name: string): void {
  if (!configured) return;
  safely(() => Pulse.trackScreen(name));
}

/**
 * Start a tracked operation: a `metric:<slug>:start` now and exactly one terminal event when
 * the returned handle is completed, failed or cancelled.
 *
 * Always returns a usable handle, so call sites finish the operation unconditionally.
 */
export function pulseOperation(slug: string, attrs?: Record<string, string>): PulseOp {
  if (!configured) return NOOP_OPERATION;

  try {
    const operation = Pulse.startOperation(slug, attrs);
    return {
      complete: (completeAttrs) => safely(() => operation.complete(completeAttrs)),
      fail: (error, failAttrs) => safely(() => operation.fail(error, failAttrs)),
      cancel: (cancelAttrs) => safely(() => operation.cancel(cancelAttrs)),
    };
  } catch {
    return NOOP_OPERATION;
  }
}
