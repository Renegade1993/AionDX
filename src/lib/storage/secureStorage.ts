import * as SecureStore from 'expo-secure-store';

/**
 * Keystore-backed string storage (iOS Keychain / Android Keystore). Entries are
 * never synced to backups and are readable only while the device is unlocked.
 * The web build swaps in secureStorage.web.ts.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface SecureItemOptions {
  /**
   * Gate reads behind biometrics (iOS biometryCurrentSet / Android user-auth-bound key).
   * Changing enrolled biometrics makes the item unreadable. Not available in Expo Go.
   */
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
}

const withOptions = (opts?: SecureItemOptions): SecureStore.SecureStoreOptions => ({ ...OPTIONS, ...opts });

export const secureStorage = {
  get: (key: string, opts?: SecureItemOptions) => SecureStore.getItemAsync(key, withOptions(opts)),
  set: (key: string, value: string, opts?: SecureItemOptions) => SecureStore.setItemAsync(key, value, withOptions(opts)),
  remove: (key: string, opts?: SecureItemOptions) => SecureStore.deleteItemAsync(key, withOptions(opts)),
};
