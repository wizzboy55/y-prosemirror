# y-prosemirror (fork)

> [ProseMirror](http://prosemirror.net/) Binding for [Yjs](https://github.com/yjs/yjs) - [Demo](https://demos.yjs.dev/prosemirror/prosemirror.html)

> [!IMPORTANT]
> This is a **soft fork of [yjs/y-prosemirror](https://github.com/yjs/y-prosemirror)**
> (the Yjs v14 / `@y/prosemirror` development line), published as
> `@wizzboy55/y-prosemirror`. Fork policy:
>
> - `master` tracks upstream `yjs/y-prosemirror` master and carries no fork commits.
> - `dev` is the fork's integration branch: upstream master + fork patches.
>   Generally useful fixes are intended to be upstreamed as PRs.
> - The entire Yjs v14 RC stack is **pinned to exact versions**
>   (`@y/y@14.0.0-rc.23`, `lib0@1.0.0-rc.22`, `@y/protocols@1.0.6-rc.1`,
>   `@y/websocket@4.0.0-rc.2`) because upstream still ships breaking changes
>   between release candidates. Bump these deliberately, never via `^` drift.
> - `@y/y` is a **peerDependency** here (upstream has it as a dependency):
>   your app must depend on exactly one copy of `@y/y`, otherwise you get two
>   CRDT runtimes and `instanceof` checks break across them. The same applies
>   to `lib0` — keep it deduped to a single instance.
> - Install via git while unpublished:
>   `npm i github:wizzboy55/y-prosemirror#dev` (plus `@y/y@14.0.0-rc.23`).
>
> See [`MIGRATION.md`](./MIGRATION.md) for moving documents and code from
> y-prosemirror v1 / Yjs v13, and [`ROADMAP.md`](./ROADMAP.md) for known gaps.

> [!NOTE]
> Upstream's `main` branch is the development branch for the unstable
> `@y/prosemirror` release, which adds support for Yjs v14 (`@y/y`). Most users
> should continue to use the stable `y-prosemirror` package with Yjs v13 for now.
> Parts of the documentation below still describe the stable `y-prosemirror` release.

This binding maps a Y.XmlFragment to the ProseMirror state.

## Features

* Sync ProseMirror state
* Shared Cursors
* Shared Undo / Redo (each client has its own undo-/redo-history)
* Successfully recovers when concurrents edit result in an invalid document schema

### Example

```js
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, undo, redo, initProseMirrorDoc } from 'y-prosemirror'
import { exampleSetup } from 'prosemirror-example-setup'
import { keymap } from 'prosemirror-keymap'
..

const type = ydocument.get('prosemirror', Y.XmlFragment)
const { doc, mapping } = initProseMirrorDoc(type, schema)

const prosemirrorView = new EditorView(document.querySelector('#editor'), {
  state: EditorState.create({
    doc,
    schema,
    plugins: [
        ySyncPlugin(type, { mapping }),
        yCursorPlugin(provider.awareness),
        yUndoPlugin(),
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Mod-Shift-z': redo
        })
      ].concat(exampleSetup({ schema }))
  })
})
```

Also look [here](https://github.com/yjs/yjs-demos/tree/master/prosemirror) for a working example.

#### Remote Cursors

The shared cursors depend on the Awareness instance that is exported by most providers. The [Awareness protocol](https://github.com/yjs/y-protocols#awareness-protocol) handles non-permanent data like the number of users, their user names, their cursor location, and their colors. You can change the name and color of the user like this:

```js
example.binding.awareness.setLocalStateField('user', { color: '#008833', name: 'My real name' })
```

In order to render cursor information you need to embed custom CSS for the user icon. This is a template that you can use for styling cursor information.

```css
/* this is a rough fix for the first cursor position when the first paragraph is empty */
.ProseMirror > .ProseMirror-yjs-cursor:first-child {
  margin-top: 16px;
}
.ProseMirror p:first-child, .ProseMirror h1:first-child, .ProseMirror h2:first-child, .ProseMirror h3:first-child, .ProseMirror h4:first-child, .ProseMirror h5:first-child, .ProseMirror h6:first-child {
  margin-top: 16px
}
/* This gives the remote user caret. The colors are automatically overwritten*/
.ProseMirror-yjs-cursor {
  position: relative;
  margin-left: -1px;
  margin-right: -1px;
  border-left: 1px solid black;
  border-right: 1px solid black;
  border-color: orange;
  word-break: normal;
  pointer-events: none;
}
/* This renders the username above the caret */
.ProseMirror-yjs-cursor > div {
  position: absolute;
  top: -1.05em;
  left: -1px;
  font-size: 13px;
  background-color: rgb(250, 129, 0);
  font-family: serif;
  font-style: normal;
  font-weight: normal;
  line-height: normal;
  user-select: none;
  color: white;
  padding-left: 2px;
  padding-right: 2px;
  white-space: nowrap;
}
```

You can also overwrite the default Widget dom by specifying a cursor builder in the yCursorPlugin

```js
/**
 * This function receives the remote users "user" awareness state.
 */
export const myCursorBuilder = user => {
  const cursor = document.createElement('span')
  cursor.classList.add('ProseMirror-yjs-cursor')
  cursor.setAttribute('style', `border-color: ${user.color}`)
  const userDiv = document.createElement('div')
  userDiv.setAttribute('style', `background-color: ${user.color}`)
  userDiv.insertBefore(document.createTextNode(user.name), null)
  cursor.insertBefore(userDiv, null)
  return cursor
}

const prosemirrorView = new EditorView(document.querySelector('#editor'), {
  state: EditorState.create({
    schema,
    plugins: [
        ySyncPlugin(type),
        yCursorPlugin(provider.awareness, { cursorBuilder: myCursorBuilder }),
        yUndoPlugin(),
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Mod-Shift-z': redo
        })
      ].concat(exampleSetup({ schema }))
  })
})
```

#### Utilities

The package includes a number of utility methods for converting back and forth between
a Y.Doc and Prosemirror compatible data structures. These can be useful for persisting
to a datastore or for importing existing documents.

> _Note_: Serializing and deserializing to JSON will not store collaboration history
> steps and as such should not be used as the primary storage. You will still need
> to store the Y.Doc binary update format.

```js
import { prosemirrorToYDoc } from 'y-prosemirror'

// Pass JSON previously output from Prosemirror
const doc = Node.fromJSON(schema, {
  type: "doc",
  content: [...]
})
const ydoc = prosemirrorToYDoc(doc)
```

Because JSON is a common usecase there is an equivalent method that skips the need
to create a Prosemirror Node.

```js
import { prosemirrorJSONToYDoc } from 'y-prosemirror'

// Pass JSON previously output from Prosemirror
const ydoc = prosemirrorJSONToYDoc(schema, {
  type: "doc",
  content: [...]
})
```

```js
import { yDocToProsemirror } from 'y-prosemirror'

// apply binary updates from elsewhere
const ydoc = new Y.Doc()
ydoc.applyUpdate(update)

const node = yDocToProsemirror(schema, ydoc)
```

Because JSON is a common usecase there is an equivalent method that outputs JSON
directly, this method does not require the Prosemirror schema.

```js
import { yDocToProsemirrorJSON } from 'y-prosemirror'

// apply binary updates from elsewhere
const ydoc = new Y.Doc()
ydoc.applyUpdate(update)

const node = yDocToProsemirrorJSON(ydoc)
```

### Undo/Redo

The package exports `undo` and `redo` commands which can be used in place of
[prosemirror-history](https://prosemirror.net/docs/ref/#history) by mapping the
mod-Z/Y keys - see [ProseMirror](https://github.com/yjs/yjs-demos/blob/main/prosemirror/prosemirror.js#L29)
and [Tiptap](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-collaboration/src/collaboration.ts)
examples.

Undo and redo are be scoped to the local client, so one peer won't undo another's
changes. See [Y.UndoManager](https://docs.yjs.dev/api/undo-manager) for more details.

Just like prosemirror-history, you can set a transaction's `addToHistory` meta property
to false to prevent that transaction from being rolled back by undo. This can be helpful for programmatic
document changes that aren't initiated by the user.

```js
tr.setMeta("addToHistory", false);
```

### License

[The MIT License](./LICENSE) © Kevin Jahns
