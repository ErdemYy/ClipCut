/**
 * Otomatik Emoji Eşleştirme Motoru (Frontend).
 * Backend'deki app.subtitles.emoji ile senkronizedir.
 */

export const EMOJI_MAP: Record<string, string[]> = {
  "🔥": [
    "ateş", "yangın", "bomba", "harika", "inanılmaz", "süper", "çılgın", "mükemmel",
    "efso", "şaheser", "muazzam", "patlama", "hot", "fire", "insane", "crazy",
    "incredible", "epic", "amazing", "lit", "bomb", "awesome", "great", "flame",
  ],
  "🚀": [
    "roket", "fırlat", "büyüme", "hız", "uzay", "gelecek", "yükseliş", "başla",
    "hızlı", "patlat", "uçuş", "fırla", "rocket", "launch", "fast", "speed",
    "future", "scale", "boost", "spaceship", "blast", "start", "upward",
  ],
  "💡": [
    "fikir", "akıl", "düşün", "buluş", "mantık", "zeka", "ipucu", "sır",
    "yöntem", "taktik", "öğren", "anla", "idea", "tip", "secret", "hack",
    "smart", "brain", "think", "method", "tactic", "clever", "solution",
  ],
  "💰": [
    "para", "zengin", "kazanç", "dolar", "bütçe", "gelir", "nakit", "sermaye",
    "servet", "milyon", "finans", "maliyet", "ücret", "satış", "ciro",
    "money", "cash", "rich", "profit", "wealth", "revenue", "dollar", "income",
    "sales", "cost", "price", "million", "finance", "crypto",
  ],
  "⚡": [
    "enerji", "şok", "elektrik", "ani", "güç", "dikkat", "uyan", "yıldırım",
    "çarpıcı", "flaş", "power", "shock", "energy", "fast", "bolt", "alert",
    "electric", "instant", "thunder",
  ],
  "🎯": [
    "hedef", "başarı", "odak", "tam", "nokta", "doğru", "vizyon", "amaç",
    "vur", "hedefi", "target", "goal", "focus", "bullseye", "aim", "direct",
  ],
  "🏆": [
    "şampiyon", "zafer", "kazandık", "bir numara", "en iyi", "lider", "ödül",
    "kupa", "birinci", "win", "winner", "champion", "trophy", "number1",
    "best", "first", "victory", "award",
  ],
  "📈": [
    "grafik", "artış", "yükseliş", "kar", "büyü", "geliş", "trend", "istatistik",
    "growth", "chart", "stonks", "bull", "trending", "increase", "rising",
  ],
  "🤖": [
    "robot", "yapay zeka", "ai", "kod", "teknoloji", "yazılım", "algoritma",
    "otomasyon", "sistem", "bilgisayar", "tech", "code", "model", "prompt",
    "software", "algorithm",
  ],
  "👑": [
    "kral", "kraliçe", "lider", "efsane", "patron", "en tepe", "zirve", "usta",
    "king", "queen", "boss", "crown", "elite", "legend", "master", "top",
  ],
  "❤️": [
    "aşk", "sevgi", "kalp", "bayıldım", "tutku", "harikasınız", "sevdim",
    "love", "heart", "passion", "favorite", "beloved",
  ],
  "⏳": [
    "zaman", "süre", "bekle", "saat", "dakika", "geç", "vakit", "zamanlama",
    "time", "clock", "wait", "hurry", "minute", "hour", "timing",
  ],
  "😱": [
    "şaşırtıcı", "imkansız", "olamaz", "inanmıyorum", "korkunç", "dehşet",
    "şok", "vay", "omg", "wow", "crazy", "shocking", "unreal", "unbelievable",
  ],
  "🔒": [
    "güvenlik", "kilit", "gizli", "özel", "koruma", "şifre", "güvenli",
    "secret", "safe", "lock", "privacy", "secure", "private", "hidden",
  ],
  "📣": [
    "duyuru", "seslen", "haber", "dinle", "konuş", "dikkat", "müjde",
    "announce", "listen", "shout", "speak", "news", "hear",
  ],
  "❌": [
    "yanlış", "hata", "yapma", "sakın", "dur", "asla", "hayır", "vazgeç",
    "stop", "no", "error", "wrong", "dont", "never", "fail", "bad",
  ],
  "✅": [
    "doğru", "onay", "evet", "tamam", "hazır", "başarılı", "garanti",
    "yes", "check", "correct", "done", "ready", "success", "confirmed",
  ],
  "👀": [
    "bak", "gör", "izle", "dikkat et", "fark et", "bakın", "gözlem",
    "look", "see", "watch", "notice", "eyes", "check this",
  ],
};

const WORD_TO_EMOJI = new Map<string, string>();
for (const [emoji, words] of Object.entries(EMOJI_MAP)) {
  for (const w of words) {
    const clean = w.toLowerCase().trim();
    if (!WORD_TO_EMOJI.has(clean)) WORD_TO_EMOJI.set(clean, emoji);
  }
}

function normalize(token: string): string {
  return token
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

export function findEmojiForWord(word: string): string | null {
  const clean = normalize(word);
  if (!clean) return null;
  if (WORD_TO_EMOJI.has(clean)) return WORD_TO_EMOJI.get(clean)!;

  if (clean.length >= 4) {
    for (const [key, emo] of WORD_TO_EMOJI.entries()) {
      if (key.length >= 4 && clean.startsWith(key)) {
        return emo;
      }
    }
  }
  return null;
}
