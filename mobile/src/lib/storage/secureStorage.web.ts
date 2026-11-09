/**
 * WEB PREVIEW ONLY — NOT SECURE. Browsers have no keystore, so values live in
 * localStorage. The web build exists to preview layouts with demo data; it must
 * never be used to pair with a real PC.
 */
const PREFIX = 'aiondx-preview:';

export const secureStorage = {
  get: async (key: string) => localStorage.getItem(PREFIX + key),
  set: async (key: string, value: string) => localStorage.setItem(PREFIX + key, value),
  remove: async (key: string) => localStorage.removeItem(PREFIX + key),
};
