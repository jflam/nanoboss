# Commit focus report: last 40 commits

Window analyzed: `git log -n 40` at `HEAD` `0c926d0`, spanning `0c926d0` back through `b450766`.

## Executive summary

The last 40 commits strongly support the intuition that this repo's recent history is composed of focused, mostly single-purpose commits.

My best single-number summary is:

> **Commit Focus Score: 78 / 100**

That score is not a built-in git metric; it is a heuristic I derived from the commit history to measure how atomic the recent commits are. On this scale, **78** reads as **"highly focused, with a handful of broader but still coherent refactor sweeps."**

A stricter companion metric points the same way:

- **Strict atomicity rate:** **22 / 39 non-merge commits = 56.4%**
- Definition: commits that simultaneously stay within **<=12 files**, **<=250 LOC churn**, **<=3 top-level repo areas**, and use a **single-action subject**.

I excluded the one merge commit from the main statistics, since merges aggregate already-reviewed work and are not good units for commit-focus analysis.

---

## 1. Raw results

All percentages below are over the **39 non-merge commits** in the last-40 window.

| Metric | Result | Interpretation |
|---|---:|---|
| Median files changed | **5** | Typical commit is small |
| Mean files changed | **8.7** | Average pulled up by a few broad sweeps |
| Median churn | **90 LOC** | Typical diff is modest |
| Mean churn | **228 LOC** | Again skewed by a small number of large refactors |
| Commits with **<=5 files** | **21 / 39 = 53.8%** | Over half are very compact |
| Commits with **<=10 files** | **26 / 39 = 66.7%** | Two-thirds are compact |
| Commits with **<=100 LOC churn** | **22 / 39 = 56.4%** | Over half are very small diffs |
| Commits with **<=250 LOC churn** | **28 / 39 = 71.8%** | Most are modest |
| Commits touching **<=2 top-level areas** | **22 / 39 = 56.4%** | Usually narrow in repo footprint |
| Commits touching **<=3 top-level areas** | **29 / 39 = 74.4%** | Most stay localized |
| Subjects that read as a single action | **32 / 39 = 82.1%** | Titles are unusually disciplined |
| Commits with focus score **>=80** | **22 / 39 = 56.4%** | Majority are strongly atomic |
| Commits with focus score **>=70** | **29 / 39 = 74.4%** | Roughly three-quarters are clearly focused |

Distribution highlights:

- **25th percentile:** 2 files / 20 LOC
- **50th percentile:** 5 files / 90 LOC
- **75th percentile:** 12 files / 285 LOC
- **90th percentile:** 27 files / 701 LOC
- **Max:** 37 files / 1,837 LOC

So the center of gravity is very clearly small. The mean is only meaningfully higher than the median because a few large architecture sweeps sit in the tail.

---

## 2. Commit-message evidence

The subject lines themselves are strong evidence of a one-thing-at-a-time workflow.

Verb distribution across the 40 commits:

- **Move**: 18 / 40 = 45.0%
- **Add**: 5 / 40 = 12.5%
- **Remove**: 3 / 40 = 7.5%
- **Unify**: 3 / 40 = 7.5%
- **Converge**: 2 / 40 = 5.0%
- One each: **Clean**, **Enforce**, **Switch**, **Guard**, **Refactor**, **Collapse**, **fix:**

That is exactly what a staged refactor/history cleanup looks like: one verb, one target, one architectural move per commit.

There is also a clear serial pattern in the window:

- **12 / 40 commits = 30%** are package-by-package test migration/isolation steps.
- Example sequence: `Move app-runtime tests into package suite`, `Move ACP server tests into package suite`, `Move adapters-tui tests into package suite`, `Move store tests into package suite`, etc.

This is a strong qualitative signal that the author is intentionally splitting work into narrow, repeatable steps instead of batching unrelated changes together.

---

## 3. Commit Focus Score definition

I wanted a single score that rewarded the traits people usually mean by "focused commit":

- small number of touched files
- modest churn
- limited repo footprint
- a single-action subject line

So I defined a per-commit score on a 0-100 scale:

```text
commit_focus = 100 * (
  0.35 * file_scope
+ 0.25 * churn_scope
+ 0.25 * locality
+ 0.15 * subject_singularity
)
```

Where:

### File scope
- **1.0** if commit touches **<=5 files**
- **0.8** if **6-10 files**
- **0.5** if **11-20 files**
- **0.2** if **>20 files**

### Churn scope
- **1.0** if churn is **<=100 LOC**
- **0.8** if **101-250 LOC**
- **0.5** if **251-500 LOC**
- **0.2** if **>500 LOC**

### Locality
Top-level repo areas are the first path segment, e.g. `packages/`, `tests/`, `procedures/`, `src/`, `scripts/`, `plans/`.

- **1.0** if commit touches **1** top-level area
- **0.8** if it touches **2**
- **0.6** if it touches **3**
- **0.3** if it touches **4+**

### Subject singularity
- **1.0** if the subject reads like a single action
- **0.6** if it has an obvious multi-action signal such as `and`, `,`, or `;`

Finally:

> **Window Commit Focus Score = mean(commit_focus) across the 39 non-merge commits**

That yields:

> **78.2 / 100**

I would report that as **78 / 100**.

### Why this definition is reasonable

A simple raw-file-count metric would unfairly punish package-wide sweeps that still do one coherent thing, like moving one family of tests or flipping one boundary rule across many packages. Using a mix of **size**, **churn**, **locality**, and **message singularity** produces a score that better matches how humans judge commit focus.

---

## 4. What the score says in practice

### Strongly focused commits

Examples that score **100** under the heuristic:

- `08a4095` — `Move ACP server tests into package suite`
- `e1ad305` — `Move contracts test into package isolation`
- `d23a1c5` — `Converge repo helpers into procedures/lib`
- `1e33e78` — `Refactor execution helpers into procedure engine`
- `5520980` — `fix: updating max auto approve from 8->80`
- `7498ee4` — `Remove stale TUI model catalog from knip`

These are textbook atomic commits: one file or a few files, low churn, one area, one clear intent.

### Broadest commits in the window

The lowest-scoring commits are broader, but they are still thematically coherent rather than grab-bag commits:

| Commit | Subject | Files | LOC | Areas | Focus score |
|---|---|---:|---:|---:|---:|
| `0c926d0` | `Clean up root tests and converge repo helpers` | 21 | 622 | 6 | 28.5 |
| `92c30b3` | `Remove remaining src/core paths` | 33 | 1837 | 5 | 34.5 |
| `b72f3ff` | `Remove duplicate root helpers` | 37 | 1093 | 4 | 34.5 |
| `55f0bc9` | `Unify shared helpers under app-support` | 37 | 478 | 5 | 42.0 |
| `553b17c` | `Add package smoke tests and task fan-out runner` | 27 | 346 | 3 | 43.5 |
| `b450766` | `Unify model catalog under agent-acp` | 12 | 731 | 5 | 45.0 |
| `0ee3c98` | `Move settings and agent helpers into @nanoboss/store` | 17 | 367 | 4 | 46.5 |

These are best understood as **broad-but-coherent structural sweeps**. They do reduce the numeric score, but they still read as "one architectural cleanup thread per commit," not as mixed-purpose work.

This is why the score lands at **78** instead of something like **90+**: the window contains a handful of large refactor moves, but very few commits that look unfocused.

---

## 5. Conclusion

The evidence supports the original intuition.

### Numerical conclusion

- **Commit Focus Score:** **78 / 100**
- **Median commit size:** **5 files / 90 LOC**
- **Compact commits:** **66.7%** touch **10 files or fewer**
- **Modest-churn commits:** **71.8%** stay at **250 LOC or below**
- **Localized commits:** **74.4%** stay within **3 top-level repo areas or fewer**
- **Single-action subjects:** **82.1%**
- **Strict atomicity rate:** **56.4%**

### Plain-English conclusion

This is a **highly disciplined, high-focus commit history**. Most commits are small, local, and named around one action. The exceptions are mostly deliberate architectural sweeps that still pursue one coherent refactor goal at a time.

If I had to summarize the last 40 commits in one line:

> **The recent history is strongly single-purpose: small where possible, broad only when a refactor sweep requires it, and almost never obviously mixed-purpose.**
