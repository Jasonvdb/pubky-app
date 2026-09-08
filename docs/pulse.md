# Pubky Pulse (Graph explorer telemetry)

Product analytics for the `/graph` explorer and the feed "Graph" layout, via the
`@synonymdev/pubky-pulse-web` SDK. Scope is deliberately narrow: **only** the graph experiment is
instrumented, plus the app-wide redacted page view that is its funnel denominator. No other page
gets hand-written Pulse calls — analytics elsewhere stay with cookieless Plausible, and error
reporting stays with Sentry (see [`sentry.md`](sentry.md)).

## Off by default

Pulse is enabled by exactly one runtime value. With it unset — the default in local dev, Vitest,
Cypress, CI, and any deploy that has not opted in — nothing is configured, no listener is
installed, and no request leaves the browser.

| Variable (deployed / dev fallback)                                | Runtime | Required?                                                 |
| ----------------------------------------------------------------- | ------- | --------------------------------------------------------- |
| `PUBKY_RUNTIME_PULSE_CLIENT_KEY` / `NEXT_PUBLIC_PULSE_CLIENT_KEY` | browser | Optional. Empty/unset disables Pulse entirely.            |
| `PUBKY_RUNTIME_TESTNET` / `NEXT_PUBLIC_TESTNET`                   | all     | When `true`, Pulse is disabled (CI E2E / testnet deploy). |

Both entries stay **commented out** in `.env.example`; a local `npm run dev` or Cypress run must
never emit real events. The client key is public and write-only, but it is still a key: never
commit a real value.

`shouldEnablePulse()` in `src/libs/observability/pulse.ts` is the single gate. It returns false
under `NODE_ENV=test`, under `VITEST`, on testnet, when no key is configured, and when the key
does not start with `pulse_client_`. That prefix check is a **soft gate** on purpose: the runtime
config schema deliberately does not validate the key's format, because
`runtimeConfigValueSchema.parse()` backs every consumer of `window.__PUBKY_CONFIG__` and a throw
there would turn an analytics typo into an app-wide boot failure.

## Where init happens (do not move it)

`initPulse()` is called from `src/components/atoms/PulseInit/PulseInit.tsx` — a `'use client'`
component that renders `null` and is mounted once in `src/app/layout.tsx`, so it runs on every
route. Page views are the denominator for the graph funnels, so this must never become
graph-page-only.

The same component reports those page views. The SDK's own `trackPageViews` is **off**: it sends
`location.pathname` verbatim on every History API navigation, and this app's routes carry
identifiers (`/profile/{pubky}`, `/post/{author}/{postId}`, `/collections/{userId}/{postId}`,
`/feed/{id}`, `/invite/{inviteCode}`). Instead `PulseInit` tracks `usePathname()` and reports it
through `pulseScreen()` with every dynamic segment replaced — see §Privacy.

**It cannot live in `src/instrumentation-client.ts`.** `next/dist/client/app-next.js` requires that
module at its own top level, _before_ it calls `appBootstrap()` — and `appBootstrap` is what runs
`loadScriptsInSequence(self.__next_s, …)`, the queue that executes ContainerRoot's
`next/script strategy="beforeInteractive"` tag and assigns `window.__PUBKY_CONFIG__`. Initializing
there means `shouldEnablePulse()` cannot resolve the runtime config, its `catch` returns false, and
nothing is ever sent. A client component module is evaluated during hydration, which happens inside
`appBootstrap` after that queue has run, so the runtime config is reliably present.

`initPulse()` is therefore idempotent and retry-safe: a closed gate latches nothing (it may be
closed only because the config was not resolvable yet), while `Pulse.configure()` still runs at most
once per page — after it returns, or after it throws, later calls short-circuit.

## Containment rule

> Do **not** import `@synonymdev/pubky-pulse-web` outside `src/libs/observability/pulse.ts`.

- `src/libs/observability/pulse.ts` — the only caller of `Pulse.configure()` and the only module
  that touches the SDK surface. Every helper is a no-op until `configure()` has returned without
  throwing, and every SDK call is wrapped so a telemetry failure can never escape into the
  feature that emitted it.
- `src/libs/observability/pulse.graph.ts` — the graph taxonomy (event names, funnel steps, metric
  slugs) plus the `AppError` → `_http_*` bridge. It imports `pulse.ts`, never the SDK, and must
  stay safe to evaluate server-side (no `window` / `location` / `document`): Application-layer
  graph code imports it and that code also runs on the server.

Feature code imports the constants from `pulse.graph.ts`. Never inline an event-name string —
names are not normalized server-side, so a typo silently becomes its own event.

## Privacy

Pubky App is decentralized social, and a pubky is a network-wide public identifier.

- **Never call `Pulse.setUser()`.** There is no user identity in Pulse for this app.
- **Never put a pubky, tag label, post content, post id, or a prefixed node id
  (`user:<pubky>`, `post:<author>:<id>`, `tag:<label>`) into any attribute.**
- Attributes carry counts, kinds, durations and enums only. When an attribute would naturally be
  an id, send its kind instead (`kind: 'user'`) or a count.
- **Every path is redacted by route position, never by the shape of the value.**
  `redactPathSegments()` in `pulse.ts` is the single implementation: the caller says which
  vocabulary is legal at which segment index, and everything else becomes `*`. Shape is not a
  safe discriminator — `graphApi` runs ids through `encodeURIComponent` (so `post:<author>:<id>`
  arrives as `post%3A<author>%3A<id>` with no `:` to split on), and a tag label is arbitrary
  user-authored text that can look exactly like a route word.
- The `_http_url` attribute is derived, not copied: `pulse.graph.ts` reduces the endpoint to its
  path and keeps only the fixed `/v0/graph/{kind}` prefix, so
  `https://nexus.pubky.app/v0/graph/user/<pubky>?depth=1` is reported as `/v0/graph/user/*`,
  `/v0/graph/tag/<label>` as `/v0/graph/tag/*`, and `/v0/graph/path/<from>/<to>` as
  `/v0/graph/path/*/*`. Origin and query string are dropped (the origin can be a
  `_pubky.<pubky>` host). Any non-graph endpoint that reaches the bridge falls back to a bare
  pubky sweep. The endpoint is read from `context.endpoint` or `context.url` — `safeFetch` files
  it under the second on its network and abort paths.
- The screen name is derived the same way, against the static segments declared in
  `src/app/routes.ts`: a segment nobody declared is an id, so `/profile/<pubky>` is reported as
  `/profile/*`, `/collections/<userId>/<postId>` as `/collections/*/*`, and `/invite/<code>` as
  `/invite/*`. Over-redacting an undeclared static route costs fidelity; under-redacting ships an
  identifier.

This app is deliberately cookieless Plausible plus `sendDefaultPii: false` Sentry. Pulse must not
regress that.

## What is captured

All product events carry `surface: 'explorer' | 'feed'`.

| Event                     | Attributes                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `graph_opened`            | `entry` (`deeplink` \| `self` \| `anonymous`), `is_mobile`                                                             |
| `graph_loaded`            | `node_count`, `edge_count`, `duration_ms`, `is_empty`                                                                  |
| `graph_node_expanded`     | `source` (`double_click` \| `panel` \| `refresh` \| `search_pick` \| `tag_chip`), `kind`, `added_nodes`, `total_nodes` |
| `graph_path_traced`       | `hops`, `via` (`hover_card` \| `panel`)                                                                                |
| `graph_path_not_found`    | `via`, `reason` (`not_found` \| `empty`)                                                                               |
| `graph_search_pick`       | `kind` (`user` \| `tag`), `origin` (`header` \| `inline`)                                                              |
| `graph_recentered`        | `via` (`node_click` \| `self_button` \| `breadcrumb`)                                                                  |
| `graph_retry_clicked`     | —                                                                                                                      |
| `graph_stream_merge_more` | `total_nodes`                                                                                                          |
| `graph_node_inspected`    | `kind`                                                                                                                 |
| `graph_control_used`      | `control` (the `data-cy` suffix verbatim), `state` (`on` \| `off`)                                                     |
| `graph_layout_selected`   | —                                                                                                                      |
| `graph_auto_decluttered`  | `edge_count` — **warn level**                                                                                          |

`graph_control_used` is one event with an attribute breakdown, not one event per control:
`zoom-in`, `zoom-out`, `fullscreen`, `time-toggle`, `declutter`, `communities`, `edge-details`,
`tag-hubs`, `physics`, `fit`, `release-pins`, `path-exit`, and `legend-<class>` for legend rows.
That list is exhaustive — it is every `recordControl(...)` call site.

### Funnel `graph-explore`

`graph-explore-opened` → `graph-explore-loaded` → `graph-explore-interacted` →
`graph-explore-traced`. Each step fires **at most once per mount**, behind a `useRef` flag —
React 19 StrictMode double-invokes effects in dev, and a re-fired `interacted` blurs the drop-off
that is the only question the funnel answers.

### Metrics

| Slug                      | Wraps                    | Terminal calls                                                    |
| ------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `graph-neighborhood-load` | `useSocialGraph.load`    | `complete({ node_count, edge_count })` / `fail(err)` / `cancel()` |
| `graph-node-expand`       | `useGraphCore.doExpand`  | `complete(...)` / `fail(err)` / `cancel()`                        |
| `graph-path-trace`        | `useGraphCore.tracePath` | `complete({ found, hops })` / `fail(err)` / `cancel()`            |

Start the operation _after_ the pre-fetch guards, and `cancel()` (emitting no event) on the
post-await stale-nonce return, so superseded work stays out of the success rate.

### Failures

`pulseGraphError(err, name, attrs)` — error level — and `pulseGraphWarn(err, name, attrs)` — warn
level, for degradations that leave a usable graph — both merge the `AppError` breakdown
(`_http_url`, `_http_status`, `_http_method`, `error_category`, `error_code`, `error_operation`)
into the caller's attributes. `_http_status` is omitted when the request never got a response,
which is itself the signal that it was a network failure.

For a thrown value that is **not** an `AppError`, `pulseGraphError` keeps its identity for free
(the SDK receives the value itself). `pulseGraphWarn` takes only a name and attributes, so it
sends `error_type` plus, for an `Error`, `error_message` — swept for bare pubkys, because a
thrown message can quote a URL.

`_`-prefixed attribute keys are SDK-reserved; those three `_http_*` are the supported ones. Do not
invent new `_` keys — use plain names such as `error_category`.

Add a Pulse call **alongside** the existing `Logger.*` / `Err.*` handling at a catch site, never
as a second log line and never in place of the user-facing handling. `Err.*` factories already log
and route to Sentry.

## Never instrument

These produce noise, not signal, and are deliberately left silent:

- Any hover handler — `handleUserHover`, `onNodeHover`, `handleLinkHover`, `onHoverClass`,
  `onHoverEdges`, `onProofHover`. They fire per pointer transit.
- `onNodeDragEnd` — per drag, not an outcome. The `release-pins` control already proves pinning
  is used.
- `onZoom` — per wheel tick / camera frame.
- `GraphTimeMachine.onCapChange` — per slider frame _and_ per playback tick.
- The tag-edge popover click — its follow-up already lands as `graph_node_expanded` with
  `source: 'tag_chip'`.
- Background click / `select(null)` / `clearPath` dismissals.
- The `states.tooManyNodes` prune toast — `mergeNeighborhood` can fire it repeatedly within one
  merge sequence.
- The `.catch(() => null)` / `.catch(() => [])` per-post fallbacks in the `useStreamGraph` gather
  loop — deliberate fallbacks, not failures.

## Guardrails

- Every Pulse call is `void`, additive, and sits inside an existing branch. Nothing is awaited. No
  toast text, `data-cy` attribute, control flow or timing changes because of telemetry.
- `AGENTS.md` forbids new `useCallback` / `useMemo` (React Compiler). Use `useRef` for fired-once
  guards — a ref is not a memo hook.
- `Pulse.configure()` throws on invalid values. `initPulse()` catches that into `Logger.warn`
  (never an `Err.*` factory — those file Sentry issues, and a telemetry misconfiguration must not)
  and leaves the module permanently inert.
- Feature tests need no `vi.mock`: the gate is false under `VITEST` and `NODE_ENV=test`. The
  attribute builders are therefore never reached by an ordinary suite, which is how a redaction
  bug can ship green — `pulse.test.ts` mocks the SDK and drives `initPulse()` to a configured
  state so it can assert on what the SDK actually received.

## Files

- `src/components/atoms/PulseInit/PulseInit.tsx` — the single `initPulse()` call, mounted in
  `src/app/layout.tsx`, plus app-wide screen tracking (`toSafeScreenName`)
- `src/libs/observability/pulse.ts` — gate, init, the wrapped helper surface, and the shared
  `redactPathSegments()`
- `src/libs/observability/pulse.graph.ts` — graph taxonomy + `AppError` bridge
- `src/libs/observability/pulse.test.ts` — gate and attribute-privacy coverage
- `src/libs/runtime-config/runtime-config.schema.ts` — the `pulseClientKey` field and its two env
  name maps
