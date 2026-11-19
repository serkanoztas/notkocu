import { Ionicons } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatDuration } from "../lib/format";
import { useRecording } from "../lib/RecordingProvider";

/**
 * Floating strip on every screen except the capture sheet: a recording keeps running when the sheet is
 * closed, and this is the way back to it. Also tells once that a recording was rescued after the app died.
 */
export function RecordingBar() {
  const rec = useRecording();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const onCapture = pathname === "/capture";
  const active = rec.status !== "idle" && rec.status !== "starting";

  if (onCapture) return null;
  if (active) {
    const label =
      rec.status === "paused" ? "Kayıt duraklatıldı" : rec.status === "interrupted" ? "Kayıt kesildi, devam ediliyor…" : rec.status === "finishing" ? "Kayıt kaydediliyor…" : "Kayıt sürüyor";
    return (
      <View pointerEvents="box-none" className="absolute left-3 right-3" style={{ top: insets.top + 6 }}>
        <Pressable
          onPress={() => router.push("/capture")}
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${formatDuration(rec.elapsedSec)}. Aç`}
          className="min-h-touch flex-row items-center gap-3 rounded-2xl bg-ink px-4 active:opacity-90"
        >
          <View className={`h-3 w-3 rounded-full ${rec.status === "recording" ? "bg-red-500" : "bg-amber-400"}`} />
          <Text className="flex-1 font-body-semibold text-base text-white">{label}</Text>
          <Text className="font-body-semibold text-base text-white">{formatDuration(rec.elapsedSec)}</Text>
          <Ionicons name="chevron-forward" size={18} color="#FFFFFF" />
        </Pressable>
      </View>
    );
  }
  if (rec.recoveredCount > 0) {
    return (
      <View pointerEvents="box-none" className="absolute left-3 right-3" style={{ top: insets.top + 6 }}>
        <Pressable
          onPress={rec.dismissRecovered}
          accessibilityRole="button"
          className="min-h-touch flex-row items-center gap-3 rounded-2xl bg-primary px-4 py-2 active:opacity-90"
        >
          <Ionicons name="shield-checkmark-outline" size={20} color="#FFFFFF" />
          <Text className="flex-1 font-body-medium text-sm text-white">
            {rec.recoveredCount === 1 ? "Yarım kalan kayıt kurtarıldı" : `${rec.recoveredCount} yarım kalan kayıt kurtarıldı`}, gönderiliyor.
          </Text>
          <Ionicons name="close" size={18} color="#FFFFFF" />
        </Pressable>
      </View>
    );
  }
  return null;
}
