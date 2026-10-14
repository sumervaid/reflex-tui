/**
 * Everyday conversational fillers that published stopword lists (drawn from formal, written text)
 * miss, for languages whose casual requests are full of them. General to each language: pronouns,
 * "now / just / first / please", politeness and sentence endings; never task words. Not taken from
 * any user's history. Extend by pull request; keep each entry a word people type in any request.
 * Matched after word splitting and Korean particle stripping (see languages.ts).
 */
export const CASUAL_STOPWORDS: Record<string, string[]> = {
  ko: [
    // pronouns and demonstratives
    "내가", "제가", "나는", "저는", "내", "제", "우리", "우리가", "너", "니가", "이거", "그거", "저거", "이것", "그것", "저것", "여기", "거기", "이런", "그런", "저런",
    // now / first / just / again
    "지금", "현재", "일단", "우선", "먼저", "이제", "아까", "방금", "그냥", "그저", "다시", "한번", "계속", "아직", "벌써",
    // degree and hedges
    "너무", "정말", "진짜", "완전", "약간", "조금", "좀", "많이", "혹시", "아마", "대충", "뭔가", "뭐", "어떻게", "왜", "무슨",
    // connectives
    "그리고", "근데", "그런데", "그래서", "그러면", "그럼", "아니면", "또", "및",
    // requests and politeness
    "부탁", "부탁해", "부탁해요", "부탁드려요", "해줘", "해주세요", "해줄래", "주세요", "줘", "할래", "하자", "해봐", "봐줘", "알려줘", "같은", "같아", "같은데", "있는", "있어", "없어", "하는", "되는", "있으면", "그거랑",
  ],
  ja: [
    // pronouns and demonstratives
    "私", "僕", "俺", "これ", "それ", "あれ", "この", "その", "あの", "ここ", "そこ", "こっち", "そっち",
    // now / first / just / again
    "今", "いま", "まず", "とりあえず", "一旦", "いったん", "ちょっと", "ちょい", "また", "もう", "まだ", "すぐ", "全然", "なんか", "やっぱり", "たぶん", "多分",
    // requests, politeness and endings (くだ / さい are how the word segmenter splits ください)
    "ください", "くだ", "さい", "お願い", "おねがい", "お願いします", "して", "します", "しま", "ます", "です", "でし", "たい", "てる", "ってる", "って", "ので", "けど", "から", "よう", "ほしい", "欲しい",
  ],
  zh: [
    // pronouns and demonstratives
    "我", "我的", "我们", "你", "你的", "帮", "帮我", "给我", "这个", "那个", "这些", "那些", "这里", "那里",
    // now / first / just / again
    "现在", "先", "一下", "一下子", "看看", "再", "还", "也", "就", "又", "一直", "有点", "有些",
    // requests, particles and politeness
    "请", "麻烦", "麻烦你", "吧", "呢", "啊", "吗", "了", "的", "得", "地", "很", "要", "想", "能", "可以", "需要", "一些", "什么", "怎么", "为什么",
  ],
};
