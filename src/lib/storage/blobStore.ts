import { Directory, File, Paths } from 'expo-file-system';

/** Small binary files in the app's document directory. The web build swaps in blobStore.web.ts. */
const dir = () => new Directory(Paths.document, 'aiondx-cache');
const file = (name: string) => new File(dir(), name);

export const blobStore = {
  async read(name: string): Promise<Uint8Array | null> {
    const f = file(name);
    return f.exists ? f.bytes() : null;
  },
  async write(name: string, bytes: Uint8Array): Promise<void> {
    dir().create({ intermediates: true, idempotent: true });
    const f = file(name);
    if (!f.exists) f.create();
    await f.write(bytes);
  },
  async remove(name: string): Promise<void> {
    const f = file(name);
    if (f.exists) f.delete();
  },
};
