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
 * POSTs JSON to the first reachable base URL. The bridge may advertise several
 * (LAN IPs, hostname, relay), so a failed connection falls through to the next.
 * HTTP error statuses are returned, not thrown — only network failures fall through.
 */
export async function postJson(
  baseUrls: string[],
  path: string,
  body: unknown,
  { timeoutMs = DEFAULT_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JsonResponse> {
  let lastError: unknown;
  for (const baseUrl of baseUrls.filter(isUsableBaseUrl)) {
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
      return { status: res.status, json, baseUrl };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new TransportError('Could not reach your PC. Check that AionDX is running and you are on the same network.', lastError);
}
