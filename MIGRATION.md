# Migrating from y-prosemirror v1 (Yjs v13) to @wizzboy55/y-prosemirror v2 (Yjs v14)

This guide covers both halves of the migration (upstream issues
[#260](https://github.com/yjs/y-prosemirror/issues/260) /
[#261](https://github.com/yjs/y-prosemirror/issues/261)):

1. **Code**: the v1 plugin API → the v2 API.
2. **Documents**: converting stored v13 documents into the representation the
   v2 binding writes.

## 1. Dependencies

| v1 (Yjs 13) | v2 (Yjs 14) |
| --- | --- |
| `yjs` | `@y/y` (peer dependency here — your app installs exactly one copy) |
| `y-prosemirror` | `@wizzboy55/y-prosemirror` |
| `y-protocols` | `@y/protocols` |
| `y-websocket` | `@y/websocket` |
| `y-indexeddb` | `@wizzboy55/y-prosemirror/indexeddb` (bundled port) |

The whole v14 stack is release-candidate software and this fork pins exact
versions — match them (`@y/y@14.0.0-rc.23`, `lib0@1.0.0-rc.22`,
`@y/protocols@1.0.6-rc.1`, `@y/websocket@4.0.0-rc.2`) and bump deliberately.

Everything below `@y/y` still speaks the same binary update format as Yjs
v13, so providers/storage that shuttle opaque updates keep working.

## 2. Plugin setup

v1:

```js
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, undo, redo, initProseMirrorDoc } from 'y-prosemirror'

const type = ydoc.get('prosemirror', Y.XmlFragment)
const { doc, mapping } = initProseMirrorDoc(type, schema)
const view = new EditorView(el, {
  state: EditorState.create({
    doc, schema,
    plugins: [ySyncPlugin(type, { mapping }), yCursorPlugin(provider.awareness), yUndoPlugin(), keymap({ 'Mod-z': undo, 'Mod-y': redo })]
  })
})
```

v2:

```js
import { syncPlugin, configureYProsemirror, yCursorPlugin, yUndoPlugin, undo, redo } from '@wizzboy55/y-prosemirror'
import * as Y from '@y/y'

const ydoc = new Y.Doc()
const view = new EditorView(el, {
  state: EditorState.create({
    schema,
    plugins: [syncPlugin({}), yCursorPlugin(provider.awareness), yUndoPlugin(), keymap({ 'Mod-z': undo, 'Mod-y': redo })]
  })
})
// bind (and re-bind / pause) at runtime:
configureYProsemirror({ ytype: ydoc.get('prosemirror'), renderer: null })(view.state, view.dispatch)
```

Key differences:

- **No `initProseMirrorDoc` / `mapping`.** The binding hydrates the editor
  from the ytype when `configureYProsemirror` runs.
- **The ytype is always the source of truth.** Editor content present at bind
  time is *not* imported into Yjs — seed the ydoc instead (`pmToFragment`, a
  server-side write, or any update). See CAVEATS.md "Initial content".
- **Pause/resume** is first-class: configure with `ytype: null` to pause,
  re-configure to resume.
- **Suggestions / diffs** come from Yjs v14 *renderers*
  (`Y.createDiffRenderer`, `Y.createSnapshotRenderer`) passed as the
  `renderer` option, replacing v1's `ySyncPlugin` snapshot APIs
  (`renderSnapshot` etc.). Attributed content renders through the reserved
  marks `y-attributed-insert` / `y-attributed-delete` / `y-attributed-format`,
  which **must exist in your schema** (see CAVEATS.md "Attribution mark names
  are fixed" — including node-attr suggestions, which surface as
  `y-attributed-format` with the attr keys in `userIdsByAttr`).
- The v2.0.0-4 → v2.0.0-6 `AttributionManager` → `Renderer` rename is covered
  in CHANGELOG.md if you are coming from an earlier v2 pre-release.

## 3. Utility mapping

| v1 | v2 |
| --- | --- |
| `initProseMirrorDoc(type, schema)` | not needed (hydration on configure); `fragmentToPm(fragment, tr)` for one-off conversion |
| `prosemirrorToYDoc(doc)` / `prosemirrorJSONToYDoc` | `pmToFragment(node, fragment)` |
| `yDocToProsemirror` / `yDocToProsemirrorJSON` | `fragmentToPm(fragment, tr)` |
| `absolutePositionToRelativePosition(pos, mapping...)` | same name, positions module (`import { absolutePositionToRelativePosition } from '@wizzboy55/y-prosemirror'`) |
| `relativePositionToAbsolutePosition(...)` | same name, positions module |
| `ySyncPluginKey` | `ySyncPluginKey` (state shape changed — see `$syncPluginState`) |

## 4. Migrating stored documents

`@y/y` v14 **parses** v13 binaries, but the old binding's *shape* differs
from the new one: v1 stored every inline text run in a nested `Y.XmlText`
(which materializes under v14 as a nameless child type), while v2 keeps text
inline in the parent node. A v13 document must be converted before the v2
binding can edit it.

```js
import * as Y from '@y/y'
import { needsLegacyMigration, migrateLegacyDoc } from '@wizzboy55/y-prosemirror'

const legacy = new Y.Doc({ gc: false })
Y.applyUpdate(legacy, storedV13Binary) // v14 reads the v13 binary format

if (needsLegacyMigration(legacy.get('prosemirror'))) {
  const migrated = migrateLegacyDoc(legacy) // fresh Y.Doc, same root keys
  await store(Y.encodeStateAsUpdate(migrated))
  await archive(storedV13Binary) // keep the original as backup
}
```

API:

- `needsLegacyMigration(ytype)` — detects the legacy inline-text shape.
  Cheap; safe to call on every load.
- `legacyFragmentToDelta(ytype)` — pure conversion to a new-format insert
  delta (apply it into any empty ytype yourself).
- `migrateLegacyDoc(legacyDoc, { keys = ['prosemirror'], target })` — converts
  the given root keys into a fresh (or provided) doc.

### What carries over — and what does not

| | |
| --- | --- |
| ✅ document structure, node names, attributes | preserved |
| ✅ text + marks (bold/em/…, mark attrs) | preserved |
| ⚠️ collaboration history | **reset** — the migrated doc has fresh item IDs |
| ⚠️ undo history | reset |
| ⚠️ stored relative positions (comment anchors, cursors, bookmarks) | **invalidated** — they reference old item IDs; re-anchor them (e.g. by text offset) during migration |
| ⚠️ subdocuments / non-document root types | migrate content types via `keys`; plain `Y.Map`/`Y.Array` roots load as-is under v14 |

Because history resets, run the migration **once, centrally** (server-side on
first v14 load, or a batch job), not independently on every client — two
clients migrating the same v13 doc produce two *unrelated* v14 docs whose
merge would duplicate content.

### Operational checklist

1. Freeze v1 writers (or route them read-only).
2. For each document: load binary → `needsLegacyMigration` → `migrateLegacyDoc`
   → store new binary → archive old binary.
3. Re-anchor stored relative positions against the migrated doc.
4. Deploy v2 clients pointing at the migrated documents.

The conversion is validated in `tests/migration.test.js` against documents
produced by the real Yjs v13 (`yjs13` npm alias, dev-only) — structure,
marks, node attrs, nested blocks, inline nodes, and empty nodes all
round-trip into a ProseMirror render.
