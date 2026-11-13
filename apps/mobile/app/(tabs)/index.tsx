import { Pressable, Text, View } from "react-native";
import { ConnectionStatus } from "../../src/components/ConnectionStatus";
import { Placeholder, Screen } from "../../src/components/Screen";
import { useActiveSemester } from "../../src/hooks/useActiveSemester";

export default function TodayScreen() {
  const semester = useActiveSemester(true);

  return (
    <Screen title="Bugün">
      {semester.isError ? (
        <View className="rounded-2xl border border-amber-300 bg-amber-100 p-4">
          <Text className="font-body-semibold text-base text-amber-900">Program yüklenemedi</Text>
          <Pressable
            onPress={() => semester.refetch()}
            disabled={semester.isFetching}
            className="mt-3 min-h-touch items-center justify-center self-start rounded-xl border border-amber-300 bg-white px-4"
          >
            <Text className="font-body-medium text-amber-900">{semester.isFetching ? "Deneniyor…" : "Tekrar dene"}</Text>
          </Pressable>
        </View>
      ) : null}
      <ConnectionStatus />
      <Placeholder text="Devam eden ders, sonraki dersler ve haftanın görevleri burada olacak." />
    </Screen>
  );
}
