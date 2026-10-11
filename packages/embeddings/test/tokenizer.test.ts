import { describe, expect, it } from "vitest";
import { WordPieceTokenizer } from "../src/tokenizer";

const VOCAB = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "the", "login", "page", "load", "##s", "##ing", "fast", "##er", "café", "cafe", ",", "!"].join("\n");

describe("WordPiece tokenizer", () => {
  const tok = new WordPieceTokenizer(VOCAB);
  const id = (t: string) => VOCAB.split("\n").indexOf(t);

  it("lowercases, strips accents and splits punctuation", () => {
    expect(WordPieceTokenizer.words("The LOGIN page, loads!")).toEqual(["the", "login", "page", ",", "loads", "!"]);
    expect(WordPieceTokenizer.words("Café")).toEqual(["cafe"]);
  });

  it("splits words into the longest known subwords", () => {
    expect(tok.encode("loading faster", 32)).toEqual([id("[CLS]"), id("load"), id("##ing"), id("fast"), id("##er"), id("[SEP]")]);
  });

  it("maps a word with any unknown piece to [UNK]", () => {
    expect(tok.encode("loadx page", 32)).toEqual([id("[CLS]"), id("[UNK]"), id("page"), id("[SEP]")]);
  });

  it("truncates to the token budget and still ends with [SEP]", () => {
    const ids = tok.encode("the login page loads the login page loads", 5);
    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe(id("[CLS]"));
    expect(ids.at(-1)).toBe(id("[SEP]"));
  });

  it("refuses a vocabulary without special tokens", () => {
    expect(() => new WordPieceTokenizer("a\nb")).toThrow(/missing/);
  });
});
