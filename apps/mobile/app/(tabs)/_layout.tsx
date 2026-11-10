import { Tabs } from "expo-router";
import { TabBar } from "../../src/components/TabBar";

export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: "Bugün" }} />
      <Tabs.Screen name="courses" options={{ title: "Dersler" }} />
      <Tabs.Screen name="inbox" options={{ title: "Gelen kutusu" }} />
      <Tabs.Screen name="settings" options={{ title: "Ayarlar" }} />
    </Tabs>
  );
}