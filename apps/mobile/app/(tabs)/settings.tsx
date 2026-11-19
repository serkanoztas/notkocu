import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { Screen } from "../../src/components/Screen";
import { useStorage } from "../../src/hooks/queries";
import { useAuth } from "../../src/lib/auth";
import { useOutbox } from "../../src/lib/OutboxProvider";
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
  const outbox = useOutbox();
  const unsent = outbox.entries.length;
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

  async function doSignOut() {
    setBusy(true);
    outbox.clearAll(); // the user was told; notes of this account must not wait for the next one
    await signOut(); // this screen unmounts once signed out
  }

  function onSignOut() {
    if (unsent === 0) return void doSignOut();
    Alert.alert(
      "Gönderilmemiş notların var",
      `${unsent} not henüz sunucuya gönderilmedi. Şimdi çıkış yaparsan bu notlar silinir.`,
      [
        { text: "Vazgeç", style: "cancel" },
        { text: "Yine de çık", style: "destructive", onPress: () => void doSignOut() },
      ],
    );
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
          {storage.data.pinnedAudioBytes > 0 ? (
            <Text className="mt-2 font-body text-sm text-muted">Kalıcı sesler: {formatMb(storage.data.pinnedAudioBytes)}</Text>
          ) : null}
          <View className="mt-3 h-2 overflow-hidden rounded-full bg-line">
            <View
              className={`h-2 rounded-full ${storage.data.usedBytes / storage.data.limitBytes > 0.9 ? "bg-red-600" : "bg-primary"}`}
              style={{ width: `${Math.min(100, (storage.data.usedBytes / storage.data.limitBytes) * 100)}%` }}
            />
          </View>
        </View>
      ) : null}
      {unsent > 0 ? (
        <View className="flex-row items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-100 p-5">
          <Text className="flex-1 font-body-semibold text-base text-amber-900">{unsent} not gönderilmedi</Text>
          <Pressable
            onPress={() => void outbox.flush()}
            accessibilityRole="button"
            className="min-h-touch justify-center rounded-xl border border-amber-300 bg-white px-4 active:opacity-80"
          >
            <Text className="font-body-semibold text-base text-amber-900">Şimdi gönder</Text>
          </Pressable>
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
