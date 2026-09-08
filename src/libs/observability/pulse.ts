import { Pulse } from '@synonymdev/pubky-pulse-web';
import { Env } from '@/libs/env/env';
import { Logger } from '@/libs/logger/logger';
import { getPulseClientKey, getTestnet } from '@/libs/runtime-config/runtime-config';

/**
 * Pubky Pulse (product analytics) in the browser.
 *
 * Containment rule: `@synonymdev/pubky-pulse-web` is imported here and nowhere else. Feature
 * code goes through the taxonomy wrappers in `pulse.graph.ts` or the helpers below.
 */

/** Immutable once events exist. */
const PULSE_BUNDLE_ID = 'graph.pubky.app';

const CLIENT_KEY_PREFIX = 'pulse_client_';

export const REDACTED_PATH_SEGMENT = '*';

/**
 * Replace every path segment the caller does not vouch for with `*`. `index` counts only
 * non-empty segments, so `/v0/graph/tag/<label>` sees `0..3`.
 */
export function redactPathSegments(path: string, isSafeSegment: (segment: string, index: number) => boolean): string {
  let index = 0;

  return path
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      const safe = isSafeSegment(segment, index);
      index += 1;
      return safe ? segment : REDACTED_PATH_SEGMENT;
    })
    .join('/');
}

/** True only after `Pulse.configure()` returned without throwing. */
let configured = false;

/** Set once `Pulse.configure()` threw, so it is never retried. */
let configureFailed = false;

/** A tracked operation as call sites see it: start it, then finish it exactly once. */
export interface PulseOp {
  complete(attrs?: Record<string, string>): void;
  fail(error: unknown, attrs?: Record<string, string>): void;
  cancel(attrs?: Record<string, string>): void;
}

/** Returned whenever Pulse is inactive; shared because it holds no per-operation state. */
const NOOP_OPERATION: PulseOp = Object.freeze({
  complete: () => {},
  fail: () => {},
  cancel: () => {},
});

/** Run one SDK call, swallowing anything it throws. */
function safely(call: () => void): void {
  try {
    call();
  } catch {
    // Intentionally ignored: telemetry is never load-bearing.
  }
}

/** Mirrors `shouldEnableSentry()` gate-for-gate, including the `!Env` circular-dependency guard. */
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
 * The only caller of `Pulse.configure()`. Safe to call repeatedly: a closed gate is not
 * latched, because the runtime config may simply not be resolvable yet.
 */
export function initPulse(): void {
  if (configured || configureFailed) return;
  if (!shouldEnablePulse()) return;

  try {
    Pulse.configure({
      apiKey: getPulseClientKey()!,
      bundleId: PULSE_BUNDLE_ID,
      appVersion: Env.NEXT_PUBLIC_APP_VERSION,
      consoleLogging: false,
      captureUnhandled: false,
      // The SDK would send `location.pathname` verbatim; `PulseInit` reports a redacted screen
      trackPageViews: false,
    });
  } catch (error) {
    // A warning, not an `Err.*` factory: those route to Sentry, and a telemetry
    // misconfiguration must not file a production issue or break the app.
    configureFailed = true;
    Logger.warn('Pulse configuration failed; analytics disabled for this session', error);
    return;
  }

  configured = true;
}

/** Whether events emitted right now will actually reach Pulse. */
export function isPulseActive(): boolean {
  return configured;
}

export function pulseEvent(name: string, attrs?: Record<string, string>): void {
  if (!configured) return;
  safely(() => Pulse.info(name, attrs));
}

export function pulseWarn(name: string, attrs?: Record<string, string>): void {
  if (!configured) return;
  safely(() => Pulse.warn(name, attrs));
}

/**
 * The non-Error wrap is load-bearing: `Pulse.error` is overloaded, and a string first argument
 * selects the logger overload, which shifts the event name into the attributes slot.
 */
export function pulseCaptureError(err: unknown, name: string, attrs?: Record<string, string>): void {
  if (!configured) return;
  const error = err instanceof Error ? err : new Error(String(err));
  safely(() => Pulse.error(error, name, attrs));
}

/** Step names are never normalized server-side — a typo silently becomes its own step. */
export function pulseStep(step: string, attrs?: Record<string, string>): void {
  if (!configured) return;
  safely(() => Pulse.step(step, attrs));
}

export function pulseScreen(name: string): void {
  if (!configured) return;
  safely(() => Pulse.trackScreen(name));
}

/**
 * Start a tracked operation: a `metric:<slug>:start` now and exactly one terminal event.
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
