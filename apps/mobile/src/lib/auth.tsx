import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import type { PublicUser } from "@notkocu/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, setAuthLostHandler } from "./api";
import { queryClient } from "./queryClient";
import { tokenStore } from "./tokenStore";

type Status = "loading" | "signedOut" | "signedIn";

interface AuthValue {
  status: Status;
  user: PublicUser | null;
  /** Resolves with a Turkish error message, or null on success/cancel. */
  signIn: () => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<PublicUser | null>(null);

  const reset = useCallback(() => {
    queryClient.clear();
    setUser(null);
    setStatus("signedOut");
  }, []);

  useEffect(() => {
    GoogleSignin.configure({ webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID });
    setAuthLostHandler(reset);
    let cancelled = false;
    (async () => {
      await tokenStore.hydrate();
      if (!tokenStore.getRefresh()) return cancelled || setStatus("signedOut");
      try {
        const { user: fresh } = await api.me();
        await tokenStore.setUser(fresh);
        if (!cancelled) {
          setUser(fresh);
          setStatus("signedIn");
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return; // auth-lost handler already ran
        // Offline / server down: open with the last known user.
        setUser(await tokenStore.getUser());
        setStatus("signedIn");
      }
    })();
    return () => {
      cancelled = true;
      setAuthLostHandler(null);
    };
  }, [reset]);

  const signIn = useCallback(async () => {
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const result = await GoogleSignin.signIn();
      if (!isSuccessResponse(result) || !result.data.idToken) return null; // cancelled
      const data = await api.loginWithGoogle(result.data.idToken);
      await tokenStore.set(data);
      await tokenStore.setUser(data.user);
      setUser(data.user);
      setStatus("signedIn");
      return null;
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown } | null;
      const debug = `[${String(e?.code ?? "no-code")}] ${String(e?.message ?? err)}`;
      if (__DEV__) console.error("Google sign-in failed:", debug);
      const withDebug = (msg: string) => (__DEV__ ? `${msg}\n${debug}` : msg);
      if (isErrorWithCode(err)) {
        if (err.code === statusCodes.SIGN_IN_CANCELLED || err.code === statusCodes.IN_PROGRESS) return null;
        if (err.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
          return withDebug("Google Play Hizmetleri bulunamadı ya da güncel değil.");
        }
        return withDebug("Google ile giriş yapılamadı. Tekrar dene.");
      }
      if (err instanceof ApiError) {
        return withDebug(err.status === 401 ? "Google hesabı doğrulanamadı." : err.message);
      }
      return withDebug("Giriş yapılamadı. Tekrar dene.");
    }
  }, []);

  const signOut = useCallback(async () => {
    const refreshToken = tokenStore.getRefresh();
    // Best effort: local sign-out must succeed even if the server is unreachable.
    if (refreshToken) await api.logout(refreshToken).catch(() => {});
    await GoogleSignin.signOut().catch(() => {});
    await tokenStore.clear();
    reset();
  }, [reset]);

  const value = useMemo(() => ({ status, user, signIn, signOut }), [status, user, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
