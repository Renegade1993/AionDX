import { fromB64u, toB64u } from '../encoding';

/** WEB PREVIEW ONLY — localStorage stand-in for the native file store (contents are still encrypted). */
const PREFIX = 'aiondx-preview-blob:';

export const blobStore = {
  read: async (name: string) => {
    const v = localStorage.getItem(PREFIX + name);
    return v === null ? null : fromB64u(v);
  },
  write: async (name: string, bytes: Uint8Array) => localStorage.setItem(PREFIX + name, toB64u(bytes)),
  remove: async (name: string) => localStorage.removeItem(PREFIX + name),
};
