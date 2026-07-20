# Roadmap / known gaps

Status of this fork's dev branch relative to "production-ready". Items are
ordered by how much they matter for shipping an editor on Yjs v14.
CAVEATS.md documents the *inherent* tradeoffs; this file tracks the
*actionable* ones.

## Open — needs upstream work

### View-mode structural edits at suggestion boundaries (upstream #245)

A view-mode (commit-to-base) Enter/join at the boundary of a pending
suggestion silently **flattens the suggestion into the base document**: the
moved content's `y-attributed-insert` marks are stripped by the reverse
transformer ("the view never attributes") and written to base as plain text,
while the delete side removes the suggestion from the suggestion doc — the
user's Enter effectively accepts someone else's pending suggestion.

Repro: `tests/issue-repros.test.js` → `testIssue245ViewModeEnterNotSuggested`
(skipped; remove the `t.skip()` to re-arm). A proper fix needs the binding to
recognize *moved* attributed content and route it back into the suggestion
overlay — i.e. renderer-aware attributed-insert support in `@y/y`'s
`applyDelta`. Until then: treat view-mode structural edits around pending
suggestions as hazardous.

### Merge-on-resume for paused sync

Pause/resume semantics are now pinned (`tests/undo-pause.test.js`):

- paused edits stay local and are not undoable;
- undo/redo commands no-op while paused (fork change — upstream mutated the
  ydoc behind the disconnected view);
- **resume discards paused local edits** — the ytype is the source of truth
  at (re)bind.

If paused local editing is meant to survive resume (PROJECT_GOALS.md lists
"pausing … to allow local only editing" as a goal), a merge-on-resume design
is needed. Integrator recipe until then: before resuming, capture
`diff(docToDelta(fragmentToPm(ytype, tr)), docToDelta(view.state.doc))` and
re-apply it through the binding after resume.

### Attribute-suggestion visualization

Attr changes now *carry* attribution (`y-attributed-format` with the attr
keys in `userIdsByAttr` — fork fix for upstream #255), but rendering is up to
the integrator and inherently schema-aware (how do you visualize
`height: 200 → 400`?). See CAVEATS.md "Visualizing attributed content".

### Document flattening (splits/merges/lifts)

Splits are still "delete tail + insert node" at the Y layer (CAVEATS.md
"Node splitting, merging, and lifting"); upstream plans a flat representation
behind tree-shaped wrappers. Nothing to do in this fork — track upstream.

## Ecosystem

- **Client persistence**: done — `@wizzboy55/y-prosemirror/indexeddb`
  (y-indexeddb port for `@y/y`).
- **Server persistence**: no v14 equivalent of y-redis / y-leveldb /
  Hocuspocus exists. The binary update format is v13-compatible, so storing
  opaque updates works today; anything that *decodes* documents server-side
  needs `@y/y`.
- **Network**: `@y/websocket@4.0.0-rc.2` (pinned) — RC, run your own soak
  tests before trusting it.

## RC-tracking policy

The v14 stack is pinned exactly (`@y/y@14.0.0-rc.23`, `lib0@1.0.0-rc.22`,
`@y/protocols@1.0.6-rc.1`, `@y/websocket@4.0.0-rc.2`) because upstream ships
breaking changes between RCs. To bump:

1. update the pins in `package.json`, `npm install`
2. `npm test` (includes the migration tests against real v13 binaries)
3. `npm test -- --filter repeat --repetition-time 8000` (extended fuzz)
4. `npm run test:browser` + `npm run lint` + `npm run dist`
5. read the upstream changelog for renames (the AttributionManager→Renderer
   class of change) before fixing compile errors mechanically

## Upstreaming queue

Fork patches that are general and intended as upstream PRs to
`yjs/y-prosemirror`:

| patch | where |
| --- | --- |
| attr-change suggestions render as `y-attributed-format` (#255) | `src/sync-utils.js`, `src/transformers/rendered-attributions.js` |
| caret-biased diffing (CAVEATS "Diffing ambiguity") | `src/caret-bias.js`, `src/rdt/prosemirror.js` |
| `onSchemaConflict` surfacing hook (#258) | `src/rdt/prosemirror.js`, `src/sync-plugin.js` |
| v13→v14 document migration + guide (#260/#261) | `src/migration.js`, `MIGRATION.md` |
| undo/redo no-op while paused | `src/commands.js` |
| repro suite for #244/#245/#254/#255 | `tests/issue-repros.test.js` |
| multi-peer convergence fuzz | `tests/convergence-fuzz.test.js` |
| browser test harness | `scripts/browser-tests.js` |
| IndexedDB persistence port | `src/indexeddb.js` (probably its own package upstream) |

Keep fork-only bits out of PRs: package rename, pinned versions, workflow
changes, this file.
