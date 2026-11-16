import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { semesterWeekNo, type CourseWithSessions, type NoteItem } from "@notkocu/shared";
import { AuthImage } from "../../src/components/AuthImage";
import { NoteTypeBadge } from "../../src/components/NoteTypeBadge";
import { OutboxRow } from "../../src/components/OutboxRow";
import { Placeholder, Screen } from "../../src/components/Screen";
import { TargetPicker } from "../../src/components/TargetPicker";
import { useApproveSuggestions, useAssignNote, useInbox, useUndoAssign } from "../../src/hooks/queries";
import { useNow, useTimeZone } from "../../src/hooks/useNow";
import { useScheduleNow } from "../../src/hooks/useSchedule";
import { ApiError } from "../../src/lib/api";
import { formatStamp } from "../../src/lib/format";
import { useOutbox } from "../../src/lib/OutboxProvider";

const UNDO_MS = 8000;

const courseLabel = (c?: CourseWithSessions) => c?.name || c?.code || "Ders";

function errorText(e: unknown): string {
  return e instanceof ApiError && (e.code === "NETWORK" || e.code === "TIMEOUT")
    ? "Bağlantı yok, işlem yapılamadı"
    : "İşlem yapılamadı, tekrar dene";
}

/** Where the note came from, as shown on the card. */
function sourceLabel(n: NoteItem): string {
  if (n.source === "share-intent") return "Paylaşımdan";
  return { text: "Hızlı not", image: "Fotoğraf", document: "Dosya", link: "Bağlantı", audio: "Ses", task: "Görev", code: "Kod" }[n.type];
}

export default function InboxScreen() {
  const router = useRouter();
  const timeZone = useTimeZone();
  const schedule = useScheduleNow(useNow());
  const inbox = useInbox();
  const assign = useAssignNote();
  const approve = useApproveSuggestions();
  const undoAssign = useUndoAssign();
  const unsent = useOutbox().entries.filter((e) => !e.target || e.target.courseId === null);
  const [assigning, setAssigning] = useState<NoteItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ ids: string[]; text: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notes = inbox.data?.notes ?? [];
  const count = inbox.data?.count ?? 0;
  const withSuggestion = notes.filter((n) => n.suggestion);
  const courseById = (id: string) => schedule.courses.find((c) => c._id === id);

  useEffect(() => () => void (undoTimer.current && clearTimeout(undoTimer.current)), []);

  function showUndo(ids: string[], text: string) {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ ids, text });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  }

  /** The week the note was taken in (not the current one): chips assign to it. */
  function noteWeek(n: NoteItem): number | null {
    if (!schedule.semester) return null;
    return semesterWeekNo(
      { startDate: schedule.semester.startDate, weekCount: schedule.semester.weekCount },
      new Date(n.capturedAt ?? n.createdAt),
      timeZone,
    );
  }

  function approveNotes(list: NoteItem[]) {
    if (list.length === 0 || approve.isPending) return;
    setError(null);
    approve.mutate(
      list.map((n) => n._id),
      {
        onSuccess: ({ approved }) => {
          const done = list.filter((n) => approved.includes(n._id));
          if (done.length === 0) return setError("Öneri artık geçerli değil");
          const only = done.length === 1 ? done[0]! : null;
          const c = only?.suggestion ? courseById(only.suggestion.courseId) : undefined;
          showUndo(
            done.map((n) => n._id),
            only?.suggestion ? `${courseLabel(c)} · ${only.suggestion.weekNo}. haftaya eklendi` : `${done.length} not eklendi`,
          );
        },
        onError: (e) => setError(errorText(e)),
      },
    );
  }

  function assignTo(n: NoteItem, courseId: string, weekNo: number) {
    setError(null);
    assign.mutate(
      { id: n._id, body: { courseId, weekNo } },
      {
        onSuccess: () => showUndo([n._id], `${courseLabel(courseById(courseId))} · ${weekNo}. haftaya eklendi`),
        onError: (e) => setError(errorText(e)),
      },
    );
  }

  return (
    <View className="flex-1 bg-bg">
      <Screen
        title="Gelen kutusu"
        subtitle={count > 0 ? `${count} not ders bekliyor` : undefined}
        right={
          withSuggestion.length > 0 ? (
            <Pressable
              onPress={() => approveNotes(withSuggestion)}
              disabled={approve.isPending}
              accessibilityRole="button"
              className="min-h-touch justify-center rounded-xl border border-line bg-card px-4 active:opacity-80"
            >
              <Text className="font-body-semibold text-base text-ink">Hepsini onayla</Text>
            </Pressable>
          ) : null
        }
      >
        {inbox.isPending ? <Placeholder text="Yükleniyor…" /> : null}
        {inbox.isError && !inbox.data ? (
          <View className="rounded-2xl border border-amber-300 bg-amber-100 p-4">
            <Text className="font-body-semibold text-base text-amber-900">Gelen kutusu yüklenemedi</Text>
            <Pressable onPress={() => inbox.refetch()} className="mt-3 min-h-touch justify-center self-start rounded-xl border border-amber-300 bg-white px-4">
              <Text className="font-body-medium text-amber-900">Tekrar dene</Text>
            </Pressable>
          </View>
        ) : null}
        {inbox.data && notes.length === 0 && unsent.length === 0 ? <Placeholder text="Derse atanmamış not yok." /> : null}
        {unsent.length > 0 ? (
          <View className="overflow-hidden rounded-2xl border border-line bg-card">
            {unsent.map((e, i) => (
              <OutboxRow key={e.clientId} entry={e} divider={i > 0} />
            ))}
          </View>
        ) : null}
        {error ? <Text className="font-body text-sm text-red-700">{error}</Text> : null}

        {notes.map((n) => (
          <InboxCard
            key={n._id}
            note={n}
            timeZone={timeZone}
            courses={schedule.courses}
            suggestedCourse={n.suggestion ? courseById(n.suggestion.courseId) : undefined}
            week={noteWeek(n)}
            busy={approve.isPending || assign.isPending}
            onOpen={() => router.push(`/note/${n._id}`)}
            onApprove={() => approveNotes([n])}
            onPick={() => setAssigning(n)}
            onChip={(courseId, week) => assignTo(n, courseId, week)}
          />
        ))}

        {assigning && schedule.semester ? (
          <TargetPicker
            visible
            courses={schedule.courses}
            weekCount={schedule.semester.weekCount}
            currentWeekNo={schedule.weekNo}
            value={assigning.suggestion ? { courseId: assigning.suggestion.courseId, weekNo: assigning.suggestion.weekNo } : null}
            allowInbox={false}
            onSelect={(target) => {
              const note = assigning;
              setAssigning(null);
              if (target.courseId && target.weekNo) assignTo(note, target.courseId, target.weekNo);
            }}
            onClose={() => setAssigning(null)}
          />
        ) : null}
      </Screen>

      {undo ? (
        <View className="absolute bottom-4 left-5 right-5 flex-row items-center gap-3 rounded-2xl bg-ink px-4 py-2">
          <Text numberOfLines={2} className="flex-1 font-body-medium text-base text-white">
            {undo.text}
          </Text>
          <Pressable
            onPress={() => {
              const ids = undo.ids;
              if (undoTimer.current) clearTimeout(undoTimer.current);
              setUndo(null);
              undoAssign.mutate(ids, { onError: (e) => setError(errorText(e)) });
            }}
            accessibilityRole="button"
            className="min-h-touch justify-center px-2"
          >
            <Text className="font-body-semibold text-base text-white underline">Geri al</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

interface CardProps {
  note: NoteItem;
  timeZone: string;
  courses: CourseWithSessions[];
  suggestedCourse?: CourseWithSessions;
  week: number | null;
  busy: boolean;
  onOpen: () => void;
  onApprove: () => void;
  onPick: () => void;
  onChip: (courseId: string, week: number) => void;
}

function InboxCard({ note, timeZone, courses, suggestedCourse, week, busy, onOpen, onApprove, onPick, onChip }: CardProps) {
  const processing = note.status === "pending" || note.status === "processing";
  const failed = note.status === "failed";

  const preview =
    note.type === "document"
      ? [note.content.pageCount ? `${note.content.pageCount} ${note.content.unit === "slide" ? "slayt" : note.content.unit === "section" ? "bölüm" : "sayfa"}` : null, note.aiSummary]
          .filter(Boolean)
          .join(" · ")
      : note.type === "link"
        ? note.content.url
        : note.extractedText?.replace(/\s+/g, " ");

  const hasSuggestion = !!note.suggestion && !!suggestedCourse;

  return (
    <View className="rounded-3xl border border-line bg-card p-4">
      <Pressable onPress={onOpen} accessibilityRole="button" className="gap-2">
        <View className="flex-row items-center gap-3">
          <NoteTypeBadge type={note.type} />
          <Text className="flex-1 font-body text-sm text-muted">
            {sourceLabel(note)} · {formatStamp(note.capturedAt ?? note.createdAt, timeZone)}
          </Text>
        </View>
        <View className="flex-row items-center gap-3">
          {note.type === "image" ? (
            <AuthImage fileId={note.content.thumbKey ?? note.content.fileKey} className="h-16 w-16 rounded-xl bg-line" />
          ) : null}
          <View className="flex-1 gap-1">
            <Text numberOfLines={1} className="font-body-semibold text-lg text-ink">
              {note.title || "Adsız not"}
            </Text>
            {processing ? (
              <Text className="font-body text-base text-muted">İşleniyor…</Text>
            ) : failed ? (
              <Text className="font-body text-base text-red-700">İşlenemedi</Text>
            ) : preview ? (
              <Text numberOfLines={2} className="font-body text-base text-muted">
                {preview}
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>

      {hasSuggestion && note.suggestion ? (
        <View className="mt-3 flex-row items-center gap-3 rounded-2xl bg-bg p-3">
          <Ionicons name="sparkles-outline" size={20} color="#4338CA" />
          <Text className="flex-1 font-body text-base text-muted">
            Öneri:{" "}
            <Text className="font-body-semibold text-ink">
              {courseLabel(suggestedCourse)} · {note.suggestion.weekNo}. hafta
            </Text>
          </Text>
          <Pressable
            onPress={onPick}
            disabled={busy}
            accessibilityRole="button"
            className="min-h-touch justify-center rounded-xl border border-line bg-card px-3 active:opacity-80"
          >
            <Text className="font-body-medium text-base text-ink">Değiştir</Text>
          </Pressable>
          <Pressable
            onPress={onApprove}
            disabled={busy}
            accessibilityRole="button"
            className="min-h-touch justify-center rounded-xl bg-primary px-4 active:opacity-80"
          >
            <Text className="font-body-semibold text-base text-white">Onayla</Text>
          </Pressable>
        </View>
      ) : processing || failed ? (
        <Pressable
          onPress={onPick}
          disabled={busy}
          accessibilityRole="button"
          className="mt-3 min-h-[48px] items-center justify-center rounded-xl border border-line bg-card active:opacity-80"
        >
          <Text className="font-body-semibold text-base text-ink">Derse ata</Text>
        </Pressable>
      ) : (
        <View className="mt-3 gap-2">
          <Text className="font-body text-base text-muted">
            {note.suggesting ? "Öneri hazırlanıyor…" : "AI emin olamadı. Hangi derse ait?"}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {courses.map((c) => (
              <Pressable
                key={c._id}
                onPress={() => (week ? onChip(c._id, week) : onPick())}
                disabled={busy}
                accessibilityRole="button"
                className="min-h-touch justify-center rounded-xl border border-line bg-card px-4 active:opacity-80"
              >
                <Text numberOfLines={1} className="font-body-medium text-base text-ink">
                  {courseLabel(c)}
                </Text>
              </Pressable>
            ))}
            <Pressable
              onPress={onPick}
              disabled={busy}
              accessibilityRole="button"
              className="min-h-touch justify-center rounded-xl px-3 active:opacity-80"
            >
              <Text className="font-body-medium text-base text-primary">Hafta seç…</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}
