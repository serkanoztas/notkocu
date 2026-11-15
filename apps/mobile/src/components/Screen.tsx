import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Props {
  title: string;
  subtitle?: string;
  /** Shown on the title row, right-aligned (e.g. a week chip). */
  right?: ReactNode;
  children?: ReactNode;
}

export function Screen({ title, subtitle, right, children }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerStyle={{ paddingTop: insets.top + 20, paddingHorizontal: 20, paddingBottom: 32 }}
    >
      {subtitle ? <Text className="font-body text-base text-muted">{subtitle}</Text> : null}
      <View className="flex-row items-center justify-between gap-3">
        <Text className="font-heading text-4xl text-ink">{title}</Text>
        {right}
      </View>
      <View className="mt-6 gap-4">{children}</View>
    </ScrollView>
  );
}

export function Placeholder({ text }: { text: string }) {
  return (
    <View className="rounded-2xl border border-line bg-card p-5">
      <Text className="font-body text-base text-muted">{text}</Text>
    </View>
  );
}