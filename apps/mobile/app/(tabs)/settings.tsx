import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { Screen } from "../../src/components/Screen";
import { useAuth } from "../../src/lib/auth";
import { useScheduleDraft } from "../../src/lib/scheduleDraft";

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const draft = useScheduleDraft();
  const [busy, setBusy] = useState(false);

  function onReloadSchedule() {
    Alert.alert("Ders programını yeniden yükle", "Mevcut program arşivlenecek, notların silinmez.", [
      { text: "Vazgeç", style: "cancel" },
      {
        text: "Devam et",
        onPress: () => {
          draft.begin(true);
          router.push("/onboarding/schedule");
        },
      },
    ]);
  }

  async function onSignOut() {
    setBusy(true);
    await signOut(); // this screen unmounts once signed out
  }

  return (
    <Screen title="Ayarlar">
      <View className="rounded-2xl border border-line bg-card p-5">
        <Text className="font-body-semibold text-lg text-ink">{user?.name ?? "—"}</Text>
        <Text className="mt-1 font-body text-base text-muted">{user?.email ?? ""}</Text>
      </View>
      <Pressable
        onPress={onReloadSchedule}
        accessibilityRole="button"
        className="min-h-touch items-center justify-center rounded-2xl border border-line bg-card px-5 py-3 active:opacity-80"
      >
        <Text className="font-body-semibold text-base text-ink">Ders programını yeniden yükle</Text>
      </Pressable>
      <Pressable
        onPress={onSignOut}
        disabled={busy}
        accessibilityRole="button"
        className="min-h-touch items-center justify-center rounded-2xl border border-line bg-card px-5 py-3 active:opacity-80"
      >
        {busy ? (
          <ActivityIndicator color="#B91C1C" />
        ) : (
          <Text className="font-body-semibold text-base text-red-700">Çıkış yap</Text>
        )}
      </Pressable>
    </Screen>
  );
}
