import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NoteItem, NoteType, WeekSummaryView } from "@notkocu/shared";
import { AuthImage } from "../../../../src/components/AuthImage";
import { BackHeader } from "../../../../src/components/BackHeader";
import { NoteRow } from "../../../../src/components/NoteRow";
import { OutboxRow } from "../../../../src/components/OutboxRow";
import { useCourseDetail, useRefreshWeekSummary, useWeek } from "../../../../src/hooks/queries";
import { useTimeZone } from "../../../../src/hooks/useNow";
import { formatToday, weekRangeLabel } from "../../../../src/lib/format";
import { useOutbox } from "../../../../src/lib/OutboxProvider";
import type { OutboxEntry } from "../../../../src/lib/outbox";

type View_ = "type" | "time";

const TYPE_LABEL: Record<NoteType, string> = {
  audio: "Ses",
  image: "Görsel",
  document: "Belge",
  text: "Metin",
  link: "Link",
  task: "Görev",
  code: "Kod",
};
// Audio and images get their own sections (mockup 08); the rest share one list, in this order.
const LIST_ORDER: NoteType[] = ["document", "text", "link", "task", "code"];

function SummaryCard({ summary, hasNotes, onRefresh, refreshing }: { summary: WeekSummaryView | null; hasNotes: boolean; onRefresh: () => void; refreshing: boolean }) {
  const text = summary?.summary?.trim();
  return (
    <View className="rounded-3xl bg-primary-soft p-5">
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-2">
          <Ionicons name="sparkles-outline" size={18} color="#3730A3" />
          <Text className="font-body-semibold text-base text-primary-dark">Haftanın özeti</Text>
        </View>
        {text && summary ? <Text className="font-body text-sm text-primary">{summary.noteIds.length} nottan</Text> : null}
      </View>
      {text ? (
        <Text selectable className="mt-2 font-body text-base leading-6 text-primary-dark">
          {text}
        </Text>
      ) : null}
      {summary?.generating ? (
        <Text className="mt-2 font-body text-base text-primary-dark">{text ? "Özet güncelleniyor…" : "Özet hazırlanıyor…"}</Text>
      ) : !text && summary ? (
        <View className="mt-2 items-start gap-1">
          <Text className="font-body text-base text-primary-dark">Özet şu an hazırlanamadı.</Text>
          <Pressable onPress={onRefresh} disabled={refreshing} accessibilityRole="button" className="min-h-touch justify-center">
            <Text className="font-body-semibold text-base text-primary">{refreshing ? "Gönderiliyor…" : "Tekrar dene"}</Text>
          </Pressable>
        </View>
      ) : !text ? (
        <Text className="mt-2 font-body text-base text-primary-dark">
          {hasNotes ? "Notlar işlendikten sonra özet burada görünür." : "Haftada hazır not olunca özet burada görünür."}
        </Text>
      ) : null}
    </View>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <Text className="mt-1 font-body-semibold text-base text-muted">{children}</Text>;
}

function Card({ children }: { children: ReactNode }) {
  return <View className="overflow-hidden rounded-2xl border border-line bg-card">{children}</View>;
}

/** Photos as a grid of thumbnails with their title (mockup 08). */
function ImageGrid({ notes }: { notes: Extract<NoteItem, { type: "image" }>[] }) {
  const router = useRouter();
  return (
    <View className="flex-row flex-wrap gap-3">
      {notes.map((n) => (
        <Pressable
          key={n._id}
          onPress={() => router.push(`/note/${n._id}`)}
          accessibilityRole="button"
          accessibilityLabel={n.title || "Fotoğraf"}
          style={{ width: "31%", aspectRatio: 1 }}
          className="overflow-hidden rounded-2xl bg-line active:opacity-80"
        >
          <AuthImage fileId={n.content.thumbKey ?? n.content.fileKey} className="h-full w-full" resizeMode="cover" />
          {n.status === "pending" || n.status === "processing" ? (
            <View className="absolute left-2 top-2 rounded-lg bg-white px-2 py-1">
              <Text className="font-body-semibold text-xs text-ink">İşleniyor…</Text>
            </View>
          ) : null}
          <View className="absolute bottom-0 left-0 right-0 bg-black/40 px-2 py-1">
            <Text numberOfLines={1} className="font-body-medium text-sm text-white">
              {n.title || "Fotoğraf"}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const when = (n: NoteItem) => n.capturedAt ?? n.createdAt;

export default function WeekScreen() {
  const { id, no } = useLocalSearchParams<{ id: string; no: string }>();
  const weekNo = Number(no);
  const insets = useSafeAreaInsets();
  const timeZone = useTimeZone();
  const week = useWeek(id, weekNo);
  const course = useCourseDetail(id); // already cached when coming from the course page
  const refresh = useRefreshWeekSummary(id, weekNo);
  const unsent = useOutbox().entries.filter((e) => e.target?.courseId === id && e.target.weekNo === weekNo);
  const [view, setView] = useState<View_>("type");

  const range = course.data ? weekRangeLabel(course.data.semester.startDate, weekNo) : "";
  const courseName = week.data?.course.name || week.data?.course.code || "";

  function typeView(notes: NoteItem[]) {
    const audio = notes.filter((n): n is Extract<NoteItem, { type: "audio" }> => n.type === "audio");
    const images = notes.filter((n): n is Extract<NoteItem, { type: "image" }> => n.type === "image");
    const rest = LIST_ORDER.map((t) => ({ type: t, items: notes.filter((n) => n.type === t) })).filter((g) => g.items.length > 0);
    const restNotes = rest.flatMap((g) => g.items);
    // Unsent recordings/photos have no section of their own yet: they wait at the end of the list.
    return (
      <>
        {audio.length > 0 ? (
          <>
            <SectionTitle>{`${TYPE_LABEL.audio} · ${audio.length}`}</SectionTitle>
            <Card>
              {audio.map((n, i) => (
                <NoteRow key={n._id} note={n} divider={i > 0} />
              ))}
            </Card>
          </>
        ) : null}
        {images.length > 0 ? (
          <>
            <SectionTitle>{`${TYPE_LABEL.image} · ${images.length}`}</SectionTitle>
            <ImageGrid notes={images} />
          </>
        ) : null}
        {restNotes.length + unsent.length > 0 ? (
          <>
            {rest.length > 0 ? <SectionTitle>{rest.map((g) => `${TYPE_LABEL[g.type]} · ${g.items.length}`).join("  ·  ")}</SectionTitle> : <SectionTitle>Gönderilmeyi bekleyenler</SectionTitle>}
            <Card>
              {restNotes.map((n, i) => (
                <NoteRow key={n._id} note={n} divider={i > 0} />
              ))}
              {unsent.map((e, i) => (
                <OutboxRow key={e.clientId} entry={e} divider={restNotes.length + i > 0} />
              ))}
            </Card>
          </>
        ) : null}
      </>
    );
  }

  function timeView(notes: NoteItem[]) {
    type Item = { at: string; note?: NoteItem; entry?: OutboxEntry };
    const items: Item[] = [
      ...notes.map((n) => ({ at: when(n), note: n })),
      ...unsent.map((e) => ({ at: e.capturedAt, entry: e })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const days: { label: string; items: Item[] }[] = [];
    for (const it of items) {
      const label = formatToday(new Date(it.at), timeZone);
      const last = days[days.length - 1];
      if (last?.label === label) last.items.push(it);
      else days.push({ label, items: [it] });
    }
    return (
      <>
        {days.map((d) => (
          <View key={d.label} className="gap-2">
            <SectionTitle>{d.label}</SectionTitle>
            <Card>
              {d.items.map((it, i) =>
                it.note ? <NoteRow key={it.note._id} note={it.note} divider={i > 0} /> : <OutboxRow key={it.entry!.clientId} entry={it.entry!} divider={i > 0} />,
              )}
            </Card>
          </View>
        ))}
      </>
    );
  }

  return (
    <View className="flex-1 bg-bg">
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 20, paddingBottom: 32, gap: 16 }}>
        <BackHeader title={`${weekNo}. hafta`} subtitle={[courseName, range].filter(Boolean).join(" · ")} />

        {week.isPending ? <Text className="font-body text-base text-muted">Yükleniyor…</Text> : null}
        {week.isError && !week.data ? (
          <View className="rounded-2xl border border-amber-300 bg-amber-100 p-4">
            <Text className="font-body-semibold text-base text-amber-900">Notlar yüklenemedi</Text>
            <Pressable onPress={() => week.refetch()} className="mt-3 min-h-touch justify-center self-start rounded-xl border border-amber-300 bg-white px-4">
              <Text className="font-body-medium text-amber-900">Tekrar dene</Text>
            </Pressable>
          </View>
        ) : null}

        {week.data ? (
          <>
            <SummaryCard
              summary={week.data.summary}
              hasNotes={week.data.notes.length > 0}
              onRefresh={() => refresh.mutate()}
              refreshing={refresh.isPending}
            />

            {week.data.notes.length + unsent.length > 0 ? (
              <>
                <View className="flex-row rounded-2xl bg-line/60 p-1.5" accessibilityRole="tablist">
                  {(
                    [
                      ["type", "Tipe göre"],
                      ["time", "Zaman çizelgesi"],
                    ] as const
                  ).map(([key, label]) => (
                    <Pressable
                      key={key}
                      onPress={() => setView(key)}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: view === key }}
                      className={`min-h-touch flex-1 items-center justify-center rounded-xl ${view === key ? "bg-white" : ""}`}
                    >
                      <Text className={`font-body-medium text-base ${view === key ? "text-ink" : "text-muted"}`}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
                {view === "type" ? typeView(week.data.notes) : timeView(week.data.notes)}
              </>
            ) : (
              <View className="rounded-2xl border border-line bg-card p-5">
                <Text className="font-body text-base text-muted">Bu haftada henüz not yok.</Text>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
