import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StepHeader } from "../../src/components/StepHeader";
import { api, ApiError } from "../../src/lib/api";
import { displayToIso, isMonday, isoToDisplay, maskDisplayDate, nearestMonday } from "../../src/lib/dates";
import { useScheduleDraft } from "../../src/lib/scheduleDraft";

const MAX_BYTES = 8 * 1024 * 1024;
const STEPS = ["Görsel yükleniyor", "Dersler okunuyor", "Saatler kontrol ediliyor"] as const;

type Picked = { uri: string; name: string; type: string };

function readErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "SCHEDULE_UNREADABLE") return "Program okunamadı";
    if (err.status === 413) return "Görsel çok büyük (en fazla 8 MB)";
    if (err.status === 429) return "Çok fazla deneme yaptın, biraz bekleyip tekrar dene";
    if (err.status === 400 && err.code === "UNSUPPORTED_IMAGE_TYPE") return "Bu dosya türü desteklenmiyor";
    return err.message;
  }
  return "Program okunamadı";
}

function Steps({ active }: { active: number }) {
  return (
    <View className="gap-3 rounded-3xl border border-line bg-card p-5">
      {STEPS.map((label, i) => (
        <View key={label} className="flex-row items-center gap-3">
          {i < active ? (
            <Ionicons name="checkmark-circle" size={22} color="#16A34A" />
          ) : i === active ? (
            <ActivityIndicator size="small" color="#4338CA" />
          ) : (
            <Ionicons name="ellipse-outline" size={22} color="#A1A19B" />
          )}
          <Text className={`font-body text-base ${i <= active ? "text-ink" : "text-muted"}`}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

export default function ScheduleUploadScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const draft = useScheduleDraft();

  const [dateText, setDateText] = useState(isoToDisplay(draft.startDate));
  const [image, setImage] = useState<Picked | null>(null);
  const [reading, setReading] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The request is a single call; the steps only show that something is happening.
  useEffect(() => {
    if (!reading) return;
    setStep(0);
    const t1 = setTimeout(() => setStep(1), 1500);
    const t2 = setTimeout(() => setStep(2), 9000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [reading]);

  const iso = displayToIso(dateText);
  const nameOk = draft.name.trim().length > 0;
  const canProceed = !!image && !!iso && nameOk && !reading;

  function onPicked(result: ImagePicker.ImagePickerResult) {
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return;
    if (asset.fileSize && asset.fileSize > MAX_BYTES) {
      setError("Görsel çok büyük (en fazla 8 MB)");
      return;
    }
    setError(null);
    setImage({ uri: asset.uri, name: asset.fileName ?? "program.jpg", type: asset.mimeType ?? "image/jpeg" });
  }

  async function pickFromGallery() {
    onPicked(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.8 }));
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setError("Fotoğraf çekmek için kamera izni gerekli");
      return;
    }
    onPicked(await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.8 }));
  }

  /** Validates the semester fields; offers the nearest Monday when the date isn't one. */
  function commitSemester(then: () => void) {
    if (!iso) return;
    if (!isMonday(iso)) {
      const monday = nearestMonday(iso);
      Alert.alert(
        "Başlangıç Pazartesi olmalı",
        `Haftalar Pazartesi'den başlar. ${isoToDisplay(monday)} tarihini kullanalım mı?`,
        [
          { text: "Vazgeç", style: "cancel" },
          {
            text: "Kullan",
            onPress: () => {
              setDateText(isoToDisplay(monday));
              draft.setSemester({ startDate: monday });
              then();
            },
          },
        ],
      );
      return;
    }
    draft.setSemester({ startDate: iso });
    then();
  }

  function check() {
    if (!image) return;
    commitSemester(async () => {
      setError(null);
      setReading(true);
      try {
        const { courses } = await api.parseSchedule(image);
        draft.setCourses(courses);
        router.push("/onboarding/confirm");
      } catch (err) {
        setError(readErrorMessage(err));
      } finally {
        setReading(false);
      }
    });
  }

  function manual() {
    commitSemester(() => {
      draft.setCourses([]);
      router.push("/onboarding/confirm");
    });
  }

  return (
    <View className="flex-1 bg-bg">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 20, paddingHorizontal: 20, paddingBottom: 24 }}
      >
        <StepHeader step={1} />

        <Text className="mt-4 font-heading text-4xl text-ink">Dönemini kuralım</Text>
        <Text className="mt-2 font-body text-base text-muted">Haftalar bu tarihlerden otomatik oluşur.</Text>

        <View className="mt-6 flex-row gap-3">
          <View className="flex-1 gap-1">
            <Text className="font-body-medium text-sm text-muted">Dönem</Text>
            <TextInput
              className="min-h-[52px] rounded-2xl border border-line bg-card px-4 font-body text-lg text-ink"
              value={draft.name}
              onChangeText={(name) => draft.setSemester({ name })}
              maxLength={60}
            />
          </View>
          <View className="flex-1 gap-1">
            <Text className="font-body-medium text-sm text-muted">Başlangıç</Text>
            <TextInput
              className="min-h-[52px] rounded-2xl border border-line bg-card px-4 font-body text-lg text-ink"
              value={dateText}
              onChangeText={(t) => setDateText(maskDisplayDate(t))}
              keyboardType="number-pad"
              placeholder="GG.AA.YYYY"
              maxLength={10}
            />
          </View>
        </View>
        {dateText.length === 10 && !iso ? (
          <Text className="mt-2 font-body text-sm text-red-700">Geçerli bir tarih gir (GG.AA.YYYY)</Text>
        ) : null}

        <View className="mt-4 flex-row items-center justify-between">
          <Text className="font-body text-base text-muted">Hafta sayısı</Text>
          <View className="flex-row items-center gap-3">
            <Pressable
              accessibilityLabel="Hafta sayısını azalt"
              onPress={() => draft.setSemester({ weekCount: Math.max(1, draft.weekCount - 1) })}
              className="h-12 w-12 items-center justify-center rounded-xl border border-line bg-card"
            >
              <Ionicons name="remove" size={22} color="#18181B" />
            </Pressable>
            <Text className="w-8 text-center font-body-semibold text-xl text-ink">{draft.weekCount}</Text>
            <Pressable
              accessibilityLabel="Hafta sayısını artır"
              onPress={() => draft.setSemester({ weekCount: Math.min(30, draft.weekCount + 1) })}
              className="h-12 w-12 items-center justify-center rounded-xl border border-line bg-card"
            >
              <Ionicons name="add" size={22} color="#18181B" />
            </Pressable>
          </View>
        </View>

        <View className="mt-6 h-px bg-line" />
        <Text className="mt-5 font-heading text-2xl text-ink">Ders programı</Text>
        <Text className="mt-1 font-body text-base text-muted">OBS’den aldığın ekran görüntüsü yeterli.</Text>

        <View className="mt-4">
          {reading ? (
            <Steps active={step} />
          ) : (
            <View className="items-center gap-4 rounded-3xl border border-dashed border-line bg-card p-5">
              <Ionicons name="image-outline" size={40} color="#4338CA" />
              <Text className="font-body-medium text-lg text-ink">
                {image ? "Görsel seçildi" : "Görsel yükle, AI okusun"}
              </Text>
              <Pressable
                onPress={pickFromGallery}
                className="min-h-[56px] w-full items-center justify-center rounded-2xl bg-primary active:opacity-80"
              >
                <Text className="font-body-semibold text-base text-white">
                  {image ? "Başka görsel seç" : "Galeriden seç"}
                </Text>
              </Pressable>
              <Pressable
                onPress={takePhoto}
                className="min-h-[52px] w-full items-center justify-center rounded-2xl border border-line bg-card"
              >
                <Text className="font-body-medium text-base text-ink">Fotoğraf çek</Text>
              </Pressable>
            </View>
          )}
        </View>

        {error ? (
          <View className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4">
            <Text className="font-body-semibold text-base text-red-800">{error}</Text>
            {error === "Program okunamadı" ? (
              <Text className="mt-1 font-body text-sm text-red-800">
                Daha net bir görselle tekrar deneyebilir ya da dersleri elle girebilirsin.
              </Text>
            ) : null}
          </View>
        ) : null}

        <Pressable
          onPress={manual}
          disabled={reading || !iso || !nameOk}
          className="mt-5 min-h-touch items-center justify-center"
        >
          <Text className="font-body-medium text-base text-ink underline">Elle gireceğim</Text>
        </Pressable>
      </ScrollView>

      <View className="px-5" style={{ paddingBottom: insets.bottom + 16 }}>
        <Pressable
          onPress={check}
          disabled={!canProceed}
          className={`min-h-[56px] items-center justify-center rounded-2xl ${canProceed ? "bg-primary active:opacity-80" : "bg-line"}`}
        >
          <Text className={`font-body-semibold text-base ${canProceed ? "text-white" : "text-muted"}`}>Kontrol et</Text>
        </Pressable>
      </View>
    </View>
  );
}
