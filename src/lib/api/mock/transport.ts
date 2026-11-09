import { apiErrorFrom, ConfirmCancelledError, ConfirmKeyInvalidatedError } from '../errors';
import type { LocalConfirmGate, Transport, TransportHooks } from '../transport';
import { createMockFacade, DEMO_SESSION_ID, type MockFacade } from './facade';

const LATENCY_MS = 250;

/**
 * The demo host's transport: facade calls answered by the in-memory facade, with a little
 * latency. The demo PC behaves as if this phone held a biometric confirm key: sensitive actions
 * show the OS prompt (the simulated key unlock), and are unavailable while the pairing is
 * flagged as needing re-confirmation, exactly like a real one (SPEC §15.1).
 */
export function createMockTransport(
  localGate: LocalConfirmGate,
  hooks: TransportHooks & { keyInvalid?: () => boolean } = {},
  facade: MockFacade = createMockFacade(),
): Transport {
  return {
    async request<T>({ method, path, body, confirm }: Parameters<Transport['request']>[0]): Promise<T> {
      if (confirm && hooks.keyInvalid?.()) throw new ConfirmKeyInvalidatedError();
      if (confirm && !(await localGate(confirm))) throw new ConfirmCancelledError('cancel', confirm);
      // The change feed waits on its own; everything else gets network-ish latency.
      if (!path.startsWith('/v1/changes')) await new Promise((r) => setTimeout(r, LATENCY_MS));
      const res = await facade.handle({ method, path, body });
      if (res.status < 200 || res.status >= 300) throw apiErrorFrom(res.status, res.body);
      return res.body as T;
    },
    sessionId: async () => DEMO_SESSION_ID,
  };
}
