/**
 * Pause/resume × undo semantics (the open design question from
 * PROJECT_GOALS.md "How should undo/redo work when sync is paused?").
 *
 * These tests PIN the current semantics so changes to them are deliberate:
 *
 * - pausing (`configureYProsemirror({ ytype: null })`) disconnects the view;
 *   local edits stay in ProseMirror only and are NOT recorded by the
 *   Yjs-level UndoManager
 * - the undo/redo commands NO-OP while paused (fork behavior — upstream let
 *   them mutate the ydoc behind the paused view's back, silently diverging
 *   view and document)
 * - resuming re-binds with the ytype as source of truth: paused local edits
 *   are DISCARDED from the view (integrators who want offline edits to
 *   survive must capture and re-apply them — see ROADMAP.md)
 */

import * as t from 'lib0/testing'
import * as YPM from '@y/prosemirror'
import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from './complexSchema.js'

const mkEditor = () => {
  const ydoc = new Y.Doc({ gc: false })
  const ytype = ydoc.get('prosemirror')
  const undoManager = new Y.UndoManager(ytype)
  const view = new EditorView({ mount: document.createElement('div') }, {
    state: EditorState.create({ schema, plugins: [YPM.syncPlugin(), YPM.yUndoPlugin(undoManager)] })
  })
  YPM.configureYProsemirror({ ytype })(view.state, view.dispatch)
  /**
   * @param {string} text
   * @param {number} [pos]
   */
  const typePara = (text, pos = 0) =>
    view.dispatch(view.state.tr.insert(pos, schema.nodes.paragraph.create(null, schema.text(text))))
  return { ydoc, ytype, undoManager, view, typePara }
}

/**
 * Paused edits stay local: nothing reaches the ydoc or the undo stack.
 */
export const testPauseKeepsEditsLocal = () => {
  const { ytype, undoManager, view, typePara } = mkEditor()
  typePara('one')
  t.assert(undoManager.undoStack.length === 1, 'synced edit is undoable')
  const yBefore = JSON.stringify(ytype.toDelta({ deep: true }).toJSON())

  YPM.configureYProsemirror({ ytype: null })(view.state, view.dispatch)
  typePara('two', view.state.doc.content.size)

  t.assert(view.state.doc.textContent === 'onetwo', 'paused edit is visible locally')
  t.assert(JSON.stringify(ytype.toDelta({ deep: true }).toJSON()) === yBefore, 'paused edit did not reach the ydoc')
  t.assert(undoManager.undoStack.length === 1, 'paused edit is not on the undo stack')
  view.destroy()
}

/**
 * Undo/redo no-op while paused. (Upstream behavior was to undo the *ydoc*
 * behind the disconnected view: the view kept the undone content, the ydoc
 * lost it, and the divergence was destructive on resume.)
 */
export const testUndoNoopsWhilePaused = () => {
  const { ytype, undoManager, view, typePara } = mkEditor()
  typePara('one')
  const yBefore = JSON.stringify(ytype.toDelta({ deep: true }).toJSON())
  YPM.configureYProsemirror({ ytype: null })(view.state, view.dispatch)

  t.assert(YPM.undo(view.state) === false, 'undo reports no-op while paused')
  t.assert(YPM.undoCommand(view.state, undefined) === false, 'undoCommand reports unavailable while paused')
  t.assert(undoManager.undoStack.length === 1, 'undo stack untouched')
  t.assert(JSON.stringify(ytype.toDelta({ deep: true }).toJSON()) === yBefore, 'ydoc untouched by paused undo')
  t.assert(view.state.doc.textContent === 'one', 'view untouched by paused undo')

  // resume: view and doc still agree, and undo works again
  YPM.configureYProsemirror({ ytype })(view.state, view.dispatch)
  t.assert(view.state.doc.textContent === 'one', 'resume renders the intact ydoc')
  t.assert(YPM.undo(view.state) === true, 'undo works after resume')
  t.assert(view.state.doc.textContent === '', 'undo after resume reverts the synced edit')
  view.destroy()
}

/**
 * Resume semantics: the ytype is the source of truth — paused local edits
 * are replaced by the ydoc's content on re-bind. Pinned so a future
 * merge-on-resume design changes this test deliberately.
 */
export const testResumeDiscardsPausedEdits = () => {
  const { ytype, view, typePara } = mkEditor()
  typePara('one')
  YPM.configureYProsemirror({ ytype: null })(view.state, view.dispatch)
  typePara('two', view.state.doc.content.size)
  t.assert(view.state.doc.textContent === 'onetwo', 'paused edit visible before resume')

  YPM.configureYProsemirror({ ytype })(view.state, view.dispatch)
  t.assert(view.state.doc.textContent === 'one', 'resume replaces the view with the ydoc content (paused edits discarded)')
  view.destroy()
}

/**
 * Ydoc changes arriving while paused do not disturb the paused view; the
 * resume renders them.
 */
export const testPausedViewIgnoresRemoteUntilResume = () => {
  const { ytype, view, typePara } = mkEditor()
  typePara('one')
  YPM.configureYProsemirror({ ytype: null })(view.state, view.dispatch)

  // a remote-style edit lands in the ydoc while the view is paused
  ytype.applyDelta(
    delta.create().retain(1).insert([delta.create('paragraph', {}, 'remote')]).done()
  )
  t.assert(view.state.doc.textContent === 'one', 'paused view does not render ydoc changes')

  YPM.configureYProsemirror({ ytype })(view.state, view.dispatch)
  t.assert(view.state.doc.textContent === 'oneremote', 'resume renders the ydoc changes')
  view.destroy()
}
