# NotKoçu Teknik Plan

Nov 9, 2026 · @serkan

## Genel bakış ve kapsam

NotKoçu, üniversite öğrencisinin ders notlarını **dönem → ders → hafta** düzeninde tutan, kişisel kullanıma yönelik bir mobil uygulamadır (iOS ve Android, Expo ile tek kod tabanı). Not metin, belge, görsel, ses, link, görev ya da kod olabilir. Hepsi ilgili haftanın altında toplanır ve AI ile metne çevrilir, özetlenir.

**Kapsamda:**

- Ders programını ekran görüntüsünden otomatik kurmak
- Ders saatinde alınan notu doğru ders ve haftaya otomatik atamak
- 7 not tipi ve her tip için AI işleme (OCR, transkript, metin çıkarma)
- Haftalık AI özeti
- Ders dışında alınan notlar için gelen kutusu ve AI'ın ders önerisi
- Not ve haftaları PDF olarak dışa aktarma; telefonun paylaşım menüsüyle çift yönlü entegrasyon

**Kapsam dışı (bilinçli karar):** Grup, not paylaşımı ve sohbet. WhatsApp, Teams ve Telegram bu ihtiyacı zaten karşılıyor. Uygulama bunun yerine onlarla paylaşım menüsü üzerinden çalışır.

**Web sürümü yok:** Not alma, kamera ve ses kaydı telefonda gerçekleştiği için ürün yalnızca mobil geliştirilir. Sunucu sadece mobil uygulamaya hizmet veren bir API'dir.

## Teknoloji yığını

Yığın tek bir Expo uygulaması ve onun konuştuğu bir Express API'den oluşur. Backend tarafı pyb-ai-analysis'teki Express + Mongoose yapısının devamıdır; yeni öğrenilecek parçalar Expo ve arka plan iş kuyruğu.

| Katman | Seçim | Not |
| --- | --- | --- |
| Mobil | Expo (React Native) + Expo Router | Kamera, ses kaydı, push, paylaşım menüsü; dev build gerekir |
| Arayüz | NativeWind (Tailwind sınıfları) | Tailwind bilgisi doğrudan taşınır |
| Sunucu verisi | TanStack Query | Önbellek, yeniden deneme, işleme durumunu sorgulama |
| API | Node.js + Express | pyb-ai-analysis'teki controller / service yapısı |
| Kimlik | Google ile giriş (`@react-native-google-signin`) + JWT | Sunucu Google token'ını doğrular, kendi access/refresh token'ını verir; token'lar `expo-secure-store`'da |
| Veritabanı | MongoDB Atlas + Mongoose | Atlas Vector Search ileride RAG için |
| AI | Gemini (metin, görsel, ses) + Gemini embedding | Structured output ile JSON |
| Dosya depolama | S3 uyumlu depolama (örn. Cloudflare R2) | İmzalı URL ile telefondan doğrudan yükleme |
| Arka plan işleri | BullMQ + Redis | OCR, transkript ve özet işleri |
| Bildirim | Expo Push | İşleme bitti, görev hatırlatmaları |
| PDF üretimi | PDFKit (sunucu) | pyb-ai-analysis'teki kod yeniden kullanılır |
| Dağıtım | EAS Build + EAS Update | Mağaza derlemesi ve mağazaya uğramıyan hızlı güncelleme |

**Expo Go ve dev build:** İlk aşamalar Expo Go ile test edilir (ilk test platformu Android, fiziksel cihaz). Expo Go'da çalışmayan parçalar dev build gerektirir ve ilgili aşamaya kadar eklenmez: `@react-native-google-signin`, `expo-share-intent`, Android'de uzaktan push (`expo-notifications`), arka plan ses kaydı.

Web olmadığı için Vercel'e gerek kalmaz. API ve worker aynı sunucuda (Railway ya da Render) iki ayrı süreç olarak çalışır, Redis de aynı platformdan alınır.

## Veri modeli

Model 6 koleksiyondan oluşur. Her kayıt `userId` taşır, yani kullanıcı verisi tamamen birbirinden ayrıdır. Tüm not tipleri tek bir `NoteItem` koleksiyonunda, `type` alanıyla ayrılır.

```js
User        { _id, email, name, avatarUrl, timeZone: "Europe/Istanbul", pushTokens[], createdAt }

Semester    { _id, userId, name: "2026 Güz", startDate, weekCount: 14,
              weekStatuses: [{ weekNo, status: "normal"|"holiday"|"midterm"|"final" }],
              isActive }

Course      { _id, userId, semesterId, code, name, instructor, color }

Session     { _id, userId, courseId, day: 0-6 (0=Pazartesi … 6=Pazar), start: "09:00", end: "10:50",
              room, kind: "teori"|"lab"|"uygulama" }

NoteItem    { _id, userId,
              courseId?, weekNo?, sessionId?,      // boşsa gelen kutusunda
              type: "text"|"document"|"image"|"audio"|"link"|"task"|"code",
              title, content: {...},               // tipe özel alanlar
              extractedText, aiSummary,
              suggestion?: { courseId, weekNo, confidence },  // gelen kutusu için
              status: "pending"|"processing"|"ready"|"failed",
              source: "app"|"share-intent",
              tags[], createdAt, updatedAt }

WeekSummary { _id, userId, courseId, weekNo, summary,
              noteIds[], generatedAt, stale }
```

Tipe özel `content` alanları:

| Tip | `content` |
| --- | --- |
| text | `markdown` |
| document | `fileKey`, `mime`, `pageCount`, `pages[]` (sayfa başına metin) |
| image | `fileKey`, `width`, `height`, `ocrMarkdown` |
| audio | `fileKey`, `durationSec`, `transcript[]` (zaman damgalı), `chapters[]` |
| link | `url`, `siteTitle`, `thumbnail` |
| task | `dueAt`, `remindAt`, `done` |
| code | `language`, `code` |

**İndeksler:** `NoteItem(userId, courseId, weekNo, createdAt)` hafta sayfası için; `NoteItem(userId, courseId, createdAt)` gelen kutusu için (atanmamış notlarda `courseId` her zaman açıkça `null`); `Session(userId, day)` otomatik atama sorgusu için; `Session(courseId)` ders sayfası için; `WeekSummary(userId, courseId, weekNo)` benzersiz.

**Gün, saat ve hafta hesapları:** `User.timeZone` (varsayılan `Europe/Istanbul`) alanına göre yapılır, sunucu saatine göre değil. `Session.day` sayıdır (0=Pazartesi); program JSON'undaki `"MON"` gibi kodlar sayıya yalnızca `packages/shared/src/time.ts` içindeki `dayCodeToIndex` ile çevrilir. Gün, dakika, hafta numarası ve otomatik atama penceresi (`dayIndex`, `minutesOfDay`, `weekNo`, `matchesSessionWindow`) da aynı dosyadadır; başka yerde dönüşüm yazılmaz.

Yeni not eklendiğinde ilgili `WeekSummary.stale = true` olur. Özet bir sonraki açılışta ya da gece çalışan bir işte yeniden üretilir.

## Not tipleri ve AI işleme hattı

Her not, tipi ne olursa olsun aynı hattan geçer ve sonunda `extractedText` alanına düz metin olarak yazılır. Haftalık özet, gelen kutusu önerisi ve ileride kurulacak RAG sohbeti tipe bakmadan yalnızca bu alanı okur.

&#91;embedded content: Not işleme hattı · 6 adım\]

Kullanıcı hiç beklemez: not, yüklendiği anda `pending` olarak görünür, arka planda işlenir. Başarısız iş 3 kez yeniden denenir, sonra `failed` olur ve not detayında "Tekrar dene" butonu çıkar.

| Tip | İşleme | `extractedText` kaynağı |
| --- | --- | --- |
| Metin | Yok (anında `ready`) | Markdown'ın kendisi |
| Belge | PDF'te metin katmanı okunur; PPTX/DOCX önce PDF'e çevrilir; metni olmayan sayfa Gemini'ye görsel olarak gider | Sayfa sayfa metin |
| Görsel | Gemini görsel girdisiyle OCR yapılır ve not düzenli Markdown'a çevrilir | `ocrMarkdown` |
| Ses | Gemini ses girdisiyle zaman damgalı transkript çıkarılır; ardından bölüm başlıkları ve özet üretilir | Transkript |
| Link | Sayfa başlığı ve açıklaması çekilir, kısa özet yazılır | Başlık + özet |
| Görev | Yok; `remindAt` için zamanlanmış push bildirimi kurulur | Başlık |
| Kod | Yok | Kodun kendisi |

**Haftalık özet:** Haftanın tüm `extractedText` alanları tek bir prompt'ta birleştirilir. Gemini, 3–5 cümlelik özet ve hangi notlardan beslendiğini döner. Uzun ses transkriptlerinde ham metin yerine notun kendi `aiSummary` alanı kullanılır; böylece prompt kısa kalır.

## Ders programı içe aktarma

Kullanıcı OBS'den aldığı ders programı ekran görüntüsünü ya da PDF'ini yükler. Gemini, sabit bir `responseSchema` ile görseli JSON'a çevirir. Kayıt, kullanıcı onay ekranında kontrol edip onaylamadan oluşmaz.

```json
{
  "courses": [
    {
      "code": "YBS-301",
      "name": "Veritabanı Yönetim Sistemleri",
      "instructor": "...",
      "sessions": [
        { "day": "MON", "start": "09:00", "end": "10:50", "room": "D-204", "kind": "teori" }
      ],
      "confidence": 0.92
    }
  ]
}
```

**Akış:**

1. Mobilde görsel kırpılıp düzleştirilir (expo-image-manipulator), sonra depolamaya yüklenir.
2. `POST /api/schedule/parse` görseli Gemini'ye gönderir ve JSON'u kaydetmeden döner.
3. Onay ekranında program haftalık takvim olarak gösterilir. `confidence < 0.8` olan dersler sarı ve kesikli çizgiyle işaretlenir; kullanıcı bunları seçeneklerle ya da elle düzeltir.
4. `POST /api/schedule/confirm` tek işlemde `Semester`, `Course` ve `Session` kayıtlarını oluşturur. Haftalar kayıt olarak tutulmaz; `startDate` ve `weekCount`'tan hesaplanır.

**Prompt'ta açıkça belirtilecek kurallar:**

- Bitişik saat hücrelerindeki aynı ders tek oturum sayılır.
- Aynı kodun teori ve lab oturumları tek dersin altında toplanır.
- Okunamayan alan boş bırakılır, tahmin edilmez; bu durumda `confidence` düşürülür.
- Sadece ders kodu görünüyorsa `name` boş döner; ders adı kullanıcıya sorulur.

**Test:** Akdeniz OBS'sinden 3–4 farklı gerçek ekran görüntüsü toplanır (tam ekran, kırpılmış, telefonla çekilmiş). Prompt, her biri doğru okunana kadar iyileştirilir.

## Ekranlar ve akışlar

MVP 9 ekrandan oluşur ve hepsinin tıklanabilir mockup'ı hazır: [NotKoçu mobil ekranlar](https://claude.ai/artifact/ArPMw3qFzNJjRjxzEFRsyR). Alt menüde 4 sekme (Bugün, Dersler, Gelen kutusu, Ayarlar) ve ortada her ekranda görünen bir + butonu bulunur.

| Ekran | Grup | İçerik |
| --- | --- | --- |
| Giriş | İlk kurulum | Google veya e-posta ile giriş |
| Program yükle | İlk kurulum | Dönem adı, başlangıç tarihi, hafta sayısı; ekran görüntüsü/PDF yükleme ve okuma adımları |
| Program onayı | İlk kurulum | Haftalık takvim, emin olunamayan dersin düzeltilmesi |
| Bugün | Ana gezinme | Devam eden ders kartı, sonraki dersler, haftanın görevleri, gelen kutusu uyarısı |
| Ders sayfası | Ana gezinme | Ders saatleri, ders içinde arama, 14 haftalık grid, seçili haftanın özeti |
| Hafta sayfası | Ana gezinme | AI özeti; "tipe göre" ve "zaman çizelgesi" görünümleri |
| Not detayı | Ana gezinme | Tipe göre görüntüleyici (seste oynatıcı, bölümler, transkript) |
| Hızlı yakalama | Not girişi | Kaydedileceği yer, 6 not tipi, tipe göre giriş alanı |
| Gelen kutusu | Not girişi | AI ders önerisi, onayla/değiştir, emin değilse ders seçimi |

**Otomatik atama kuralı:** Not oluşturulduğunda sunucu, kullanıcının `Session` kayıtlarına bakar. Şu anki gün ve saat bir oturumun **başlangıcından 10 dk önce ile bitişinden 30 dk sonra** arasındaysa not o derse ve o haftaya atanır. Eşleşme yoksa not gelen kutusuna düşer. Hafta numarası `floor((bugün − startDate) / 7) + 1` ile hesaplanır.

**Gelen kutusunda AI önerisi:** Not işlenip `extractedText` çıktıktan sonra Gemini'ye kullanıcının ders listesi ve bu metin verilir. Model `{ courseId, weekNo, confidence }` döner. `confidence < 0.7` ise öneri gösterilmez, kullanıcıdan ders seçmesi istenir.

## API endpoint'leri

API REST olarak tasarlandı. Tek istemcisi mobil uygulamadır. Kimlik uçları dışındaki tüm uçlar `Authorization: Bearer` gerektirir ve sorguları `userId` ile sınırlar.

| Metot | Yol | Ne yapar |
| --- | --- | --- |
| POST | `/api/auth/google` | Google ID token'ını doğrular, access + refresh token döner |
| POST | `/api/auth/refresh` | Access token'ı yeniler |
| DELETE | `/api/me` | Hesabı ve tüm verisini siler |
| POST | `/api/schedule/parse` | Program görselini okur, JSON döner (kayıt yok) |
| POST | `/api/schedule/confirm` | Dönem, ders ve oturumları oluşturur |
| GET | `/api/today` | Bugünün dersleri, devam eden ders, haftanın görevleri, gelen kutusu sayısı |
| GET | `/api/courses` | Aktif dönemin dersleri ve oturumları |
| GET | `/api/courses/:id` | Ders detayı ve hafta başına not sayıları |
| PATCH | `/api/courses/:id` | Ders adı, rengi, oturumları düzenlenir |
| GET | `/api/courses/:id/weeks/:no` | Haftanın notları ve özeti |
| POST | `/api/courses/:id/weeks/:no/summary` | Haftalık özeti yeniden üretir |
| POST | `/api/uploads/sign` | Dosya için imzalı yükleme URL'si verir |
| POST | `/api/notes` | Not oluşturur; otomatik atamayı yapar, işleme işini kuyruğa atar |
| GET | `/api/notes/:id` | Not detayı ve işleme durumu |
| PATCH | `/api/notes/:id` | Düzenleme veya ders/hafta ataması |
| DELETE | `/api/notes/:id` | Notu ve dosyasını siler |
| GET | `/api/inbox` | Atanmamış notlar ve AI önerileri |
| POST | `/api/inbox/approve` | Bir ya da birden çok öneriyi onaylar |
| POST | `/api/export/pdf` | Not ya da hafta için PDF üretir, indirme linki döner |
| POST | `/api/devices` | Expo push token kaydeder |

İşleme durumunu takip etmek için istemci, not `ready` olana kadar `GET /api/notes/:id`'yi birkaç saniyede bir sorgular. Uygulama kapalıysa iş bitince push bildirimi gider. Socket.io bu yüzden gerekmez.

## Dışa aktarma ve paylaşım

Uygulama içinde paylaşım sistemi kurulmaz. Dışarıyla alışveriş tamamen telefonun kendi paylaşım menüsü üzerinden, iki yönde yapılır.

**Dışarı (NotKoçu → WhatsApp vb.):**

- Hafta sayfasında ve not detayında bir "Paylaş" butonu bulunur.
- **PDF (MVP):** Sunucuda PDFKit ile üretilir. Haftalık PDF'te önce AI özeti, ardından tipe göre notlar yer alır; görseller küçük boyutta, ses kayıtları transkript olarak eklenir. Mobilde `expo-sharing` ile paylaşım menüsü açılır; kullanıcı dosyayı WhatsApp'a, Drive'a ya da Dosyalar'a gönderebilir.
- **Görsel kart (sonraki sürüm):** Tek bir notun WhatsApp'a uygun boyutta kart görüntüsü. Mobilde `react-native-view-shot` ile üretilir.

**İçeri (WhatsApp vb. → NotKoçu):**

- Uygulama paylaşım menüsünde hedef olarak görünür (`expo-share-intent`; Expo dev build gerektirir).
- Gelen PDF, görsel ya da link `source: "share-intent"` ile not olarak oluşur. Otomatik atama kuralı burada da çalışır: ders saatindeyse o haftaya, değilse gelen kutusuna gider.

## MVP yol haritası

MVP, haftada yaklaşık 15–20 saat çalışmayla 6 haftalık bir plan olarak önerildi. Her aşama kendi başına çalışan bir parça bırakır, böylece plan herhangi bir noktada kesilse bile elde kullanılabilir bir ürün kalır.

&#91;embedded content: MVP yol haritası · 6 aşama\]

Sıralama bilinçli: Program içe aktarma en erken yapılıyor, çünkü otomatik atama ve hafta yapısı ona bağlı. Ses, en pahalı ve en riskli tip olduğu için sona bırakıldı. MVP sonrası için aday özellikler: ders içinde RAG ile soru sorma, quiz ve flashcard üretimi, görsel kart olarak dışa aktarma.

## Açık sorular ve riskler

| Konu | Risk | Önlem |
| --- | --- | --- |
| AI maliyeti | 1,5 saatlik ses kayıtlarının transkripti en pahalı iş | Kullanıcı başına aylık dakika limiti; Flash Lite modeli; kaydı parçalara bölüp işlemek |
| Program okuma doğruluğu | OBS ekranı farklı çıktığında dersler yanlış okunabilir | Onay ekranı zorunlu; düşük güven vurgusu; gerçek örneklerle test |
| Ses kaydı izni | Bazı hocalar kayda izin vermiyor | Kayıt öncesi "izin aldım" onayı; kayıtlar sadece kullanıcıya özel |
| Kişisel veri (KVKK) | Ses ve görsellerde başkalarının sesi ya da yüzü olabilir | Dosyalar özel depoda ve imzalı URL ile; hesap silinince tüm veri siliniyor |
| Mobil arka plan kaydı | Uzun kayıtta iOS/Android uygulamayı durdurabilir | Expo dev build + arka plan ses izni; erken gerçek cihaz testi |
| Zayıf bağlantı | Sınıfta internet kesilirse not ya da dosya kaybolabilir | Not önce telefona kaydedilir, yükleme kuyruğu bağlantı gelince devam eder |
| Mağaza süreci | App Store incelemesi ve hesap ücreti (Apple yıllık 99 $) | Test için TestFlight ve Android dahili test; mağaza yayını MVP sonrasına |

**Karar bekleyen sorular:**

- [ ] API ve worker için Railway mi Render mı kullanılacak?
- [ ] Dosya depolama: Cloudflare R2 mi, MongoDB GridFS mi?
- [x] İlk test hangi platformda yapılacak: Android, fiziksel cihaz, Expo Go (dev build native modül gereken aşamada)
