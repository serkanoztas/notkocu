import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Placeholder } from "../src/components/Screen";

export default function CaptureScreen() {
  const router = useRouter();
  return (
    <View className="flex-1 gap-4 bg-bg p-5 pt-8">
      <Text className="font-heading text-3xl text-ink">Hızlı yakalama</Text>
      <Placeholder text="Not tipi seçimi ve giriş alanları sonraki aşamada eklenecek." />
      <Pressable
        onPress={() => router.back()}
        className="min-h-touch items-center justify-center rounded-xl bg-primary px-4"
      >
        <Text className="font-body-semibold text-white">Kapat</Text>
      </Pressable>
    </View>
  );
}