export class TransportError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface JsonResponse {
  status: number;
  json: unknown;
  baseUrl: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
/**
 * How long a base URL gets to answer the reachability probe. Separate from `timeoutMs`, which
 * covers the request itself and is long for long-polls (pair 30 s, changes 35 s).
 */
export const CONNECT_TIMEOUT_MS = 2500;
/** A URL that answered this recently is used without probing it first. */
const REACHED_FRESH_MS = 15_000;
/** §4.1: unauthenticated and immediate, so it only measures reachability. */
const HELLO_PATH = '/api/mobile/v1/hello';

const lastReached = new Map<string, number>();

/** Forgets which URLs answered recently (tests). */
export function resetReachability(): void {
  lastReached.clear();
}

/**
 * Can this base URL be reached at all? Any HTTP answer counts (an older bridge without /hello says
 * 404). Only a failed or slow connection is "no".
 */
async function reachable(baseUrl: string, connectTimeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (Date.now() - (lastReached.get(baseUrl) ?? 0) < REACHED_FRESH_MS) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    await fetch(joinUrl(baseUrl, HELLO_PATH), { method: 'GET', signal: controller.signal });
    lastReached.set(baseUrl, Date.now());
    return true;
  } catch (err) {
    if (signal?.aborted) throw err;
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** `http://[fe80::…]` (fe80::/10): its zone id means nothing to the phone, so it's never usable. */
const LINK_LOCAL_V6 = /^https?:\/\/\[fe[89ab][0-9a-f]?:/i;

/**
 * A base URL the phone can try (contract §7, rev 4.4): http(s) only, IPv6 ULA allowed in brackets
 * (`http://[fd12::1]:47734`), link-local IPv6 skipped if one ever appears.
 */
export function isUsableBaseUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && !LINK_LOCAL_V6.test(url);
}

/** Joins without a URL parser, so bracketed IPv6 hosts don't depend on the platform's URL polyfill. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * POSTs JSON to the first reachable base URL, in the given order. The QR may list several (Wi-Fi,
 * IPv6 ULA, a VPN address), so a URL that doesn't connect within `connectTimeoutMs` is skipped
 * rather than stalling the whole `timeoutMs`. HTTP error statuses are returned, not thrown — only
 * network failures fall through.
 */
export async function postJson(
  baseUrls: string[],
  path: string,
  body: unknown,
  { timeoutMs = DEFAULT_TIMEOUT_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS, signal }: { timeoutMs?: number; connectTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JsonResponse> {
  let lastError: unknown;
  for (const baseUrl of baseUrls.filter(isUsableBaseUrl)) {
    if (!(await reachable(baseUrl, connectTimeoutMs, signal))) {
      lastError = new Error(`No answer from ${baseUrl} within ${connectTimeoutMs} ms`);
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(joinUrl(baseUrl, path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json: unknown = await res.json().catch(() => null);
      lastReached.set(baseUrl, Date.now());
      return { status: res.status, json, baseUrl };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastReached.delete(baseUrl);
      lastError = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new TransportError('Could not reach your PC. Check that AionDX is running and you are on the same network.', lastError);
}
