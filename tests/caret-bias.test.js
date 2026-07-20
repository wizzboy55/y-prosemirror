/**
 * Caret-biased diffing tests (CAVEATS.md "Diffing ambiguity").
 *
 * Unit tests drive `biasChangeTowardCaret` directly on delta triples; the
 * integration test shows the observable merge improvement: without the bias,
 * a character typed at the start of a repeated run anchors wherever the diff
 * happened to put it (typically after the common prefix — the run's end),
 * so a concurrent format on the run's tail bleeds onto the typed character.
 */

import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import * as t from 'lib0/testing'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import * as YPM from '@y/prosemirror'
import { biasChangeTowardCaret, docToDelta, pmToDeltaPath } from '@y/prosemirror'
import { schema } from './complexSchema.js'

/**
 * @param {Array<import('prosemirror-model').Node>} blocks
 */
const doc = (blocks) => schema.node('doc', null, blocks)
/**
 * @param {Array<import('prosemirror-model').Node>} inline
 */
const p = (inline) => schema.node('paragraph', null, inline)
/**
 * @param {string} s
 * @param {boolean} [bold]
 */
const txt = (s, bold = false) => schema.text(s, bold ? [schema.marks.strong.create()] : [])

/**
 * Assert the bias is anchor-only: applying the biased change to the before
 * state yields exactly the after state.
 *
 * @param {any} state
 * @param {any} biased
 * @param {any} next
 * @param {string} msg
 */
const assertApplyEquivalent = (state, biased, next, msg) => {
  const applied = delta.cloneDeep(state)
  applied.apply(delta.cloneDeep(biased), { final: true, move: true })
  t.compare(
    JSON.parse(JSON.stringify(applied.done(false).toJSON())),
    JSON.parse(JSON.stringify(next.toJSON())),
    msg
  )
}

/**
 * Typing at the START of a repeated run: the raw diff anchors the insert at
 * the run's end (maximal common prefix); the bias re-anchors it at the caret.
 */
export const testCaretBiasInsertAtRunStart = () => {
  const before = doc([p([txt('aaaa')])])
  const after = doc([p([txt('aaaaa')])])
  const state = docToDelta(before)
  const next = docToDelta(after)
  const change = delta.diff(/** @type {any} */ (state), /** @type {any} */ (next))
  // user typed at PM pos 1 (offset 0); caret sits after the char at PM pos 2
  const caretPath = pmToDeltaPath(after, 2)
  t.compare(caretPath, [0, 1], 'caret path points into the paragraph at offset 1')
  const biased = biasChangeTowardCaret(/** @type {any} */ (change), /** @type {any} */ (state), caretPath)
  assertApplyEquivalent(state, biased, next, 'biased insert still produces the same document')
  // the biased change must anchor the insert at offset 0 (no leading retain)
  const para = /** @type {any} */ (biased).children.start.value ?? /** @type {any} */ (biased).children.start
  const inner = /** @type {any} */ (para).children?.start ?? null
  t.assert(inner != null && delta.$textOp.check(inner) && inner.insert === 'a',
    'insert anchored at the caret (offset 0), not at the run end')
}

/**
 * Backspace inside a repeated run: the deletion anchors at the caret.
 */
export const testCaretBiasDeleteAtCaret = () => {
  const before = doc([p([txt('aaaaa')])])
  const after = doc([p([txt('aaaa')])])
  const state = docToDelta(before)
  const next = docToDelta(after)
  const change = delta.diff(/** @type {any} */ (state), /** @type {any} */ (next))
  // user backspaced the char at offsets 2..3; caret lands at offset 2 (PM pos 3)
  const caretPath = pmToDeltaPath(after, 3)
  t.compare(caretPath, [0, 2], 'caret path at offset 2')
  const biased = biasChangeTowardCaret(/** @type {any} */ (change), /** @type {any} */ (state), caretPath)
  assertApplyEquivalent(state, biased, next, 'biased delete still produces the same document')
  const para = /** @type {any} */ (biased).children.start.value
  const first = para.children.start
  t.assert(delta.$retainOp.check(first) && first.retain === 2, 'delete anchored behind a retain(2)')
  t.assert(delta.$deleteOp.check(first.next) && first.next.delete === 1, 'single-char delete at the caret')
}

/**
 * The slide never crosses a format boundary: typing a plain char before a
 * bold run stays in the plain window; the equality window simply ends there.
 */
export const testCaretBiasRespectsFormatBoundary = () => {
  const before = doc([p([txt('aa'), txt('aa', true)])])
  const after = doc([p([txt('a'), txt('aa'), txt('aa', true)])]) // plain 'a' typed at start
  const state = docToDelta(before)
  const next = docToDelta(after)
  const change = delta.diff(/** @type {any} */ (state), /** @type {any} */ (next))
  const biased = biasChangeTowardCaret(/** @type {any} */ (change), /** @type {any} */ (state), pmToDeltaPath(after, 2))
  assertApplyEquivalent(state, biased, next, 'format-adjacent bias is apply-equivalent')
  const para = /** @type {any} */ (biased).children.start.value ?? /** @type {any} */ (biased).children.start
  const inner = /** @type {any} */ (para).children?.start
  t.assert(inner != null && delta.$textOp.check(inner) && inner.format == null,
    'the biased op is still the plain insert')
}

/**
 * Bail-outs: a multi-cluster change is returned unchanged (identity).
 */
export const testCaretBiasBailsOnComplexChange = () => {
  const before = doc([p([txt('aaaa')]), p([txt('bbbb')])])
  const after = doc([p([txt('aaaXa')]), p([txt('bbYbb')])]) // two edits
  const state = docToDelta(before)
  const next = docToDelta(after)
  const change = delta.diff(/** @type {any} */ (state), /** @type {any} */ (next))
  const biased = biasChangeTowardCaret(/** @type {any} */ (change), /** @type {any} */ (state), pmToDeltaPath(after, 5))
  t.assert(biased === change, 'multi-edit change bails to the original diff')
}

/**
 * Integration: base "aaaa"; peer B bolds the last two chars while peer A
 * concurrently types a plain "a" at the start. With caret bias, A's char
 * anchors before the run, so the merged doc bolds the ORIGINAL last two
 * chars — the typed char stays out of the bolded tail.
 */
export const testCaretBiasConcurrentMarkMerge = () => {
  const docA = new Y.Doc({ gc: false })
  docA.clientID = 1
  const docB = new Y.Doc({ gc: false })
  docB.clientID = 2
  docA.get('prosemirror').applyDelta(
    delta.create().insert([delta.create('paragraph', {}, 'aaaa')]).done()
  )
  const syncPair = () => {
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)))
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)))
  }
  syncPair()
  const mkView = (/** @type {Y.Type} */ ytype) => {
    const view = new EditorView(
      { mount: document.createElement('div') },
      { state: EditorState.create({ schema, plugins: [YPM.syncPlugin({})] }) }
    )
    YPM.configureYProsemirror({ ytype, renderer: null })(view.state, view.dispatch)
    return view
  }
  const viewA = mkView(docA.get('prosemirror'))
  const viewB = mkView(docB.get('prosemirror'))

  // offline concurrent edits
  // B bolds the last two chars (offsets 2..4 → PM 3..5)
  viewB.dispatch(viewB.state.tr.addMark(3, 5, schema.marks.strong.create()))
  // A types a plain 'a' at the start — set the selection exactly like real
  // typing would leave it (caret after the typed char)
  {
    const tr = viewA.state.tr.insertText('a', 1, 1)
    tr.setSelection(TextSelection.create(tr.doc, 2))
    viewA.dispatch(tr)
  }

  syncPair()
  syncPair()

  const jsonA = JSON.parse(JSON.stringify(viewA.state.doc.toJSON()))
  const jsonB = JSON.parse(JSON.stringify(viewB.state.doc.toJSON()))
  t.compare(jsonA, jsonB, 'peers converge')
  t.compare(jsonA, {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'aaa' },
        { type: 'text', text: 'aa', marks: [{ type: 'strong' }] }
      ]
    }]
  }, 'typed char anchored at the caret — the concurrent bold stays on the original tail')
  viewA.destroy()
  viewB.destroy()
}
