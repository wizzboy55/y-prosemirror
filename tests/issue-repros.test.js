/**
 * Repro suite for upstream suggestion-mode issues #244, #245, #254, #255
 * (github.com/yjs/y-prosemirror/issues). All four were reported against the
 * pre-delta-RDT binding (May 2026); each test here re-states the *expected*
 * behavior from the issue against the current binding so we know exactly
 * which of them still reproduce.
 *
 * Layout mirrors suggestions.test.js: one base Y.Doc, a "view suggestions"
 * doc (renderer.suggestionMode = false — edits commit to base) and a
 * "suggestion mode" doc (suggestionMode = true — edits stay suggestions),
 * chain-synced, one PM view each.
 */

import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import * as t from 'lib0/testing'
import { schema } from './complexSchema.js'
import { createPMView, setupTwoWaySync } from './cohort.js'

/** Insertion mark as it appears in PM doc JSON */
const insertionMark = {
  type: 'y-attributed-insert',
  attrs: { userIds: [], timestamp: null }
}
/** Deletion mark as it appears in PM doc JSON */
const deletionMark = {
  type: 'y-attributed-delete',
  attrs: { userIds: [], timestamp: null }
}

/**
 * @param {import('prosemirror-model').Node} doc
 * @param {object} expected
 * @param {string} message
 */
const assertDocJSON = (doc, expected, message) => {
  t.compare(JSON.parse(JSON.stringify(doc.toJSON())), expected, message)
}

/**
 * @param {object} [opts]
 * @param {import('lib0/delta').Delta} [opts.seedDelta]
 * @param {string} [opts.baseContent]
 */
const mkSetup = (opts = {}) => {
  const doc = new Y.Doc({ gc: false, guid: 'base' })
  const suggestionDoc = new Y.Doc({ isSuggestionDoc: true, gc: false, guid: 'suggestions' })
  const suggestionModeDoc = new Y.Doc({ isSuggestionDoc: true, gc: false, guid: 'suggestions-edit' })

  const attrs = new Y.Attributions()
  const suggestionRenderer = Y.createDiffRenderer(doc, suggestionDoc, { attrs })
  suggestionRenderer.suggestionMode = false
  const suggestionModeRenderer = Y.createDiffRenderer(doc, suggestionModeDoc, { attrs })
  suggestionModeRenderer.suggestionMode = true

  setupTwoWaySync(suggestionDoc, suggestionModeDoc)

  const viewBase = createPMView(doc.get('prosemirror'))
  const viewSuggestion = createPMView(suggestionDoc.get('prosemirror'), suggestionRenderer)
  const viewSuggestionMode = createPMView(suggestionModeDoc.get('prosemirror'), suggestionModeRenderer)

  if (opts.seedDelta) {
    doc.get('prosemirror').applyDelta(opts.seedDelta)
  } else if (opts.baseContent != null) {
    doc.get('prosemirror').applyDelta(
      delta.create().insert([delta.create('paragraph', {}, opts.baseContent)]).done()
    )
  }
  return { doc, suggestionDoc, suggestionModeDoc, viewBase, viewSuggestion, viewSuggestionMode }
}

/**
 * Issue #244 — "V2 suggestions: typing in deleted content (View mode) edge
 * cases". A suggestion-mode user suggests deleting "world"; a view-mode user
 * then types inside the deletion-struck span. Expected (Google-Docs-like, and
 * per CAVEATS.md "Editing suggestion-deleted content"): the insert works,
 * commits to the base doc at the right position, and the typed character is
 * NOT swallowed, NOT misplaced, and NOT delete-marked (the inherited
 * `y-attributed-delete` mark must be corrected away by the binding).
 */
export const testIssue244TypeIntoSuggestionDeletedText = () => {
  const { viewBase, viewSuggestion, viewSuggestionMode } = mkSetup({ baseContent: 'Hello world' })

  // Suggest deleting "world": <p>Hello world</p>, "world" = pos 7..12.
  viewSuggestionMode.dispatch(viewSuggestionMode.state.tr.delete(7, 12))
  assertDocJSON(viewSuggestion.state.doc, {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world', marks: [deletionMark] }
      ]
    }]
  }, '#244 pre: "world" is rendered as a suggested deletion')

  // View-mode user types "X" between "w" and "o" of the struck "world"
  // (rendered pos 8). PM's insertText inherits the deletion mark at that
  // position — exactly the implicit-inheritance case from CAVEATS.md.
  viewSuggestion.dispatch(viewSuggestion.state.tr.insertText('X', 8))

  // The insert is a view-mode edit → commits to base between "w" and "o".
  assertDocJSON(viewBase.state.doc, {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: 'Hello wXorld' }]
    }]
  }, '#244: base doc received the typed character at the correct position')

  // Rendered views: X sits unmarked between the still-suggested deletions.
  const expectedRendered = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'w', marks: [deletionMark] },
        { type: 'text', text: 'X' },
        { type: 'text', text: 'orld', marks: [deletionMark] }
      ]
    }]
  }
  assertDocJSON(viewSuggestion.state.doc, expectedRendered,
    '#244: originating view shows X unmarked inside the deletion')
  assertDocJSON(viewSuggestionMode.state.doc, expectedRendered,
    '#244: suggestion-mode peer converges to the same render')
}

/**
 * Issue #245 — "V2 suggestions, content wrongly inserted as suggestion".
 * With a pending suggestion in the paragraph, a view-mode user presses Enter
 * after the base text. Expected: the split is added as *original* content
 * (base doc gains the paragraph split; the new paragraph node carries no
 * insertion mark), and the pending suggestion stays pending.
 *
 * KNOWN FAILURE (skipped): the failure shape has *morphed* since the issue
 * was filed. On current master the view-mode split at the suggestion boundary
 * silently FLATTENS the pending suggestion into the base doc: the split's
 * insert side carries the suggested content with its `y-attributed-insert`
 * marks, the reverse transformer strips the `y-attributed-*` namespace ("the
 * view never attributes"), and the stripped content is written to base as
 * plain text — while the delete side removes it from the suggestion doc. Net:
 * pressing Enter next to someone's pending suggestion accepts it without
 * anyone asking. A proper fix needs the binding to recognize *moved*
 * attributed content and route it back into the suggestion overlay, which
 * requires renderer-aware attributed-insert support in `@y/y`'s `applyDelta`
 * (see ROADMAP.md). Remove the `t.skip()` to re-arm this repro.
 */
export const testIssue245ViewModeEnterNotSuggested = () => {
  t.skip()
  const { viewBase, viewSuggestion, viewSuggestionMode } = mkSetup({ baseContent: 'Hello world' })

  // A pending suggestion: append " Greetings" at the end (pos 12).
  viewSuggestionMode.dispatch(viewSuggestionMode.state.tr.insertText(' Greetings', 12))
  assertDocJSON(viewSuggestion.state.doc, {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello world' },
        { type: 'text', text: ' Greetings', marks: [insertionMark] }
      ]
    }]
  }, '#245 pre: " Greetings" is rendered as a suggested insertion')

  // View-mode user presses Enter right after "world" (rendered pos 12 —
  // the boundary between base text and the suggested insertion).
  viewSuggestion.dispatch(viewSuggestion.state.tr.split(12))

  // The split is a view-mode edit → the base doc splits into two paragraphs
  // (second one empty — the suggested " Greetings" is not base content).
  assertDocJSON(viewBase.state.doc, {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
      { type: 'paragraph' }
    ]
  }, '#245: base doc received the paragraph split as original content')

  // Both suggestion renders agree, and the new paragraph node itself is NOT
  // marked as a suggested insertion (its content — the pending " Greetings"
  // suggestion — still is).
  t.compare(
    JSON.parse(JSON.stringify(viewSuggestion.state.doc.toJSON())),
    JSON.parse(JSON.stringify(viewSuggestionMode.state.doc.toJSON())),
    '#245: view-mode and suggestion-mode peers converge'
  )
  const secondPara = viewSuggestion.state.doc.child(1)
  t.assert(
    !secondPara.marks.some(m => m.type.name === 'y-attributed-insert'),
    '#245: the split-off paragraph node is original content, not a suggested insertion'
  )
}

/**
 * Issue #254 — "V2 suggestions: copy / paste". Pasted content carries the
 * `y-attributed-*` marks of its source (they are part of the copied slice),
 * but those marks are a *read-only projection* (CAVEATS.md): the binding must
 * not persist them as user formats. Expected:
 *   - pasting in suggestion mode: the pasted run becomes one fresh suggestion
 *     (fresh attribution), stale mark attrs are not preserved;
 *   - pasting in view mode: the pasted run commits to base as plain content,
 *     and no `y-attributed-*` format ever reaches the base Y document.
 */
export const testIssue254PasteStaleAttributionMarks = () => {
  const staleIns = schema.marks['y-attributed-insert'].create({ userIds: ['stale-user'], timestamp: null })

  t.group('paste into suggestion mode re-attributes freshly', () => {
    const { viewBase, viewSuggestion, viewSuggestionMode } = mkSetup({ baseContent: 'Hello ' })
    // Paste "World" carrying a stale insertion mark at the end (pos 7).
    viewSuggestionMode.dispatch(
      viewSuggestionMode.state.tr.insert(7, schema.text('World', [staleIns]))
    )
    // Base doc untouched (suggestion-mode edit).
    assertDocJSON(viewBase.state.doc, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }] }]
    }, '#254: base unchanged by suggestion-mode paste')
    // The pasted text is a fresh suggestion: insertion-marked with the
    // *current* attribution (userIds []), not the stale one.
    const expected = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'World', marks: [insertionMark] }
        ]
      }]
    }
    assertDocJSON(viewSuggestionMode.state.doc, expected,
      '#254: pasted run is one fresh suggestion (stale mark attrs replaced)')
    assertDocJSON(viewSuggestion.state.doc, expected,
      '#254: view-mode peer agrees')
  })

  t.group('paste into view mode strips attribution to base', () => {
    const { doc, viewBase, viewSuggestion, viewSuggestionMode } = mkSetup({ baseContent: 'Hello ' })
    viewSuggestion.dispatch(
      viewSuggestion.state.tr.insert(7, schema.text('World', [staleIns]))
    )
    const expected = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello World' }] }]
    }
    // View-mode edits commit to base — as plain, unattributed content.
    assertDocJSON(viewBase.state.doc, expected,
      '#254: view-mode paste committed to base as plain content')
    assertDocJSON(viewSuggestion.state.doc, expected,
      '#254: originating view shows no attribution marks')
    assertDocJSON(viewSuggestionMode.state.doc, expected,
      '#254: suggestion-mode peer shows no attribution marks')
    // The y-attributed-* namespace must never be persisted into the base Y
    // document as a text format.
    const baseDelta = JSON.stringify(doc.get('prosemirror').toDelta({ deep: true }).toJSON())
    t.assert(!baseDelta.includes('y-attributed'),
      '#254: no y-attributed-* format leaked into the base Y document')
  })
}

/**
 * Issue #255 — "V2 suggestions / diff: changing attrs does not show". A
 * suggestion-mode user changes a node attribute only (heading level 1 → 2;
 * same node type, so the Y layer records a setAttr, not delete+insert).
 * Expected: the base doc keeps level 1, the suggestion render shows level 2
 * *and* surfaces the change as an attribution (a `y-attributed-format` node
 * mark), so accept/reject UIs can find it. Observed upstream: the change
 * renders but carries no attribution at all.
 */
export const testIssue255AttrChangeShowsAsSuggestion = () => {
  const { viewBase, viewSuggestion, viewSuggestionMode } = mkSetup({
    seedDelta: delta.create().insert([delta.create('heading', { level: 1 }, 'Hello world')]).done()
  })
  assertDocJSON(viewBase.state.doc, {
    type: 'doc',
    content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hello world' }] }]
  }, '#255 pre: base doc has a level-1 heading')

  // Suggestion-mode user bumps the heading level (attr-only change).
  viewSuggestionMode.dispatch(
    viewSuggestionMode.state.tr.setNodeMarkup(0, undefined, { level: 2 })
  )

  // The suggestion must not leak into the base doc.
  assertDocJSON(viewBase.state.doc, {
    type: 'doc',
    content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hello world' }] }]
  }, '#255: base doc still has level 1 (attr change stayed a suggestion)')

  // Both suggestion renders show the new level…
  t.assert(viewSuggestionMode.state.doc.child(0).attrs.level === 2,
    '#255: suggestion-mode renders the changed level')
  t.assert(viewSuggestion.state.doc.child(0).attrs.level === 2,
    '#255: view-mode peer renders the changed level')
  // …and the changed node carries a format attribution so the change is
  // visible/reviewable as a suggestion.
  const attributed = (/** @type {import('prosemirror-model').Node} */ n) =>
    n.marks.some(m => m.type.name === 'y-attributed-format')
  t.assert(attributed(viewSuggestionMode.state.doc.child(0)),
    '#255: suggestion-mode surfaces the attr change as y-attributed-format')
  t.assert(attributed(viewSuggestion.state.doc.child(0)),
    '#255: view-mode surfaces the attr change as y-attributed-format')
}
