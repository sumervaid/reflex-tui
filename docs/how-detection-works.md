# How detection works

```
scan history → find repeats across ≥ 3 independent sessions → show evidence
            → you approve → SKILL.md in ~/.reflex/skills → you install → a fresh agent session uses it
```

Each session becomes a trace: what was asked (intent terms), what was done (ordered actions such
as inspect CI, install dependencies, patch, run tests, inspect the diff), normalized commands,
file categories and outcome. Copies, resumed sessions and quick retries count once. Traces are
compared on intent (0.40), action sequence (0.30), commands and tools (0.15), file categories
(0.10) and repository (0.05), then clustered. Intent compares the requests' words (stemmed terms,
phrases and a small concept lexicon) in any language: Japanese, Chinese and Thai are split into
words, Korean particles are stripped (배포를 → 배포), filler words are dropped (published lists plus
everyday fillers, `casual-stopwords.ts`) and words your own history uses across unrelated kinds of
work are quieted, more so as the history grows; with the optional model (`reflex model fetch`) it also compares
their meaning, so "make the login page load faster", "the sign-in screen is really slow" and
"로그인 화면이 너무 느려" match. A cluster becomes a suggestion only if it has at
least 3 independent sessions with consistent behavior; one-offs, read-and-answer sessions and
generic "read, edit, test" patterns are not suggested.

Suggestions need the same kind of task in at least 3 independent sessions. If a week of history
finds nothing, try a longer window (`--days 30`).

The skill contains only steps seen in at least half the sessions, in the order they usually
happened, with example commands that recurred and passed a safety filter. Corrections you gave in
follow-up messages ("don't change the CI workflow") become constraints when the same correction
appears in at least 2 sessions; only the words those sessions share are kept. No transcript excerpts.

Thresholds, clustering and the evaluation set: [architecture.md](architecture.md#from-sessions-to-suggestions).
Matching by meaning and which model to pick: [embedding-models.md](embedding-models.md).

## Limitations

- Confidence is a ranking heuristic, not a probability.
- Without the model, intent matching uses stemmed TF-IDF plus a small built-in lexicon (English).
  Requests worded with no words in common, or asked in different languages, need
  `reflex model fetch` to match.
- Embedding models do not know developer jargon as well as the lexicon ("GitHub Actions is red" vs.
  "CI is failing"), so they are combined with word matching, never used alone. With the light
  model, requests in other scripts (Korean, Japanese, ...) are matched by words only. Clusters
  found only by meaning may get a generic name.
- Each source reads at most its 2,000 most recent files per scan.
