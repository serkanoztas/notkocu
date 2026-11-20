import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useShareIntentContext } from "expo-share-intent";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AUDIO_IMPORT_EXTENSIONS, AUDIO_IMPORT_MAX_BYTES } from "@notkocu/shared";
import { TargetPicker, type PickedTarget } from "../src/components/TargetPicker";
import type { NewOutboxNote } from "../src/lib/OutboxProvider";
import { useNow, useTimeZone } from "../src/hooks/useNow";
import { findAutoTarget, useScheduleNow } from "../src/hooks/useSchedule";
import { useAudioLimitMin } from "../src/hooks/queries";
import { readAudioFileDuration } from "../src/lib/audioFileInfo";
import { DAY_SHORT, formatDuration } from "../src/lib/format";
import { useOutbox } from "../src/lib/OutboxProvider";
import { useRecording } from "../src/lib/RecordingProvider";

type IconName = keyof typeof Ionicons.glyphMap;
type CaptureType = "text" | "image" | "audio" | "document" | "link";

const TYPES: { key: string; label: string; icon: IconName; active: boolean }[] = [
  { key: "text", label: "Metin", icon: "reorder-three-outline", active: true },
  { key: "image", label: "Fotoğraf", icon: "camera-outline", active: true },
  { key: "audio", label: "Ses kaydı", icon: "mic-outline", active: true },
  { key: "document", label: "Dosya", icon: "document-outline", active: true },
  { key: "link", label: "Link", icon: "link-outline", active: true },
  { key: "task", label: "Görev", icon: "checkbox-outline", active: false },
];

const MAX_PHOTOS = 10;
const MAX_DOCS = 5;
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const DOC_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

interface PickedFile {
  uri: string;
  name: string;
  size?: number;
}

/** An external audio file waiting to be saved; durationSec: undefined = still reading, null = could not be read. */
interface ImportedAudio extends PickedFile {
  durationSec?: number | null;
}

/** "example.com/x" -> "https://example.com/x"; null when it cannot be a web address. */
function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const u = new URL(withScheme);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".") ? withScheme : null;
  } catch {
    return null;
  }
}

const AUDIO_PICKER_TYPES = ["audio/*", "application/ogg"];
const hasExt = (name: string | null | undefined, exts: readonly string[]) => exts.some((x) => (name ?? "").toLowerCase().endsWith("." + x));
const isAmrFile = (f: { mimeType?: string | null; fileName?: string | null }) => /amr/i.test(f.mimeType ?? "") || hasExt(f.fileName, ["amr"]);
const isAudioFile = (f: { mimeType?: string | null; fileName?: string | null }) =>
  (f.mimeType ?? "").startsWith("audio/") || /ogg|opus/i.test(f.mimeType ?? "") || hasExt(f.fileName, AUDIO_IMPORT_EXTENSIONS) || isAmrFile(f);

const DOC_EXTENSIONS = [".pdf", ".docx", ".pptx"];
const isDocument = (f: { mimeType?: string | null; fileName?: string | null }) =>
  DOC_TYPES.includes(f.mimeType ?? "") || DOC_EXTENSIONS.some((x) => (f.fileName ?? "").toLowerCase().endsWith(x));

const formatSize = (bytes?: number) =>
  bytes === undefined ? "" : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export default function CaptureScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ courseId?: string; weekNo?: string }>();
  const timeZone = useTimeZone();
  const now = useNow(); // the shown target refreshes once a minute while this sheet is open
  const schedule = useScheduleNow(now);
  const outbox = useOutbox();
  const rec = useRecording();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const [fromShare, setFromShare] = useState(false);

  // A target the user chose by hand (or via "Not al" on a course) stays fixed; otherwise it follows the clock.
  const [manual, setManual] = useState<PickedTarget | null>(
    params.courseId ? { courseId: params.courseId, weekNo: Number(params.weekNo) || undefined } : null,
  );
  const [picking, setPicking] = useState(false);
  const [type, setType] = useState<CaptureType>("text");
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<PickedFile[]>([]);
  const [docs, setDocs] = useState<PickedFile[]>([]);
  const [url, setUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [consent, setConsent] = useState(false); // "Hocadan kayıt izni aldım"
  // Audio imported from a file (picker or share): its own target (default inbox) and, when the course has
  // several sessions that week, which one it belongs to. The auto-assignment rule is NOT used for imports.
  const [imported, setImported] = useState<ImportedAudio | null>(null);
  const [importTarget, setImportTarget] = useState<PickedTarget | null>(null); // null = inbox
  const [importSession, setImportSession] = useState<string | null>(null);
  const audioLimitMin = useAudioLimitMin();
  const recording = rec.status !== "idle"; // a recording is in progress: this sheet is its control panel

  const importMode = type === "audio" && imported !== null && !recording;
  const importCourse = importMode && importTarget?.courseId ? schedule.courses.find((c) => c._id === importTarget.courseId) : undefined;
  const importSessions = importCourse ? [...importCourse.sessions].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)) : [];
  const sessionMissing = importSessions.length > 1 && !importSession;
  const manualCourse = manual?.courseId ? schedule.courses.find((c) => c._id === manual.courseId) : undefined;
  const target = importMode
    ? importTarget?.courseId
      ? { course: importCourse, weekNo: importTarget.weekNo ?? schedule.weekNo ?? 1 }
      : null // imports go to the inbox unless a lesson is picked
    : manual
      ? manual.courseId
        ? { course: manualCourse, weekNo: manual.weekNo ?? schedule.weekNo ?? 1 }
        : null // inbox chosen by hand
      : schedule.autoTarget;

  const label = target?.course ? `${target.course.name || target.course.code} · ${target.weekNo}. hafta` : "Gelen kutusu";
  const caption = importMode
    ? importTarget?.courseId
      ? "Elle seçildi · kayıt o dersin saatine işlenir"
      : "Gelen kutusuna gider; dersi yazıdan tahmin edilir ya da sen seçersin"
    : manual
      ? "Elle seçildi"
      : schedule.autoTarget
        ? "Şu an derstesin, otomatik seçildi"
        : "Ders saati dışında, gelen kutusuna gider";

  // Recomputed at save time, not at open time: opened at 08:45, saved at 09:05 -> the course.
  function resolveTarget(): { courseId: string; weekNo: number } | { courseId: null; weekNo?: undefined } {
    if (manual) {
      return manual.courseId
        ? { courseId: manual.courseId, weekNo: manual.weekNo ?? schedule.weekNo ?? 1 }
        : { courseId: null };
    }
    const auto = findAutoTarget(schedule.semester, schedule.courses, new Date(), timeZone);
    return auto ? { courseId: auto.course._id, weekNo: auto.weekNo } : { courseId: null };
  }

  // Opened again from the "Kayıt sürüyor" strip: show the recorder.
  useEffect(() => {
    if (rec.status !== "idle") setType("audio");
  }, [rec.status]);

  async function startRecording() {
    if (!consent) return;
    setError(null);
    const started = await rec.start({ target: resolveTarget() }); // the start of the recording decides where it goes
    if (!started) setError(null); // the reason is in rec.error
  }

  async function finishRecording() {
    const ok = await rec.finish();
    if (ok) router.back();
  }

  // Closing the sheet never stops a recording by accident.
  function closeSheet() {
    if (rec.status === "idle" || rec.status === "starting" || rec.status === "finishing") {
      router.back();
      return;
    }
    Alert.alert("Kayıt sürüyor", "Kaydı ne yapalım?", [
      { text: "Kayıt sürsün", onPress: () => router.back() },
      { text: "Bitir ve kaydet", onPress: () => void finishRecording() },
      {
        text: "Kaydı sil",
        style: "destructive",
        onPress: () =>
          Alert.alert("Kaydı sil", "Şimdiye kadarki kayıt silinecek.", [
            { text: "Vazgeç", style: "cancel" },
            { text: "Sil", style: "destructive", onPress: () => void rec.discard().then(() => router.back()) },
          ]),
      },
    ]);
  }

  // Content shared from another app (WhatsApp, Drive, a browser ...): fill the screen, the user presses Kaydet.
  useEffect(() => {
    if (!hasShareIntent) return;
    setFromShare(true);
    const files = shareIntent.files ?? [];
    const toPicked = (f: (typeof files)[number]): PickedFile => ({
      uri: f.path,
      name: f.fileName || (f.mimeType?.startsWith("image/") ? "foto.jpg" : "belge"),
      size: f.size ?? undefined,
    });

    if (files.length > 0) {
      const images = files.filter((f) => f.mimeType?.startsWith("image/"));
      const docsShared = files.filter(isDocument);
      const audios = files.filter(isAudioFile);
      if (images.length === 0 && docsShared.length === 0 && audios.length > 0) {
        // A shared voice note (WhatsApp .opus ...): the Ses type in import mode; the user picks the lesson, default inbox.
        const first = audios[0]!;
        setType("audio");
        if (isAmrFile(first)) {
          setError("AMR biçimi desteklenmiyor. Ses dosyasını m4a, mp3 ya da ogg olarak paylaş.");
        } else {
          setImportFile({ uri: first.path, name: first.fileName || "ses", size: first.size ?? undefined });
          if (audios.length > 1) setError("Bir seferde tek ses dosyası eklenir; ilkini ekledim.");
        }
      } else if (images.length > 0) {
        setType("image");
        setPhotos(images.slice(0, MAX_PHOTOS).map(toPicked));
        setError(null);
      } else if (docsShared.length > 0) {
        const fit = docsShared.filter((f) => (f.size ?? 0) <= MAX_DOC_BYTES);
        setType("document");
        setDocs(fit.slice(0, MAX_DOCS).map(toPicked));
        setError(fit.length < docsShared.length ? "Dosya en fazla 20 MB olabilir" : null);
      } else {
        setError("Bu dosya türü desteklenmiyor. Fotoğraf, PDF, DOCX, PPTX ve ses paylaşabilirsin.");
      }
    } else if (shareIntent.webUrl) {
      const link = shareIntent.webUrl;
      // WhatsApp-style shares carry a sentence around the address: keep it as the title.
      const title = (shareIntent.meta?.title || (shareIntent.text ?? "").replace(link, "")).replace(/\s+/g, " ").trim();
      setType("link");
      setUrl(link);
      setLinkTitle(title.slice(0, 120));
      setError(null);
    } else if (shareIntent.text) {
      setType("text");
      setText(shareIntent.text.slice(0, 20000));
      setError(null);
    }
  }, [hasShareIntent, shareIntent]);

  // Leaving the screen (saved, closed or swiped away) ends the share, so it is not handled twice.
  // (resetShareIntent is a new function every render, so it is read through a ref and runs on unmount only.)
  const resetRef = useRef(resetShareIntent);
  resetRef.current = resetShareIntent;
  useEffect(() => () => resetRef.current(), []);

  function addPhotos(result: ImagePicker.ImagePickerResult) {
    if (result.canceled) return;
    setError(null);
    setPhotos((prev) =>
      [...prev, ...result.assets.map((a) => ({ uri: a.uri, name: a.fileName ?? "foto.jpg", size: a.fileSize }))].slice(0, MAX_PHOTOS),
    );
  }

  // quality 0.7 compresses on the device; the server shrinks further (max 2000 px).
  async function pickFromCamera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setError("Kamera izni gerekli. Ayarlardan izin verebilirsin.");
      return;
    }
    addPhotos(await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7 }));
  }

  async function pickFromGallery() {
    addPhotos(
      await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: Math.max(1, MAX_PHOTOS - photos.length),
        quality: 0.7,
      }),
    );
  }

  /** Starts an import: the file is kept as is, its length is read in the background. */
  function setImportFile(file: ImportedAudio) {
    if ((file.size ?? 0) > AUDIO_IMPORT_MAX_BYTES) {
      setError("Ses dosyası en fazla 100 MB olabilir");
      return;
    }
    setError(null);
    setImportSession(null);
    setImported({ ...file, durationSec: undefined });
    void readAudioFileDuration(file.uri).then((durationSec) =>
      setImported((prev) => (prev && prev.uri === file.uri ? { ...prev, durationSec } : prev)),
    );
  }

  async function pickAudioFile() {
    const res = await DocumentPicker.getDocumentAsync({ type: AUDIO_PICKER_TYPES, multiple: false, copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    if (isAmrFile({ mimeType: a.mimeType, fileName: a.name })) {
      setError("AMR biçimi desteklenmiyor. Ses dosyasını m4a, mp3 ya da ogg olarak ekle.");
      return;
    }
    setImportFile({ uri: a.uri, name: a.name, size: a.size });
  }

  async function pickDocuments() {
    const res = await DocumentPicker.getDocumentAsync({ type: DOC_TYPES, multiple: true, copyToCacheDirectory: true });
    if (res.canceled) return;
    const tooBig = res.assets.filter((a) => (a.size ?? 0) > MAX_DOC_BYTES);
    setError(tooBig.length ? "Dosya en fazla 20 MB olabilir" : null);
    const ok = res.assets.filter((a) => (a.size ?? 0) <= MAX_DOC_BYTES);
    setDocs((prev) => [...prev, ...ok.map((a) => ({ uri: a.uri, name: a.name, size: a.size }))].slice(0, MAX_DOCS));
  }

  // "Kaydet" only writes to the device (text, address, a copy of each file) and returns at once; the
  // outbox sends in the background and keeps retrying when there is no connection.
  async function save() {
    if (saving) return;
    setError(null);
    const target = resolveTarget(); // decided now, at capture time, not when it is finally sent
    const source = fromShare ? ("share-intent" as const) : ("app" as const);
    const notes: NewOutboxNote[] = [];

    if (importMode && imported) {
      const where = importTarget?.courseId
        ? {
            courseId: importTarget.courseId,
            weekNo: importTarget.weekNo ?? schedule.weekNo ?? 1,
            ...(importSession ? { sessionId: importSession } : {}),
          }
        : { courseId: null };
      notes.push({ kind: "audio", imported: true, target: where, file: { uri: imported.uri, name: imported.name }, source: fromShare ? "share-intent" : "import" });
    } else if (type === "image" || type === "document") {
      for (const f of type === "image" ? photos : docs) {
        notes.push({ kind: type, target, file: { uri: f.uri, name: f.name }, source });
      }
    } else if (type === "link") {
      const normalized = normalizeUrl(url);
      if (!normalized) {
        setError("Geçerli bir web adresi gir");
        return;
      }
      notes.push({ kind: "link", target, url: normalized, title: linkTitle.trim() || undefined, source });
    } else if (text.trim()) {
      notes.push({ kind: "text", target, markdown: text.trim(), source });
    }
    if (notes.length === 0) return;

    setSaving(true);
    try {
      for (const note of notes) await outbox.add(note);
      router.back();
    } catch {
      setError("Not cihaza kaydedilemedi, depolama alanını kontrol et");
      setSaving(false);
    }
  }

  const busy = saving || rec.status === "starting" || rec.status === "finishing";
  const canSave =
    !busy &&
    (type !== "audio" || importMode) && // a recording has its own controls
    (importMode
      ? !sessionMissing
      : type === "image"
      ? photos.length > 0
      : type === "document"
        ? docs.length > 0
        : type === "link"
          ? url.trim().length > 0
          : text.trim().length > 0);

  return (
    <KeyboardAvoidingView className="flex-1 bg-bg" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 24, gap: 16 }}
      >
        <View className="flex-row items-center justify-between">
          <Text className="font-heading text-3xl text-ink">Hızlı not</Text>
          <Pressable
            onPress={closeSheet}
            accessibilityRole="button"
            accessibilityLabel="Kapat"
            className="h-11 w-11 items-center justify-center rounded-xl bg-line/60"
          >
            <Ionicons name="close" size={22} color="#18181B" />
          </Pressable>
        </View>

        <View className="flex-row items-center gap-3 rounded-2xl bg-line/50 p-4">
          <View
            className="h-12 w-1.5 rounded-full"
            style={{ backgroundColor: target?.course?.color ?? "#A1A19B" }}
          />
          <View className="flex-1">
            <Text className="font-body text-sm text-muted">Kaydedileceği yer</Text>
            <Text numberOfLines={2} className="font-body-semibold text-lg text-ink">
              {label}
            </Text>
            <Text className={`font-body text-sm ${!importMode && !manual && schedule.autoTarget ? "text-green-700" : "text-muted"}`}>{caption}</Text>
          </View>
          <View className="items-end gap-1">
            <Pressable
              onPress={() => setPicking(true)}
              disabled={!schedule.semester || recording}
              className="min-h-touch items-center justify-center rounded-xl border border-line bg-card px-4"
            >
              <Text className="font-body-semibold text-base text-ink">Değiştir</Text>
            </Pressable>
            {manual && !importMode ? (
              <Pressable onPress={() => setManual(null)} className="min-h-touch justify-center px-1">
                <Text className="font-body-medium text-sm text-primary">Otomatik seç</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View className="flex-row flex-wrap gap-3">
          {TYPES.map((t) => (
            <Pressable
              key={t.key}
              disabled={!t.active || busy || recording}
              onPress={() => setType(t.key as CaptureType)}
              accessibilityRole="button"
              accessibilityState={{ disabled: !t.active, selected: t.active && type === t.key }}
              className={`min-h-[76px] items-center justify-center rounded-2xl border-2 px-2 ${
                !t.active
                  ? "border-transparent bg-line/50 opacity-60"
                  : type === t.key
                    ? "border-primary bg-primary-soft"
                    : "border-line bg-card"
              }`}
              style={{ width: "31%" }}
            >
              <Ionicons name={t.icon} size={24} color={t.active && type === t.key ? "#3730A3" : "#6B6B66"} />
              <Text className={`mt-1 font-body-medium text-sm ${t.active && type === t.key ? "text-primary-dark" : "text-muted"}`}>{t.label}</Text>
              {!t.active ? <Text className="font-body text-xs text-muted">yakında</Text> : null}
            </Pressable>
          ))}
        </View>

        {type === "audio" ? (
          <View className="gap-4">
            {recording ? (
              <View className="items-center gap-4 rounded-2xl border border-line bg-card p-6">
                <View className="flex-row items-center gap-2">
                  <View className={`h-3 w-3 rounded-full ${rec.status === "recording" ? "bg-red-500" : "bg-amber-400"}`} />
                  <Text className="font-body-medium text-base text-muted">
                    {rec.status === "recording"
                      ? "Kayıt sürüyor"
                      : rec.status === "paused"
                        ? "Duraklatıldı"
                        : rec.status === "interrupted"
                          ? "Kayıt kesildi (arama ya da sistem)"
                          : "Kaydediliyor…"}
                  </Text>
                </View>
                <Text className="font-heading text-6xl text-ink" accessibilityLabel={`Kayıt süresi ${formatDuration(rec.elapsedSec)}`}>
                  {formatDuration(rec.elapsedSec)}
                </Text>
                <View className="w-full flex-row gap-3">
                  {rec.status === "recording" ? (
                    <Pressable
                      onPress={rec.pause}
                      accessibilityRole="button"
                      className="min-h-[56px] flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-line bg-card active:opacity-80"
                    >
                      <Ionicons name="pause" size={22} color="#18181B" />
                      <Text className="font-body-semibold text-base text-ink">Duraklat</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => void rec.resume()}
                      disabled={busy}
                      accessibilityRole="button"
                      className="min-h-[56px] flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-line bg-card active:opacity-80"
                    >
                      <Ionicons name="mic" size={22} color="#18181B" />
                      <Text className="font-body-semibold text-base text-ink">Devam</Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => void finishRecording()}
                    disabled={busy}
                    accessibilityRole="button"
                    className="min-h-[56px] flex-1 flex-row items-center justify-center gap-2 rounded-2xl bg-primary active:opacity-80"
                  >
                    <Ionicons name="stop" size={22} color="#FFFFFF" />
                    <Text className="font-body-semibold text-base text-white">Bitir</Text>
                  </Pressable>
                </View>
                {rec.elapsedSec > audioLimitMin * 60 ? (
                  <View className="w-full rounded-xl bg-amber-100 p-3">
                    <Text className="font-body-semibold text-sm text-amber-900">Bu kayıt otomatik işlenmeyecek</Text>
                    <Text className="font-body text-sm text-amber-900">
                      {audioLimitMin} dakikadan uzun kayıtlar yazıya çevrilmez. Kayıt sürer ve dinlenebilir; önemli kısmını kırpıp tekrar yükleyebilirsin.
                    </Text>
                  </View>
                ) : null}
                <Text className="text-center font-body text-sm text-muted">
                  Ekran kapansa ve uygulama arka planda olsa da kayıt sürer. Bildirimdeki "Kayıt yapılıyor" yazısı bu yüzdendir.
                </Text>
              </View>
            ) : importMode && imported ? (
              <View className="gap-3">
                <View className="min-h-touch flex-row items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3">
                  <Ionicons name="musical-notes-outline" size={22} color="#9D174D" />
                  <View className="flex-1">
                    <Text numberOfLines={1} className="font-body-medium text-base text-ink">
                      {imported.name}
                    </Text>
                    <Text className="font-body text-sm text-muted">
                      {[
                        formatSize(imported.size),
                        imported.durationSec === undefined ? "süre okunuyor…" : imported.durationSec ? formatDuration(imported.durationSec) : "süre okunamadı",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => {
                      setImported(null);
                      setImportSession(null);
                    }}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="Dosyayı çıkar"
                    hitSlop={8}
                    className="h-11 w-11 items-center justify-center"
                  >
                    <Ionicons name="close" size={20} color="#6B6B66" />
                  </Pressable>
                </View>
                {imported.durationSec && imported.durationSec > audioLimitMin * 60 ? (
                  <View className="rounded-xl bg-amber-100 p-3">
                    <Text className="font-body-semibold text-sm text-amber-900">Bu kayıt otomatik işlenmeyecek</Text>
                    <Text className="font-body text-sm text-amber-900">
                      Kayıt {audioLimitMin} dakikadan uzun; eklenir ve dinlenebilir ama yazıya çevrilmez. Önemli kısmını kırpıp yüklersen çevrilir.
                    </Text>
                  </View>
                ) : null}
                {importSessions.length > 1 ? (
                  <View className="gap-2">
                    <Text className="font-body-medium text-base text-ink">Hangi oturum?</Text>
                    <View className="flex-row flex-wrap gap-2">
                      {importSessions.map((s) => {
                        const selected = importSession === s._id;
                        return (
                          <Pressable
                            key={s._id}
                            onPress={() => setImportSession(s._id)}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            className={`min-h-touch justify-center rounded-xl border px-4 ${selected ? "border-primary bg-primary-soft" : "border-line bg-card"}`}
                          >
                            <Text className={`font-body-medium text-base ${selected ? "text-primary-dark" : "text-ink"}`}>
                              {DAY_SHORT[s.day]} {s.start}–{s.end} · {s.kind}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}
                <Text className="font-body text-sm text-muted">
                  Başkasına ait bir kaydı eklemeden önce kaydeden kişinin ve hocanın bundan haberi olduğundan emin ol. Kayıt arka planda yazıya çevrilir ve bölümlere ayrılır.
                </Text>
              </View>
            ) : (
              <>
                <Pressable
                  onPress={() => void pickAudioFile()}
                  disabled={busy}
                  accessibilityRole="button"
                  className="min-h-[56px] flex-row items-center justify-center gap-2 rounded-2xl border border-line bg-card active:opacity-80"
                >
                  <Ionicons name="folder-open-outline" size={22} color="#18181B" />
                  <Text className="font-body-semibold text-base text-ink">Dosyadan ekle</Text>
                </Pressable>
                <Pressable
                  onPress={() => setConsent((c) => !c)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: consent }}
                  className="min-h-touch flex-row items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3 active:opacity-80"
                >
                  <Ionicons name={consent ? "checkbox" : "square-outline"} size={26} color={consent ? "#4338CA" : "#6B6B66"} />
                  <Text className="flex-1 font-body-medium text-base text-ink">Hocadan kayıt izni aldım</Text>
                </Pressable>
                <Pressable
                  onPress={() => void startRecording()}
                  disabled={!consent || busy}
                  accessibilityRole="button"
                  className={`min-h-[64px] flex-row items-center justify-center gap-2 rounded-2xl ${consent && !busy ? "bg-primary active:opacity-80" : "bg-line"}`}
                >
                  <Ionicons name="mic" size={24} color={consent && !busy ? "#FFFFFF" : "#6B6B66"} />
                  <Text className={`font-body-semibold text-lg ${consent && !busy ? "text-white" : "text-muted"}`}>
                    {rec.status === "starting" ? "Başlıyor…" : "Kaydı başlat"}
                  </Text>
                </Pressable>
                <Text className="font-body text-sm text-muted">
                  Kayıt 10 dakikalık parçalar halinde cihaza yazılır; uygulama kapanırsa kaldığı yerden kurtarılır. Bitirince arka planda yazıya çevrilir ve bölümlere ayrılır.
                </Text>
              </>
            )}
            {rec.error ? <Text className="font-body text-sm text-red-700">{rec.error}</Text> : null}
          </View>
        ) : null}

        {type === "image" ? (
          <View className="gap-3">
            <View className="flex-row gap-3">
              <Pressable
                onPress={pickFromCamera}
                disabled={busy || photos.length >= MAX_PHOTOS}
                accessibilityRole="button"
                className="min-h-[56px] flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-line bg-card active:opacity-80"
              >
                <Ionicons name="camera-outline" size={22} color="#18181B" />
                <Text className="font-body-semibold text-base text-ink">{photos.length ? "Bir tane daha" : "Kamera"}</Text>
              </Pressable>
              <Pressable
                onPress={pickFromGallery}
                disabled={busy || photos.length >= MAX_PHOTOS}
                accessibilityRole="button"
                className="min-h-[56px] flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-line bg-card active:opacity-80"
              >
                <Ionicons name="images-outline" size={22} color="#18181B" />
                <Text className="font-body-semibold text-base text-ink">Galeri</Text>
              </Pressable>
            </View>
            {photos.length > 0 ? (
              <View className="flex-row flex-wrap gap-3">
                {photos.map((p) => (
                  <View key={p.uri} className="h-24 w-24">
                    <Image source={{ uri: p.uri }} className="h-24 w-24 rounded-xl bg-line" resizeMode="cover" />
                    <Pressable
                      onPress={() => setPhotos((prev) => prev.filter((x) => x.uri !== p.uri))}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel="Fotoğrafı çıkar"
                      hitSlop={8}
                      className="absolute -right-2 -top-2 h-7 w-7 items-center justify-center rounded-full bg-ink"
                    >
                      <Ionicons name="close" size={16} color="#FFFFFF" />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="font-body text-sm text-muted">Fotoğraf çek ya da galeriden seç; her fotoğraf ayrı bir not olur.</Text>
            )}
          </View>
        ) : null}

        {type === "document" ? (
          <View className="gap-3">
            <Pressable
              onPress={pickDocuments}
              disabled={busy || docs.length >= MAX_DOCS}
              accessibilityRole="button"
              className="min-h-[56px] flex-row items-center justify-center gap-2 rounded-2xl border border-line bg-card active:opacity-80"
            >
              <Ionicons name="document-attach-outline" size={22} color="#18181B" />
              <Text className="font-body-semibold text-base text-ink">{docs.length ? "Dosya ekle" : "Dosya seç"}</Text>
            </Pressable>
            {docs.length > 0 ? (
              <View className="gap-2">
                {docs.map((d) => (
                  <View key={d.uri} className="min-h-touch flex-row items-center gap-3 rounded-2xl border border-line bg-card px-4 py-2">
                    <Ionicons name="document-outline" size={22} color="#9A3412" />
                    <View className="flex-1">
                      <Text numberOfLines={1} className="font-body-medium text-base text-ink">
                        {d.name}
                      </Text>
                      <Text className="font-body text-sm text-muted">{formatSize(d.size)}</Text>
                    </View>
                    <Pressable
                      onPress={() => setDocs((prev) => prev.filter((x) => x.uri !== d.uri))}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel="Dosyayı çıkar"
                      hitSlop={8}
                      className="h-11 w-11 items-center justify-center"
                    >
                      <Ionicons name="close" size={20} color="#6B6B66" />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="font-body text-sm text-muted">PDF, Word (DOCX) ya da PowerPoint (PPTX), en fazla 20 MB; her dosya ayrı bir not olur.</Text>
            )}
          </View>
        ) : null}

        {type === "link" ? (
          <View className="gap-3">
            <View>
              <Text className="mb-1 font-body-medium text-base text-ink">Web adresi</Text>
              <TextInput
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://"
                placeholderTextColor="#A1A19B"
                className="min-h-[52px] rounded-2xl border border-line bg-card px-4 font-body text-base text-ink"
              />
            </View>
            <View>
              <Text className="mb-1 font-body-medium text-base text-ink">Başlık (isteğe bağlı)</Text>
              <TextInput
                value={linkTitle}
                onChangeText={setLinkTitle}
                maxLength={120}
                placeholder="Bu bağlantı ne hakkında?"
                placeholderTextColor="#A1A19B"
                className="min-h-[52px] rounded-2xl border border-line bg-card px-4 font-body text-base text-ink"
              />
            </View>
          </View>
        ) : null}

        {type === "text" ? (
          <View>
            <Text className="mb-1 font-body-medium text-base text-ink">Not</Text>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              autoFocus
              textAlignVertical="top"
              maxLength={20000}
              placeholder="Derste ne konuşuldu?"
              placeholderTextColor="#A1A19B"
              className="min-h-[180px] rounded-2xl border border-line bg-card p-4 font-body text-base text-ink"
            />
          </View>
        ) : null}

        {error ? <Text className="font-body text-sm text-red-700">{error}</Text> : null}
      </ScrollView>

      {type !== "audio" || importMode ? (
      <View className="px-5" style={{ paddingBottom: insets.bottom + 16 }}>
        <Pressable
          onPress={save}
          disabled={!canSave}
          className={`min-h-[56px] items-center justify-center rounded-2xl ${canSave ? "bg-primary active:opacity-80" : "bg-line"}`}
        >
          <Text className={`font-body-semibold text-base ${canSave ? "text-white" : "text-muted"}`}>
            {busy ? "Kaydediliyor…" : "Kaydet"}
          </Text>
        </Pressable>
      </View>
      ) : null}

      {picking && schedule.semester ? (
        <TargetPicker
          visible
          courses={schedule.courses}
          weekCount={schedule.semester.weekCount}
          currentWeekNo={schedule.weekNo}
          value={
            importMode
              ? importTarget
              : (manual ?? (schedule.autoTarget ? { courseId: schedule.autoTarget.course._id, weekNo: schedule.autoTarget.weekNo } : null))
          }
          allowInbox
          onSelect={(t) => {
            if (importMode) {
              setImportTarget(t.courseId ? t : null);
              setImportSession(null);
            } else {
              setManual(t);
            }
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
