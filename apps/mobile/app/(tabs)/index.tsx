import { ConnectionStatus } from "../../src/components/ConnectionStatus";
import { Placeholder, Screen } from "../../src/components/Screen";

export default function TodayScreen() {
  return (
    <Screen title="Bugün">
      <ConnectionStatus />
      <Placeholder text="Devam eden ders, sonraki dersler ve haftanın görevleri burada olacak." />
    </Screen>
  );
}