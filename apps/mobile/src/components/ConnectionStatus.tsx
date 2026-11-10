import { Pressable, Text, View } from "react-native";
import { useHealth } from "../hooks/useHealth";
import { api } from "../lib/api";

export function ConnectionStatus() {
  const { data, error, isPending, isFetching, refetch } = useHealth();

  let dot = "bg-muted";
  let title = "Bağlanıyor…";
  let detail: string | undefined = api.baseUrl || "EXPO_PUBLIC_API_URL tanımlı değil";

  if (data) {
    const dbUp = data.db === "connected";
    dot = dbUp ? "bg-green-600" : "bg-amber-500";
    title = dbUp ? "API bağlı · veritabanı bağlı" : "API bağlı · veritabanı bağlı değil";
  } else if (error) {
    dot = "bg-red-700";
    title = error.message || "API'ye ulaşılamıyor";
  }

  return (
    <View className="rounded-2xl border border-line bg-card p-4">
      <View className="flex-row items-center gap-3">
        <View className={`h-3 w-3 rounded-full ${dot}`} />
        <Text className="flex-1 font-body-semibold text-base text-ink">{title}</Text>
      </View>
      {detail ? <Text className="mt-1 font-body text-sm text-muted">{detail}</Text> : null}
      {!isPending && error ? (
        <Pressable
          onPress={() => refetch()}
          disabled={isFetching}
          className="mt-3 min-h-touch items-center justify-center self-start rounded-xl border border-line px-4"
        >
          <Text className="font-body-medium text-primary">{isFetching ? "Deneniyor…" : "Tekrar dene"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}