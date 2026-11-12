import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../src/lib/auth";

const FEATURES = [
  { icon: "calendar-outline", bg: "bg-note-text-bg", color: "#3730A3", text: "Ders programını ekran görüntüsünden kur" },
  { icon: "camera-outline", bg: "bg-note-image-bg", color: "#166534", text: "Derste çektiğin not doğru haftaya kendiliğinden gitsin" },
  { icon: "sparkles-outline", bg: "bg-note-audio-bg", color: "#9D174D", text: "Her haftanın özeti AI ile hazır" },
] as const;

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPress() {
    setBusy(true);
    setError(null);
    const message = await signIn();
    // On success the auth guard swaps screens; only reset state when we stay here.
    setError(message);
    setBusy(false);
  }

  return (
    <View
      className="flex-1 bg-bg px-6"
      style={{ paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }}
    >
      <View className="h-16 w-16 items-center justify-center rounded-2xl bg-primary">
        <Ionicons name="document-text-outline" size={32} color="#FFFFFF" />
      </View>
      <Text className="mt-10 font-heading text-5xl text-ink">NotKoçu</Text>
      <Text className="mt-3 font-body text-lg text-muted">
        Ders notların hafta hafta düzenli.{"\n"}Fotoğraf, ses, PDF; hepsi tek yerde.
      </Text>

      <View className="mt-8 gap-4">
        {FEATURES.map((f) => (
          <View key={f.text} className="flex-row items-center gap-4">
            <View className={`h-10 w-10 items-center justify-center rounded-xl ${f.bg}`}>
              <Ionicons name={f.icon} size={20} color={f.color} />
            </View>
            <Text className="flex-1 font-body text-base text-ink">{f.text}</Text>
          </View>
        ))}
      </View>

      <View className="flex-1" />

      {error ? <Text className="mb-3 text-center font-body text-sm text-red-700">{error}</Text> : null}
      <Pressable
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        className="min-h-[56px] items-center justify-center rounded-2xl bg-ink active:opacity-80"
      >
        {busy ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text className="font-body-semibold text-base text-white">Google ile devam et</Text>
        )}
      </Pressable>
      <Text className="mt-4 text-center font-body text-xs text-muted">
        Devam ederek Kullanım koşulları ve Gizlilik politikasını kabul etmiş olursun.
      </Text>
    </View>
  );
}
