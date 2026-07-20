/**
 * Compatibility helpers for code written against y-prosemirror v1's
 * standalone conversion API. These cover the common server-side conversion
 * surface (`prosemirrorToYXmlFragment`, `yXmlFragmentToProseMirrorRootNode`,
 * `updateYFragment`, `initProseMirrorDoc`) on top of the v2 delta-based
 * binding, so v1 integrations can port with an import swap.
 *
 * Notes:
 * - v2 has no per-binding `mapping`; `initProseMirrorDoc` returns empty maps
 *   for its `mapping`/`meta` members purely for call-shape compatibility.
 * - `updateYFragment`'s v1 `meta` argument (mapping/isOMark) is accepted and
 *   ignored — the v2 diff-based update needs no external mapping state.
 *
 * @module v1-compat
 */

import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import { EditorState } from 'prosemirror-state'
import { docToDelta, fragmentToPm, pmToFragment } from './sync-utils.js'
import { syncPlugin } from './sync-plugin.js'

/**
 * v1: build the sync plugin pre-bound to a fragment. The v2 plugin binds the
 * initial ytype as soon as the view is created; v1's `mapping` option is
 * accepted and ignored (v2 keeps no external mapping state).
 *
 * @param {Y.Type} ytype
 * @param {Record<string, unknown>} [_opts]
 * @return {import('prosemirror-state').Plugin}
 */
export const ySyncPlugin = (ytype, _opts = {}) => syncPlugin(/** @type {any} */ ({ ytype }))

/**
 * v1: convert a ProseMirror node into a (provided or fresh, unattached)
 * fragment. Returns the fragment.
 *
 * @param {import('prosemirror-model').Node} node
 * @param {Y.Type} [fragment] target fragment; a fresh unattached `Y.Type` when omitted
 * @return {Y.Type}
 */
export const prosemirrorToYXmlFragment = (node, fragment = new Y.Type()) =>
  pmToFragment(node, fragment)

/**
 * v1: materialize a fragment as a ProseMirror root node for `schema`.
 *
 * @param {Y.Type} fragment
 * @param {import('prosemirror-model').Schema} schema
 * @return {import('prosemirror-model').Node}
 */
export const yXmlFragmentToProseMirrorRootNode = (fragment, schema) =>
  fragmentToPm(fragment, EditorState.create({ schema }).tr)

/**
 * v1: incrementally update `fragment` so it renders as `node` (diff-based —
 * unchanged content is retained, so concurrent edits merge reasonably).
 *
 * @param {Y.Doc} doc
 * @param {Y.Type} fragment
 * @param {import('prosemirror-model').Node} node the desired document node
 * @param {unknown} [_meta] v1 binding mapping state — ignored
 */
export const updateYFragment = (doc, fragment, node, _meta) => {
  const current = /** @type {any} */ (fragment.toDelta({ deep: true }))
  const desired = /** @type {any} */ (docToDelta(node))
  const change = delta.diff(current, desired)
  if (!change.isEmpty()) {
    Y.transact(doc, () => {
      fragment.applyDelta(/** @type {any} */ (change))
    })
  }
}

/**
 * v1: build the initial editor doc for a fragment. v2 hydrates through
 * `configureYProsemirror`, so the returned `mapping`/`meta` are empty
 * call-shape placeholders.
 *
 * @param {Y.Type} fragment
 * @param {import('prosemirror-model').Schema} schema
 * @return {{ doc: import('prosemirror-model').Node, mapping: Map<any, any>, meta: { mapping: Map<any, any>, isOMark: Map<any, any> } }}
 */
export const initProseMirrorDoc = (fragment, schema) => ({
  doc: yXmlFragmentToProseMirrorRootNode(fragment, schema),
  mapping: new Map(),
  meta: { mapping: new Map(), isOMark: new Map() }
})
