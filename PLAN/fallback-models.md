# Plan: Fallback models

Status: **implemented and validated on downstream patch branch** (2026-08-04). Independent review found no confirmed blocking defect; its strict-provider concern was disproven by the provider-filtered candidate set, and its test-coverage concern was addressed by strengthening the unified runner seam tests.

Reference: [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents). Its useful idea is an ordered model-candidate loop with attempt reporting. Its implementation starts a separate `pi --model` child process per attempt, so this in-process project must not copy its process/session machinery.

## Product contract

### Configuration

Per-agent frontmatter uses this project's snake-case style:

```yaml
model: anthropic/claude-haiku-4-5
fallback_models:
  - openai/gpt-4o-mini
  - google/gemini-2.5-flash
```

Global/project setting in `subagents.json`:

```json
{
  "defaultFallbackModels": [
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash"
  ]
}
```

Effective fallback list:

1. `fallback_models: false` explicitly disables fallback for the agent.
2. An agent `fallback_models` list replaces the default list.
3. If omitted, use merged `defaultFallbackModels`.
4. If both are absent, there is no fallback.

Keep the configuration deliberately narrow:

- No `fallbackModels` frontmatter alias.
- No `none`, empty-string, or empty-array disable aliases; only `false` disables an inherited default.
- No per-call fallback parameter.
- Existing `fallbackSubagent` remains unrelated: it substitutes an **agent type**, not a model.

### Primary model and explicit caller model

Primary selection is:

1. A trimmed nonblank caller `Agent({ model })` overrides agent frontmatter.
2. Otherwise use agent frontmatter `model`.
3. Otherwise inherit the parent session model. An inherited parent model is a normal non-explicit primary and therefore uses `defaultFallbackModels` when the agent does not override/disable them.

Blank/whitespace caller model values are omission, not explicit selection.

When the effective primary came from caller `Agent({ model })`:

- Do not use per-agent or default fallback models.
- Preserve Pi's normal same-model auto-retry behavior.
- After Pi's same-model retry budget ends, report the error.

### Candidate resolution

For non-caller-supplied primaries, build and deduplicate:

```text
[primary, ...effectiveFallbackModels]
```

Use the registry availability/auth view, but make explicitly provider-qualified candidates strict: `provider/model` may resolve only within that provider. Do not use the current `resolveModel` step that silently retries the bare id under another provider; cross-provider selection must be explicitly listed in `fallback_models`. Bare/fuzzy candidates may resolve only when there is one unambiguous available match across providers; multiple matches are `unavailable/ambiguous` and require explicit `provider/model` configuration. A configured candidate that cannot resolve is recorded as `unavailable` and skipped. If no runnable candidate remains, fail closed and list all configured candidates; never silently inherit or select an unlisted model.

### Runtime failure policy

Two distinct policies are required:

1. **Same-model retry:** leave this entirely to Pi `AgentSession` and its `settings.retry` budget/backoff.
2. **Cross-model fallback:** after the Pi session settles, any final `AssistantMessage` with `stopReason: "error"` advances to the next configured model, except context overflow.

This deliberately needs no new classifier and no regex table. Pi's stream contract represents request/model/runtime failures as assistant `stopReason: "error"`; tool failures remain separate `toolResult` messages. Pi still owns the narrower transient classification for same-model retry. Cross-model fallback is broader because a different provider/model can recover from both transient failures and deterministic current-provider failures such as quota, billing, auth, disabled, or unavailable models.

Never model-fallback on:

- context overflow (Pi compaction policy owns it),
- tool/task failures,
- abort or caller/user stop,
- max-turn/grace termination,
- steering completion,
- ordinary model output quality.

### One in-session fallback executor

Both initial spawn and `Agent({ resume })` use the same child-session fallback executor.

For one invocation cycle:

1. Capture the session leaf immediately after this invocation's user prompt is persisted.
2. Let Pi finish all same-model retries.
3. If the final assistant error is eligible for cross-model fallback:
   - call public `session.navigateTree(userPromptEntryId, { summarize: false })`, which restores the leaf to that user prompt's parent and rebuilds active context;
   - call `session.setModel(nextModel)` and then `session.prompt(editorText)` to replay the same prompt through the complete AgentSession lifecycle, including same-model retry, overflow compaction, extension events, pending queues, and `agent_settled`.
4. Before advancing, abort nested children owned by the failed attempt so they cannot keep modifying the environment alongside the next model.
5. Reset the per-attempt turn/grace counters; each model candidate receives the full configured `max_turns` budget, matching whole-run retry semantics. Lifetime usage/tool counters remain aggregated on the logical record.
6. Repeat until success, non-fallback failure, abort/stop, or candidate exhaustion.

`session.setModel()` is safe here because every child session receives a private `SettingsManager.inMemory()` clone of the effective parent settings when created. The call preserves Pi's model-change event, session entry, auth check, and thinking clamp while writing only to child-local memory. This is the in-process equivalent of nicobailon's separate `pi --model` attempt processes and does not require a forked Pi runtime.

Failed attempts remain append-only branches in the child session file for diagnosis, but are not in the active LLM context. The logical agent/session ID, extensions, tools, memory binding, worktree, transcript, ownership, and notifications remain single-instance; no session/worktree/extension teardown and recreation per model.

### Resume candidate order

Each resume is a fresh fallback cycle. If the configured chain is `A → B → C` and the child currently runs on `B`, that resume tries:

```text
B → A → C
```

That is: current effective model first, then original configured primary, then remaining fallbacks in configured order, deduplicated. A prior failure is not a permanent circuit breaker.

### Model scope

Keep existing `scopeModels` policy; do not invent a stricter fallback-only policy:

- caller-supplied out-of-scope primary: hard error;
- user-authored frontmatter/default fallback candidates: warning, then run (same trust level as frontmatter-pinned models);
- inherited parent primary: warning, then run.

### Results and diagnostics

Record a compact attempt list on the logical `AgentRecord`:

```ts
interface ModelAttempt {
  model: string;
  status: "unavailable" | "failed" | "succeeded";
  error?: string;
}
```

Rules:

- Aggregate usage/tool counts across all attempts through existing lifecycle callbacks.
- On success, return only the successful attempt's final output. Failed partial assistant text is diagnostic-only and is not mixed into the answer.
- On exhaustion, fail closed and append a bounded attempts section:

```text
Model attempts:
  1. anthropic/claude-haiku-4-5 — quota exhausted
  2. openai/gpt-4o-mini — unavailable
  3. google/gemini-2.5-flash — timeout
All model candidates failed.
```

- One logical completion notification only.
- Update the existing `invocation.modelName` to the effective final/current model. Do not add fallback-specific settings UI, widget panels, tags, or TUI components in v1.

## Pi API baseline

No Pi classifier or fork-specific runtime change is required. The implementation uses public `SettingsManager.inMemory`, `AgentSession.navigateTree`, `setModel`, `prompt`, and `isContextOverflow`. Packed-artifact inspection found the full surface first present in Pi 0.80.5, so all Pi peer minimums are raised from `>=0.80.0` to `>=0.80.5`.

## Implementation slices

### Slice 1 — Configuration and candidate resolution

- [x] Add `AgentConfig.fallbackModels: string[] | false` internally, parsed only from `fallback_models`.
- [x] Add sanitized `SubagentsSettings.defaultFallbackModels?: string[]`.
- [x] Store the loaded default directly in extension/session runtime state; no unnecessary setter/UI state layer.
- [x] Add pure candidate resolution/deduplication and attempt formatting, with strict `provider/model` matching and unique-only fuzzy handling for bare ids.
- [x] Remove silent parent/cross-provider substitution when a configured chain is active.
- [x] Unit-test omission/list/false precedence, caller-model isolation, availability skip, dedupe, and fail-closed behavior.

### Slice 2 — Unified spawn/resume in-session fallback

- [x] Extend `RunResult`/resume result with typed model attempts.
- [x] Implement one prompt/fallback runner used by initial prompt and resume.
- [x] Locate the invocation user-message entry on the active branch.
- [x] After Pi same-model retries settle, advance on any final assistant `stopReason: "error"` except context overflow; no local classifier table.
- [x] Give child sessions a private in-memory settings clone, navigate to the user-message entry, switch with `setModel()`, and replay with `prompt()` through the full AgentSession lifecycle.
- [x] Accumulate attempts and update the logical record's effective model.
- [x] Abort failed-attempt nested children before advancing candidates.
- [x] Reset turn/grace counters per model attempt while aggregating lifetime usage/tool counts.
- [x] Preserve caller abort, steering, transcript, and notification behavior.
- [x] Test initial spawn and resume ordering, context-overflow exclusion, and nested cleanup wiring.

### Slice 3 — Documentation

- [x] README: config, precedence, explicit caller behavior, same-model-before-cross-model order, side-effect warning, and `fallbackSubagent` distinction.
- [x] CHANGELOG under `Unreleased`.

`defaultFallbackModels` is configured directly in global/project `subagents.json` in v1; no settings-menu/editor work is required.

## Acceptance examples

1. **Unavailable primary:** pinned A unavailable, fallback B available → starts on B; attempt A is `unavailable`.
1a. **Strict provider:** `anthropic/X` unavailable while `gateway/X` exists but is not listed → do not select `gateway/X`; continue only to explicitly configured fallbacks.
1b. **Ambiguous bare id:** fallback `haiku` matches two providers → record ambiguous/unavailable and require explicit `provider/model`; do not pick one by registry order or current-provider preference.
2. **Transient error:** A exhausts Pi same-model retries with a transient provider error, B succeeds → one logical completed agent, only B's output returned.
3. **Permanent provider limit:** A reports quota/billing/account exhaustion → Pi does not waste same-model retries, but the final assistant error advances to B.
4. **All exhausted:** A/B/C fail or are unavailable → error lists all attempts; no silent parent model.
5. **Explicit caller model:** caller chooses X → Pi may same-model retry X; agent/default fallbacks are never tried.
5a. **Inherited primary:** agent has no model/fallback override, inherits parent P, and global defaults contain B → P failure advances to B.
6. **Agent disables default:** `fallback_models: false` + global defaults → primary only.
7. **Tool failure:** tool/task error does not switch model.
8. **Context overflow:** compaction policy runs; fallback chain does not advance.
9. **Resume fallback:** current B fails on a resume; candidates are B, then original A, then remaining C.
10. **Scope:** out-of-scope configured fallback warns and runs, matching existing frontmatter trust semantics.
11. **No global pollution:** automatic fallback changes child session model but not Pi's global default provider/model.
12. **Per-model turn budget:** if A consumes turns before a provider failure, B still gets the full configured `max_turns`; lifetime accounting includes both.
13. **Nested cleanup:** active nested children from failed attempt A are stopped before attempt B begins.

## Explicit risks

- Whole-invocation retry can repeat tool side effects. This is an accepted consequence of the selected product behavior and must be documented. The abandoned attempt remains in the worktree/filesystem even though its transcript branch is excluded from model context.
- Child sessions deliberately use a private in-memory settings manager so public `AgentSession.setModel()` cannot pollute global/project settings. Focused integration tests must prove model-select/thinking/session semantics and the full retry/compaction lifecycle against the minimum supported Pi version.
- Failed branches remain in the append-only child session file and output transcript; they are diagnosable but not model-visible on the active branch.
- Resetting turn budget per model can multiply the configured turn ceiling by the candidate count. This matches whole-run fallback semantics and must be documented.

## Deliberately excluded as redundant

- Copying nicobailon's retry regex table or adding a new fallback classifier.
- Separate spawn and resume fallback engines.
- Fresh session, extension reload, or worktree recreation for each candidate.
- Per-call fallback parameters.
- Multiple frontmatter aliases/disable spellings.
- Implicit cross-provider substitution outside the configured fallback chain.
- A fallback-specific scope policy.
- Fallback-specific settings UI, widget/panel/tag framework, or agent-type display work.
- Returning failed partial output alongside the successful answer.
- Persisting automatic fallback as Pi's global default model.
- Depending on a forked Pi runtime or bypassing AgentSession lifecycle with raw `agent.continue()`.

Do not start implementation until the user explicitly authorizes it.
