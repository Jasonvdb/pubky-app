import { isAppError } from '@/libs/error/error';
import { pulseCaptureError, pulseWarn } from '@/libs/observability/pulse';
import { RAW_PUBKY_PATTERN } from '@/libs/observability/sentry.constants';

/**
 * Pubky Pulse taxonomy for the graph explorer (`/graph`) and the feed "Graph" layout.
 *
 * This module is the single source of truth for every graph event name, funnel step and metric
 * slug: names are never normalized server-side, so a typo silently becomes its own event.
 * Import the constants — do not inline string literals at call sites.
 *
 * Two hard constraints:
 * - **No SDK import.** It talks to `pulse.ts` only, which owns the containment boundary.
 *   `@/libs/error/error` and the dependency-free `sentry.constants` are the only other imports —
 *   in particular NOT `error.utils`, whose `Err.*` re-export would drag the Sentry SDK into
 *   every server bundle that touches the graph.
 * - **Server-safe.** It is imported by Application-layer code that also runs on the server, so
 *   it must never read `window`, `location` or `document` at module scope or in a helper.
 *
 * Privacy (see `docs/pulse.md`): attributes carry counts, kinds, durations and enums only.
 * Never a pubky, tag label, post id, post content, or a prefixed node id.
 */

/** Which graph surface produced the event. Stamped on every event below as `surface`. */
export type Surface = 'explorer' | 'feed';

/** Funnel that measures how far a session gets into the explorer. */
export const GRAPH_FUNNEL_SLUG = 'graph-explore';

/** Funnel steps, verbatim. Each fires at most once per mount (ref-guarded at the call site). */
export const GRAPH_FUNNEL_STEPS = {
  OPENED: 'graph-explore-opened',
  LOADED: 'graph-explore-loaded',
  INTERACTED: 'graph-explore-interacted',
  TRACED: 'graph-explore-traced',
} as const;

/** Operation slugs. Each wraps one async unit of work with a start + single terminal event. */
export const GRAPH_METRICS = {
  NEIGHBORHOOD_LOAD: 'graph-neighborhood-load',
  NODE_EXPAND: 'graph-node-expand',
  PATH_TRACE: 'graph-path-trace',
} as const;

/** Product events. See `docs/pulse.md` for the attribute of each and the never-instrument list. */
export const GRAPH_EVENTS = {
  OPENED: 'graph_opened',
  LOADED: 'graph_loaded',
  NODE_EXPANDED: 'graph_node_expanded',
  PATH_TRACED: 'graph_path_traced',
  PATH_NOT_FOUND: 'graph_path_not_found',
  SEARCH_PICK: 'graph_search_pick',
  RECENTERED: 'graph_recentered',
  RETRY_CLICKED: 'graph_retry_clicked',
  STREAM_MERGE_MORE: 'graph_stream_merge_more',
  NODE_INSPECTED: 'graph_node_inspected',
  CONTROL_USED: 'graph_control_used',
  LAYOUT_SELECTED: 'graph_layout_selected',
  AUTO_DECLUTTERED: 'graph_auto_decluttered',
} as const;

/** Failure events, one per catch site. Emitted through the two bridges at the bottom of the file. */
export const GRAPH_ERROR_EVENTS = {
  LOAD_FAILED: 'graph_load_failed',
  ADD_USER_FAILED: 'graph_add_user_failed',
  EXPAND_FAILED: 'graph_expand_failed',
  ADD_TAG_FAILED: 'graph_add_tag_failed',
  PATH_FAILED: 'graph_path_failed',
  INGEST_FAILED: 'graph_ingest_failed',
  SEED_VIEWER_FAILED: 'graph_seed_viewer_failed',
  STREAM_SYNTHESIS_FAILED: 'graph_stream_synthesis_failed',
  STREAM_RELS_FAILED: 'graph_stream_rels_failed',
} as const;

/** Stand-in for any identifying path segment. Short so the route shape stays readable. */
const REDACTED_SEGMENT = '*';

/**
 * Strip identity out of one URL path segment.
 *
 * Nexus graph ids are prefixed (`user:<pubky>`, `post:<author>:<id>`, `tag:<label>`), so the
 * kind before the first colon is the only part worth keeping — everything after it is a
 * pubky, a post id or a user-authored tag label, all of which §Privacy forbids. Bare pubky
 * segments (other nexus routes) are matched by the shared Sentry pattern.
 */
function redactPathSegment(segment: string): string {
  const separator = segment.indexOf(':');
  if (separator > 0) return `${segment.slice(0, separator)}:${REDACTED_SEGMENT}`;
  return segment.replace(RAW_PUBKY_PATTERN, REDACTED_SEGMENT);
}

/**
 * The `_http_url` value: request path only, with every identifying segment redacted.
 *
 * The origin and query string are dropped deliberately — the origin can be a
 * `_pubky.<pubky>` host and the query carries pagination noise, and neither adds anything to
 * a failure breakdown that the route shape does not already give.
 */
function toSafeHttpPath(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return undefined;

  let path: string;
  try {
    path = new URL(endpoint).pathname;
  } catch {
    // A relative endpoint (or a malformed one) never reaches `URL`; keep it minus the query.
    path = endpoint.split('?')[0];
  }

  return path.split('/').map(redactPathSegment).join('/');
}

/**
 * Translate an `AppError` into Pulse attributes.
 *
 * `fetchNexus` throws `httpResponseToError(...)`, an `AppError` whose `context` carries
 * `endpoint` and `statusCode`. Both are typed `unknown`, so they are narrowed before use.
 *
 * `_`-prefixed keys are SDK-reserved; `_http_url` / `_http_status` / `_http_method` are the
 * three supported ones, and no others may be invented. `_http_status` is omitted when the
 * request never got a response (a network failure), which is itself the signal.
 */
function toErrorAttributes(error: unknown): Record<string, string> {
  if (!isAppError(error)) return {};

  const attributes: Record<string, string> = {};
  if (error.category) attributes.error_category = error.category;
  if (error.code) attributes.error_code = String(error.code);
  if (error.operation) attributes.error_operation = error.operation;

  const httpPath = toSafeHttpPath(error.context?.endpoint);
  if (httpPath) {
    attributes._http_url = httpPath;
    // Every graph endpoint is a GET; there is no other verb on this surface.
    attributes._http_method = 'GET';
  }

  const statusCode = error.context?.statusCode;
  if (typeof statusCode === 'number') attributes._http_status = String(statusCode);

  return attributes;
}

/**
 * Report a graph failure at error level, enriched with the HTTP and `AppError` breakdown.
 *
 * Add it alongside the existing `Logger.*` / `Err.*` call at a catch site — never as a second
 * log line, and never in place of the user-facing handling.
 */
export function pulseGraphError(err: unknown, name: string, attrs?: Record<string, string>): void {
  pulseCaptureError(err, name, { ...toErrorAttributes(err), ...attrs });
}

/**
 * Same enrichment at warn level, for degradations rather than failures — a failed Dexie
 * backfill or a missing relationship batch leaves a usable graph, so it must not raise an
 * error-rate alarm.
 */
export function pulseGraphWarn(err: unknown, name: string, attrs?: Record<string, string>): void {
  pulseWarn(name, { ...toErrorAttributes(err), ...attrs });
}
