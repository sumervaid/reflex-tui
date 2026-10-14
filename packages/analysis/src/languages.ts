import STOPWORDS_ISO from "stopwords-iso/stopwords-iso.json";
import { CASUAL_STOPWORDS } from "./casual-stopwords";

/**
 * Word-level handling of requests in any language, for intent terms. Three things English needed
 * no help with: words without spaces between them (Japanese, Chinese, Thai), particles glued to
 * Korean words (로딩이, 배포를), and filler words in every language. Stopword lists come from
 * stopwords-iso (MIT, compiled from published sources), never from any one user's history.
 */

const LISTS = STOPWORDS_ISO as Record<string, string[]>;
const sets = new Map<string, Set<string>>();
/** A language's stopwords: the published list, plus everyday fillers it misses (casual-stopwords.ts). */
function listOf(lang: string): Set<string> {
  let s = sets.get(lang);
  if (!s) sets.set(lang, (s = new Set([...(LISTS[lang] ?? []), ...(CASUAL_STOPWORDS[lang] ?? [])].map((w) => w.toLowerCase()))));
  return s;
}

/** Scripts written without spaces between words: split with the platform's word segmenter (ICU). */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Where Latin letters or digits meet Hangul: "ci가", "19로" are two words, the second a particle. */
const LATIN_HANGUL = /(?<=[\p{Script=Latin}\p{N}])(?=\p{Script=Hangul})|(?<=\p{Script=Hangul})(?=[\p{Script=Latin}\p{N}])/u;

/** Split one space-delimited chunk further: at Latin/Hangul boundaries, and by word in scripts written without spaces. */
export function splitUnspaced(chunk: string): string[] {
  return chunk.split(LATIN_HANGUL).flatMap((part) => (UNSPACED.test(part) ? [...segmenter.segment(part)].filter((s) => s.isWordLike).map((s) => s.segment) : [part]));
}

/** A single Han character is often a whole word (页 page, 慢 slow); other one-letter tokens are noise. */
export function meaningfulSingle(word: string): boolean {
  return /^\p{Script=Han}$/u.test(word);
}

/** Stopword lists for words in a non-Latin script; such words can never collide with English ones. */
const BY_SCRIPT: Array<[RegExp, string[]]> = [
  [/\p{Script=Hangul}/u, ["ko"]],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, ["ja"]],
  [/\p{Script=Han}/u, ["zh", "ja"]],
  [/\p{Script=Cyrillic}/u, ["ru", "uk", "bg"]],
  [/\p{Script=Arabic}/u, ["ar", "fa", "ur", "ku"]],
  [/\p{Script=Devanagari}/u, ["hi", "mr"]],
  [/\p{Script=Bengali}/u, ["bn"]],
  [/\p{Script=Gujarati}/u, ["gu"]],
  [/\p{Script=Thai}/u, ["th"]],
  [/\p{Script=Greek}/u, ["el"]],
  [/\p{Script=Hebrew}/u, ["he"]],
  [/\p{Script=Armenian}/u, ["hy"]],
];

/**
 * Latin-script languages. Their stopwords overlap English words (Spanish "a", "no"; German "die"),
 * so a list applies only to a request detected as that language.
 */
const LATIN = ["es", "de", "fr", "pt", "it", "nl", "ca", "gl", "ro", "pl", "cs", "sk", "sl", "hr", "hu", "fi", "et", "lv", "lt", "sv", "da", "no", "tr", "id", "ms", "vi", "tl", "sw", "af", "eu", "eo", "ga", "br", "la", "so", "st", "ha", "yo", "zu"];

/**
 * The Latin-script language a request is written in, by the classic method of counting each
 * language's function words; undefined for English or when too few words decide it.
 */
export function latinLanguage(words: string[]): string | undefined {
  const latin = words.filter((w) => /^\p{Script=Latin}+$/u.test(w));
  if (latin.length < 3) return undefined;
  const english = latin.filter((w) => listOf("en").has(w)).length;
  let best: string | undefined;
  let bestHits = 0;
  for (const lang of LATIN) {
    const list = listOf(lang);
    const hits = latin.filter((w) => list.has(w)).length;
    if (hits > bestHits) [best, bestHits] = [lang, hits];
  }
  return best && bestHits >= 2 && bestHits > english ? best : undefined;
}

/**
 * Whether a word carries no task meaning in its own script, or in the request's detected Latin-script
 * language. `keep` holds developer words no list may remove ("ci" is a French function word).
 */
export function isForeignStopword(word: string, latinLang: string | undefined, keep: ReadonlySet<string> = new Set()): boolean {
  if (keep.has(word)) return false;
  for (const [script, langs] of BY_SCRIPT) if (script.test(word)) return langs.some((l) => listOf(l).has(word));
  return latinLang !== undefined && listOf(latinLang).has(word);
}

/** Korean particles that attach to the end of a word, longest first. */
const KO_PARTICLES = ["에서는", "에서도", "으로는", "에게서", "에서", "에게", "한테", "까지", "부터", "처럼", "보다", "으로", "이랑", "하고", "이나", "이란", "로", "랑", "은", "는", "이", "가", "을", "를", "에", "의", "도", "만", "와", "과", "나"];
/** Predicate endings after a verbal noun (수정해줘, 추가하자, 개선해주세요), longest first. */
const KO_ENDINGS = ["해주세요", "해줄래", "해줘요", "해주라", "해줘", "해봐", "해야", "했는데", "했어", "하자", "하기", "하는", "하고", "하면", "하려고", "해서", "할", "해", "함", "됨", "돼", "되는", "된"];

/**
 * A Korean word without its trailing particle or verb ending: 로딩이 → 로딩, 배포를 → 배포,
 * 수정해줘 → 수정. Standard grammar, applied only when at least two syllables remain, so the same
 * noun matches however it is inflected. Used for matching, not for display accuracy.
 */
export function koreanStem(word: string): string {
  if (!/^\p{Script=Hangul}+$/u.test(word)) return word;
  for (const ending of KO_ENDINGS) if (word.endsWith(ending) && word.length - ending.length >= 2) return word.slice(0, -ending.length);
  for (const p of KO_PARTICLES) if (word.endsWith(p) && word.length - p.length >= 2) return word.slice(0, -p.length);
  return word;
}

/** Path pieces and file extensions ("src", "ts" from src/utils/date.ts): where code lives, not what was asked. */
const PATH_FRAGMENTS = new Set("src lib libs dist app apps pkg packages internal cmd ts tsx js jsx mjs cjs py rb rs java kt swift cpp hpp json yaml yml toml md mdx txt html css scss sql sh lock".split(" "));

/**
 * Whether a word is too generic to name a workflow: a stopword in any language's published or
 * casual list (the full English list too, which matching cannot use because it drops "test" and
 * "fix"), or a path fragment. `keep` holds developer words that always qualify.
 */
export function isGenericWord(word: string, keep: ReadonlySet<string> = new Set()): boolean {
  if (keep.has(word)) return false;
  if (PATH_FRAGMENTS.has(word)) return true;
  for (const lang of [...Object.keys(LISTS), ...Object.keys(CASUAL_STOPWORDS)]) if (listOf(lang).has(word)) return true;
  return false;
}
