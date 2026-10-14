import { describe, expect, it } from "vitest";
import { intentTerms } from "../src/intents";
import { isForeignStopword, koreanStem, latinLanguage, splitUnspaced } from "../src/languages";

describe("requests in other languages", () => {
  it("splits scripts written without spaces into words", () => {
    expect(splitUnspaced("チェックアウトページの読み込みが遅い")).toEqual(expect.arrayContaining(["ページ", "読み込み", "遅い"]));
    expect(splitUnspaced("결제페이지")).toEqual(["결제페이지"]); // Korean uses spaces; left as is
  });

  it("separates Korean particles glued to English words or numbers", () => {
    expect(splitUnspaced("ci가")).toEqual(["ci", "가"]);
    expect(splitUnspaced("README에")).toEqual(["README", "에"]);
  });

  it("strips Korean particles and verb endings when two syllables remain", () => {
    expect(koreanStem("로딩이")).toBe("로딩");
    expect(koreanStem("배포를")).toBe("배포");
    expect(koreanStem("수정해줘")).toBe("수정");
    expect(koreanStem("추가해주세요")).toBe("추가");
    expect(koreanStem("페이지")).toBe("페이지");
    expect(koreanStem("이")).toBe("이");
    expect(koreanStem("loading")).toBe("loading");
  });

  it("detects a Latin-script language from its function words, and never calls English foreign", () => {
    expect(latinLanguage("el ci está fallando en main desde el último merge".split(" "))).toBe("es");
    expect(latinLanguage("die ci auf main schlägt seit dem letzten merge fehl".split(" "))).toBe("de");
    expect(latinLanguage("the ci is failing on main after the last merge".split(" "))).toBeUndefined();
    expect(latinLanguage("fix ci".split(" "))).toBeUndefined();
  });

  it("applies a language's stopwords only to that script or detected language, and never to developer words", () => {
    expect(isForeignStopword("지금", undefined)).toBe(true);
    expect(isForeignStopword("de", "es")).toBe(true);
    expect(isForeignStopword("de", undefined)).toBe(false);
    expect(isForeignStopword("ci", "fr", new Set(["ci"]))).toBe(false);
  });

  it("gives comparable terms for the same task asked in different ways", () => {
    expect(intentTerms("결제 페이지 로딩이 너무 느려")).toEqual(expect.arrayContaining(["결제", "페이지", "로딩"]));
    expect(intentTerms("チェックアウトページの読み込みが遅い")).toEqual(expect.arrayContaining(["ページ", "読み込み", "遅い"]));
    expect(intentTerms("结账页面加载要四秒，太慢了")).toEqual(expect.arrayContaining(["太慢"]));
    expect(intentTerms("la CI échoue sur main depuis le dernier merge")).toEqual(expect.arrayContaining(["ci", "main", "merge"]));
    expect(intentTerms("la CI échoue sur main depuis le dernier merge")).not.toContain("la");
  });

  it("drops everyday fillers, so unrelated casual requests share no terms", () => {
    const ci = intentTerms("내가 지금 일단 CI 깨진 거 좀 봐줘");
    const docs = intentTerms("내가 지금 그냥 README 좀 업데이트해줘");
    expect(ci.filter((t) => docs.includes(t))).toEqual([]);
    expect(intentTerms("とりあえず今ちょっとCIを直してください")).not.toEqual(expect.arrayContaining(["とりあえず"]));
    expect(intentTerms("帮我看一下现在CI为什么失败")).not.toContain("帮我");
  });

  it("leaves English requests as before", () => {
    expect(intentTerms("CI is failing on main after the last merge, figure out why and fix it")).toEqual(["ci", "fail", "main", "last", "merge", "fix"]);
  });
});
