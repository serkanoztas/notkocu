import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { Screen } from "../../src/components/Screen";
import { useStorage } from "../../src/hooks/queries";
import { useAuth } from "../../src/lib/auth";
import { useScheduleDraft } from "../../src/lib/scheduleDraft";

/** Bytes as "23 MB"; below 1 MB shown with one decimal so a first photo is not "0 MB". */
function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 && mb % 1 !== 0 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const draft = useScheduleDraft();
  const storage = useStorage();
  const [busy, setBusy] = useState(false);
  const [openFlow, setOpenFlow] = useState(false);

  // The onboarding screens only exist once replace mode is on, so navigate after that render.
  useEffect(() => {
    if (openFlow && draft.replacing) {
      setOpenFlow(false);
      router.push("/onboarding/schedule");
    }
  }, [openFlow, draft.replacing, router]);

  function onReloadSchedule() {
    Alert.alert("Ders programını yeniden yükle", "Mevcut program arşivlenecek, notların silinmez.", [
      { text: "Vazgeç", style: "cancel" },
      {
        text: "Devam et",
        onPress: () => {
          draft.begin(true);
          setOpenFlow(true);
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
      {storage.data ? (
        <View className="rounded-2xl border border-line bg-card p-5">
          <View className="flex-row items-center justify-between">
            <Text className="font-body-semibold text-base text-ink">Depolama</Text>
            <Text className="font-body text-base text-muted">
              {formatMb(storage.data.usedBytes)} / {formatMb(storage.data.limitBytes)}
            </Text>
          </View>
          <View className="mt-3 h-2 overflow-hidden rounded-full bg-line">
            <View
              className={`h-2 rounded-full ${storage.data.usedBytes / storage.data.limitBytes > 0.9 ? "bg-red-600" : "bg-primary"}`}
              style={{ width: `${Math.min(100, (storage.data.usedBytes / storage.data.limitBytes) * 100)}%` }}
            />
          </View>
        </View>
      ) : null}
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
