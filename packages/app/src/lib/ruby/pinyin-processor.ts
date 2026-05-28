/**
 * Pinyin Processor — converts Chinese characters to pinyin/zhuyin readings.
 *
 * Uses a locally downloaded dictionary file (not bundled with the app).
 * The dictionary is a JSON mapping of characters/words to their readings.
 *
 * Dictionary format: { "char_or_word": "reading", ... }
 * e.g., { "你": "nǐ", "好": "hǎo", "你好": "nǐ hǎo", ... }
 */

// CDN URL for pinyin dictionary (~3MB)
export const PINYIN_DICT_URL =
  "https://cdn.jsdelivr.net/npm/@pinyin-pro/data@latest/json/modern.json";

export const PINYIN_DICT_FILENAME = "pinyin-dict.json";

export interface RubyToken {
  /** Original character(s) */
  char: string;
  /** Pronunciation reading (pinyin or zhuyin) */
  reading: string;
  /** Whether this token needs ruby (CJK character) */
  needsRuby: boolean;
}

// Singleton dictionary cache
// Format: { "word": ["pinyin reading", frequency] }
let _pinyinDict: Record<string, [string, number]> | null = null;

/**
 * Load pinyin dictionary from a local file path.
 * Call this once after download completes.
 */
export async function loadPinyinDict(dictPath: string): Promise<void> {
  // On Tauri desktop, use readTextFile directly (fetch won't work with bare fs paths)
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const text = await readTextFile(dictPath);
    _pinyinDict = JSON.parse(text);
    return;
  } catch {
    // Not Tauri or readTextFile failed — try fetch as fallback
  }

  try {
    const response = await fetch(dictPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    _pinyinDict = await response.json();
  } catch (err) {
    throw new Error(`Failed to load pinyin dictionary from ${dictPath}: ${err}`);
  }
}

/**
 * Set the dictionary directly (for testing or alternative loading)
 */
export function setPinyinDict(dict: Record<string, [string, number]>): void {
  _pinyinDict = dict;
}

/**
 * Check if dictionary is loaded
 */
export function isPinyinDictLoaded(): boolean {
  return _pinyinDict !== null;
}

// CJK Unified Ideographs range
const CJK_REGEX = /[一-鿿㐀-䶿豈-﫿]/;

/**
 * Annotate Chinese text with pinyin readings.
 * Uses longest-match-first for multi-char words.
 */
export function annotateChinese(
  text: string,
  _mode: "pinyin" | "zhuyin" = "pinyin",
): RubyToken[] {
  if (!_pinyinDict || !text) return [{ char: text, reading: "", needsRuby: false }];

  const tokens: RubyToken[] = [];
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    // Non-CJK characters — pass through
    if (!CJK_REGEX.test(char)) {
      // Collect consecutive non-CJK
      let j = i + 1;
      while (j < text.length && !CJK_REGEX.test(text[j])) j++;
      tokens.push({ char: text.slice(i, j), reading: "", needsRuby: false });
      i = j;
      continue;
    }

    // Try longest match (up to 4 chars)
    let matched = false;
    for (let len = Math.min(4, text.length - i); len >= 1; len--) {
      const word = text.slice(i, i + len);
      const entry = _pinyinDict[word];
      if (entry) {
        const reading = entry[0]; // entry format: [pinyin, frequency]
        // For multi-char words, split reading by space and assign per char
        const readings = reading.split(" ");
        if (readings.length === word.length) {
          for (let k = 0; k < word.length; k++) {
            tokens.push({ char: word[k], reading: readings[k], needsRuby: true });
          }
        } else {
          // Reading doesn't split evenly — annotate as a group
          tokens.push({ char: word, reading, needsRuby: true });
        }
        i += len;
        matched = true;
        break;
      }
    }

    // Single char fallback — no reading found
    if (!matched) {
      tokens.push({ char: char, reading: "", needsRuby: CJK_REGEX.test(char) });
      i++;
    }
  }

  return tokens;
}

/**
 * Convert pinyin to zhuyin (Bopomofo).
 * Basic conversion table for common syllables.
 */
export function pinyinToZhuyin(pinyin: string): string {
  // Simplified conversion — a full implementation would need a complete mapping table
  // For MVP, return pinyin as-is if no conversion available
  return pinyin; // TODO: implement full pinyin→zhuyin mapping
}
