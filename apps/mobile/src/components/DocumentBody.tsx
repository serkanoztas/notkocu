import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { NoteItem } from "@notkocu/shared";
import { openDocument } from "../lib/files";

type DocumentNote = Extract<NoteItem, { type: "document" }>;

const UNIT_LABEL = { page: "Sayfa", slide: "Slayt", section: "Bölüm" } as const;
const UNIT_COUNT = { page: "sayfa", slide: "slayt", section: "bölüm" } as const;
const PREVIEW_PAGES = 5;

/** Document note: summary, page by page text and "open the original file". */
export function DocumentBody({ note, onRetry, retrying }: { note: DocumentNote; onRetry: () => void; retrying: boolean }) {
  const { content } = note;
  const unit = content.unit ?? "page";
  const pages = content.pages ?? [];
  const [showAll, setShowAll] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  async function open() {
    setOpening(true);
    setOpenError(null);
    try {
      await openDocument(content);
    } catch {
      setOpenError("Dosya açılamadı, bağlantını kontrol edip tekrar dene");
    } finally {
      setOpening(false);
    }
  }

  const shown = showAll ? pages : pages.slice(0, PREVIEW_PAGES);
  const processing = note.status === "pending" || note.status === "processing";

  return (
    <>
      <View className="flex-row items-center gap-3 rounded-2xl border border-line bg-card p-4">
        <Ionicons name="document-outline" size={28} color="#9A3412" />
        <View className="flex-1">
          <Text numberOfLines={2} className="font-body-semibold text-base text-ink">
            {content.fileName ?? note.title}
          </Text>
          {content.pageCount ? (
            <Text className="font-body text-sm text-muted">
              {content.pageCount} {UNIT_COUNT[unit]}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={open}
          disabled={opening}
          accessibilityRole="button"
          className="min-h-touch justify-center rounded-xl border border-line bg-bg px-4 active:opacity-80"
        >
          <Text className="font-body-semibold text-base text-ink">{opening ? "Açılıyor…" : "Dosyayı aç"}</Text>
        </Pressable>
      </View>
      {openError ? <Text className="font-body text-sm text-red-700">{openError}</Text> : null}

      {processing ? (
        <View className="rounded-2xl border border-line bg-card p-4">
          <Text className="font-body text-base text-muted">İşleniyor…</Text>
        </View>
      ) : note.status === "failed" ? (
        <View className="rounded-2xl border border-red-200 bg-card p-4">
          <Text className="font-body-semibold text-base text-red-700">Belge işlenemedi</Text>
          <Pressable
            onPress={onRetry}
            disabled={retrying}
            accessibilityRole="button"
            className="mt-3 min-h-touch justify-center self-start rounded-xl border border-line bg-white px-4"
          >
            <Text className="font-body-medium text-base text-ink">{retrying ? "Gönderiliyor…" : "Tekrar dene"}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {note.aiSummary ? (
            <View className="rounded-2xl bg-primary-soft p-4">
              <View className="flex-row items-center gap-2">
                <Ionicons name="sparkles-outline" size={18} color="#3730A3" />
                <Text className="font-body-semibold text-base text-primary-dark">Özet</Text>
              </View>
              <Text selectable className="mt-2 font-body text-base leading-6 text-primary-dark">
                {note.aiSummary}
              </Text>
            </View>
          ) : null}

          {shown.map((text, i) => (
            <View key={i} className="rounded-2xl border border-line bg-card p-4">
              <Text className="mb-2 font-body-semibold text-sm text-muted">
                {UNIT_LABEL[unit]} {i + 1}
              </Text>
              <Text selectable className="font-body text-base leading-6 text-ink">
                {text || "(Bu bölümde metin yok)"}
              </Text>
            </View>
          ))}
          {pages.length > PREVIEW_PAGES && !showAll ? (
            <Pressable
              onPress={() => setShowAll(true)}
              accessibilityRole="button"
              className="min-h-touch items-center justify-center rounded-xl border border-line bg-card px-4"
            >
              <Text className="font-body-medium text-base text-ink">Tümünü göster ({pages.length} {UNIT_COUNT[unit]})</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </>
  );
}
