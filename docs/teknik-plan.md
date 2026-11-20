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
| Kimlik | Google ile giriş (`@react-native-google-signin`) + JWT | Sunucu Google ID token'ını (audience = Web client ID) doğrular; access token JWT (15 dk), refresh token opak ve tek kullanımlık (30 gün, DB'de SHA-256 hash'i, rotasyon + yeniden kullanım tespiti); token'lar `expo-secure-store`'da |
| Veritabanı | MongoDB Atlas + Mongoose | Atlas Vector Search ileride RAG için |
| AI | Gemini (metin, görsel, ses) + Gemini embedding | Structured output ile JSON |
| Dosya depolama | MongoDB GridFS (mevcut Atlas, bucket `files`) | Telefondan API'ye multipart yükleme; gösterim auth'lu akış endpoint'i ile |
| Arka plan işleri | MongoDB tabanlı kuyruk + ayrı worker süreci | OCR, transkript ve özet işleri; Redis/BullMQ yok |
| Bildirim | Expo Push | İşleme bitti, görev hatırlatmaları |
| PDF üretimi | PDFKit (sunucu) | pyb-ai-analysis'teki kod yeniden kullanılır |
| Dağıtım | EAS Build + EAS Update | Mağaza derlemesi ve mağazaya uğramıyan hızlı güncelleme |

**Expo Go ve dev build:** İlk aşamalar Expo Go ile test edilir (ilk test platformu Android, fiziksel cihaz). Expo Go'da çalışmayan parçalar dev build gerektirir ve ilgili aşamaya kadar eklenmez: `@react-native-google-signin` (Google ile giriş; `app.json`'da Firebase'siz varyant, `iosUrlScheme` yer tutucudur, iOS aşamasında gerçek değerle değişir), `expo-share-intent`, Android'de uzaktan push (`expo-notifications`), arka plan ses kaydı.

Web olmadığı için Vercel'e gerek kalmaz. API ve worker aynı sunucuda (Railway ya da Render) iki ayrı süreç olarak çalışır; ikisi de yalnızca MongoDB'ye bağlanır, ek servis gerekmez.

## Veri modeli

Model 7 koleksiyondan oluşur (6 veri koleksiyonu + `RefreshToken`). Her kayıt `userId` taşır, yani kullanıcı verisi tamamen birbirinden ayrıdır. Tüm not tipleri tek bir `NoteItem` koleksiyonunda, `type` alanıyla ayrılır.

```js
User        { _id, googleId, email, name, avatarUrl, timeZone: "Europe/Istanbul", pushTokens[], createdAt }

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
              clientId?, capturedAt?,                         // outbox: aynı clientId ikinci not yaratmaz; capturedAt notun alındığı an (createdAt ona eşit)
              job {...}, suggestJob {...},                    // kuyruk kayıtları, istemciye gitmez
              status: "pending"|"processing"|"ready"|"failed",
              source: "app"|"share-intent",
              tags[], createdAt, updatedAt }

WeekSummary { _id, userId, courseId, weekNo, summary,
              noteIds[], generatedAt, stale }

RefreshToken { _id, userId, tokenHash, familyId, expiresAt (TTL), usedAt?, createdAt }
```

Tipe özel `content` alanları:

| Tip | `content` |
| --- | --- |
| text | `markdown` |
| document | `fileKey`, `mime`, `pageCount`, `pages[]` (sayfa başına metin) |
| image | `fileKey` (işlenmiş görsel), `thumbKey` (~200 px küçük resim, yoksa boş), `mime`, `width`, `height`, `ocrMarkdown` |
| audio | `chunks[]` (`fileKey`, `startSec`, `durationSec`, `size`, `mime`; ~10 dk'lık parçalar), `durationSec`, `transcript[]` (küresel zaman damgalı), `chapters[]`, `audioExpiresAt`, `pinned`, `audioDeleted` |
| link | `url`, `siteTitle`, `thumbnail` |
| task | `dueAt`, `remindAt`, `done` |
| code | `language`, `code` |

**İndeksler:** `NoteItem(userId, courseId, weekNo, createdAt)` hafta sayfası için; `NoteItem(userId, courseId, createdAt)` gelen kutusu için (atanmamış notlarda `courseId` her zaman açıkça `null`); `Session(userId, day)` otomatik atama sorgusu için; `Session(courseId)` ders sayfası için; `WeekSummary(userId, courseId, weekNo)` benzersiz.

**Gün, saat ve hafta hesapları:** `User.timeZone` (varsayılan `Europe/Istanbul`) alanına göre yapılır, sunucu saatine göre değil. `Session.day` sayıdır (0=Pazartesi); program JSON'undaki `"MON"` gibi kodlar sayıya yalnızca `packages/shared/src/time.ts` içindeki `dayCodeToIndex` ile çevrilir. Gün, dakika, hafta numarası ve otomatik atama penceresi (`dayIndex`, `minutesOfDay`, `weekNo`, `matchesSessionWindow`) da aynı dosyadadır; başka yerde dönüşüm yazılmaz.

Yeni not eklendiğinde ilgili `WeekSummary.stale = true` olur. Özet bir sonraki açılışta ya da gece çalışan bir işte yeniden üretilir.

## Not tipleri ve AI işleme hattı

Her not, tipi ne olursa olsun aynı hattan geçer ve sonunda `extractedText` alanına düz metin olarak yazılır. Haftalık özet, gelen kutusu önerisi ve ileride kurulacak RAG sohbeti tipe bakmadan yalnızca bu alanı okur.

1. **Not oluşturulur:** dosya GridFS'e yazılır, `status: pending`
2. **Otomatik atama:** ders saatindeyse o haftaya, değilse gelen kutusuna
3. **Kuyruk:** `pending` not zaten iştir; worker onu atomik olarak alır, `status: processing`
4. **Tipe göre işleme:** OCR, transkript, metin çıkarma (Gemini)
5. **Sonuç kaydedilir:** `extractedText` + `aiSummary`, `status: ready`
6. **Sonraki adımlar:** gelen kutusunda ders önerisi, haftalık özet yenilenir, push bildirimi gider

Kullanıcı hiç beklemez: not, yüklendiği anda `pending` olarak görünür, arka planda işlenir. Başarısız iş 3 kez yeniden denenir, sonra `failed` olur ve not detayında "Tekrar dene" butonu çıkar.

| Tip | İşleme | `extractedText` kaynağı |
| --- | --- | --- |
| Metin | Yok (anında `ready`) | Markdown'ın kendisi |
| Belge | PDF'te metin katmanı okunur; DOCX/PPTX metni saf JS ile çıkarılır (LibreOffice yok); metin katmanı olmayan ya da çok az olan PDF Gemini'ye PDF olarak gider | Sayfa/slayt/bölüm bazında metin |
| Görsel | Gemini görsel girdisiyle OCR yapılır ve not düzenli Markdown'a çevrilir | `ocrMarkdown` |
| Ses | Gemini ses girdisiyle zaman damgalı transkript çıkarılır; ardından bölüm başlıkları ve özet üretilir | Transkript |
| Link | Sayfa başlığı ve açıklaması çekilir, kısa özet yazılır | Başlık + özet |
| Görev | Yok; `remindAt` için zamanlanmış push bildirimi kurulur | Başlık |
| Kod | Yok | Kodun kendisi |

**Aşama 4a'da uygulanan sapmalar (dosyalar, kuyruk, görsel notlar):**

- **Depolama:** Cloudflare R2 yerine MongoDB GridFS. Yükleme imzalı URL ile değil, `POST /api/notes` multipart gövdesiyle API'ye yapılır. Her dosyanın `metadata.userId` alanı vardır; okuma, silme ve kullanım hesabı bu alanla sınırlıdır. Gösterim `GET /api/files/:id` (Bearer gerekir, başkasının dosyası 404, `Cache-Control: private`). `/api/uploads/sign` yazılmadı.
- **Yükleme kuralları:** jpeg/png/webp/heic/heif, en fazla 10 MB, kullanıcı başına dakikada 20 yükleme. Dosya türü istemcinin söylediğine göre değil ilk baytlara bakılarak doğrulanır. `POST /api/notes` multipart alanları: `type=image`, `file`, `title?`, `courseId?` + `weekNo?`, `inbox=1` (açık gelen kutusu; multipart'ta `null` olmadığı için). Hiçbiri yoksa Aşama 3'teki otomatik atama çalışır. Her fotoğraf ayrı bir nottur; mobil çoklu seçimde sırayla yükler.
- **Sunucuda görsel işleme (sharp, yalnızca API):** yazmadan önce EXIF yönüne göre döndürülür, uzun kenar en fazla 2000 px'e indirilir, JPEG kalite 80 olarak kaydedilir; ayrıca ~200 px küçük resim ayrı GridFS dosyası olarak `content.thumbKey`'e yazılır. sharp girdiyi çözemezse (özellikle HEIC) orijinal olduğu gibi saklanır, küçük resim üretilmez ve istemci `thumbKey ?? fileKey` kullanır. Listeler küçük resmi, not detayı büyük görseli gösterir; OCR işlenmiş görseli okur.
- **Depolama sınırı:** kullanıcı başına `USER_STORAGE_LIMIT_MB` (varsayılan 200). Aşılırsa yükleme 413 `STORAGE_LIMIT` ile reddedilir. Sınır yumuşaktır: aynı anda gelen iki yükleme hafifçe aşabilir. `GET /api/me/storage` kullanılan ve toplam bayt sayısını döner; Ayarlar'da "23 MB / 200 MB" gösterilir.
- **Kuyruk (MongoDB):** bekleyen not (`status: pending`) iştir; `NoteItem.job` alt dokümanı `attempts`, `deferrals`, `runAt`, `leaseUntil`, `lastError` tutar ve istemciye gönderilmez. Worker `findOneAndUpdate` ile `pending` ve vakti gelmiş notu (ya da lease'i dolmuş `processing` notu) alıp `processing` yapar, 3 dk lease verir ve `attempts`'i artırır. Başarıda `ready`; hatada 30 sn × deneme kadar bekleyip `pending`'e döner; 3. denemeden sonra `failed`. Sonuç yalnızca lease hâlâ worker'daysa yazılır (çift işleme koruması). Lease'i dolmuş ve 3 denemesi bitmiş kayıtlar worker'ın süpürme adımıyla `failed` olur. `POST /api/notes/:id/retry` yalnızca `failed` notu `pending`'e alır (aksi 409).
- **Gemini 429/kota** deneme sayısını artırmaz: not `pending`'e ~60 sn sonrasına ertelenir (`deferrals` artar). Kota günlerce sürerse sonsuz döngü olmasın diye 30 ertelemeden sonra `failed` olur. **Gemini 503/500 (model aşırı yüklü):** önce aynı istek hemen bir kez `GEMINI_FALLBACK_MODEL` ile denenir (tanımlıysa; worker log'unda yalnızca model adları ve durum kodu görünür). Yedek de başarısızsa 429 gibi ertelenir, deneme sayısı artmaz: ilk erteleme 10 sn, sonra 20, 40, 80, 160 sn, en çok 5 dk; 10 ertelemeden (~30 dk) sonra `failed` (`AI_UNAVAILABLE`; öneri hattında sessizce `done`). Diğer hatalar 3 deneme kuralındadır.

- **Test notu:** `check-queue` / `check-http` çalıştırılırken worker açık olmamalı; açık worker betiklerin test notlarını kapıp sonuçları rastgele bozar.
- **OCR:** `services/ai/imageOcr.ts`, program okuyucuyla aynı model/thinking ayarlarını ve `responseSchema`'yı kullanır (`markdown`, `title`, `summary`); yeniden deneme yalnızca kuyruktadır. Log'a yalnızca HTTP durumu yazılır. Sonuç `content.ocrMarkdown`, `extractedText` (metin yoksa özet) ve `aiSummary`'ye gider; başlık varsayılan "Fotoğraf" ise Gemini'nin önerdiği başlıkla değişir.
- **Silme:** not silinince `fileKey` ve `thumbKey` dosyaları da silinir; `DELETE /api/me` kullanıcının tüm GridFS dosyalarını `metadata.userId` ile siler. Görsel notlarda metin düzenleme (`markdown` PATCH) 400 döner.
- **Worker:** `npm run worker` (ayrı süreç, eşzamanlılık 2, SIGINT/SIGTERM'de düzgün kapanır). Kuyruk ve dosya mantığı `npm run check-queue`, uçtan uca HTTP akışı (worker açıkken) `npm run check-http` ile denenir.
- **Mobil:** Hızlı yakalamada Fotoğraf aktif (kamera + galeri çoklu seçim, `quality: 0.7`, en fazla 10 fotoğraf). Hafta sayfası, gelen kutusu ve not detayı, `pending/processing` not varken 4 sn'de bir yeniden sorgular, hepsi `ready/failed` olunca durur. Görseller `Authorization` başlığıyla yüklenir (token süresi dolunca bir kez tazelenip yeniden denenir). Çevrimdışı önbellek yalnızca JSON'u saklar; görsel byte'ı Query verisine girmez (Android'in kendi görsel önbelleği uygulama kontrolünde değildir).

**Aşama 4b'de uygulanan sapmalar (belge, öneri, outbox, paylaşım):**

- **Belge hattı (`services/documents/`):** yükleme `POST /api/notes` multipart (`type=document`), en fazla 20 MB (görsel 10 MB kalır), tür istemcinin söylediğine göre değil ilk baytlara bakılarak belirlenir: `%PDF-`, zip içinde `word/document.xml` (DOCX) ya da `ppt/presentation.xml` (PPTX); eski `.doc/.ppt` ve diğerleri 400 `UNSUPPORTED_DOCUMENT_TYPE`. Dosya olduğu gibi GridFS'e yazılır, depolama sınırı 4a'daki gibi. Worker: **DOCX** paragraflarını sırayla alır; sayfa kavramı olmadığı için açık sayfa sonlarında (`w:br page`, `lastRenderedPageBreak`) böler, yoksa ~3000 karakterlik bölümlere böler (`unit: "section"`). **PPTX** slaytları `presentation.xml` sırasıyla, konuşmacı notlarıyla birlikte (`unit: "slide"`). **PDF** önce metin katmanından; sayfa başına ortalama < 40 karakter ya da sayfaların yarısından fazlası boşsa PDF taranmış sayılır ve 10 sayfalık parçalar halinde Gemini'ye PDF olarak gider (en çok 60 sayfa, fazlası `TOO_LONG` ile `failed`; parça ~14 MB'ı geçerse Gemini Files API kullanılır ve iş sonunda silinir). Özet her durumda metin üzerinden ayrı, ucuz bir çağrıyla üretilir (ilk ~30k karakter). Sonuç `content.pages[]`, `pageCount`, `unit`, `extractedText` (en çok 300k karakter) ve `aiSummary`. Zip için sıkıştırılmamış boyut sınırı vardır (zip bomb koruması). Gemini ayarları ve log gizliliği 4a ile aynıdır (`services/ai/errors.ts` ortak hata türlerini taşır).
- **Link notu:** `POST /api/notes` JSON (`type=link`, `url` + isteğe bağlı `title`); yalnızca http/https; sayfa çekilmez ve özetlenmez (SSRF yok, özet sonraya). `extractedText` = başlık + adres.
- **Gelen kutusu AI önerisi (`suggestJob` hattı):** `status`'a dokunmayan ikinci, bağımsız kuyruk hattı; böylece gelen kutusundaki metin notu "işleniyor" görünmez. Gelen kutusuna düşen (`courseId: null`, `extractedText` var) her not için kuyruğa girer: metin ve link oluşturulunca, görsel/belge işlenince, bir not gelen kutusuna geri taşınınca. Gemini yalnızca dersi seçer (`responseSchema`: ders id'leri + `none`, `confidence`); **hafta AI'dan alınmaz**, notun `capturedAt ?? createdAt` anından `semesterWeekNo` ile hesaplanır (dönem dışıysa öneri yok). `confidence < 0.7` ise öneri saklanmaz. Hat 3 deneme + 429'da 60 sn erteleme kurallarını işleme hattıyla paylaşır, hata sessizdir (kullanıcı dersi kendisi seçer). `POST /api/inbox/approve` öneriyi uygular; "Geri al" mevcut `PATCH {courseId: null}` ile yapılır ve öneri notta kalır; elle atama öneriyi temizler. Notlar `suggesting` alanıyla "öneri hazırlanıyor" durumunu bildirir.
- **Outbox ve idempotent oluşturma:** "Kaydet" yalnızca cihaza yazar (metin/adres, dosyanın **kopyası** `Paths.document/outbox/<clientId>/` altında, `entry.json` en son yazılır) ve ekranı kapatır; gönderim arka plandadır. Gönderim: uygulama açılışında, ön plana gelince ve bekleyen not varken 30 sn'de bir (arka plan görevi yok, nedeni yukarıda). Bağlantı/zaman aşımı/5xx/429/401'de not saklanır; kalıcı 4xx (`STORAGE_LIMIT`, dosya türü...) notu "Gönderilemedi · neden" olarak işaretler ve kendiliğinden denenmez; silinmiş derse giden not (404) gelen kutusuna düşer. Sunucuda `(userId, clientId)` benzersiz kısmi indeksi: aynı `clientId` ikinci not yaratmaz, var olan not **200** ile döner. `capturedAt` (gelecekte olamaz, şimdiye kırpılır) hedefi ve haftayı belirler; `createdAt = capturedAt` olur. Hedef cihazda Kaydet anında, önbellekteki dönemden çözülür (dönem yoksa sunucu `capturedAt` ile atar). Hafta sayfası ve gelen kutusu gönderilmemiş notları "Gönderilmedi" etiketiyle gösterir; Ayarlar'da sayaç ve "Şimdi gönder" vardır; çıkış yaparken gönderilmemiş not varsa uyarılır ve onaylanırsa silinir. Oturum kendiliğinden düşerse notlar korunur, aynı kullanıcı girince devam eder; farklı kullanıcı girerse silinir.
- **Paylaş → NotKoçu:** `ShareIntentProvider` kök düzende; oturum açık ve dönem varsa paylaşılan içerikle Hızlı yakalama açılır, hedef olağan kuralla seçilidir, kullanıcı Kaydet'e basar. Eşleme: görsel → Fotoğraf (çoklu), PDF/DOCX/PPTX → Dosya, web adresi → Link (başlık = adresin çevresindeki metin), adressiz düz metin → Metin (alan önceden dolu); karışık içerikte görseller ya da belgeler, desteklenmeyen türde uyarı. Notlar `source: "share-intent"` ile gider ("Paylaşımdan"). Ekran kapanınca paylaşım temizlenir.
- **Doğrulama araçları:** `npm run check-docs` (çıkarıcılar, çevrimdışı), `check-queue` (kuyruk, öneri hattı, `clientId` indeksi), `check-http` (uçtan uca HTTP; worker döngüsünü süreç içinde çalıştırır ve yalnızca kendi test notlarını alır). `check-http` ve `check-queue` varsayılan olarak **sahte Gemini** kullanır; gerçek istek yalnızca `CHECK_REAL_GEMINI=1` ile atılır. Scriptler yarıda kesilseler de kendi verilerini siler.

**Aşama 4b'de alınan kararlar (paketler ve yapılandırma):**

- **Native paketler tek dev build'de:** `expo-document-picker` (belge seçimi), `expo-sharing` (belgeyi cihazdaki uygulamayla açma), `expo-share-intent` (Paylaş → NotKoçu). Bilerek eklenmeyenler: `expo-network` (bağlantı `/api/health` + AppState + zamanlayıcı ile anlaşılır), `expo-background-task` (Android'de ~15 dk ve güvenilmez; outbox ön plana gelince ve ön plandayken periyodik dener), `expo-crypto` (`clientId` için benzersizlik yeter, güvenlik gerekmez).
- **expo-share-intent yapılandırması:** eklentinin Android filtreleri yalnızca `text/*`, `image/*`, `video/*`, `*/*` kabul eder (PDF/DOCX/PPTX için ayrı MIME verilemez), bu yüzden `*/*` kullanılır ve desteklenmeyen dosya türü uygulamada reddedilir. iOS share extension'ı bu aşamada `disableIOS: true` ile kapalıdır; iOS aşamasında açılır (bundle id / Apple team gerekir).
- **Sunucu kütüphaneleri (native değil):** `unpdf` (PDF metin katmanı), `pdf-lib` (taranmış PDF'i parçalara bölme), `fflate` (zip, boyut sınırlı) ve `fast-xml-parser` (DOCX/PPTX XML). LibreOffice kullanılmaz.

**Aşama 5'te alınan kararlar (ses, saklama, haftalık özet):**

- **Parçalı kayıt:** Mobil kaydı ~10 dk'lık parçalara böler; parçalar sunucuda **birleştirilmez** (sunucuda ffmpeg yok), her biri ayrı GridFS dosyası olarak `content.chunks[]`'ta durur. Gerekçe: kapanmamış tek dosya süreç ölünce bozulur, parça en çok kendi kaybını getirir; parça aynı zamanda Gemini'ye giden birimdir (parça bazında yeniden deneme). Android'de ham ADTS AAC (`.aac`) tercih edilir (kesilen akış çalınabilir kalır); olmazsa `.m4a` + 5 dk parça. Parça geçişinde ~0,2–0,5 sn ses kaybı olabilir. Ayar: mono, 16 kHz, 24 kbps.
- **Küresel zaman:** Transkript, bölümler ve "satıra dokun → atla" tüm kaydın başından saniye cinsindendir; parça/yerel konum dönüşümü yalnızca `packages/shared/src/audio.ts`'te yapılır (parça sınırına denk gelen zaman sonraki parçayı açar). Oynatıcı bir parça çalarken sonrakini önceden yükler.
- **Saklama:** Ses dosyaları oluşturma + 30 gün sonra otomatik silinir (**tüm parçalar**); transkript, bölümler ve özet kalıcıdır. "Kalıcı yap" (`pinned`) süresiz tutar ve kotaya sayılır; geri alınabilir: kalıcılık kalkınca `audioExpiresAt = max(şimdi + 7 gün, eski süre)`. Worker günde bir süpürür. Yükleme sınırı kayıt başına 60 MB (en çok 24 parça, parça başı 8 MB).
- **Haftalık özet:** Yalnızca hafta sayfası açıldığında ve özet yoksa/eskimişse arka planda üretilir; açılmayan haftalar için Gemini çağrısı yapılmaz.

**Aşama 5'te uygulanan sapmalar (ses, haftalık özet, ekranlar):**

- **Yükleme:** `POST /api/notes` multipart, `type=audio`, birden fazla `file` parçası (sırayla) + `chunkDurations` (JSON, saniye; cihazın ölçtüğü). En çok 24 parça, parça başı 8 MB, toplam 60 MB (`Content-Length` > 61 MB gövde okunmadan 413). Tür ilk baytlardan: ADTS AAC ya da MP4/M4A, aksi 400 `UNSUPPORTED_AUDIO_TYPE`. Parçalar ayrı GridFS dosyası; `content.chunks[]` küresel zaman çizelgesinde (`startSec` = önceki parçaların süreleri toplamı). `audioExpiresAt` = sunucuya ulaşma + 30 gün. Süresi eksik/0 olan parça boyuttan kestirilir (24 kbps).
- **Worker (ses):** parça başına Gemini ses girdisi (satır içi; parçalar küçük olduğundan Files API gerekmedi), şema `segments[{start:"MM:SS", text}]`; zamanlar parça uzunluğuna sıkıştırılıp `chunk.startSec` ile küresele çevrilir. Biten parça sonucu `job.progress`'e yazılır ve **kira süresi uzatılır**; yeniden denemede yalnızca başarısız parça tekrarlanır. Sonra transkript metninden (ses yeniden gönderilmez) `chapters[]` + `aiSummary`. `extractedText` zaman damgasız transkripttir. `GEMINI_MODEL_AUDIO` (boşsa `GEMINI_MODEL`); yedek model, 429/503 erteleme ve log gizliliği mevcut kurallarla.
- **Saklama:** worker başlangıçta ve 24 saatte bir süpürür (idempotent): süresi dolmuş, `pinned` olmayan, `ready/failed` ses notlarının **tüm parça dosyaları** silinir, `content.audioDeleted=true`, parçaların `fileKey`'i kalkar, süre/transkript/bölüm/özet kalır. `PATCH /api/notes/:id { pinned }` atomik alan güncellemesidir; `pinned:false` → `audioExpiresAt = max(şimdi + 7 gün, eski süre)`. `GET /api/me/storage` `pinnedAudioBytes` da döner (Ayarlar'da "Kalıcı sesler: X MB").
- **Haftalık özet hattı:** `WeekSummary.job` üzerinde üçüncü kuyruk hattı (aynı kurallar). `GET /courses/:id/weeks/:no` hazır not varken özet yoksa/eskiyse işi **koşullu upsert** ile bir kez kuyruğa atar (tekrar açmak yığmaz; başarısızlıktan sonra 10 dk bekleme), yanıtta `summary { summary, noteIds, generatedAt, stale, generating }`. `POST …/summary` bekleme olmadan yeniler (202). Girdi: notların `aiSummary`'si (yoksa `extractedText` başı ~1500 karakter; ses için her zaman `aiSummary`), ~40k karakter sınırı; **kaynak `noteIds`'i sunucu belirler**, model yalnızca `{summary}` döner. Talep alındığında `stale=false`; iş sırasında değişen not `stale`'i tekrar `true` yapar.
- **Mobil kayıt:** `expo-audio` (tek yeni native paket; plugin `enableBackgroundRecording` + `enableBackgroundPlayback`). Android'de ham ADTS AAC (`.aac`, mono 16 kHz 24 kbps) 10 dk'lık parçalar; her parça kapanınca `outbox/<clientId>/` içine taşınır, `entry.json` (`recording:true`) güncellenir. Açılışta aktif kaydı olmayan `recording` girdileri kurtarılır (kesilen son parça da dahil; süresi boyuttan kestirilir) ve normal gönderime girer. Kesintide (arama/sistem) kaydedici kendiliğinden durursa parça kapatılır, birkaç kez otomatik yeni parça denenir, olmazsa "Devam" gösterilir. **Hedef (ders/hafta) kaydın başında** çözülür ve `capturedAt` başlangıçtır. Kayıt, capture ekranı kapansa da sürer ("Kayıt sürüyor" şeridi). "Hocadan kayıt izni aldım" onayı olmadan başlamaz. Yükleme zaman aşımı 10 dk; 60 MB üstü istemcide "çok büyük".
- **Mobil oynatma:** parçalar yetkili indirmeyle önbelleğe iner, **yerel `AudioPlaylist`** ile çalınır (planda iki oynatıcıyla elle önyükleme düşünülmüştü; yerel liste sonraki parçayı kendisi önyüklediği için daha az kod ve daha küçük boşluk). Konum her yerde küresel zaman: bölüm/satır/çubuk dokunuşu `locateChunk` ile parçayı bulur (sınıra denk zaman sonraki parçanın 0'ı), gerekirse `skipTo` + `seekTo`. Hız 1/1,5/2×, ±15 sn. Dalga formu yerine ilerleme çubuğu (dalga formu ses analizi ister).
- **Hafta sayfası:** özet kartı ("N nottan", "Özet hazırlanıyor…", hazırlanırken 4 sn'de bir yenileme), "Tipe göre" (Ses, Görsel ızgarası, Belge·Metin·…) ve "Zaman çizelgesi" (gün başlıkları). Paylaş butonu Aşama 6'da. Ders sayfasındaki hafta kartı özeti göstermez (özet yalnızca hafta sayfası açılınca üretilir).
- **Doğrulama:** `check-queue` (ses parçası bazlı yeniden deneme, saklama süpürmesi, haftalık özet hattı), `check-http` (ses yükleme/sniff/limit, uçtan uca transkript, pin/geri alma, hafta sayfası tetikleyicisi), `packages/shared` testleri (`locateChunk`). Hepsi sahte Gemini ile; çalıştırırken worker kapalı olmalı. ADTS çıktısı, arka plan kaydı, kesinti/kurtarma ve parça geçişi yalnızca cihazda doğrulanabilir. Cihaz testi: arka plan kaydı (ekran kapalı), transkript, atlama ve hafta sayfası doğrulandı; **arama kesintisi (otomatik yeni parça / "Devam") cihazda test edilmedi.**

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

**Aşama 2'de uygulanan sapmalar:**

- Görsel depolamaya yüklenmez; multipart olarak `POST /api/schedule/parse`'a gider (en fazla 8 MB, jpeg/png/webp/heic), sunucu saklamaz, yalnızca Gemini'ye iletir. Kullanıcı başına dakikada 5 istek.
- PDF bu aşamada desteklenmez, yalnızca görsel (PDF sonraya kaldı).
- Oturumlara opsiyonel `alternatives: [{day,start,end}]` eklendi: saat iki şekilde okunabiliyorsa onay ekranı "hangisi doğru?" çipleri gösterir. `parse` yanıtında `day` sayıdır (0=Pazartesi); gün kodu çevirisi sunucuda `dayCodeToIndex` ile yapılır.
- Gemini cevabı şemaya uymazsa ya da boşsa bir kez yeniden denenir; yine olmazsa 422 `SCHEDULE_UNREADABLE`, mobilde "Program okunamadı" + "Elle gireceğim".
- `POST /api/schedule/confirm`: aktif dönem varsa 409 `ACTIVE_SEMESTER_EXISTS`; `replaceActive: true` ile eski dönem silinmez, `isActive=false` olur. `startDate` Pazartesi olmak zorundadır (aksi 400) ve öğlen 12:00 UTC olarak saklanır (her saat diliminde aynı takvim günü). Kullanıcı başına tek aktif dönem, kısmi benzersiz indeksle garanti edilir. Transaction replica set ister (Atlas'ta sorun yok).
- `GET /api/semesters/active`: aktif dönem + dersler + oturumlar; mobil yalnızca bu istek başarılı dönüp `semester === null` ise onboarding'e yönlendirir, ağ hatası/5xx'te sekmeler açılır ve Bugün ekranında "Program yüklenemedi" + "Tekrar dene" gösterilir.
- Mobilde tarih `GG.AA.YYYY` girilir, API'ye `YYYY-MM-DD` gider; Pazartesi değilse en yakın Pazartesi önerilir. Görsel kırpma `expo-image-picker`'ın `allowsEditing` seçeneğiyle yapılır (`expo-image-manipulator` eklenmedi).
- Model adı `GEMINI_MODEL` env'inden gelir; görsel/PDF OCR için `GEMINI_MODEL_OCR`, ders programı için `GEMINI_MODEL_SCHEDULE` ile işe göre değiştirilebilir (boşsa `GEMINI_MODEL`). Desteklenmeyen `thinkingLevel` (örn. gemini-3.8-flash'ta MINIMAL) model bazında atlanır. `apps/api` içinde `npm run try-parse -- <görsel>` ile komut satırından denenebilir.

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
| Giriş | İlk kurulum | Google ile giriş (MVP'de e-posta yok) |
| Program yükle | İlk kurulum | Dönem adı, başlangıç tarihi, hafta sayısı; ekran görüntüsü/PDF yükleme ve okuma adımları |
| Program onayı | İlk kurulum | Haftalık takvim, emin olunamayan dersin düzeltilmesi |
| Programı yeniden yükle | Ayarlar | Ayarlar'daki "Ders programını yeniden yükle" butonu onay sorar ("Mevcut program arşivlenir, notların silinmez"), sonra Program yükle ve Program onayı ekranlarını açar; onayda `replaceActive: true` gönderilir ve eski dönem `isActive=false` olur. Bu akışta Program yükle'de geri butonu vardır (vazgeçilebilir) |
| Bugün | Ana gezinme | Devam eden ders kartı, sonraki dersler, haftanın görevleri, gelen kutusu uyarısı |
| Ders sayfası | Ana gezinme | Ders saatleri, ders içinde arama, 14 haftalık grid, seçili haftanın özeti |
| Hafta sayfası | Ana gezinme | AI özeti; "tipe göre" ve "zaman çizelgesi" görünümleri |
| Not detayı | Ana gezinme | Tipe göre görüntüleyici (seste oynatıcı, bölümler, transkript) |
| Hızlı yakalama | Not girişi | Kaydedileceği yer, 6 not tipi, tipe göre giriş alanı |
| Gelen kutusu | Not girişi | AI ders önerisi, onayla/değiştir, emin değilse ders seçimi |

**Aşama 3'te uygulanan sapmalar:**

- Otomatik atama ve "şu an / sonraki ders" kuralı `packages/shared/src/assignment.ts` içindedir (`resolveAutoTarget`, `sessionState`, `semesterWeekNo`; yalnızca `time.ts` üzerine kurulu). API ve mobil aynı kodu kullanır. Pencereler çakışırsa saate en yakın oturum kazanır (devam eden, bitmiş ya da başlamamış olandan önce gelir; eşitlikte erken başlayan). Hafta 1..`weekCount` dışındaysa not gelen kutusuna düşer.
- Mobil, "Kaydedileceği yer" ve devam eden/sonraki ders hesaplarını önbellekteki aktif dönemden ve `User.timeZone`'dan yapar (cihaz saat dilimi kullanılmaz), böylece çevrimdışıyken de çalışır ve sunucuyla aynı sonucu verir. Otomatik hedef capture açılışında sabitlenmez: Kaydet anında yeniden hesaplanır, ekranda açıkken dakikada bir güncellenir. Elle seçilen ya da Bugün'deki "Not al" ile gelen hedef sabit kalır.
- `POST /api/notes` gövdesinde `courseId` yoksa sunucu otomatik atar; `null` gelen kutusu, bir id ise elle atama (`weekNo` zorunlu, ders kullanıcıya ait ve hafta `weekCount` içinde olmalı). Mobil hedefi her zaman açıkça gönderir. Başkasına ait ya da geçersiz id her yerde 404 döner.
- `GET /api/courses` (liste) yazılmadı: Dersler sekmesi `GET /api/semesters/active` verisini kullanır. `GET /api/today` yalnızca sunucu tarafı özettir (bugünün oturumları, devam eden dersin bu haftaki not sayısı, gelen kutusu sayısı, `tasks: []`); mobil devam eden/sonraki dersleri kendisi hesaplar.
- Ders sayfasında arama kutusu, Hafta sayfasında "Tipe göre / Zaman çizelgesi" sekmesi ve paylaş butonu yok (tek not tipi var). AI özeti alanı "Özet 5. aşamada" yer tutucusudur. Markdown düz metin olarak gösterilir.
- Hızlı yakalamada yalnızca Metin aktiftir; diğer 5 tip "yakında" ve pasif. Çevrimdışı not kaydı 4b'de outbox ile çözüldü (aşağıda); ilk halinde çevrimdışıyken not kaydedilemiyordu.
- Çevrimdışı önbellek: TanStack Query önbelleği `expo-file-system` `File` ile `Paths.document/query-cache.json` dosyasına yazılır (`@tanstack/react-query-persist-client`, saf JS; native paket yok). 7 gün geçerli, uygulama sürümü değişince silinir, çıkışta/oturum kaybında diskten de silinir.

**Otomatik atama kuralı:** Not oluşturulduğunda sunucu, kullanıcının `Session` kayıtlarına bakar. Şu anki gün ve saat bir oturumun **başlangıcından 10 dk önce ile bitişinden 30 dk sonra** arasındaysa not o derse ve o haftaya atanır. Eşleşme yoksa not gelen kutusuna düşer. Hafta numarası `floor((bugün − startDate) / 7) + 1` ile hesaplanır.

**Gelen kutusunda AI önerisi:** Not işlenip `extractedText` çıktıktan sonra Gemini'ye kullanıcının ders listesi ve bu metin verilir. Model yalnızca `{ courseId, confidence }` döner; hafta AI'dan alınmaz, notun alındığı andan hesaplanır (4b sapmaları). `confidence < 0.7` ise öneri gösterilmez, kullanıcıdan ders seçmesi istenir.

## API endpoint'leri

API REST olarak tasarlandı. Tek istemcisi mobil uygulamadır. `/api/health` ve `/api/auth/*` dışındaki tüm uçlar `Authorization: Bearer` gerektirir ve sorguları `userId` ile sınırlar.

| Metot | Yol | Ne yapar |
| --- | --- | --- |
| POST | `/api/auth/google` | Google ID token'ını doğrular, access + refresh token döner |
| POST | `/api/auth/refresh` | Refresh token'ı döndürür (rotasyon): yeni access + refresh token; kullanılmış token tekrar gelirse tüm aile iptal olur |
| POST | `/api/auth/logout` | Gönderilen refresh token'ın ailesini iptal eder (204) |
| GET | `/api/me` | Giriş yapan kullanıcının bilgisi |
| DELETE | `/api/me` | Hesabı ve tüm verisini siler |
| POST | `/api/schedule/parse` | Program görselini okur, JSON döner (kayıt yok) |
| POST | `/api/schedule/confirm` | Dönem, ders ve oturumları oluşturur |
| GET | `/api/semesters/active` | Aktif dönem, dersleri ve oturumları (yoksa `semester: null`) |
| GET | `/api/today` | Bugünün dersleri, devam eden ders, haftanın görevleri, gelen kutusu sayısı |
| GET | `/api/courses` | Aktif dönemin dersleri ve oturumları |
| GET | `/api/courses/:id` | Ders detayı ve hafta başına not sayıları |
| PATCH | `/api/courses/:id` | Ders adı, rengi, oturumları düzenlenir |
| GET | `/api/courses/:id/weeks/:no` | Haftanın notları ve özeti (özet eskiyse işi kuyruğa atar) |
| POST | `/api/courses/:id/weeks/:no/summary` | Haftalık özeti yeniden üretir |
| GET | `/api/files/:id` | Kullanıcının kendi dosyasını (görsel ya da küçük resim) akıtır; başkasınınki 404 |
| POST | `/api/notes` | Not oluşturur; otomatik atamayı yapar. Metin/link: JSON; görsel/belge: multipart (`file`), `pending` olarak kuyruğa girer. `clientId` ve `capturedAt` ile idempotent (tekrarda var olan not 200 döner) |
| POST | `/api/notes/:id/retry` | `failed` notu yeniden kuyruğa alır |
| GET | `/api/me/storage` | Kullanılan, izin verilen ve kalıcı yapılmış ses depolama alanı (bayt) |
| GET | `/api/notes/:id` | Not detayı ve işleme durumu |
| PATCH | `/api/notes/:id` | Düzenleme, ders/hafta ataması, ses için `pinned` (Kalıcı yap / geri al) |
| DELETE | `/api/notes/:id` | Notu ve dosyalarını (görsel + küçük resim) siler |
| GET | `/api/inbox` | Atanmamış notlar ve AI önerileri |
| POST | `/api/inbox/approve` | `{ noteIds }`: önerisi olan gelen kutusu notlarını önerilen ders ve haftaya atar (`{ approved, skipped }`) |
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

1. [x] **Temel:** Expo + Express + MongoDB, Google ile giriş + JWT, dönem/ders/oturum şeması
2. [x] **Program içe aktarma:** görselden JSON (Gemini), onay ekranı, haftaların hesaplanması
3. [x] **Ana ekranlar:** Bugün, Ders, Hafta ekranları; hızlı yakalama (metin); otomatik atama kuralı
4. [x] **Dosyalar ve işleme:**
   - [x] **4a:** görsel notlar (kamera/galeri), GridFS, Mongo kuyruğu + worker, Gemini OCR, depolama sınırı (Android cihazda test edildi)
   - [x] **4b:** belge (PDF/PPTX/DOCX) + link notu, gelen kutusu AI ders önerisi, çevrimdışı not kuyruğu (outbox), Paylaş → NotKoçu (Android cihazda test edildi)
5. [x] **Ses ve AI özetleri:** ses kaydı + transkript; haftalık özet; not detay ekranları (Android cihazda test edildi: ekran kapalıyken kayıt, transkript kalitesi, bölüm/satıra dokunup atlama, hafta özeti, Tipe göre/Zaman çizelgesi. **Test edilmedi:** arama/sistem kesintisi sırasında kayıt davranışı)
6. [ ] **Dışa aktarma ve test:** PDF + paylaşım menüsü; push bildirimleri; sınıf arkadaşlarıyla test; **preview build'de uçak modunda çevrimdışı açılış doğrulaması** (dev build'de uçak modu Metro'ya erişimi kestiği için test edilemez; 4a'da yalnızca API kapalıyken açılış doğrulandı)

**Kurulum notları (Google girişi):**

- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (mobil) ve `GOOGLE_WEB_CLIENT_ID` (API) aynı **Web application** client ID'sidir.
- Android client ID hiçbir `.env`'e yazılmaz. Android OAuth client yalnızca Google Cloud'da paket adı ve SHA-1 ile tanımlanır, uygulama kodu onu kullanmaz. Yanlışlıkla `.env`'e yazılırsa giriş sessizce başarısız olur ve API'ye istek gitmez.

**Kurulum notları (mobil):**

- SDK 58'de global `fetch` = `expo/fetch`; FormData'ya dosya `expo-file-system` `File` ile eklenir, `{ uri, name, type }` çalışmaz ("Unsupported FormDataPart implementation" hatası verir ve istek cihazdan hiç çıkmaz).
- `Stack.Protected` guard'ları açılışta ara durumlara göre değişmemeli; `ready` bir kez kilitlenir (`_layout.tsx`). Aksi halde navigator hazır olmadan rota listesi değişir ve LogBox'ta "REMOVE_ROUTES was not handled by any navigator" hataları birikir.

Sıralama bilinçli: Program içe aktarma en erken yapılıyor, çünkü otomatik atama ve hafta yapısı ona bağlı. Ses, en pahalı ve en riskli tip olduğu için sona bırakıldı. MVP sonrası için aday özellikler: ders içinde RAG ile soru sorma, quiz ve flashcard üretimi, görsel kart olarak dışa aktarma.

## Açık sorular ve riskler

| Konu | Risk | Önlem |
| --- | --- | --- |
| AI maliyeti | 1,5 saatlik ses kayıtlarının transkripti en pahalı iş | Kullanıcı başına aylık dakika limiti; Flash Lite modeli; kaydı parçalara bölüp işlemek |
| Program okuma doğruluğu | OBS ekranı farklı çıktığında dersler yanlış okunabilir | Onay ekranı zorunlu; düşük güven vurgusu; gerçek örneklerle test |
| Ses kaydı izni | Bazı hocalar kayda izin vermiyor | Kayıt öncesi "izin aldım" onayı; kayıtlar sadece kullanıcıya özel |
| Kişisel veri (KVKK) | Ses ve görsellerde başkalarının sesi ya da yüzü olabilir | Dosyalar özel depoda (GridFS), yalnızca sahibine auth'lu akışla verilir; hesap silinince tüm veri ve dosyalar siliniyor |
| Mobil arka plan kaydı | Uzun kayıtta iOS/Android uygulamayı durdurabilir | Expo dev build + arka plan ses izni; erken gerçek cihaz testi |
| Zayıf bağlantı | Sınıfta internet kesilirse not ya da dosya kaybolabilir | Not önce telefona kaydedilir (outbox), bağlantı gelince kendiliğinden gönderilir; `clientId` ile çift not oluşmaz |
| Mağaza süreci | App Store incelemesi ve hesap ücreti (Apple yıllık 99 $) | Test için TestFlight ve Android dahili test; mağaza yayını MVP sonrasına |

**Karar bekleyen sorular:**

- [ ] preview/production build aşamasında `EXPO_PUBLIC_API_URL` ve `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` EAS ortam değişkeni (`eas env:create`) olarak tanımlanacak; dev build'de Metro yerel `.env`'den okur.
- [ ] Play Store öncesi: Play App Signing SHA-1'i için ikinci Android OAuth client; Ayarlar'a "Hesabı sil" butonu.
- [ ] API ve worker için Railway mi Render mı kullanılacak?
- [x] Dosya depolama: MongoDB GridFS (Cloudflare R2 yok). Kuyruk: MongoDB tabanlı (Redis/BullMQ yok).
- [x] İlk test hangi platformda yapılacak: Android, fiziksel cihaz, Expo Go (dev build native modül gereken aşamada)
