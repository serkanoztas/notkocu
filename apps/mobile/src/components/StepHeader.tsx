import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";

interface Props {
  step: 1 | 2;
  onBack?: () => void;
}

export function StepHeader({ step, onBack }: Props) {
  return (
    <View className="h-12 flex-row items-center">
      <View className="w-12">
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Geri"
            className="h-11 w-11 items-center justify-center rounded-xl border border-line bg-card"
          >
            <Ionicons name="chevron-back" size={22} color="#18181B" />
          </Pressable>
        ) : null}
      </View>
      <View className="flex-1 flex-row items-center justify-center gap-2">
        <View className="h-1.5 w-14 rounded-full bg-primary" />
        <View className={`h-1.5 w-14 rounded-full ${step === 2 ? "bg-primary" : "bg-line"}`} />
      </View>
      <Text className="w-12 text-right font-body text-sm text-muted">{step}/2</Text>
    </View>
  );
}
