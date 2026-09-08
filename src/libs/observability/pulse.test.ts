import { describe, expect, it, vi } from 'vitest';
import { toSafeScreenName } from '@/atoms/PulseInit/PulseInit';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode, NetworkErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { HttpStatusCode } from '@/libs/http/http.types';
import { RUNTIME_CONFIG_WINDOW_KEY } from '@/libs/runtime-config/runtime-config';
import { NETWORK_RUNTIME_DEFAULTS } from '@/libs/runtime-config/runtime-config.schema';
import { graphApi } from '@/services/nexus/graph/graph.api';
import { pulseEvent, pulseOperation, shouldEnablePulse } from './pulse';
import { pulseGraphError } from './pulse.graph';

const TEST_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const TEST_OTHER_PUBKY = 'euwmq57zefw5ynnkhh37b3gcmhs7g3cptdbw1doaxj1pbmzp3wro';
const TEST_POST_ID = '003544WKXXGQG';
const TEST_TAG_LABEL = 'my-secret-tag';
const TEST_INVITE_CODE = 'X7Q2-NEVER-LOG-ME';

/**
 * Endpoints exactly as the client requests them.
 *
 * Built through the real `graphApi` builders rather than hand-written, because the leak the
 * redaction guards against lives in the difference: `kind` is its own path segment and the id
 * is `encodeURIComponent`-escaped, so `post:<author>:<id>` reaches the wire with no `:` in it.
 */
const GRAPH_ENDPOINTS = {
  user: graphApi.neighborhood({ kind: 'user', id: TEST_PUBKY, depth: 1 }),
  post: graphApi.neighborhood({ kind: 'post', id: `${TEST_PUBKY}:${TEST_POST_ID}` }),
  tag: graphApi.neighborhood({ kind: 'tag', id: TEST_TAG_LABEL }),
  path: graphApi.path({ from: TEST_PUBKY, to: TEST_OTHER_PUBKY }),
};

const TEST_CLIENT_KEY = 'pulse_client_abc123';

/**
 * Inject a window runtime config (the client-side source the Pulse gates read).
 * Returns a cleanup that removes the injection again.
 */
function injectRuntimeConfig(overrides: Record<string, unknown> = {}): () => void {
  window[RUNTIME_CONFIG_WINDOW_KEY] = {
    ...NETWORK_RUNTIME_DEFAULTS,
    testnet: false,
    pulseClientKey: TEST_CLIENT_KEY,
    ...overrides,
  };
  return () => {
    delete window[RUNTIME_CONFIG_WINDOW_KEY];
  };
}

/**
 * Import a fresh ./pulse with Env mocked to a deployed shape (NODE_ENV=production, not Vitest)
 * so the runtime-config gates are actually exercised instead of short-circuiting on the test
 * guards that keep Pulse off for every suite in this repo.
 */
async function withProdEnvPulse(run: (mod: typeof import('./pulse')) => void | Promise<void>): Promise<void> {
  vi.resetModules();
  vi.doMock('@/libs/env/env', () => ({
    Env: {
      NODE_ENV: 'production',
      VITEST: undefined,
      NEXT_PUBLIC_APP_VERSION: 'test',
    },
  }));

  try {
    const mod = await import('./pulse');
    await run(mod);
  } finally {
    vi.doUnmock('@/libs/env/env');
    vi.resetModules();
  }
}

/** The SDK surface `pulse.ts` calls, mocked so every emitted attribute is observable. */
type MockedPulseSdk = {
  configure: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  step: ReturnType<typeof vi.fn>;
  trackScreen: ReturnType<typeof vi.fn>;
  startOperation: ReturnType<typeof vi.fn>;
};

/** A fully stubbed SDK; `overrides` replaces the one method a test needs to drive itself. */
function mockSdk(overrides: Partial<MockedPulseSdk> = {}): MockedPulseSdk {
  return {
    configure: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    trackScreen: vi.fn(),
    startOperation: vi.fn(),
    ...overrides,
  };
}

/**
 * Import a fresh ./pulse with the SDK mocked (so `Pulse.configure()` calls are observable and
 * no real SDK boots) and Env mocked to a deployed shape.
 *
 * `NODE_ENV` / `VITEST` are stubbed on `process.env` too: runtime-config reads those directly,
 * and only in "required" mode does a missing `window.__PUBKY_CONFIG__` throw instead of quietly
 * falling back to `NEXT_PUBLIC_*` — the throw is exactly the browser condition under test.
 */
async function withMockedSdk(
  sdk: MockedPulseSdk,
  run: (mod: typeof import('./pulse')) => void | Promise<void>,
): Promise<void> {
  vi.resetModules();
  vi.doMock('@synonymdev/pubky-pulse-web', () => ({ Pulse: sdk }));
  vi.doMock('@/libs/env/env', () => ({
    Env: {
      NODE_ENV: 'production',
      VITEST: undefined,
      NEXT_PUBLIC_APP_VERSION: 'test',
    },
  }));
  vi.doMock('@/libs/logger/logger', () => ({ Logger: { warn: vi.fn() } }));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VITEST', '');

  try {
    await run(await import('./pulse'));
  } finally {
    vi.unstubAllEnvs();
    vi.doUnmock('@/libs/logger/logger');
    vi.doUnmock('@/libs/env/env');
    vi.doUnmock('@synonymdev/pubky-pulse-web');
    vi.resetModules();
  }
}

describe('shouldEnablePulse', () => {
  it('is disabled under Vitest even with a valid client key configured', () => {
    const removeRuntimeConfig = injectRuntimeConfig();
    try {
      expect(shouldEnablePulse()).toBe(false);
    } finally {
      removeRuntimeConfig();
    }
  });

  it('is disabled when no client key is configured', async () => {
    const removeRuntimeConfig = injectRuntimeConfig({ pulseClientKey: undefined });
    try {
      await withProdEnvPulse(({ shouldEnablePulse: gate }) => {
        expect(gate()).toBe(false);
      });
    } finally {
      removeRuntimeConfig();
    }
  });

  it('is disabled when the key lacks the pulse_client_ prefix (soft gate, never a throw)', async () => {
    const removeRuntimeConfig = injectRuntimeConfig({ pulseClientKey: 'sk_live_not_a_pulse_key' });
    try {
      await withProdEnvPulse(({ shouldEnablePulse: gate }) => {
        expect(() => gate()).not.toThrow();
        expect(gate()).toBe(false);
      });
    } finally {
      removeRuntimeConfig();
    }
  });

  it('is disabled when the runtime config sets testnet=true', async () => {
    const removeRuntimeConfig = injectRuntimeConfig({ testnet: true });
    try {
      await withProdEnvPulse(({ shouldEnablePulse: gate }) => {
        expect(gate()).toBe(false);
      });
    } finally {
      removeRuntimeConfig();
    }
  });

  it('returns false instead of throwing when the runtime config cannot be resolved', async () => {
    // Deployed/required mode with neither a window injection nor PUBKY_RUNTIME_* set: config
    // resolution throws, and a telemetry gate must swallow that rather than break boot.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', '');
    try {
      await withProdEnvPulse(({ shouldEnablePulse: gate }) => {
        expect(() => gate()).not.toThrow();
        expect(gate()).toBe(false);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is enabled with a prefixed client key on a non-testnet deploy', async () => {
    const removeRuntimeConfig = injectRuntimeConfig();
    try {
      await withProdEnvPulse(({ shouldEnablePulse: gate }) => {
        expect(gate()).toBe(true);
      });
    } finally {
      removeRuntimeConfig();
    }
  });
});

describe('helpers before initPulse()', () => {
  it('report Pulse as inactive', async () => {
    await withProdEnvPulse(({ isPulseActive }) => {
      expect(isPulseActive()).toBe(false);
    });
  });

  it('are safe no-ops', () => {
    expect(() => pulseEvent('graph_opened', { surface: 'explorer' })).not.toThrow();
    expect(() => pulseGraphError(new Error('boom'), 'graph_load_failed')).not.toThrow();
  });

  it('still hand back a usable operation handle so call sites need no enabled branch', () => {
    const operation = pulseOperation('graph-neighborhood-load');

    expect(() => operation.complete({ node_count: '3' })).not.toThrow();
    expect(() => operation.fail(new Error('boom'))).not.toThrow();
    expect(() => operation.cancel()).not.toThrow();
  });

  it('never initializes the SDK when the gate is closed', async () => {
    const configure = vi.fn();
    vi.resetModules();
    vi.doMock('@synonymdev/pubky-pulse-web', () => ({ Pulse: { configure } }));

    try {
      const { initPulse, isPulseActive } = await import('./pulse');
      initPulse();

      expect(configure).not.toHaveBeenCalled();
      expect(isPulseActive()).toBe(false);
    } finally {
      vi.doUnmock('@synonymdev/pubky-pulse-web');
      vi.resetModules();
    }
  });
});

describe('initPulse', () => {
  it('stays initializable after a call made before window.__PUBKY_CONFIG__ was injected', async () => {
    const sdk = mockSdk();

    await withMockedSdk(sdk, ({ initPulse, isPulseActive }) => {
      // The runtime config is published by a beforeInteractive script that has not run yet, so
      // the gate cannot resolve it. That must not latch "disabled" for the life of the page.
      initPulse();
      expect(sdk.configure).not.toHaveBeenCalled();
      expect(isPulseActive()).toBe(false);

      const removeRuntimeConfig = injectRuntimeConfig();
      try {
        initPulse();
        expect(sdk.configure).toHaveBeenCalledTimes(1);
        expect(isPulseActive()).toBe(true);

        // Idempotent: a remount or a StrictMode double-invoke reconfigures nothing.
        initPulse();
        expect(sdk.configure).toHaveBeenCalledTimes(1);
      } finally {
        removeRuntimeConfig();
      }
    });
  });

  it('never retries Pulse.configure() once it has thrown', async () => {
    const sdk = mockSdk({
      configure: vi.fn(() => {
        throw new Error('invalid Pulse configuration');
      }),
    });

    await withMockedSdk(sdk, ({ initPulse, isPulseActive }) => {
      const removeRuntimeConfig = injectRuntimeConfig();
      try {
        expect(() => initPulse()).not.toThrow();
        expect(() => initPulse()).not.toThrow();

        expect(sdk.configure).toHaveBeenCalledTimes(1);
        expect(isPulseActive()).toBe(false);
      } finally {
        removeRuntimeConfig();
      }
    });
  });
});

type ConfiguredPulse = {
  sdk: MockedPulseSdk;
  pulse: typeof import('./pulse');
  graph: typeof import('./pulse.graph');
  /**
   * The freshly imported `AppError`. `vi.resetModules()` gives the bridge its own module
   * graph, and its `isAppError` check is an `instanceof` against THAT class.
   */
  AppError: typeof AppError;
};

/**
 * Drive Pulse all the way to a CONFIGURED state against a mocked SDK, then run assertions on
 * what the SDK actually received.
 *
 * Every other helper in this file stops at the disabled early return, which is precisely how a
 * redaction bug can ship green: the attribute builders are never reached. Here `initPulse()`
 * really runs, so `pulseGraphError` / `pulseGraphWarn` / `pulseScreen` emit for real.
 */
async function withConfiguredPulse(run: (ctx: ConfiguredPulse) => void | Promise<void>): Promise<void> {
  const sdk = mockSdk();
  const removeRuntimeConfig = injectRuntimeConfig();

  try {
    await withMockedSdk(sdk, async (pulse) => {
      pulse.initPulse();
      expect(pulse.isPulseActive()).toBe(true);

      const graph = await import('./pulse.graph');
      const { AppError: FreshAppError } = await import('@/libs/error/error');

      await run({ sdk, pulse, graph, AppError: FreshAppError });
    });
  } finally {
    removeRuntimeConfig();
  }
}

/** A 404 from nexus for `endpoint`, the shape `httpResponseToError` builds. */
function notFoundError(Ctor: typeof AppError, endpoint: string): AppError {
  return new Ctor({
    category: ErrorCategory.Client,
    code: ClientErrorCode.NOT_FOUND,
    message: 'Not Found',
    service: ErrorService.Nexus,
    operation: 'fetchNexus',
    context: { endpoint, statusCode: HttpStatusCode.NOT_FOUND },
  });
}

describe('configured pulseGraphError attributes', () => {
  it('configures the SDK with its own page-view tracking off', async () => {
    await withConfiguredPulse(({ sdk }) => {
      expect(sdk.configure).toHaveBeenCalledWith(expect.objectContaining({ trackPageViews: false }));
    });
  });

  it('maps an AppError onto the supported _http_* keys and the error breakdown', async () => {
    await withConfiguredPulse(({ sdk, graph, AppError: Ctor }) => {
      graph.pulseGraphError(notFoundError(Ctor, GRAPH_ENDPOINTS.user), graph.GRAPH_ERROR_EVENTS.LOAD_FAILED, {
        surface: 'explorer',
      });

      expect(sdk.error).toHaveBeenCalledTimes(1);
      const [, name, attributes] = sdk.error.mock.calls[0];
      expect(name).toBe('graph_load_failed');
      expect(attributes).toEqual({
        _http_url: '/v0/graph/user/*',
        _http_method: 'GET',
        _http_status: String(HttpStatusCode.NOT_FOUND),
        error_category: ErrorCategory.Client,
        error_code: ClientErrorCode.NOT_FOUND,
        error_operation: 'fetchNexus',
        surface: 'explorer',
      });
    });
  });

  it('redacts the id out of every route graphApi builds', async () => {
    await withConfiguredPulse(({ sdk, graph, AppError: Ctor }) => {
      graph.pulseGraphError(notFoundError(Ctor, GRAPH_ENDPOINTS.tag), graph.GRAPH_ERROR_EVENTS.ADD_TAG_FAILED);
      graph.pulseGraphError(notFoundError(Ctor, GRAPH_ENDPOINTS.post), graph.GRAPH_ERROR_EVENTS.EXPAND_FAILED);
      graph.pulseGraphError(notFoundError(Ctor, GRAPH_ENDPOINTS.path), graph.GRAPH_ERROR_EVENTS.PATH_FAILED);

      expect(sdk.error.mock.calls.map(([, , attributes]) => attributes._http_url)).toEqual([
        '/v0/graph/tag/*',
        '/v0/graph/post/*',
        '/v0/graph/path/*/*',
      ]);
    });
  });

  it('never leaks a tag label, post id or pubky through any emitted attribute', async () => {
    await withConfiguredPulse(({ sdk, graph, AppError: Ctor }) => {
      for (const endpoint of Object.values(GRAPH_ENDPOINTS)) {
        graph.pulseGraphError(notFoundError(Ctor, endpoint), graph.GRAPH_ERROR_EVENTS.LOAD_FAILED);
      }
      graph.pulseGraphWarn(notFoundError(Ctor, GRAPH_ENDPOINTS.tag), graph.GRAPH_ERROR_EVENTS.STREAM_RELS_FAILED, {});

      const emitted = JSON.stringify([
        ...sdk.error.mock.calls.map(([, , attributes]) => attributes),
        ...sdk.warn.mock.calls,
      ]);

      expect(emitted).not.toContain(TEST_PUBKY);
      expect(emitted).not.toContain(TEST_OTHER_PUBKY);
      expect(emitted).not.toContain(TEST_POST_ID);
      expect(emitted).not.toContain(TEST_TAG_LABEL);
    });
  });

  it('reads the endpoint from context.url when the request never reached the server', async () => {
    await withConfiguredPulse(({ sdk, graph, AppError: Ctor }) => {
      // `safeFetch` files the URL under `url`, not `endpoint`, on its network and abort paths.
      const error = new Ctor({
        category: ErrorCategory.Network,
        code: NetworkErrorCode.CONNECTION_FAILED,
        message: 'Failed to fetch',
        service: ErrorService.Nexus,
        operation: 'fetchNexus',
        context: { url: GRAPH_ENDPOINTS.path, offline: false },
      });
      graph.pulseGraphError(error, graph.GRAPH_ERROR_EVENTS.PATH_FAILED);

      const [, , attributes] = sdk.error.mock.calls[0];
      expect(attributes._http_url).toBe('/v0/graph/path/*/*');
      expect(attributes._http_method).toBe('GET');
      expect(attributes).not.toHaveProperty('_http_status');
    });
  });

  it('sweeps a bare pubky out of a non-graph endpoint', async () => {
    await withConfiguredPulse(({ sdk, graph, AppError: Ctor }) => {
      graph.pulseGraphError(
        notFoundError(Ctor, `https://nexus.pubky.app/v0/user/${TEST_PUBKY}/details`),
        graph.GRAPH_ERROR_EVENTS.SEED_VIEWER_FAILED,
      );

      const [, , attributes] = sdk.error.mock.calls[0];
      expect(attributes._http_url).toBe('/v0/user/*/details');
    });
  });

  it('passes plain errors through with only the caller attributes', async () => {
    await withConfiguredPulse(({ sdk, graph }) => {
      graph.pulseGraphError(new Error('boom'), graph.GRAPH_ERROR_EVENTS.INGEST_FAILED, { surface: 'feed' });

      const [thrown, , attributes] = sdk.error.mock.calls[0];
      expect(thrown).toBeInstanceOf(Error);
      expect(attributes).toEqual({ surface: 'feed' });
    });
  });
});

describe('configured pulseGraphWarn attributes', () => {
  it('keeps the AppError breakdown at warn level', async () => {
    await withConfiguredPulse(({ sdk, graph, AppError: Ctor }) => {
      graph.pulseGraphWarn(notFoundError(Ctor, GRAPH_ENDPOINTS.tag), graph.GRAPH_ERROR_EVENTS.STREAM_RELS_FAILED, {
        surface: 'feed',
      });

      expect(sdk.error).not.toHaveBeenCalled();
      expect(sdk.warn).toHaveBeenCalledWith('graph_stream_rels_failed', {
        _http_url: '/v0/graph/tag/*',
        _http_method: 'GET',
        _http_status: String(HttpStatusCode.NOT_FOUND),
        error_category: ErrorCategory.Client,
        error_code: ClientErrorCode.NOT_FOUND,
        error_operation: 'fetchNexus',
        surface: 'feed',
      });
    });
  });

  it('keeps the identity of a value that is not an AppError, with pubkys swept out', async () => {
    await withConfiguredPulse(({ sdk, graph }) => {
      graph.pulseGraphWarn(new TypeError(`no rels for ${TEST_PUBKY}`), graph.GRAPH_ERROR_EVENTS.STREAM_RELS_FAILED, {
        surface: 'feed',
      });
      graph.pulseGraphWarn('just a string', graph.GRAPH_ERROR_EVENTS.STREAM_SYNTHESIS_FAILED);

      expect(sdk.warn.mock.calls).toEqual([
        ['graph_stream_rels_failed', { error_type: 'TypeError', error_message: 'no rels for *', surface: 'feed' }],
        ['graph_stream_synthesis_failed', { error_type: 'string' }],
      ]);
    });
  });
});

describe('screen names', () => {
  it.each([
    ['/', '/'],
    ['/graph', '/graph'],
    ['/settings/notifications', '/settings/notifications'],
    ['/collections/bookmarks', '/collections/bookmarks'],
    [`/profile/${TEST_PUBKY}`, '/profile/*'],
    [`/profile/${TEST_PUBKY}/followers`, '/profile/*/followers'],
    [`/post/${TEST_PUBKY}/${TEST_POST_ID}`, '/post/*/*'],
    [`/collections/${TEST_PUBKY}/${TEST_POST_ID}`, '/collections/*/*'],
    [`/invite/${TEST_INVITE_CODE}`, '/invite/*'],
    ['/feed/9f3ab2', '/feed/*'],
  ])('reduces %s to the route shape %s', (pathname, expected) => {
    expect(toSafeScreenName(pathname)).toBe(expected);
  });

  it('reports the redacted route, never the raw pathname', async () => {
    await withConfiguredPulse(({ sdk, pulse }) => {
      pulse.pulseScreen(toSafeScreenName(`/profile/${TEST_PUBKY}`));
      pulse.pulseScreen(toSafeScreenName(`/invite/${TEST_INVITE_CODE}`));

      expect(sdk.trackScreen.mock.calls).toEqual([['/profile/*'], ['/invite/*']]);
      const emitted = JSON.stringify(sdk.trackScreen.mock.calls);
      expect(emitted).not.toContain(TEST_PUBKY);
      expect(emitted).not.toContain(TEST_INVITE_CODE);
    });
  });
});
