import { Ionicons } from "@expo/vector-icons";
import { Tabs, useRouter } from "expo-router";
import type { ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../theme";

type IconName = keyof typeof Ionicons.glyphMap;
// expo-router 58 does not re-export this type from its entry point.
type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

const TABS: Record<string, { label: string; icon: IconName; iconActive: IconName }> = {
  index: { label: "Bugün", icon: "home-outline", iconActive: "home" },
  courses: { label: "Dersler", icon: "bookmark-outline", iconActive: "bookmark" },
  inbox: { label: "Gelen kutusu", icon: "file-tray-outline", iconActive: "file-tray" },
  settings: { label: "Ayarlar", icon: "settings-outline", iconActive: "settings" },
};

// The center "+" button sits between the 2nd and 3rd tab.
const CENTER_AFTER = 2;

export function TabBar({ state, emitter, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const items = state.routes.map((route, index) => {
    const meta = TABS[route.name];
    if (!meta) return null;
    const focused = state.index === index;
    const color = focused ? colors.primary : colors.muted;
    return (
      <Pressable
        key={route.key}
        accessibilityRole="button"
        accessibilityLabel={meta.label}
        accessibilityState={{ selected: focused }}
        onPress={() => {
          const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigateToTab(route.key);
        }}
        className="min-h-touch flex-1 items-center justify-center py-2"
      >
        <Ionicons name={focused ? meta.iconActive : meta.icon} size={24} color={color} />
        <Text
          numberOfLines={1}
          className={`mt-1 text-xs ${focused ? "font-body-semibold" : "font-body"}`}
          style={{ color }}
        >
          {meta.label}
        </Text>
      </Pressable>
    );
  });

  const before = items.slice(0, CENTER_AFTER);
  const after = items.slice(CENTER_AFTER);

  return (
    <View
      className="flex-row items-center border-t border-line bg-card px-2"
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
    >
      {before}
      <View className="w-24 items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Yeni not"
          onPress={() => router.push("/capture")}
          className="-mt-6 h-14 w-14 items-center justify-center rounded-2xl bg-primary"
          style={{ elevation: 4, shadowColor: colors.primary, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } }}
        >
          <Ionicons name="add" size={32} color="#FFFFFF" />
        </Pressable>
      </View>
      {after}
    </View>
  );
}