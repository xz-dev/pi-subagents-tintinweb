# Downstream Maintenance

This fork is a continuously maintained downstream distribution of
[`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents). Its
`master` branch follows upstream and carries a small, ordered set of patches
while they are still needed.

## Current maintenance mode

There is intentionally no `ci` maintenance branch and no automatic upstream
sync workflow. The patch set is small enough that automated rebuilding is not
yet worth the additional machinery. Until that changes, every update to
`master` must use the manual rebuild procedure below.

This is not permission to accumulate ordinary development directly on
`master`. Each product change must remain on its own independently testable
patch branch, preferably with an upstream pull request. `master` is only the
validated integration result.

## Authoritative branches

- `upstream/master` is the only rebuild baseline.
- Each downstream patch branch is the source of truth for that patch.
- `maintenance/manual-master` owns this file and any future documentation about
  the manual downstream process. It must not contain product behavior changes.
- `origin/master` is the consumable integrated result, not a patch source.

The enabled patch order at the time this file was introduced is:

1. `origin/fix/show-effective-agent-model` — upstream PR #168
2. `origin/fix/conversation-viewer-safe-display` — upstream PR #154
3. `origin/feat/agent-status-elapsed` — upstream PR #139
4. `origin/fix/fleetview-active-roster` — upstream PR #169
5. `origin/fix/collapse-get-subagent-result` — upstream PR #173
6. `origin/test/nested-recursive-print-mode-e2e` — upstream PR #191, adding recursive print-mode boundary coverage after upstream merged #164
7. `origin/fix/agent-startup-error-status` — upstream PR #180
8. `origin/fix/rpc-agent-activity` — upstream PR #181
9. `origin/fix/steer-completion-notifications` — upstream PR #190
10. `origin/fix/agent-tool-error-rendering` — upstream PR #195
11. `origin/test/oauth-session-regression` — upstream PR #198

When integrating PR #154 immediately after PR #168, resolve their overlapping
`buildInvocationTags()` hunk by preserving PR #154's raw-metadata contract:
return `invocation.modelName` unchanged from `buildInvocationTags()`. PR #168's
one-line sanitization remains at its standalone tool-result display boundary via
`prepareModelNameForDisplay()`, while PR #154's conversation viewer and
invocation-tag renderers own their terminal-safety gates. Validate the combined
`agent-widget` and `conversation-viewer` safety tests before continuing. Retire
this integration handling when either PR absorbs the compatible boundary.

Update this list whenever a patch is added, reordered, renamed, superseded, or
retired. If this file changes, update `maintenance/manual-master` first and
rebuild `master`; do not make a maintenance-only edit directly on `master`.

## Manual rebuild procedure

1. Read `AGENTS.md`, `CONTRIBUTING.md`, and this file. Preserve unrelated local
   work and untracked files.
2. Fetch and prune `upstream` and `origin`. Record the exact SHAs of
   `upstream/master` and `origin/master` before doing anything destructive.
3. Inspect every enabled patch source and its upstream PR when applicable.
   Rebase or otherwise refresh stale patch branches on the same latest
   `upstream/master`; run their independent checks before integration.
4. Create a clean candidate branch/worktree from the recorded
   `upstream/master`.
5. Apply the net `maintenance/manual-master` overlay first as one signed,
   single-parent commit. Then apply each enabled product patch in the exact
   order above, one signed, single-parent integration commit per patch. Do not
   make source-branch internal commits or merge parents reachable from
   `master`.
6. Stop on an empty patch, conflict, unexpected file, or changed assumption.
   Resolve product conflicts on the owning patch branch when possible. If a
   conflict exists only in the combined stack, document and verify the narrow
   integration resolution instead of silently changing behavior.
7. Verify the candidate graph is linear, starts at the recorded upstream SHA,
   contains exactly one integration commit per enabled overlay/patch, and has
   no unrelated files. Verify all downstream integration commit signatures.
8. Run focused tests for every patch, followed by:

   ```bash
   npm ci
   npm run lint
   npm run typecheck
   npm run test
   npm run build
   git diff --check upstream/master...HEAD
   ```

9. Obtain an independent review of the complete candidate, including conflict
   resolutions, patch order, topology, signatures, and test evidence.
10. Immediately before publishing, confirm that both remote
    `upstream/master` and remote `origin/master` still equal the recorded SHAs.
    Update `origin/master` only with an explicit lease, for example:

    ```bash
    git push origin <candidate-sha>:master \
      --force-with-lease=refs/heads/master:<recorded-origin-master-sha>
    ```

11. Fetch again and verify GitHub/local topology, exact remote SHA, signatures,
    and CI for the published commit. Keep or archive source patch branches while
    they remain enabled.

## Patch lifecycle

When upstream merges a patch or provides an equivalent fix, first verify the
upstream behavior with that patch's regression tests. Remove the patch from this
ordered list, rebuild from the latest upstream without it, and validate the full
stack before archiving or deleting its source branch.

If manual rebuilding becomes frequent, error-prone, or difficult to audit,
create a dedicated `ci` branch and an upstream-sync workflow. Move downstream
maintenance automation and this policy to that branch, while keeping product
patches independent. Until then, remembering and performing this manual process
is mandatory for every `master` update.
