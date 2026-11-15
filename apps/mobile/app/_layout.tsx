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
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useActiveSemester } from "../src/hooks/useActiveSemester";
import { AuthProvider, useAuth } from "../src/lib/auth";
import { queryClient } from "../src/lib/queryClient";
import { ScheduleDraftProvider, useScheduleDraft } from "../src/lib/scheduleDraft";

SplashScreen.preventAutoHideAsync();

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
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ScheduleDraftProvider>
            <StatusBar style="dark" />
            <RootStack />
          </ScheduleDraftProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function RootStack() {
  const { status } = useAuth();
  const signedIn = status === "signedIn";
  const semester = useActiveSemester(signedIn);
  const { replacing } = useScheduleDraft();

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

  if (!ready) return null;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#F6F6F3" } }}>
      <Stack.Protected guard={signedIn && !needsOnboarding}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="capture" options={{ presentation: "modal" }} />
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
