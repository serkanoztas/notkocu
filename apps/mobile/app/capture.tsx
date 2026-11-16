import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TargetPicker, type PickedTarget } from "../src/components/TargetPicker";
import { useCreateImageNote, useCreateNote } from "../src/hooks/queries";
import { useNow, useTimeZone } from "../src/hooks/useNow";
import { findAutoTarget, useScheduleNow } from "../src/hooks/useSchedule";
import { ApiError } from "../src/lib/api";

type IconName = keyof typeof Ionicons.glyphMap;

const TYPES: { key: string; label: string; icon: IconName; active: boolean }[] = [
  { key: "text", label: "Metin", icon: "reorder-three-outline", active: true },
  { key: "image", label: "Fotoğraf", icon: "camera-outline", active: true },
  { key: "audio", label: "Ses kaydı", icon: "mic-outline", active: false },
  { key: "document", label: "Dosya", icon: "document-outline", active: false },
  { key: "link", label: "Link", icon: "link-outline", active: false },
  { key: "task", label: "Görev", icon: "checkbox-outline", active: false },
];

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "STORAGE_LIMIT") return "Depolama alanın doldu";
    if (err.code === "IMAGE_TOO_LARGE") return "Fotoğraf çok büyük";
    return err.code === "NETWORK" || err.code === "TIMEOUT" ? "Bağlantı yok, not kaydedilemedi" : err.message;
  }
  return "Not kaydedilemedi, tekrar dene";
}

export default function CaptureScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ courseId?: string; weekNo?: string }>();
  const timeZone = useTimeZone();
  const now = useNow(); // the shown target refreshes once a minute while this sheet is open
  const schedule = useScheduleNow(now);
  const create = useCreateNote();
  const createImage = useCreateImageNote();

  // A target the user chose by hand (or via "Not al" on a course) stays fixed; otherwise it follows the clock.
  const [manual, setManual] = useState<PickedTarget | null>(
    params.courseId ? { courseId: params.courseId, weekNo: Number(params.weekNo) || undefined } : null,
  );
  const [picking, setPicking] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<"text" | "image">("text");
  const [photos, setPhotos] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

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

  const MAX_PHOTOS = 10;

  function addPhotos(result: ImagePicker.ImagePickerResult) {
    if (result.canceled) return;
    setError(null);
    setPhotos((prev) => [...prev, ...result.assets.map((a) => a.uri)].slice(0, MAX_PHOTOS));
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

  // One note per photo, uploaded one after another. Uploaded photos leave the list; a failure stops
  // the batch and keeps the rest so "Kaydet" can be pressed again.
  async function savePhotos() {
    if (photos.length === 0 || createImage.isPending) return;
    setError(null);
    const target = resolveTarget();
    const total = photos.length;
    let done = 0;
    for (const uri of [...photos]) {
      setProgress({ done, total });
      try {
        await createImage.mutateAsync({ uri, target });
      } catch (e) {
        setProgress(null);
        setError(errorText(e));
        return;
      }
      done += 1;
      setPhotos((prev) => prev.filter((p) => p !== uri));
    }
    setProgress(null);
    router.back();
  }

  function save() {
    if (type === "image") return void savePhotos();
    if (!text.trim() || create.isPending) return;
    setError(null);
    const resolved = resolveTarget();
    create.mutate(
      { type: "text", markdown: text.trim(), ...resolved },
      { onSuccess: () => router.back(), onError: (e) => setError(errorText(e)) },
    );
  }

  const busy = create.isPending || createImage.isPending;
  const canSave = !busy && (type === "image" ? photos.length > 0 : text.trim().length > 0);

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
              onPress={() => setType(t.key as "text" | "image")}
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
                {photos.map((uri) => (
                  <View key={uri} className="h-24 w-24">
                    <Image source={{ uri }} className="h-24 w-24 rounded-xl bg-line" resizeMode="cover" />
                    <Pressable
                      onPress={() => setPhotos((prev) => prev.filter((p) => p !== uri))}
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
        ) : (
        <View>
          <Text className="mb-1 font-body-medium text-base text-ink">Not</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoFocus={type === "text"}
            textAlignVertical="top"
            maxLength={20000}
            placeholder="Derste ne konuşuldu?"
            placeholderTextColor="#A1A19B"
            className="min-h-[180px] rounded-2xl border border-line bg-card p-4 font-body text-base text-ink"
          />
        </View>
        )}

        {error ? <Text className="font-body text-sm text-red-700">{error}</Text> : null}
      </ScrollView>

      <View className="px-5" style={{ paddingBottom: insets.bottom + 16 }}>
        <Pressable
          onPress={save}
          disabled={!canSave}
          className={`min-h-[56px] items-center justify-center rounded-2xl ${canSave ? "bg-primary active:opacity-80" : "bg-line"}`}
        >
          <Text className={`font-body-semibold text-base ${canSave ? "text-white" : "text-muted"}`}>
            {progress ? `Yükleniyor ${Math.min(progress.done + 1, progress.total)}/${progress.total}…` : busy ? "Kaydediliyor…" : "Kaydet"}
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
