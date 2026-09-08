import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode, NetworkErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { HttpStatusCode } from '@/libs/http/http.types';
import { RUNTIME_CONFIG_WINDOW_KEY } from '@/libs/runtime-config/runtime-config';
import { NETWORK_RUNTIME_DEFAULTS } from '@/libs/runtime-config/runtime-config.schema';
import { pulseEvent, pulseOperation, shouldEnablePulse } from './pulse';
import { pulseGraphError } from './pulse.graph';

const TEST_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';

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
  /**
   * Import a fresh ./pulse with the SDK mocked (so `Pulse.configure()` calls are observable and
   * no real SDK boots) and Env mocked to a deployed shape.
   *
   * `NODE_ENV` / `VITEST` are stubbed on `process.env` too: runtime-config reads those directly,
   * and only in "required" mode does a missing `window.__PUBKY_CONFIG__` throw instead of quietly
   * falling back to `NEXT_PUBLIC_*` — the throw is exactly the browser condition under test.
   */
  async function withMockedSdk(
    configure: () => void,
    run: (mod: typeof import('./pulse')) => void | Promise<void>,
  ): Promise<void> {
    vi.resetModules();
    vi.doMock('@synonymdev/pubky-pulse-web', () => ({ Pulse: { configure } }));
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
      const mod = await import('./pulse');
      await run(mod);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock('@/libs/logger/logger');
      vi.doUnmock('@/libs/env/env');
      vi.doUnmock('@synonymdev/pubky-pulse-web');
      vi.resetModules();
    }
  }

  it('stays initializable after a call made before window.__PUBKY_CONFIG__ was injected', async () => {
    const configure = vi.fn();

    await withMockedSdk(configure, ({ initPulse, isPulseActive }) => {
      // The runtime config is published by a beforeInteractive script that has not run yet, so
      // the gate cannot resolve it. That must not latch "disabled" for the life of the page.
      initPulse();
      expect(configure).not.toHaveBeenCalled();
      expect(isPulseActive()).toBe(false);

      const removeRuntimeConfig = injectRuntimeConfig();
      try {
        initPulse();
        expect(configure).toHaveBeenCalledTimes(1);
        expect(isPulseActive()).toBe(true);

        // Idempotent: a remount or a StrictMode double-invoke reconfigures nothing.
        initPulse();
        expect(configure).toHaveBeenCalledTimes(1);
      } finally {
        removeRuntimeConfig();
      }
    });
  });

  it('never retries Pulse.configure() once it has thrown', async () => {
    const configure = vi.fn(() => {
      throw new Error('invalid Pulse configuration');
    });

    await withMockedSdk(configure, ({ initPulse, isPulseActive }) => {
      const removeRuntimeConfig = injectRuntimeConfig();
      try {
        expect(() => initPulse()).not.toThrow();
        expect(() => initPulse()).not.toThrow();

        expect(configure).toHaveBeenCalledTimes(1);
        expect(isPulseActive()).toBe(false);
      } finally {
        removeRuntimeConfig();
      }
    });
  });
});

describe('pulseGraphError attributes', () => {
  /**
   * The bridge only builds attributes; capture is a no-op under Vitest because Pulse is
   * disabled, so assert the built payload through a mocked capture funnel instead.
   *
   * `makeError` receives the freshly imported `AppError` class: `vi.resetModules()` gives
   * `pulse.graph` its own module graph, and the bridge's `instanceof` check only recognises
   * errors built from THAT class.
   */
  async function captureGraphError(
    makeError: (ctor: typeof AppError) => unknown,
    attrs?: Record<string, string>,
  ): Promise<Record<string, string> | undefined> {
    const pulseCaptureError = vi.fn();
    vi.resetModules();
    vi.doMock('@/libs/observability/pulse', () => ({ pulseCaptureError, pulseWarn: vi.fn() }));

    try {
      const { AppError: FreshAppError } = await import('@/libs/error/error');
      const { pulseGraphError: bridge } = await import('./pulse.graph');
      bridge(makeError(FreshAppError), 'graph_load_failed', attrs);
      return pulseCaptureError.mock.calls[0]?.[2];
    } finally {
      vi.doUnmock('@/libs/observability/pulse');
      vi.resetModules();
    }
  }

  it('maps an AppError onto the supported _http_* keys and the error breakdown', async () => {
    const attributes = await captureGraphError(
      (Ctor) =>
        new Ctor({
          category: ErrorCategory.Client,
          code: ClientErrorCode.NOT_FOUND,
          message: 'Not Found',
          service: ErrorService.Nexus,
          operation: 'fetchNexus',
          context: {
            endpoint: `https://nexus.pubky.app/v0/graph/user/user:${TEST_PUBKY}?depth=1`,
            statusCode: HttpStatusCode.NOT_FOUND,
          },
        }),
      { surface: 'explorer' },
    );

    expect(attributes).toEqual({
      _http_url: '/v0/graph/user/user:*',
      _http_method: 'GET',
      _http_status: String(HttpStatusCode.NOT_FOUND),
      error_category: ErrorCategory.Client,
      error_code: ClientErrorCode.NOT_FOUND,
      error_operation: 'fetchNexus',
      surface: 'explorer',
    });
  });

  it('never leaks a pubky, post id or tag label through the endpoint', async () => {
    const attributes = await captureGraphError(
      (Ctor) =>
        new Ctor({
          category: ErrorCategory.Client,
          code: ClientErrorCode.NOT_FOUND,
          message: 'Not Found',
          service: ErrorService.Nexus,
          operation: 'fetchNexus',
          context: { endpoint: `https://_pubky.${TEST_PUBKY}/v0/graph/post/post:${TEST_PUBKY}:003544WKXXGQG` },
        }),
    );

    expect(attributes?._http_url).toBe('/v0/graph/post/post:*');
    expect(JSON.stringify(attributes)).not.toContain(TEST_PUBKY);
    expect(JSON.stringify(attributes)).not.toContain('003544WKXXGQG');
  });

  it('omits _http_status when the request never got a response', async () => {
    const attributes = await captureGraphError(
      (Ctor) =>
        new Ctor({
          category: ErrorCategory.Network,
          code: NetworkErrorCode.CONNECTION_FAILED,
          message: 'Failed to fetch',
          service: ErrorService.Nexus,
          operation: 'fetchNexus',
          context: { endpoint: 'https://nexus.pubky.app/v0/graph/path/user:a/user:b' },
        }),
    );

    expect(attributes).not.toHaveProperty('_http_status');
    expect(attributes?._http_url).toBe('/v0/graph/path/user:*/user:*');
  });

  it('passes plain errors through with only the caller attributes', async () => {
    const attributes = await captureGraphError(() => new Error('boom'), { surface: 'feed' });

    expect(attributes).toEqual({ surface: 'feed' });
  });
});
