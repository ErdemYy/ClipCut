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
- **Sıfır Maliyetli Mock Modu:** `GEMINI_API_KEY` girilmediğinde sistem otomatik olarak mock AI modunda çalışır ve ücret ödemeden tüm akışı test etmenizi sağlar.

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
