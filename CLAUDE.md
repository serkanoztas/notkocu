# NotKoçu

Üniversite öğrencileri için kişisel ders notu uygulaması: dönem → ders → hafta düzeninde metin, belge, görsel, ses, link, görev ve kod notları. Notlar AI (Gemini) ile metne çevrilir ve haftalık olarak özetlenir. **Sadece mobil** (iOS + Android, Expo). Web sürümü yok, grup/paylaşım sistemi yok.

## Referans dokümanlar

Bir işe başlamadan önce ilgili bölümü oku:

- `docs/teknik-plan.md`: Kapsam, veri modeli, AI işleme hattı, API endpoint'leri, yol haritası. **Tek doğru kaynak budur.** Kodla plan çelişirse önce bana sor.
- `docs/ekranlar/*.png`: 9 ekranın mockup görüntüleri. Düzen, renk ve metinler için referans alınır.
- `docs/ekranlar/*.html`: Aynı ekranların kaynağı. Kopyalanacak kod değildir, sadece ölçü ve metin bakmak için kullanılır.

## Teknoloji yığını

- `apps/mobile`: Expo (dev build), Expo Router, NativeWind, TanStack Query, TypeScript
- `apps/api`: Node.js + Express + Mongoose, TypeScript
- `apps/api/src/worker`: BullMQ + Redis worker'ı (OCR, transkript, özet)
- `packages/shared`: Mobil ve API arasında paylaşılan tipler (NoteItem, Course, Session…)
- Veritabanı MongoDB Atlas, dosyalar S3 uyumlu depolamada (imzalı URL), AI için Gemini, bildirim için Expo Push

## Kurallar

- Arayüz metinleri Türkçe; kod, değişken ve commit mesajları İngilizce.
- Tüm not tipleri tek `NoteItem` koleksiyonunda, `type` alanıyla ayrılır. Her tipin işlenmesi sonunda `extractedText` doldurulur.
- Her sorgu `userId` ile sınırlanır. Başka kullanıcının verisine erişen bir endpoint olmamalı.
- Gemini çağrıları `apps/api/src/services/ai/` altında toplanır. JSON beklenen her yerde `responseSchema` kullanılır.
- Uzun işler (OCR, ses, özet) asla istek içinde yapılmaz; kuyruğa atılır, not `pending` → `processing` → `ready | failed` durumlarından geçer.
- Sırlar `.env` dosyasında tutulur, repoya girmez. `.env.example` güncel tutulur.
- Web yalnızca geliştirme sırasında hızlı önizleme içindir. Web'e özel kod, ekran ya da düzeltme yazılmaz; bir özellik webde çalışmıyorsa sorun sayılmaz. Her aşama Android cihazda test edilir.

## Tasarım

- Ana renk `#4338CA`, arka plan `#F6F6F3`, kartlar beyaz ve `#E4E4DF` çerçeveli
- Fontlar: başlıklar için Space Grotesk, gövde için Inter
- Not tipi renkleri: Metin `#EEF0FF/#3730A3`, Belge `#FFEDD5/#9A3412`, Görsel `#DCFCE7/#166534`, Ses `#FCE7F3/#9D174D`, Görev `#FEF3C7/#92400E`
- Dokunma alanları en az 44 px

## Çalışma şekli

- Yol haritasındaki aşamalara sırayla gidilir (`docs/teknik-plan.md` → MVP yol haritası). Bir aşama bitmeden sonrakine geçilmez.
- Her aşamaya önce bir plan çıkararak başla, onayımı al, sonra kodla.
- Plandan sapan bir karar alınırsa `docs/teknik-plan.md` da güncellenir.

## Komutlar

<!-- Proje kurulunca doldurulacak -->
- Mobil: `cd apps/mobile && npx expo start`
- API: `cd apps/api && npm run dev`
- Worker: `cd apps/api && npm run worker`