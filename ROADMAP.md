# Roadmap / known gaps

Status of this fork's dev branch relative to "production-ready". Items are
ordered by how much they matter for shipping an editor on Yjs v14.
CAVEATS.md documents the *inherent* tradeoffs; this file tracks the
*actionable* ones.

## Fixed in this fork

### View-mode structural edits at suggestion boundaries (upstream #245)

Previously a view-mode (commit-to-base) Enter/join at the boundary of a
pending suggestion silently **flattened the suggestion into the base
document** — the user's Enter effectively accepted someone else's pending
suggestion. Fixed by three cooperating pieces, no `@y/y` changes needed:

1. `buildAttributionCorrection` (rdt/prosemirror.js) detects *moves*: an
   inserted run still carrying `y-attributed-insert` marks whose characters
   are covered by insert-attributed content deleted in the same change keeps
   its marks (typed-inherited marks — the #244 case — still get corrected).
2. The `movedAttributionToFormat` reverse (transformers/attribution-to-format.js)
   converts those marks into delta attribution instead of stripping them.
3. `YSyncRdt` splits the change (`splitMovedInsertions`) and applies the
   moved part in a **non-local transaction** (`transact(doc, fn, origin,
   false)`), which the `DiffRenderer`'s forward-to-base listener ignores —
   the content lands in the suggestion overlay only and is re-attributed as
   a pending suggestion.

Tests: `testIssue245ViewModeEnterNotSuggested` (split + accept-all) and
`testIssue245ViewModeJoinKeepsSuggestion` in `tests/issue-repros.test.js`.

Known limitations of the fix:

- **Authorship may transfer.** The moved items are re-created by the moving
  client, so the renderer re-attributes them to the *mover's* user mapping
  (Yjs has no move primitive — a CRDT-level constraint). The suggestion stays
  pending; only the attributed author can change.
- Move detection is a per-change character-multiset cover: a transaction that
  simultaneously types new text *and* deletes identical attributed text could
  keep marks on the typed text (it becomes a suggestion rather than base
  content). Single PM transactions rarely mix both; the failure mode is
  conservative (nothing is silently accepted).
- Only `y-attributed-insert` moves are preserved. Moving *suggestion-deleted*
  (struck-through) content still un-suggests its deletion — the moved copy
  becomes plain base content.

## Open — needs upstream work

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
| moved pending suggestions survive view-mode splits/joins (#245) | `src/rdt/prosemirror.js`, `src/rdt/y-sync.js`, `src/transformers/attribution-to-format.js`, `src/sync-utils.js` |
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
