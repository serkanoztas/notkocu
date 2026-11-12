import type { PublicUser } from "@notkocu/shared";
import * as SecureStore from "expo-secure-store";

const ACCESS = "auth.accessToken";
const REFRESH = "auth.refreshToken";
const USER = "auth.user";

let access: string | null = null;
let refresh: string | null = null;
let hydrated = false;

export const tokenStore = {
  /** Loads tokens from secure storage once; later reads use the in-memory copy. */
  async hydrate() {
    if (hydrated) return;
    [access, refresh] = await Promise.all([
      SecureStore.getItemAsync(ACCESS),
      SecureStore.getItemAsync(REFRESH),
    ]);
    hydrated = true;
  },
  getAccess: () => access,
  getRefresh: () => refresh,
  async set(tokens: { accessToken: string; refreshToken: string }) {
    access = tokens.accessToken;
    refresh = tokens.refreshToken;
    hydrated = true;
    await Promise.all([
      SecureStore.setItemAsync(ACCESS, tokens.accessToken),
      SecureStore.setItemAsync(REFRESH, tokens.refreshToken),
    ]);
  },
  async clear() {
    access = null;
    refresh = null;
    hydrated = true;
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS),
      SecureStore.deleteItemAsync(REFRESH),
      SecureStore.deleteItemAsync(USER),
    ]);
  },
  /** Last known user, so the app can open offline. */
  async getUser(): Promise<PublicUser | null> {
    try {
      const raw = await SecureStore.getItemAsync(USER);
      return raw ? (JSON.parse(raw) as PublicUser) : null;
    } catch {
      return null;
    }
  },
  setUser: (user: PublicUser) => SecureStore.setItemAsync(USER, JSON.stringify(user)),
};
