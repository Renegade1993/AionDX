import { getRandomValues } from 'expo-crypto';

// @noble/* reads randomness from globalThis.crypto.getRandomValues. Hermes may not
// provide it, so back it with the platform CSPRNG via expo-crypto.
const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues };
}
