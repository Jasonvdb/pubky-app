'use client';

import { useState, useSyncExternalStore } from 'react';
import { getPulseConsent, setPulseConsent, subscribePulseConsent } from '@/libs/observability/pulse-consent';

export function usePulseConsent() {
  const consent = useSyncExternalStore(subscribePulseConsent, getPulseConsent, () => 'unavailable' as const);
  const [saveFailed, setSaveFailed] = useState(false);
  const choose = (accepted: boolean) => setSaveFailed(!setPulseConsent(accepted));
  return { consent, choose, saveFailed };
}
