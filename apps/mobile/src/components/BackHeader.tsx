import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

interface Props {
  /** Small line above the title (e.g. the note type). */
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  right?: ReactNode;
}

/** Top bar of the pushed screens: back button, optional title block, optional right action. */
export function BackHeader({ eyebrow, title, subtitle, right }: Props) {
  const router = useRouter();
  return (
    <View className="min-h-[48px] flex-row items-center gap-3">
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Geri"
        className="h-11 w-11 items-center justify-center rounded-xl border border-line bg-card"
      >
        <Ionicons name="chevron-back" size={22} color="#18181B" />
      </Pressable>
      <View className="flex-1">
        {eyebrow ? <Text className="font-body-semibold text-xs uppercase text-muted">{eyebrow}</Text> : null}
        {title ? (
          <Text numberOfLines={1} className="font-heading text-2xl text-ink">
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text numberOfLines={1} className="font-body text-sm text-muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}
