# ClipCut 🎬✨

ClipCut, yapay zekâ destekli modern bir video üretim ve akıllı edit stüdyosudur.

- **Prompt ile Video Üret:** Google Veo entegrasyonu ile metinden sinematik video üretimi (9:16 veya 16:9).
- **Otomatik & Çok Dilli Altyazı:** Gemini API ile kelime zaman damgalı transkripsiyon ve 17+ dile çeviri.
- **Canlı Altyazı Stilleri:** TikTok/Reels tarzı kelime vurgulama (Karaoke), pop efekti, klasik sinema, kutulu ve minimal stiller.
- **Doğal Dil Prompt'u ile Otomatik Edit:** *"Sessiz kısımları sil, dikey yap, sarı karaoke altyazı koy, hafif lofi müzik ekle ve başa 'Yeni Ürün' yaz"* gibi doğal dil komutlarıyla otomatik kurgu planı oluşturma.
- **Deterministik FFmpeg Motoru:** AI doğrudan komut satırı çalıştırmaz; Pydantic ile doğrulanan bir JSON Edit DSL planı üretir, Python motoru bunu güvenli ve hatasız şekilde FFmpeg filtre grafiğine dönüştürür.
- **Gelişmiş Edit İşlemleri:** Sessizlik temizleme (`silencedetect`), yeniden boyutlandırma/reframe (9:16, 1:1, 16:9, blur arka plan), geçiş efektleri (`xfade`), renk filtreleri (`eq`, `lut`), hız değiştirme, ses ducking (`sidechaincompress`), ses efektleri (whoosh, pop, ding) ve animasyonlu başlıklar.
- **Geri Al / İleri Al:** Edit geçmişi sayesinde yapılan her işlem tek tıkla geri alınabilir.
- **Dışa Aktarma:** 1080p MP4 ve ayrıca SRT / VTT altyazı dosyası indirme.
- **Çoklu Platform İhracatı:** Dışa Aktar panelinden TikTok/Reels/Shorts (9:16), Instagram (1:1 ve 4:5), YouTube (16:9) formatlarını seçip tek işte sıralı render alın. Bulanık kenar doldurma, siyah kenar veya merkez kırpma; 720p/1080p/4K ve kalite seçenekleri desteklenir. MP4 ve JPG kapaklar tek tek veya topluca ZIP olarak indirilir.
- **Kapak Karesi Seçici:** Kaynak videoyu oynatıp/sürükleyip proje kapağını kaydedin. Çoklu format render'ında seçilen kaynak zamanı edit zaman çizelgesine eşlenir; kare kesildiyse ilk çıktı karesi kullanılır ve sonuçta belirtilir.
- **Uzun Videodan Kısa Klipler:** Editörde **Kısa Klipler** sekmesinden 30–60 saniye aralığını ve aday sayısını seçin. Yerel FFmpeg sessizlik analizi konuşma yoğunluğunu sıralar; mevcut gerçek transkript varsa kelime/dakika bilgisi de kullanılır. Adayları önizleyin ve seçtiklerinizi bağımsız 9:16 MP4 dosyaları/ZIP olarak çıkarın. Kaynak ses ile altyazı/renk stili korunur; ana editteki hız, kesimler, seslendirme ve zamanlı katmanlar kliplere taşınmaz. Bu özellik ücretli AI çağrısı yapmaz, anlamsal önem veya viral başarı garantisi vermez; müzik/gürültü konuşma gibi algılanabilir. Tamamen sessiz/sessiz ağırlıklı videoda aday bulunmayabilir.
- **Sıfır Maliyetli Mock Modu:** `GEMINI_API_KEY` girilmediğinde sistem otomatik olarak mock AI modunda çalışır ve ücret ödemeden tüm akışı test etmenizi sağlar.

## Senaryodan çok sahneli video

1. **Yeni Video → Senaryodan Üret** bölümüne konuyu veya hazır senaryoyu yazın; dil, format, ortak stil, 2–12 sahne ve sahne süresini seçin.
2. **Önce sahne planını hazırla** yalnızca taslak oluşturur. Gerçek AI modunda metin çağrısı için ayrı onay istenir; bu aşamada video üretilmez.
3. Editördeki **Sahneler** panelinde başlıkları, görsel promptları, anlatımı, ortak karakter/mekân yönergelerini düzenleyin; yukarı/aşağı düğmeleriyle sırayı değiştirip kaydedin. Dil seçmek mevcut anlatımı otomatik çevirmez.
4. **Sahne zaman çizelgesi** üretilmiş sahnelerin küçük resimlerini, süre dağılımını ve birleşik zamanlarını gösterir. Kartları sürükleyip bırakarak veya **Sola/Sağa taşı** düğmeleriyle sırayı değiştirin; seçili sahneyi kırpma aralığında oynatıp başlangıç/bitiş noktalarını ayarlayın. Önizleme kırpma sınırında durur. Kırpma, sıralama ve geçişler AI video üretimi başlatmaz; yalnızca kaydedilip yerel olarak yeniden birleştirilir. Kırpma sesi ve altyazı kelimelerini de keser, yeni konuşma üretmez.
5. Her sahne için **önceki sahneden geçiş** seçin: sert kesme, çözünme (crossfade) veya kararmadan geçiş. Süre 0.2–2 sn arasındadır; kısa sahnelerde iki sahnenin %40'ıyla otomatik sınırlanır. Geçişlerde video ve ses birlikte çaprazlanır; altyazı kelimeleri yeni başlangıç zamanına kaydırılır, böylece dudak/ses ve altyazı eşleşmesi korunur.
6. Seslendirme ve altyazı seçeneklerini belirleyip **Kalan N sahneyi üret ve birleştir** düğmesine basın. Gerçek modda video üretimi için ayrıca onay gerekir. Görsel promptlar Google'a; açıkken anlatım metinleri mevcut Edge TTS servisine gönderilir. Sahne önizlemeleri ve ilerleme kaydedilir.
7. **Üretim kontrol merkezi:** Üretim sürerken panelde aktif sahne, kalan sahne sayısı ve **Kalan üretimi durdur** düğmesi görünür. Durdurma talebi kooperatiftir: sürmekte olan sahne bitene kadar beklenir (o sahne için sağlayıcıya başlatılmış istek ücretlenmiş olabilir), daha başlamamış sahneler atlanır ve bu çalışmada birleştirme yapılmaz. Durduktan sonra aynı düğme yalnızca kalan sahneleri üretir; hazır sahneler değişmez. Durdurma son sahnenin üretimi sırasında gelirse ve tüm sahneler hazır olursa birleştirme tamamlanır (yerel, ücretsiz işlem). Yalnızca `storyboard_generate` işleri durdurulabilir; diğer iş türleri (çeviri, render, ihracat) sonuna kadar çalışır ve durdurma isteği 409 döner. Aynı proje ve iş türü için zaten sırada/çalışan bir işlem varken yeni istek 409 döner — ücretli çağrıların (üretim, transkribe, çeviri) veya uzun yerel işlerin (render, ihracat) çift tetiklenmesi engellenir.
8. Sahneler 720p/30fps ve ortak ses biçimine normalize edilip tek kaynak videoda birleştirilir. Kırpılan aralıklar ve geçişler bu aşamada uygulanır; altyazılar editör önizlemesinde gösterilir ve render sırasında yakılır. Ardından mevcut edit ve çoklu platform ihracatı kullanılabilir.

**Devam / yeniden üretim:** Başarılı sahneler korunur. Plan değişiklikleri yalnızca ilgili önbellekleri geçersiz kılar; sadece anlatım değişirse mevcut ham görsel tekrar kullanılır. Tek sahne yeniden üretilebilir. Yeniden birleştirmede eski kaynak ve edit verileri korunur; zamanlı editler yeni kaynağa otomatik taşınmaz ve bunun için ayrıca onay istenir.

**Sürüm geri yükleme:** Her birleştirmede önceki durum "Korunan sürümler" listesine arşivlenir (en fazla 6; dosyalar silinmez). Yeni arşivlerde o kaynağı üreten sahne planının tam kopyası da durur. onay kutusu işaretlenip **Bu sürümü geri yükle** dendiğinde arşivdeki kaynak video, edit durumu (plan/plan geçmişi/altyazı/çıkış dosyası) ve sahne planı geri gelir; geri yükleme anındaki durum önce yeni bir korunan sürüm olarak eklenir, yani işlem geriden de dönebilir. Eski biçimde arşivlenmiş (plan kopyası olmayan) sürümler yalnızca video bağlantısı olarak açılır, restore yapılamaz; sürüm arşivi üretim sürerken engellenir.

Eski kaynak videolar Sahneler panelinden açılabilir.

**Panel kısayolları:** Dashboard proje kartlarında sahne üretimi durumu gösterilir: üretim sürerken veya tamamlanmadan önce kartta `🎬 hazır/toplam sahne üretildi` etiketi görünür (panel 2,5 saniyede bir yenilenir); birleştirme bekleyen hazır sahneler de bağımsız birleştirmeye davet eder. Kaynak video, render çıktısı ve altyazı `.srt` dosyası için doğrudan **⬇ Kaynak / ⬇ Çıkış / ⬇ SRT** indirme düğmeleri kartın altındadır — editörü açmaya gerek kalmadan. SRT indirme başlığı artık Türkçe proje adlarını da destekler (RFC 5987 `filename*` kodlaması); öncesinde Türkçe adlı projelerde SRT indirme 500 hatası veriyordu. SRT düğmesi yalnızca altyazı varken görünür.

**Sınırlar:** Planlanan toplam süre, sağlayıcının faturalandırdığı süre/tutar değildir. Uzun anlatımda son kare tutulur (sahne en fazla 30 sn); karakter tutarlılığı yalnızca ortak promptlarla teşvik edilir, garanti edilmez. Kırpma en az 0.25 sn bırakmalıdır; kırpma yalnızca hazır ve değişmemiş sahnelerde yapılabilir, üretim ayarı değişen sahnede önce kırpma sıfırlanmalıdır. Bir kelimenin ortasından kesilen konuşma yarım kalabilir. Geçişler toplam süreyi kısaltır; geçiş sırasında iki sahnenin anlatımı kısa süre örtüşebilir. Kararmadan geçiş ayrı bir siyah boşluk eklemez, iki sahneyi siyah üzerinden çaprazlar. Geçişler yalnızca birleştirme sırasında uygulanır; sahne dosyaları değişmez. Sağlayıcıda başlayıp sonucu alınamayan istek ücretlenmiş olabilir; yeniden deneme ek ücret doğurabilir. Sabit parasal harcama limiti uygulanmaz. Demo modunda taslak mekaniktir, görseller demo üretimidir ve ses gerçek konuşma değil sentetik tondur; TTS dahil harici API çağrısı yapılmaz. Storyboard gerçek modunda TTS başarısız olursa demo sesle devam edilmez.

**Model uyumluluğu:** Varsayılan `veo-3.0-fast-generate-001`, [Google dokümanında](https://ai.google.dev/gemini-api/docs/veo) deprecated durumundadır ve gerçek modda 8 sn sahneyle sınırlandırılmıştır. Veo 3.1 Preview sürümleri 22 Ekim 2026'da kapatılmıştır. Mevcut sağlayıcı otomatik değiştirilmez; gerçek hesap/model erişimi ayrıca doğrulanmalıdır. Testler ücretli video üretimi yapmadan mock ve yerel FFmpeg ile çalıştırılır.

---

## 🚀 Hızlı Başlangıç

### 1. Gereksinimler
- **Python 3.11+**
- **Node.js 20+**
- **FFmpeg** (Proje otomatik olarak Python `imageio-ffmpeg` üzerinden taşınabilir FFmpeg ikilisini bulur; ek kuruluma gerek yoktur)

---

### 2. Backend'i Başlatma

```powershell
cd C:\Users\Okul\.gemini\antigravity-ide\scratch\clipcut\backend

# Sanal ortamı aktive edin (zaten hazır)
.\.venv\Scripts\Activate.ps1

# (İsteğe bağlı) Gerçek Gemini & Veo için API anahtarı ayarlayın
# .env dosyasında:
# GEMINI_API_KEY=your_gemini_api_key

# Sunucuyu başlatın
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Backend API adresi: `http://localhost:8000`  
Etkileşimli Swagger dokümantasyonu: `http://localhost:8000/docs`

---

### 3. Frontend'i Başlatma

```powershell
cd C:\Users\Okul\.gemini\antigravity-ide\scratch\clipcut\frontend

npm run dev
```

Tarayıcınızda açın: `http://localhost:3000`

---

## 🛠️ Kolay Başlatma Dosyaları

Proje kök dizininde tek tıkla her iki servisi de başlatan script'ler hazırlanmıştır:
- `start-all.ps1` (PowerShell)
- `start-backend.bat`
- `start-frontend.bat`

---

## 🧠 Desteklenen Prompt Edit Komutları (Örnekler)

Editör içindeki prompt kutusuna Türkçe veya İngilizce serbestçe yazabilirsiniz:

- *"Sessiz yerleri temizle"* (Sessizlikleri otomatik tespit eder ve kaldırır)
- *"Videoyu dikey yap (9:16)"* veya *"TikTok formatına çevir"*
- *"Sarı karaoke altyazı ekle"*
- *"Kelime kelime büyüyen pop altyazı yap, büyük harf olsun"*
- *"Altyazıyı üste al ve fontunu Poppins yap"*
- *"Hafif lofi fon müziği koy ve konuşurken sesi kısılsın"*
- *"Enerjik müzik ekle"*
- *"Sinematik renk filtresi ve vinyet uygula"*
- *"Siyah beyaz yap"*
- *"Parçalar arasına kayma (slide) geçişi koy"*
- *"Başa 'Hoş Geldiniz' başlığı ekle"*
- *"1.25 kat hızlandır"*
- *"İlk 3 saniyeyi kes"* veya *"5 ile 8. saniye arasını çıkar"*
- *"Konuşma sesini normalize et"*
