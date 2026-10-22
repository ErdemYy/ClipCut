"""Otomatik Emoji Eşleştirme Motoru (Alex Hormozi & Submagic Stili).

Transkriptteki kelimeleri Türkçe ve İngilizce duygu/anlam sözlüğü ile tarar
ve uygun anahtar kelimelere bağlamsal emojiler (🔥, 🚀, 💡, 💰, ⚡ vb.) eşler.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

# Emoji kategorileri ve anahtar kelimeler (Türkçe & İngilizce)
EMOJI_DICTIONARY: dict[str, list[str]] = {
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
}

# Hızlı arama için ters indeks (kelime -> emoji)
_WORD_TO_EMOJI: dict[str, str] = {}
for emoji, words in EMOJI_DICTIONARY.items():
    for word in words:
        clean = word.lower().strip()
        if clean not in _WORD_TO_EMOJI:
            _WORD_TO_EMOJI[clean] = emoji


def _normalize(token: str) -> str:
    """Noktalama işaretlerini temizler ve Türkçe küçük harfe dönüştürür."""
    # Türkçe I/İ dönüşümü
    token = token.replace("İ", "i").replace("I", "ı").lower()
    # Noktalama temizliği
    return re.sub(r"[^\w\s]", "", token).strip()


def find_emoji_for_word(word_text: str) -> Optional[str]:
    """Tek bir kelime veya kısa ifade için eşleşen emojiyi döner."""
    cleaned = _normalize(word_text)
    if not cleaned:
        return None

    # Doğrudan tam eşleşme
    if cleaned in _WORD_TO_EMOJI:
        return _WORD_TO_EMOJI[cleaned]

    # Kök / ön ek eşleşmesi (örn: "kazançlarımız" -> "kazanç", "paralar" -> "para")
    if len(cleaned) >= 4:
        for key, emo in _WORD_TO_EMOJI.items():
            if len(key) >= 4 and cleaned.startswith(key):
                return emo

    return None


def find_emoji_for_segment(segment_text: str) -> Optional[str]:
    """Bir cümle veya segment içindeki en güçlü kelime için emoji bulur."""
    tokens = segment_text.split()
    for tok in tokens:
        found = find_emoji_for_word(tok)
        if found:
            return found
    return None
