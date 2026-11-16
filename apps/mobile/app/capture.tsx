import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useShareIntentContext } from "expo-share-intent";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TargetPicker, type PickedTarget } from "../src/components/TargetPicker";
import type { NewOutboxNote } from "../src/lib/OutboxProvider";
import { useNow, useTimeZone } from "../src/hooks/useNow";
import { findAutoTarget, useScheduleNow } from "../src/hooks/useSchedule";
import { useOutbox } from "../src/lib/OutboxProvider";

type IconName = keyof typeof Ionicons.glyphMap;
type CaptureType = "text" | "image" | "document" | "link";

const TYPES: { key: string; label: string; icon: IconName; active: boolean }[] = [
  { key: "text", label: "Metin", icon: "reorder-three-outline", active: true },
  { key: "image", label: "Fotoğraf", icon: "camera-outline", active: true },
  { key: "audio", label: "Ses kaydı", icon: "mic-outline", active: false },
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

  const manualCourse = manual?.courseId ? schedule.courses.find((c) => c._id === manual.courseId) : undefined;
  const target = manual
    ? manual.courseId
      ? { course: manualCourse, weekNo: manual.weekNo ?? schedule.weekNo ?? 1 }
      : null // inbox chosen by hand
    : schedule.autoTarget;

  const label = target?.course ? `${target.course.name || target.course.code} · ${target.weekNo}. hafta` : "Gelen kutusu";
  const caption = manual
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
      if (images.length > 0) {
        setType("image");
        setPhotos(images.slice(0, MAX_PHOTOS).map(toPicked));
        setError(null);
      } else if (docsShared.length > 0) {
        const fit = docsShared.filter((f) => (f.size ?? 0) <= MAX_DOC_BYTES);
        setType("document");
        setDocs(fit.slice(0, MAX_DOCS).map(toPicked));
        setError(fit.length < docsShared.length ? "Dosya en fazla 20 MB olabilir" : null);
      } else {
        setError("Bu dosya türü desteklenmiyor. Fotoğraf, PDF, DOCX ve PPTX paylaşabilirsin.");
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

    if (type === "image" || type === "document") {
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

  const busy = saving;
  const canSave =
    !busy &&
    (type === "image"
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
            onPress={() => router.back()}
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
            <Text className={`font-body text-sm ${!manual && schedule.autoTarget ? "text-green-700" : "text-muted"}`}>{caption}</Text>
          </View>
          <View className="items-end gap-1">
            <Pressable
              onPress={() => setPicking(true)}
              disabled={!schedule.semester}
              className="min-h-touch items-center justify-center rounded-xl border border-line bg-card px-4"
            >
              <Text className="font-body-semibold text-base text-ink">Değiştir</Text>
            </Pressable>
            {manual ? (
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
              disabled={!t.active || busy}
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

      {picking && schedule.semester ? (
        <TargetPicker
          visible
          courses={schedule.courses}
          weekCount={schedule.semester.weekCount}
          currentWeekNo={schedule.weekNo}
          value={manual ?? (schedule.autoTarget ? { courseId: schedule.autoTarget.course._id, weekNo: schedule.autoTarget.weekNo } : null)}
          allowInbox
          onSelect={(t) => {
            setManual(t);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
