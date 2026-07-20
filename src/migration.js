/**
 * Migration of documents produced by the old `y-prosemirror` (Yjs v13) into
 * the representation used by this binding (upstream issue #260).
 *
 * Yjs v14 (`@y/y`) parses the v13 binary format, so a legacy document loads —
 * but its *shape* differs from what this binding writes:
 *
 * - **legacy**: every inline text run lives in a nested `Y.XmlText`, which
 *   materializes under `@y/y` as a *nameless* child type (a delta without a
 *   `name`) wrapping the text ops;
 * - **new**: text ops live directly in the parent node's children.
 *
 * The migration walks the legacy structure and splices each nameless text
 * wrapper's runs (with their formats) inline into the parent, preserving node
 * names, attributes, and nested structure.
 *
 * The result is a *fresh* document: content is preserved, collaboration
 * history is not (undo stacks and relative positions — cursors, comment
 * anchors — do not carry over). Migrate once, centrally (e.g. server-side on
 * first v14 load), keep the v13 binary as backup, and re-anchor any stored
 * relative positions against the new document. See MIGRATION.md.
 *
 * @module migration
 */

import * as Y from '@y/y'
import * as delta from 'lib0/delta'

/**
 * Whether an element inserted into a delta is itself a nested delta (node).
 *
 * @param {any} el
 * @return {el is delta.DeltaAny}
 */
const isNodeDelta = (el) => delta.$deltaAny.check(el)

/**
 * A legacy inline-text wrapper: a nested child type *without a node name*.
 * The old binding's `Y.XmlText` is the only structure that produces this —
 * the new binding always names nested nodes and keeps text inline.
 *
 * @param {any} el
 * @return {boolean}
 */
const isLegacyTextWrapper = (el) => isNodeDelta(el) && el.name == null

/**
 * Deep-scan a fragment (or node delta) for legacy inline-text wrappers.
 *
 * @param {delta.DeltaAny} d
 * @return {boolean}
 */
const deltaHasLegacyText = (d) => {
  for (const op of d.children) {
    if (delta.$insertOp.check(op)) {
      for (const el of op.insert) {
        if (isLegacyTextWrapper(el)) return true
        if (isNodeDelta(el) && deltaHasLegacyText(el)) return true
      }
    }
  }
  return false
}

/**
 * Whether `ytype` holds a document in the *legacy* (`y-prosemirror` v1 /
 * Yjs v13) representation and needs {@link migrateLegacyDoc} before this
 * binding can edit it.
 *
 * @param {Y.Type} ytype
 * @return {boolean}
 */
export const needsLegacyMigration = (ytype) =>
  deltaHasLegacyText(ytype.toDelta({ deep: true }))

/**
 * Extract the plain attrs map of a settled node delta.
 *
 * @param {delta.DeltaAny} d
 * @return {Record<string, any>}
 */
const attrsOf = (d) => {
  /** @type {Record<string, any>} */
  const attrs = {}
  for (const op of d.attrs) {
    if (delta.$setAttrOp.check(op)) {
      attrs[/** @type {string} */ (op.key)] = op.value
    }
  }
  return attrs
}

/**
 * Convert a settled legacy node delta into a new-format node delta: named
 * children recurse, nameless text wrappers are spliced inline (keeping each
 * run's format), text already inline passes through.
 *
 * @param {delta.DeltaAny} d
 * @param {string | null} name
 * @return {delta.DeltaAny}
 */
const convertNode = (d, name = d.name ?? null) => {
  const out = /** @type {delta.DeltaBuilderAny} */ (name == null ? delta.create() : delta.create(name))
  const attrs = attrsOf(d)
  if (Object.keys(attrs).length > 0) out.setAttrs(attrs)
  for (const op of d.children) {
    if (delta.$textOp.check(op)) {
      out.insert(op.insert, op.format ?? null)
    } else if (delta.$insertOp.check(op)) {
      for (const el of op.insert) {
        if (isLegacyTextWrapper(el)) {
          // splice the wrapper's text runs (and any embedded inline nodes)
          // directly into this node's children
          for (const tOp of /** @type {delta.DeltaAny} */ (el).children) {
            if (delta.$textOp.check(tOp)) {
              out.insert(tOp.insert, tOp.format ?? null)
            } else if (delta.$insertOp.check(tOp)) {
              for (const tEl of tOp.insert) {
                out.insert([isNodeDelta(tEl) ? convertNode(tEl) : tEl], tOp.format ?? null)
              }
            }
          }
        } else if (isNodeDelta(el)) {
          out.insert([convertNode(el)], op.format ?? null)
        } else {
          out.insert([el], op.format ?? null)
        }
      }
    }
    // settled documents contain no retain/delete/modify ops
  }
  return /** @type {delta.DeltaAny} */ (out.done(false))
}

/**
 * Convert a legacy fragment's content into a new-format insert delta that can
 * be `applyDelta`-ed into an empty ytype. Pure — reads `ytype`, writes
 * nothing.
 *
 * @param {Y.Type} ytype
 * @return {delta.DeltaAny}
 */
export const legacyFragmentToDelta = (ytype) =>
  convertNode(ytype.toDelta({ deep: true }), null)

/**
 * Migrate a legacy (`y-prosemirror` v1 / Yjs v13) document into a fresh
 * `@y/y` v14 document in the representation this binding uses.
 *
 * ```js
 * const legacy = new Y.Doc({ gc: false })
 * Y.applyUpdate(legacy, v13Binary) // @y/y parses the v13 format
 * if (needsLegacyMigration(legacy.get('prosemirror'))) {
 *   const migrated = migrateLegacyDoc(legacy) // fresh doc, same keys
 *   persist(Y.encodeStateAsUpdate(migrated))  // keep v13Binary as backup
 * }
 * ```
 *
 * @param {Y.Doc} legacyDoc
 * @param {object} [opts]
 * @param {Array<string>} [opts.keys] root keys to migrate (default: `['prosemirror']`)
 * @param {Y.Doc} [opts.target] migrate into this doc instead of a fresh one
 * @return {Y.Doc} the migrated document (content only — no history)
 */
export const migrateLegacyDoc = (legacyDoc, { keys = ['prosemirror'], target = new Y.Doc({ gc: legacyDoc.gc }) } = {}) => {
  for (const key of keys) {
    target.get(key).applyDelta(legacyFragmentToDelta(legacyDoc.get(key)))
  }
  return target
}
