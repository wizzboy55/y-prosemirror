/**
 * Tests for the `onSchemaConflict` hook (upstream issue #258): when two
 * individually-valid concurrent edits compose into a schema-invalid document,
 * the binding recovers by reshaping/dropping/inventing content — and must
 * tell the integrator instead of resolving silently.
 */

import * as Y from '@y/y'
import * as YPM from '@y/prosemirror'
import * as delta from 'lib0/delta'
import * as t from 'lib0/testing'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from './complexSchema.js'

/**
 * @typedef {{ change: any, fix: any, wholesaleReplace: boolean }} Conflict
 */

/**
 * A PM view over `ytype` with an onSchemaConflict recorder.
 *
 * @param {Y.Type} ytype
 * @param {Array<Conflict>} conflicts sink the handler pushes into
 */
const mkView = (ytype, conflicts) => {
  const view = new EditorView(
    { mount: document.createElement('div') },
    {
      state: EditorState.create({
        schema,
        plugins: [YPM.syncPlugin({ onSchemaConflict: c => conflicts.push(c) })]
      })
    }
  )
  YPM.configureYProsemirror({ ytype, renderer: null })(view.state, view.dispatch)
  return view
}

/**
 * @param {Y.Doc} a
 * @param {Y.Doc} b
 */
const syncPair = (a, b) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

/**
 * The CAVEATS.md "Schema mismatches under concurrency" scenario. complexSchema
 * declares `blockquote { content: 'block+' }`:
 *
 *   1. both peers share <blockquote><p>A</p><p>B</p></blockquote>
 *   2. peer 1 deletes paragraph A (locally valid — B remains)
 *   3. peer 2 concurrently deletes paragraph B (locally valid — A remains)
 *   4. they sync: the merged Y state is an *empty* blockquote — invalid under
 *      `block+` — and each peer's binding must resolve it
 *
 * The resolution must (a) fire onSchemaConflict with a non-empty fix, and
 * (b) leave both peers convergent (Y and PM).
 */
export const testSchemaConflictConcurrentDeletes = () => {
  const docA = new Y.Doc({ gc: false })
  docA.clientID = 1
  const docB = new Y.Doc({ gc: false })
  docB.clientID = 2
  // seed docA with <blockquote><p>A</p><p>B</p></blockquote> and copy to docB
  docA.get('prosemirror').applyDelta(
    delta.create().insert([
      delta.create('blockquote', {}, [
        delta.create('paragraph', {}, 'A'),
        delta.create('paragraph', {}, 'B')
      ])
    ]).done()
  )
  syncPair(docA, docB)

  /** @type {Array<Conflict>} */
  const conflictsA = []
  /** @type {Array<Conflict>} */
  const conflictsB = []
  const viewA = mkView(docA.get('prosemirror'), conflictsA)
  const viewB = mkView(docB.get('prosemirror'), conflictsB)

  // sanity: both peers see the seeded blockquote
  t.assert(viewA.state.doc.firstChild?.type.name === 'blockquote', 'peer A sees the blockquote')
  t.assert(viewB.state.doc.firstChild?.childCount === 2, 'peer B sees both paragraphs')

  // offline concurrent deletes: A deletes <p>A</p> (pos 1..4), B deletes <p>B</p> (pos 4..7)
  viewA.dispatch(viewA.state.tr.delete(1, 4))
  viewB.dispatch(viewB.state.tr.delete(4, 7))
  t.assert(conflictsA.length === 0 && conflictsB.length === 0, 'local edits are valid — no conflict yet')

  // reconnect
  syncPair(docA, docB)

  // each peer received a remote change that empties the blockquote — the
  // binding had to resolve the schema violation and must have surfaced it
  t.assert(conflictsA.length + conflictsB.length > 0, 'onSchemaConflict fired on at least one peer')
  const conflict = /** @type {Conflict} */ (conflictsA[0] ?? conflictsB[0])
  t.assert(!conflict.fix.isEmpty(), 'the conflict carries a non-empty fix delta')

  // fixes propagate: sync again and both peers must fully converge
  syncPair(docA, docB)
  syncPair(docA, docB)
  t.compare(
    JSON.parse(JSON.stringify(viewA.state.doc.toJSON())),
    JSON.parse(JSON.stringify(viewB.state.doc.toJSON())),
    'peers converge after the schema-conflict resolution'
  )
  // the converged doc is schema-valid by construction; check the invariant
  // explicitly for the failure mode we care about (empty blockquote)
  viewA.state.doc.descendants(node => {
    if (node.type.name === 'blockquote') {
      t.assert(node.childCount >= 1, 'no empty blockquote survives')
    }
    return true
  })
  viewA.destroy()
  viewB.destroy()
}

/**
 * No false positives: an ordinary remote edit that fits the schema must not
 * fire the handler.
 */
export const testSchemaConflictSilentOnValidMerge = () => {
  const docA = new Y.Doc({ gc: false })
  docA.clientID = 1
  const docB = new Y.Doc({ gc: false })
  docB.clientID = 2
  docA.get('prosemirror').applyDelta(
    delta.create().insert([delta.create('paragraph', {}, 'hello world')]).done()
  )
  syncPair(docA, docB)
  /** @type {Array<Conflict>} */
  const conflictsA = []
  /** @type {Array<Conflict>} */
  const conflictsB = []
  const viewA = mkView(docA.get('prosemirror'), conflictsA)
  const viewB = mkView(docB.get('prosemirror'), conflictsB)

  viewA.dispatch(viewA.state.tr.insertText('AA', 1))
  viewB.dispatch(viewB.state.tr.insertText('ZZ', 12))
  syncPair(docA, docB)

  t.compare(
    JSON.parse(JSON.stringify(viewA.state.doc.toJSON())),
    JSON.parse(JSON.stringify(viewB.state.doc.toJSON())),
    'peers converge on the valid merge'
  )
  t.assert(conflictsA.length === 0 && conflictsB.length === 0, 'no conflict reported for a schema-valid merge')
  viewA.destroy()
  viewB.destroy()
}

/**
 * A throwing handler must not break the sync — the fix still applies and
 * peers still converge.
 */
export const testSchemaConflictHandlerThrowSafe = () => {
  const docA = new Y.Doc({ gc: false })
  docA.clientID = 1
  const docB = new Y.Doc({ gc: false })
  docB.clientID = 2
  docA.get('prosemirror').applyDelta(
    delta.create().insert([
      delta.create('blockquote', {}, [
        delta.create('paragraph', {}, 'A'),
        delta.create('paragraph', {}, 'B')
      ])
    ]).done()
  )
  syncPair(docA, docB)
  const mkThrowingView = (/** @type {Y.Type} */ ytype) => {
    const view = new EditorView(
      { mount: document.createElement('div') },
      {
        state: EditorState.create({
          schema,
          plugins: [YPM.syncPlugin({ onSchemaConflict: () => { throw new Error('integrator bug') } })]
        })
      }
    )
    YPM.configureYProsemirror({ ytype, renderer: null })(view.state, view.dispatch)
    return view
  }
  const viewA = mkThrowingView(docA.get('prosemirror'))
  const viewB = mkThrowingView(docB.get('prosemirror'))
  viewA.dispatch(viewA.state.tr.delete(1, 4))
  viewB.dispatch(viewB.state.tr.delete(4, 7))
  syncPair(docA, docB)
  syncPair(docA, docB)
  t.compare(
    JSON.parse(JSON.stringify(viewA.state.doc.toJSON())),
    JSON.parse(JSON.stringify(viewB.state.doc.toJSON())),
    'peers converge even when the handler throws'
  )
  viewA.destroy()
  viewB.destroy()
}
