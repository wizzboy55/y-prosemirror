/**
 * Caret-biased diffing (CAVEATS.md "Diffing ambiguity").
 *
 * When a local ProseMirror transaction reaches Y, it is expressed as
 * `diff(before, after)` — and a diff over repeated content is ambiguous:
 * inserting `a` into `aaaaa` yields `aaaaaa`, and *any* of the six positions
 * is a valid anchor. Locally they are indistinguishable, but concurrent
 * remote edits rebase against the chosen anchor, so the "wrong" choice
 * produces visibly incorrect merges (text landing on the wrong side of a
 * concurrent insert, marks bleeding onto the typed text, …).
 *
 * Users overwhelmingly edit at the caret, so this module re-anchors the
 * ambiguity window toward it: {@link biasChangeTowardCaret} takes the diff, the
 * before/after states, and the caret's delta path, and — when the change is a
 * simple single-cluster edit inside one textblock — slides the cluster
 * within its equality window (same character *and* same formats; never
 * across inline nodes) so that an insert *ends* at the caret and a delete
 * *starts* at it. The result applies to `before` with exactly the same
 * outcome (`apply(before, biased) === after`); only the CRDT anchoring
 * changes. Anything unexpected — multi-cluster changes, format
 * instructions, attr ops, node inserts — bails to the original diff.
 *
 * (The bias-toward-caret technique is the same one fast-diff uses for Quill,
 * see jhchen/fast-diff#2.)
 *
 * @module caret-bias
 */

import * as delta from 'lib0/delta'
import * as fun from 'lib0/function'

/**
 * A comparable inline token: a character with its formats, or an opaque
 * inline-node sentinel (never equal to anything, so slides stop at nodes).
 *
 * @typedef {{ c: string, f: any } | { node: true }} InlineToken
 */

/**
 * Flatten a settled textblock delta's children into inline tokens.
 * Returns null when the content contains anything but text and inline nodes.
 *
 * @param {delta.DeltaAny} d
 * @return {Array<InlineToken> | null}
 */
const inlineTokens = (d) => {
  /** @type {Array<InlineToken>} */
  const out = []
  for (const op of d.children) {
    if (delta.$textOp.check(op)) {
      for (const c of op.insert) out.push({ c, f: op.format ?? null })
    } else if (delta.$insertOp.check(op)) {
      for (let i = 0; i < op.insert.length; i++) out.push({ node: true })
    } else {
      return null // settled state must not contain instructions
    }
  }
  return out
}

/**
 * @param {InlineToken} a
 * @param {InlineToken} b
 */
const tokenEq = (a, b) =>
  'c' in a && 'c' in b && a.c === b.c && fun.equalityDeep(a.f, b.f)

/**
 * Whether a delta carries any attribute ops.
 *
 * @param {delta.DeltaAny} d
 */
const hasAttrOps = (d) => !d.attrs[Symbol.iterator]().next().done

/**
 * The settled child node delta at `index` of a settled parent delta, or null.
 *
 * @param {delta.DeltaAny} d
 * @param {number} index
 * @return {delta.DeltaAny | null}
 */
const settledChildAt = (d, index) => {
  let i = 0
  for (const op of d.children) {
    if (delta.$insertOp.check(op)) {
      if (index < i + op.insert.length) {
        const el = op.insert[index - i]
        return delta.$deltaAny.check(el) ? el : null
      }
      i += op.insert.length
    } else if (delta.$textOp.check(op)) {
      i += op.insert.length
      if (index < i) return null
    } else {
      return null
    }
  }
  return null
}

/**
 * Bias the terminal (textblock) level: expects `[retain*, insert|delete, retain*]`
 * with no formats/attrs anywhere, and slides the single cluster toward the
 * caret offset. Returns the rebuilt level delta, or null to bail.
 *
 * @param {delta.DeltaAny} change the level's change delta
 * @param {delta.DeltaAny} state settled before-state of this node
 * @param {number} caretOffset caret offset inside this node, post-change coords
 * @return {delta.DeltaAny | null}
 */
const biasTextLevel = (change, state, caretOffset) => {
  if (hasAttrOps(change)) return null // attr ops → bail
  const stateTokens = inlineTokens(state)
  if (stateTokens == null) return null
  /** @type {{ kind: 'insert', text: string, format: any } | { kind: 'delete', len: number } | null} */
  let cluster = null
  let k = 0 // cluster anchor in state coords (== next coords for the retain prefix)
  let seenCluster = false
  for (const op of change.children) {
    if (delta.$retainOp.check(op)) {
      if (op.format !== undefined || /** @type {any} */ (op).attribution !== undefined) return null
      if (!seenCluster) k += op.retain
    } else if (delta.$textOp.check(op)) {
      if (seenCluster || cluster != null) return null // second cluster → bail
      // data-op tri-state: null means "no attribution" — bail only on real one
      if (/** @type {any} */ (op).attribution != null) return null
      cluster = { kind: 'insert', text: op.insert, format: op.format ?? null }
      seenCluster = true
    } else if (delta.$deleteOp.check(op)) {
      if (seenCluster || cluster != null) return null
      cluster = { kind: 'delete', len: op.delete }
      seenCluster = true
    } else {
      return null // node inserts / modify — bail
    }
  }
  if (cluster == null) return null
  if (cluster.kind === 'insert') {
    const format = cluster.format
    /** @type {Array<InlineToken>} */
    let w = cluster.text.split('').map(c => ({ c, f: format }))
    // target: insert END at the caret (post-change coords: end = k + |w|).
    // Best-effort — slide as far as the equality window allows.
    let steps = caretOffset - (k + w.length)
    while (steps > 0 && k < stateTokens.length && tokenEq(stateTokens[k], w[0])) {
      w = [...w.slice(1), stateTokens[k]]
      k++
      steps--
    }
    while (steps < 0 && k > 0 && tokenEq(stateTokens[k - 1], w[w.length - 1])) {
      w = [stateTokens[k - 1], ...w.slice(0, -1)]
      k--
      steps++
    }
    const out = /** @type {delta.DeltaBuilderAny} */ (delta.create(change.name ?? undefined))
    if (k > 0) out.retain(k)
    out.insert(w.map(t => /** @type {{c:string}} */ (t).c).join(''), format)
    return /** @type {delta.DeltaAny} */ (out.done(false))
  } else {
    const n = cluster.len
    if (k + n > stateTokens.length) return null
    // target: delete START at the caret
    let steps = caretOffset - k
    while (steps > 0 && k + n < stateTokens.length && tokenEq(stateTokens[k], stateTokens[k + n])) {
      k++
      steps--
    }
    while (steps < 0 && k > 0 && tokenEq(stateTokens[k - 1], stateTokens[k + n - 1])) {
      k--
      steps++
    }
    const out = /** @type {delta.DeltaBuilderAny} */ (delta.create(change.name ?? undefined))
    if (k > 0) out.retain(k)
    out.delete(n)
    return /** @type {delta.DeltaAny} */ (out.done(false))
  }
}

/**
 * Recursive walk along the caret path. Non-terminal levels must address the
 * path's child through a modify op (or an untouched retain — nothing to
 * bias). Returns the rebuilt delta or null to bail.
 *
 * @param {delta.DeltaAny} change
 * @param {delta.DeltaAny} state settled before-state at this level
 * @param {Array<number>} path pmToDeltaPath output
 * @param {number} depth
 * @return {delta.DeltaAny | null}
 */
const biasAtLevel = (change, state, path, depth) => {
  if (depth === path.length - 1) {
    return biasTextLevel(change, state, path[depth])
  }
  const targetIndex = path[depth]
  if (hasAttrOps(change)) return null
  // walk ops tracking the NEXT (post-change) child index; the change must
  // consist of retains leading to exactly one modify at the caret's child
  let nextPos = 0
  let retainPrefix = 0
  /** @type {delta.ModifyOp<any> | null} */
  let target = null
  for (const op of change.children) {
    if (delta.$retainOp.check(op)) {
      if (op.format !== undefined || /** @type {any} */ (op).attribution !== undefined) return null
      if (target != null) return null // ops after the caret's subtree — bail
      if (nextPos + op.retain > targetIndex) return null // untouched subtree — nothing to bias
      nextPos += op.retain
      retainPrefix += op.retain
    } else if (delta.$modifyOp.check(op)) {
      if (nextPos !== targetIndex || target != null) return null // edit outside the caret's subtree — bail
      target = op
      nextPos += 1
    } else {
      return null // inserts/deletes at ancestor levels — structural change, bail
    }
  }
  if (target == null) return null
  const stateChild = settledChildAt(state, retainPrefix)
  if (stateChild == null) return null
  const biased = biasAtLevel(target.value, stateChild, path, depth + 1)
  if (biased == null) return null
  const out = /** @type {delta.DeltaBuilderAny} */ (delta.create(change.name ?? undefined))
  if (retainPrefix > 0) out.retain(retainPrefix)
  out.modify(/** @type {any} */ (biased), target.format, /** @type {any} */ (target).attribution)
  return /** @type {delta.DeltaAny} */ (out.done(false))
}

/**
 * Re-anchor an ambiguous local change toward the caret. Falls back to the
 * original `change` whenever the shape is not the simple caret-local edit
 * this pass understands — the result is always safe to emit.
 *
 * @param {delta.DeltaAny} change `diff(state, next)`
 * @param {delta.DeltaAny} state the settled before-state (document delta)
 * @param {Array<number>} caretPath `pmToDeltaPath(nextDoc, selection.from)`
 * @return {delta.DeltaAny}
 */
export const biasChangeTowardCaret = (change, state, caretPath) => {
  if (caretPath.length < 2) return change
  try {
    return biasAtLevel(change, state, caretPath, 0) ?? change
  } catch (_err) {
    return change
  }
}
