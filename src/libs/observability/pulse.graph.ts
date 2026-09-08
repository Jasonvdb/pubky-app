import { isAppError } from '@/libs/error/error';
import {
  pulseCaptureError,
  pulseEvent,
  pulseWarn,
  REDACTED_PATH_SEGMENT,
  redactPathSegments,
} from '@/libs/observability/pulse';
import { RAW_PUBKY_PATTERN } from '@/libs/observability/sentry.constants';

/**
 * Pubky Pulse taxonomy for the graph explorer (`/graph`) and the feed "Graph" layout: event
 * names, funnel steps and metric slugs, none of which are normalized server-side.
 *
 * Privacy invariant: attributes carry counts, kinds, durations and enums only — never a pubky,
 * tag label, post id, post content, or a prefixed node id.
 *
 * Server-safe by contract (Application-layer code imports it): no `window`, no SDK import, and
 * never `@/libs/error/error.utils`, whose `Err.*` re-export would pull the Sentry SDK into every
 * server bundle that touches the graph.
 */

/** Stamped on every event below as `surface`. */
export type Surface = 'explorer' | 'feed';

export const EXPLORER_SURFACE: Surface = 'explorer';

export const FEED_SURFACE: Surface = 'feed';

export const GRAPH_FUNNEL_SLUG = 'graph-explore';

/** Each step fires at most once per mount (ref-guarded at the call site). */
export const GRAPH_FUNNEL_STEPS = {
  OPENED: 'graph-explore-opened',
  LOADED: 'graph-explore-loaded',
  INTERACTED: 'graph-explore-interacted',
  TRACED: 'graph-explore-traced',
} as const;

export const GRAPH_METRICS = {
  NEIGHBORHOOD_LOAD: 'graph-neighborhood-load',
  NODE_EXPAND: 'graph-node-expand',
  PATH_TRACE: 'graph-path-trace',
} as const;

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

/** Failure events, one per catch site, emitted through the two bridges at the bottom of the file. */
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

/** Prefix shared by every URL `graphApi` builds. Anything else takes the fallback sweep. */
const GRAPH_PATH_PREFIX = '/v0/graph/';

/**
 * Positional vocabulary for a nexus graph request path — one entry per segment. Redacting by
 * POSITION rather than by segment shape is what makes this safe: `graphApi` runs every id through
 * `encodeURIComponent`, and a tag label is user-authored text that can look like a route word.
 */
const GRAPH_PATH_VOCABULARY: readonly ReadonlySet<string>[] = [
  new Set(['v0']),
  new Set(['graph']),
  new Set(['user', 'post', 'tag', 'path']),
];

/**
 * The `_http_url` value: request path only, every identifying segment redacted. The origin can be
 * a `_pubky.<pubky>` host and the query adds nothing to a failure breakdown, so both are dropped.
 */
function toSafeHttpPath(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return undefined;

  let path: string;
  try {
    path = new URL(endpoint).pathname;
  } catch {
    // A relative or malformed endpoint never parses; keep it minus the query.
    path = endpoint.split('?')[0];
  }

  if (path.startsWith(GRAPH_PATH_PREFIX)) {
    return redactPathSegments(path, (segment, index) => GRAPH_PATH_VOCABULARY[index]?.has(segment) ?? false);
  }

  // Non-graph endpoint: a bare pubky is the one identifier recognisable without its route.
  return path.replace(RAW_PUBKY_PATTERN, REDACTED_PATH_SEGMENT);
}

/**
 * `fetchNexus` files the failed URL under `context.endpoint`, while `safeFetch`'s network and
 * abort paths file it under `context.url` — read both, or the HTTP breakdown goes missing exactly
 * when the request never reached the server. `_http_url` / `_http_status` / `_http_method` are
 * the only SDK-reserved keys supported, and a missing status is itself the network signal.
 */
function toErrorAttributes(error: unknown): Record<string, string> {
  if (!isAppError(error)) return {};

  const attributes: Record<string, string> = {};
  if (error.category) attributes.error_category = error.category;
  if (error.code) attributes.error_code = String(error.code);
  if (error.operation) attributes.error_operation = error.operation;

  const httpPath = toSafeHttpPath(error.context?.endpoint ?? error.context?.url);
  if (httpPath) {
    attributes._http_url = httpPath;
    // Every graph endpoint is a GET; there is no other verb on this surface.
    attributes._http_method = 'GET';
  }

  const statusCode = error.context?.statusCode;
  if (typeof statusCode === 'number') attributes._http_status = String(statusCode);

  return attributes;
}

/** Report a graph failure at error level, enriched with the HTTP and `AppError` breakdown. */
export function pulseGraphError(err: unknown, name: string, attrs?: Record<string, string>): void {
  pulseCaptureError(err, name, { ...toErrorAttributes(err), ...attrs });
}

/**
 * Identity for a thrown value that is not an `AppError`, so a warn is still triageable. The
 * message can quote a URL, so it is swept for bare pubkys before it ships.
 */
function toThrownValueAttributes(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return { error_type: typeof error };

  return {
    error_type: error.name,
    error_message: error.message.replace(RAW_PUBKY_PATTERN, REDACTED_PATH_SEGMENT),
  };
}

/** Same enrichment at warn level, for degradations that leave a usable graph. */
export function pulseGraphWarn(err: unknown, name: string, attrs?: Record<string, string>): void {
  const breakdown = isAppError(err) ? toErrorAttributes(err) : toThrownValueAttributes(err);
  pulseWarn(name, { ...breakdown, ...attrs });
}

/**
 * One event with a `control` breakdown, never one event per control. `control` is the control's
 * `data-cy` suffix verbatim, and `state` is what the control becomes.
 */
export function pulseGraphControl(surface: Surface, control: string, state?: 'on' | 'off'): void {
  pulseEvent(GRAPH_EVENTS.CONTROL_USED, { surface, control, ...(state ? { state } : {}) });
}
