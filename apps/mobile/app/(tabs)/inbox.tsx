import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { NoteItem } from "@notkocu/shared";
import { NoteTypeBadge } from "../../src/components/NoteTypeBadge";
import { Placeholder, Screen } from "../../src/components/Screen";
import { TargetPicker } from "../../src/components/TargetPicker";
import { useAssignNote, useInbox } from "../../src/hooks/queries";
import { useNow, useTimeZone } from "../../src/hooks/useNow";
import { useScheduleNow } from "../../src/hooks/useSchedule";
import { ApiError } from "../../src/lib/api";
import { formatStamp } from "../../src/lib/format";

export default function InboxScreen() {
  const router = useRouter();
  const timeZone = useTimeZone();
  const schedule = useScheduleNow(useNow());
  const inbox = useInbox();
  const assign = useAssignNote();
  const [assigning, setAssigning] = useState<NoteItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const notes = inbox.data?.notes ?? [];
  const count = inbox.data?.count ?? 0;

  return (
    <Screen title="Gelen kutusu" subtitle={count > 0 ? `${count} not ders bekliyor` : undefined}>
      {inbox.isPending ? <Placeholder text="Yükleniyor…" /> : null}
      {inbox.isError && !inbox.data ? (
        <View className="rounded-2xl border border-amber-300 bg-amber-100 p-4">
          <Text className="font-body-semibold text-base text-amber-900">Gelen kutusu yüklenemedi</Text>
          <Pressable onPress={() => inbox.refetch()} className="mt-3 min-h-touch justify-center self-start rounded-xl border border-amber-300 bg-white px-4">
            <Text className="font-body-medium text-amber-900">Tekrar dene</Text>
          </Pressable>
        </View>
      ) : null}
      {inbox.data && notes.length === 0 ? <Placeholder text="Derse atanmamış not yok." /> : null}
      {error ? <Text className="font-body text-sm text-red-700">{error}</Text> : null}

      {notes.map((n) => (
        <InboxCard key={n._id} note={n} timeZone={timeZone} onOpen={() => router.push(`/note/${n._id}`)} onAssign={() => setAssigning(n)} />
      ))}

      {assigning && schedule.semester ? (
        <TargetPicker
          visible
          courses={schedule.courses}
          weekCount={schedule.semester.weekCount}
          currentWeekNo={schedule.weekNo}
          value={null}
          allowInbox={false}
          onSelect={(target) => {
            const note = assigning;
            setAssigning(null);
            if (!target.courseId) return;
            setError(null);
            assign.mutate(
              { id: note._id, body: { courseId: target.courseId, weekNo: target.weekNo } },
              {
                onError: (e) =>
                  setError(
                    e instanceof ApiError && (e.code === "NETWORK" || e.code === "TIMEOUT")
                      ? "Bağlantı yok, not atanamadı"
                      : "Not atanamadı, tekrar dene",
                  ),
              },
            );
          }}
          onClose={() => setAssigning(null)}
        />
      ) : null}
    </Screen>
  );
}

function InboxCard(props: { note: NoteItem; timeZone: string; onOpen: () => void; onAssign: () => void }) {
  const { note } = props;
  return (
    <View className="rounded-3xl border border-line bg-card p-4">
      <Pressable onPress={props.onOpen} accessibilityRole="button" className="gap-2">
        <View className="flex-row items-center gap-3">
          <NoteTypeBadge type={note.type} />
          <Text className="flex-1 font-body text-sm text-muted">Hızlı not · {formatStamp(note.createdAt, props.timeZone)}</Text>
        </View>
        <Text numberOfLines={1} className="font-body-semibold text-lg text-ink">
          {note.title || "Adsız not"}
        </Text>
        {note.extractedText ? (
          <Text numberOfLines={2} className="font-body text-base text-muted">
            {note.extractedText.replace(/\s+/g, " ")}
          </Text>
        ) : null}
      </Pressable>
      <Pressable
        onPress={props.onAssign}
        accessibilityRole="button"
        className="mt-3 min-h-[48px] items-center justify-center rounded-xl bg-primary active:opacity-80"
      >
        <Text className="font-body-semibold text-base text-white">Derse ata</Text>
      </Pressable>
    </View>
  );
}
