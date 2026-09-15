import { gunzipSync } from 'node:zlib';
import { Pulse } from '@synonymdev/pubky-pulse-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beforeSendPulse, initializePulseConsent, initPulse } from './pulse';
import { getPulseConsent, PULSE_CONSENT_KEY, setPulseConsent } from './pulse-consent';

const config = vi.hoisted(() => ({ key: 'pulse_client_test' as string | undefined }));
vi.mock('@/libs/env/env', () => ({ Env: { NODE_ENV: 'production', NEXT_PUBLIC_APP_VERSION: 'test' } }));
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getPulseClientKey: () => config.key,
  getPulseEndpoint: () => 'http://localhost:4007/pulse',
  getDeployEnv: () => 'staging',
}));

let unsubscribe: (() => void) | undefined;
const requests = vi.fn<typeof fetch>();

beforeEach(() => {
  config.key = 'pulse_client_test';
  localStorage.clear();
  sessionStorage.clear();
  // Reset the in-memory refusal fallback using the public choice API.
  setPulseConsent(true);
  localStorage.removeItem(PULSE_CONSENT_KEY);
  requests.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', requests);
});
afterEach(() => {
  unsubscribe?.();
  Pulse.init({ enabled: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('consent gate with the real Pulse SDK', () => {
  it.each([null, 'declined', 'invalid'])(
    'does not initialize, write an ID or send before acceptance (%s)',
    async (choice) => {
      if (choice !== null) localStorage.setItem(PULSE_CONSENT_KEY, choice);
      const init = vi.spyOn(Pulse, 'init');
      unsubscribe = initializePulseConsent();
      initPulse();
      Pulse.captureException(new Error('Before consent'));
      await Pulse.flush();
      expect(init).not.toHaveBeenCalled();
      expect(localStorage.getItem('pulse.anonymous_id')).toBeNull();
      expect(sessionStorage.length).toBe(0);
      expect(requests).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', '   '])(
    'never starts with an absent/blank key, even with saved consent (%s)',
    async (key) => {
      config.key = key;
      localStorage.setItem(PULSE_CONSENT_KEY, 'accepted');
      unsubscribe = initializePulseConsent();
      await Pulse.flush();
      expect(getPulseConsent()).toBe('unavailable');
      expect(localStorage.getItem('pulse.anonymous_id')).toBeNull();
      expect(requests).not.toHaveBeenCalled();
    },
  );

  it('starts only after acceptance and stops without flushing on withdrawal', async () => {
    unsubscribe = initializePulseConsent();
    setPulseConsent(true);
    expect(localStorage.getItem('pulse.anonymous_id')).toMatch(/^pulse_anon_/);
    Pulse.captureException(new Error('Consented error'));
    await Pulse.flush();
    expect(requests).toHaveBeenCalled();
    const body = requests.mock.calls[0][1]?.body;
    const payload = typeof body === 'string' ? body : gunzipSync(body as Uint8Array).toString();
    expect(payload).toContain('Consented error');
    requests.mockClear();
    Pulse.captureException(new Error('Pending before withdrawal'));
    setPulseConsent(false);
    Pulse.captureException(new Error('After withdrawal'));
    window.dispatchEvent(new Event('pagehide'));
    await Pulse.flush();
    expect(Pulse.currentUserId).toBeUndefined();
    expect(requests).not.toHaveBeenCalled();
    expect(localStorage.getItem(PULSE_CONSENT_KEY)).toBe('declined');
  });

  it('honors saved consent and a withdrawal from another tab', async () => {
    localStorage.setItem(PULSE_CONSENT_KEY, 'accepted');
    unsubscribe = initializePulseConsent();
    expect(Pulse.currentUserId).toMatch(/^pulse_anon_/);
    localStorage.setItem(PULSE_CONSENT_KEY, 'declined');
    window.dispatchEvent(new StorageEvent('storage', { key: PULSE_CONSENT_KEY }));
    await Pulse.flush();
    expect(Pulse.currentUserId).toBeUndefined();
    expect(requests).not.toHaveBeenCalled();
  });

  it('fails closed when storage cannot be read or a choice cannot be saved', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked');
    });
    unsubscribe = initializePulseConsent();
    expect(Pulse.currentUserId).toBeUndefined();
    read.mockRestore();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked');
    });
    expect(setPulseConsent(true)).toBe(false);
    expect(Pulse.currentUserId).toBeUndefined();
    expect(getPulseConsent()).toBe('declined');
  });

  it('drops events if consent changed before a storage event is delivered', () => {
    expect(beforeSendPulse({ message: 'Not consented' } as Parameters<typeof beforeSendPulse>[0], {})).toBeNull();
  });
});
