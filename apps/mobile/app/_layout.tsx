import "../global.css";

import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from "@expo-google-fonts/inter";
import {
  SpaceGrotesk_500Medium,
  SpaceGrotesk_700Bold,
  useFonts,
} from "@expo-google-fonts/space-grotesk";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import Constants from "expo-constants";
import { ShareIntentProvider, useShareIntentContext } from "expo-share-intent";
import { Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useActiveSemester } from "../src/hooks/useActiveSemester";
import { AuthProvider, useAuth } from "../src/lib/auth";
import { CACHE_MAX_AGE_MS, queryClient } from "../src/lib/queryClient";
import { queryPersister } from "../src/lib/queryPersister";
import { RecordingBar } from "../src/components/RecordingBar";
import { OutboxProvider } from "../src/lib/OutboxProvider";
import { RecordingProvider } from "../src/lib/RecordingProvider";
import { ScheduleDraftProvider, useScheduleDraft } from "../src/lib/scheduleDraft";

SplashScreen.preventAutoHideAsync();

// A new app version drops the old cache (shapes may have changed). Only successful, non-debug queries are saved.
const persistOptions = {
  persister: queryPersister,
  maxAge: CACHE_MAX_AGE_MS,
  buster: Constants.expoConfig?.version ?? "0",
  dehydrateOptions: {
    shouldDehydrateQuery: (q: { state: { status: string }; queryKey: readonly unknown[] }) =>
      q.state.status === "success" && q.queryKey[0] !== "health",
  },
};

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });

  const fontsReady = loaded || !!error;

  if (!fontsReady) return null;

  return (
    <SafeAreaProvider>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <AuthProvider>
          <OutboxProvider>
            <RecordingProvider>
              <ScheduleDraftProvider>
                <ShareIntentProvider>
                  <StatusBar style="dark" />
                  <RootStack />
                  <RecordingBar />
                </ShareIntentProvider>
              </ScheduleDraftProvider>
            </RecordingProvider>
          </OutboxProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}

function RootStack() {
  const { status } = useAuth();
  const signedIn = status === "signedIn";
  const semester = useActiveSemester(signedIn);
  const { replacing } = useScheduleDraft();
  const router = useRouter();
  const pathname = usePathname();
  const { hasShareIntent } = useShareIntentContext();

  // Onboarding only when the request succeeded and there is no active semester.
  // Network errors / 5xx keep the tabs open (the Today screen offers a retry).
  const needsOnboarding = semester.isSuccess && semester.data.semester === null;
  const settled = status !== "loading" && (!signedIn || !semester.isPending);

  // Latch "settled" per auth state. A refetch after an error flips a data-less query back to
  // `pending`; without the latch the navigator would unmount/remount and its guards would change
  // repeatedly ("REMOVE_ROUTES was not handled by any navigator"). It resets only when signedIn
  // itself changes (login/logout), where holding the splash until the semester is known is right.
  const booted = useRef<{ signedIn: boolean } | null>(null);
  if (settled) booted.current = { signedIn };
  const ready = booted.current !== null && booted.current.signedIn === signedIn;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  // "Paylaş → NotKoçu": once signed in with a semester, open Quick capture with the shared content.
  // The intent stays in the provider until the screen is done with it (saved or closed), so a share that
  // arrives during sign-in or onboarding is not lost. A share that arrives while capture is open is
  // picked up by the screen itself.
  const canCapture = ready && signedIn && !needsOnboarding && !replacing;
  useEffect(() => {
    if (hasShareIntent && canCapture && pathname !== "/capture") router.push("/capture");
  }, [hasShareIntent, canCapture, pathname, router]);

  if (!ready) return null;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#F6F6F3" } }}>
      <Stack.Protected guard={signedIn && !needsOnboarding}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="capture" options={{ presentation: "modal" }} />
        <Stack.Screen name="course/[id]" />
        <Stack.Screen name="course/[id]/week/[no]" />
        <Stack.Screen name="note/[id]" />
      </Stack.Protected>
      {/* First-time setup, or replace mode opened from Settings while a semester is active. */}
      <Stack.Protected guard={signedIn && (needsOnboarding || replacing)}>
        <Stack.Screen name="onboarding/schedule" />
        <Stack.Screen name="onboarding/confirm" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}
