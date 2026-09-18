import {
  createScreenNameMapper,
  type LogEvent,
  Pulse,
  type PulseEventHint,
  type PulseInitResult,
} from '@synonymdev/pubky-pulse-web';
import {
  APP_ROUTES,
  AUTH_ROUTES,
  COLLECTION_ROUTES,
  COPYRIGHT_ROUTES,
  DEV_ROUTES,
  getProfileRoute,
  ONBOARDING_ROUTES,
  PROFILE_ROUTES,
  ROOT_ROUTES,
  SETTINGS_ROUTES,
} from '@/app/routes';
import { INLINE_IMAGE_UPLOAD_REJECTION_NAME } from '@/hooks/useInlineImageUpload/useInlineImageUpload.types';
import { Env } from '@/libs/env/env';
import { AppError } from '@/libs/error/error';
import { sanitizeForSentry, shouldDropCapturedExceptionFromSentry } from '@/libs/observability/sentry.utils';
import { getDeployEnv, getPulseClientKey, getPulseEndpoint } from '@/libs/runtime-config/runtime-config';
import { getPulseConsent, getPulseConsentGeneration, subscribePulseConsent } from './pulse-consent';

// Which consent this tab's Pulse state was created under. It lives in sessionStorage so it is copied and
// discarded with the SDK's per-tab session keys, and it must not carry the SDK's "pulse." prefix or
// Pulse.reset() would purge it. It records an ordering, never an identifier, and is never sent.
const PULSE_STARTED_UNDER_KEY = 'pubky-pulse-consent-v1-started-under';
// An unreadable marker can never equal a consent generation, so the state counts as stale.
const UNREADABLE_GENERATION = 'unreadable';

function getStartedUnder(): string | null {
  try {
    return window.sessionStorage.getItem(PULSE_STARTED_UNDER_KEY);
  } catch {
    return UNREADABLE_GENERATION;
  }
}

function setStartedUnder(generation: string | null): boolean {
  try {
    if (generation === null) window.sessionStorage.removeItem(PULSE_STARTED_UNDER_KEY);
    else window.sessionStorage.setItem(PULSE_STARTED_UNDER_KEY, generation);
    return true;
  } catch {
    return false;
  }
}

/** True once this tab's Pulse state outlives the consent it was created under. An absent marker is a fresh tab. */
function predatesCurrentConsent(): boolean {
  const startedUnder = getStartedUnder();
  return startedUnder !== null && startedUnder !== getPulseConsentGeneration();
}

/** Route definitions are a telemetry allowlist: never add user identifiers or arbitrary paths. */
export const pulseScreenName = createScreenNameMapper(
  [
    ROOT_ROUTES,
    '/offline',
    '/profile/tags',
    ...Object.values(APP_ROUTES).filter((route) => route !== APP_ROUTES.FEED),
    ...[
      AUTH_ROUTES,
      COLLECTION_ROUTES,
      COPYRIGHT_ROUTES,
      DEV_ROUTES,
      ONBOARDING_ROUTES,
      PROFILE_ROUTES,
      SETTINGS_ROUTES,
    ].flatMap(Object.values),
    ...Object.values(PROFILE_ROUTES).map((route) => getProfileRoute(route, '[pubky]')),
    '/post/[userId]/[postId]',
    '/collections/[userId]/[postId]',
    '/invite/[inviteCode]',
    '/feed/[id]',
  ],
  { fallback: '/unknown' },
);

export function beforeSendPulse(event: LogEvent, { originalException: error }: PulseEventHint): LogEvent | null {
  if (getPulseConsent() !== 'accepted' || predatesCurrentConsent()) return null;
  if (shouldDropCapturedExceptionFromSentry(error)) return null;
  if (error instanceof AppError) {
    // Keep only reviewed operational metadata; never spread the error or its context.
    for (const [key, value] of Object.entries({
      category: error.category,
      code: error.code,
      service: error.service,
      operation: error.operation,
      trace_id: error.traceId,
    })) {
      if (value !== undefined) (event.custom_attributes ??= {})[key] = value;
    }
  }
  event.message = sanitizeForSentry(event.message) as string;
  event.custom_attributes = sanitizeForSentry(event.custom_attributes) as LogEvent['custom_attributes'];
  return event;
}

/**
 * The SDK's init result, or null when consent stopped us before the call. Pulse.init never throws: a start
 * that was refused or that failed is reported through the result's status, so callers must read it.
 */
export function initPulse(): PulseInitResult | null {
  if (getPulseConsent() !== 'accepted') return null;
  try {
    return Pulse.init({
      apiKey: getPulseClientKey(),
      endpoint: getPulseEndpoint(),
      enabled: Env.NODE_ENV !== 'test' && !Env.VITEST,
      appVersion: Env.NEXT_PUBLIC_APP_VERSION,
      isDev: Env.NODE_ENV !== 'production' || getDeployEnv() !== 'production',
      consoleLogging: false,
      ignoreErrors: [
        'ResizeObserver loop limit exceeded',
        'ResizeObserver loop completed with undelivered notifications',
        'Failed to fetch',
        /Loading chunk \d+ failed/,
        'AbortError',
        'Non-Error promise rejection captured',
        INLINE_IMAGE_UPLOAD_REJECTION_NAME,
        /window\.webkit\.messageHandlers/,
        /Java object is gone/,
        /Java exception was raised during method invocation/,
        /Failed to connect to MetaMask/,
      ],
      // No networkTracking: network failures reach Pulse as AppErrors, so they pass the shared drop policy
      // that the SDK's fetch-level tracking cannot apply.
      screenNameForPath: pulseScreenName,
      beforeSend: beforeSendPulse,
    });
  } catch {
    // Unreachable today: the consent check above already resolved and memoized the runtime config, and the
    // SDK reports failures instead of throwing. Kept so a future read here can never break startup.
    return null;
  }
}

/** Install the consent gate before any application code can start tracking. */
export function initializePulseConsent(): () => void {
  let running = false; // this page has a live client; the marker outlives the page and cannot say so
  const sync = () => {
    const accepted = getPulseConsent() === 'accepted';
    if (!accepted || predatesCurrentConsent()) {
      // reset() disables synchronously without flushing, removes collectors and deletes the anonymous ID,
      // session and queued events the banner asked consent to store, so nothing replays on re-acceptance.
      // It also runs on a page that never started Pulse: a returning tab still holds the session a previous
      // page stored, and no other tab can delete it.
      Pulse.reset();
      setStartedUnder(null);
      running = false;
    }
    if (!accepted || running) return;
    // Record the provenance before starting, so "SDK state present, marker absent" cannot exist and the
    // events init() records synchronously are not dropped by beforeSendPulse. The marker stays if the start
    // then fails: it describes the Pulse state this tab may still hold from an earlier page load, and
    // dropping it would make a stale tab look brand new and let it resume a pre-withdrawal session.
    if (!setStartedUnder(getPulseConsentGeneration())) return;
    // Only a client that actually started counts as running. A refused or failed init is retried on the next
    // consent notification, focus or pageshow; re-initializing a live client is a no-op in the SDK, so a
    // retry can never install a second set of collectors.
    running = initPulse()?.status === 'enabled';
  };
  const unsubscribe = subscribePulseConsent(sync);
  sync();
  return unsubscribe;
}
