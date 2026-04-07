# 2026-04-07 commit procedure plan

## Summary

The current `/commit` procedure is too thin to reduce round trips. It delegates the entire git workflow to a downstream agent, which means the agent has to rediscover the same local steps every time: inspect the worktree, decide what to stage, craft a message, add the required trailer, commit, and sometimes push.

The better design is:

- make `/commit` deterministic and host-driven
- let a cheaper model infer **candidate related files** from this session's run history via MCP/session tools
- intersect those candidates with the **actual current git changes**
- stage and commit only the resulting files
- keep `/push` explicit, with an optional `/publish` procedure for commit+push

This should preserve safety while removing most of the chat back-and-forth around git workflows.

---

## Current state

### What exists today

- `commands/commit.ts` is a wrapper around `ctx.callAgent(...)`
- session MCP tools already expose:
  - top-level runs
  - descendants / ancestors
  - exact cell reads
  - exact ref reads
- top-level cells persist replayed frontend events, including tool events with `rawInput` / `rawOutput`
- current git state is still available locally via normal git commands

### What is missing

- there is no first-class `modifiedFiles` field per run/cell
- MCP/session history can only provide a **heuristic candidate set**
- the current `/commit` does not encode staging rules, trailer rules, branch/upstream rules, or push behavior

---

## Goals

1. Reduce round trips for "commit" and "commit and push" flows.
2. Avoid blindly committing unrelated changes from a dirty worktree.
3. Use cheaper delegated inference where deep reasoning is unnecessary.
4. Keep remote side effects explicit unless the user clearly asks for them.
5. Return machine-readable outputs so other procedures can compose commit/push flows.

---

## Proposed procedure set

### 1. `/commit`

Deterministic local commit procedure.

Responsibilities:

- inspect current git state
- derive candidate files from current session history
- intersect candidate files with actual changed files
- choose a safe staging set
- generate a commit message
- append the required Copilot co-author trailer
- create the commit
- return commit SHA, branch, staged file list, and message

### 2. `/push`

Deterministic push procedure.

Responsibilities:

- inspect current branch and upstream
- push current branch to upstream if configured
- otherwise push `origin <branch>` if unambiguous
- return remote, branch, and resulting pushed SHA

### 3. `/publish`

Optional composite procedure for one-shot "commit and push".

Responsibilities:

- call `/commit`
- then call `/push`
- return both results together

This should only be used when the user clearly wants both local and remote side effects in one command.

---

## Candidate-file inference design

### Why use a cheaper model here

The "which files are probably related to this chat?" step is mostly retrieval and light heuristics:

- inspect session history
- extract file paths from tool events
- rank likely touched files

That does not need the strongest model. A cheaper delegated model should be sufficient.

### Inputs available to the model

The procedure should gather, then pass to the delegated model:

- recent top-level runs in the current session
- descendants for the most relevant top-level run(s)
- exact cell records where needed
- replayed tool events containing `rawInput` / `rawOutput`
- current user request or commit context

### Heuristics for candidate files

The delegated model should propose files from:

- `apply_patch` / edit operations
- file write or write-to-file tool calls
- bash commands that clearly mention file paths
- structured tool inputs that contain `path`, `file`, or similar fields
- newly created files referenced in run outputs

### Important constraint

Session history should be treated as a **candidate-file source**, not the source of truth.

The procedure must intersect model-proposed files with:

- `git diff --name-only`
- `git status --short`

That keeps the final commit scoped to real current changes.

---

## Deterministic `/commit` flow

1. Inspect worktree:
   - branch
   - staged files
   - unstaged/untracked files

2. Build a candidate file set:
   - session history via MCP/session tools
   - delegated cheap-model inference

3. Intersect candidates with current changed files.

4. Decide the staging set:
   - if there are already staged files, prefer staged-only unless user intent clearly says otherwise
   - if candidate intersection is non-empty and specific, stage only those files
   - if the worktree is ambiguous, stop and ask instead of broad staging

5. Generate the commit message:
   - can be delegated to a model, or derived from prompt/context plus changed files
   - always append:
     `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

6. Create the commit and return:
   - commit SHA
   - branch
   - files included
   - commit message

---

## Deterministic `/push` flow

1. Inspect current branch.
2. Detect upstream tracking branch.
3. If upstream exists, push to it.
4. If no upstream exists but `origin` is present and unambiguous, push `origin <branch>`.
5. If remote selection is ambiguous, stop and ask.
6. Return pushed branch/remotes/sha.

---

## Safety rules

- never default to `git add -A`
- never push implicitly from `/commit`
- do not commit unrelated dirty files outside the selected set
- prefer staged-only when user intent is ambiguous
- stop on ambiguous worktree state instead of guessing
- preserve current repository conventions for commit trailers

---

## Possible future improvement

Add first-class per-run metadata such as:

- `modifiedFiles`
- `readFiles`
- `createdFiles`

If NanoBoss records those directly, `/commit` can rely less on replay-event heuristics and delegated inference becomes simpler and cheaper.

---

## Tests to add

1. `/commit` chooses only files linked to the current session run when unrelated dirty files are present.
2. `/commit` prefers staged-only when staged files already exist.
3. `/commit` appends the required Copilot co-author trailer.
4. `/push` uses upstream when configured.
5. `/push` stops on ambiguous remotes.
6. `/publish` composes `/commit` then `/push` and returns both results.
7. candidate-file inference tolerates noisy session history and still intersects safely with git.

---

## Implementation notes

- Replace the current thin `commands/commit.ts` wrapper with a real procedure.
- Consider adding a helper for commit-scoping logic so `/publish` and other procedures can reuse it.
- Use a cheaper delegated model only for candidate-file inference, not for final git authority.
- Keep outputs machine-oriented so other procedures can compose them cleanly.

---

## Todo breakdown

1. Analyze exactly what file evidence is available from session MCP history and replay events.
2. Design the cheap-model candidate-file inference prompt and output shape.
3. Implement deterministic `/commit` staging and commit creation.
4. Implement `/push` and optional `/publish`.
5. Add tests and consider first-class `modifiedFiles` tracking.
