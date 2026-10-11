/**
 * BERT WordPiece tokenizer (uncased), as used by all-MiniLM-L6-v2: lowercase, strip accents, split
 * on whitespace and punctuation, then greedy longest-match subwords with a "##" continuation prefix.
 */
export class WordPieceTokenizer {
  readonly cls: number;
  readonly sep: number;
  readonly unk: number;
  private vocab: Map<string, number>;

  constructor(vocabText: string) {
    this.vocab = new Map();
    vocabText.split("\n").forEach((token, i) => {
      const t = token.replace(/\r$/, "");
      if (t && !this.vocab.has(t)) this.vocab.set(t, i);
    });
    const id = (t: string) => {
      const v = this.vocab.get(t);
      if (v === undefined) throw new Error(`Vocabulary is missing ${t}`);
      return v;
    };
    this.cls = id("[CLS]");
    this.sep = id("[SEP]");
    this.unk = id("[UNK]");
  }

  /** Basic tokenization: words, with each punctuation mark and CJK ideograph as its own token. */
  static words(text: string): string[] {
    const clean = text
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ");
    return clean.match(/[\p{Script=Han}]|[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}]/gu) ?? [];
  }

  private pieces(word: string): number[] {
    if (word.length > 100) return [this.unk];
    const out: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found: number | undefined;
      while (end > start) {
        found = this.vocab.get((start > 0 ? "##" : "") + word.slice(start, end));
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) return [this.unk];
      out.push(found);
      start = end;
    }
    return out;
  }

  /** Token ids with [CLS] and [SEP], truncated to `maxTokens` in total. */
  encode(text: string, maxTokens: number): number[] {
    const ids = [this.cls];
    for (const w of WordPieceTokenizer.words(text)) {
      for (const p of this.pieces(w)) {
        if (ids.length >= maxTokens - 1) break;
        ids.push(p);
      }
      if (ids.length >= maxTokens - 1) break;
    }
    ids.push(this.sep);
    return ids;
  }
}
