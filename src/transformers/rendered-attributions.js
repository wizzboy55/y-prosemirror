import * as delta from 'lib0/delta'
import { Transformer, Template, createTransformResult } from 'lib0/delta/transformer'
import { liftAttrAttributions, nodeContentAttributed, touchesAttrAttribution } from '../sync-utils.js'

/**
 * # `renderedAttributions` — y-prosemirror's replacement for lib0's `fullAttributions`
 *
 * Same pipeline role and output contract as
 * `lib0/delta/transformer/full-attributions`: whenever an op changes
 * attribution, re-emit the **complete accumulated** attribution for that
 * position (in "set present + clear removed" instruction form), so the
 * downstream `attributionToFormat` can render whole mark values. `applyB` is a
 * passthrough (the view never attributes).
 *
 * ## Why not lib0's `fullAttributions`?
 *
 * `fullAttributions` is *stateful*: it accumulates attribution in a private
 * overlay by tracking the change stream it is fed. Parts of the y-prosemirror
 * data side's change stream are diffs (returned fixes are
 * `diff(expected, actual)`; the uncertain-window emissions are diffs of full
 * renders) — and a diff between two renders is not unique: with several
 * equal-named nodes of similar content (e.g. short paragraphs), `diff` may
 * pair node instances differently on different peers (see CAVEATS.md
 * "Diffing ambiguity"). Applying any of those diffs converges to the same
 * *content*, but an overlay that tracks the *ops* accumulates the attribution
 * at whichever node the local pairing chose — peers' overlays drift apart,
 * and with them the attribution marks their views render (observed in the
 * suggestion-mode fuzz: two peers showing a format-suggestion on different
 * paragraphs). (The data side's *steady-state* emissions are nowadays the
 * native change deltas — identical on every peer — which shrinks that
 * ambiguity class, but does not remove it: fixes stay diffs.)
 *
 * This transformer is therefore **stateless**: it resolves the full
 * attribution from the data side's *current rendered state* (`getState()` — a
 * shared read value, never mutated here). Every change flowing `applyA` is, by
 * construction of the data RDT, positioned against exactly that state (a
 * native change payload is emitted right after the maintained cache was
 * patched with it; an uncertain-window emission is `diff(prev, next)` where
 * `next` is the state at emission time; a returned fix is
 * `diff(expected, actual)` where `actual` is the state), so a parallel walk
 * lines the two up — retains/modifies consume state positions, inserts do
 * not, deletes consume none (the state is the post-change render). Whatever
 * pairing produced the change, the attribution emitted here is the render's
 * truth at that position.
 *
 * Like `fullAttributions`, `applyA` enriches its input **in place** via
 * `d.apply(full, { move: true })` (the binding hands the transformer a
 * privately-owned builder) and never mutates a shared `format`/`attribution`
 * object — every emitted attribution is freshly allocated.
 *
 * @module transformers/rendered-attributions
 */

/**
 * The full attribution to emit for a position: the state's truth, plus a
 * `null` clear for every key the change touched that the truth no longer has
 * ("set present + clear removed" — a downstream consumer merges wholesale, so
 * removed keys must be cleared explicitly). The nested `format` map merges one
 * level, mirroring `Attribution` semantics.
 *
 * @param {{[k:string]:any}|null|undefined} stateAttr the render's attribution
 * @param {{[k:string]:any}|null|undefined} opAttr the change's attribution update
 * @return {{[k:string]:any}|null}
 */
const resolveAttr = (stateAttr, opAttr) => {
  if (stateAttr == null) return null // truth: no attribution — clear everything
  /** @type {{[k:string]:any}} */
  const out = {}
  for (const k in stateAttr) {
    out[k] = k === 'format' ? { ...stateAttr.format } : stateAttr[k]
  }
  if (opAttr != null) {
    for (const k in opAttr) {
      if (k === 'format' && opAttr.format != null && typeof opAttr.format === 'object') {
        const f = /** @type {{[k:string]:any}} */ (out.format ?? (out.format = {}))
        for (const fk in opAttr.format) {
          if (f[fk] === undefined) f[fk] = null // cleared format key
        }
      } else if (out[k] === undefined) {
        out[k] = null // cleared key
      }
    }
  }
  return out
}

/**
 * Merge a state node's lifted attr attribution ({@link liftAttrAttributions})
 * into an *instruction-form* resolved attribution. A `null` resolved value is
 * the clear-all instruction; when the node still carries attr provenance the
 * content dimensions stay explicitly cleared while `format` carries the lift.
 *
 * @param {{[k:string]:any}|null} resolved
 * @param {delta.DeltaAny | null} stateChild
 * @return {{[k:string]:any}|null}
 */
const mergeLiftedInstruction = (resolved, stateChild) => {
  // `resolved` is the state's complete truth for the node op — when it says
  // the node itself is suggested content (inserted/deleted wholesale), its
  // attrs belong to that suggestion and no separate attr lift applies.
  if (nodeContentAttributed(resolved)) return resolved
  const lift = stateChild == null ? null : liftAttrAttributions(stateChild)
  if (lift == null) return resolved
  if (resolved == null) {
    return { insert: null, delete: null, format: lift }
  }
  return { ...resolved, format: { ...(resolved.format ?? {}), ...lift } }
}

/**
 * Build the content-free `full` delta carrying the resolved attribution at
 * exactly `d`'s attribution-touching positions, walking `state` (the
 * post-change render) in parallel. Mirrors `full-attributions.js`' `buildFull`,
 * with the overlay replaced by the render.
 *
 * Besides content attribution, this also lifts a node's *attr* attribution
 * (resolved from the state node's own attribute ops) onto the op wrapping the
 * node — see {@link liftAttrAttributions} for why attr provenance rides the
 * `format` dimension.
 *
 * @param {delta.DeltaAny} d
 * @param {delta.DeltaAny | null} state
 * @return {delta.DeltaBuilderAny}
 */
const buildFull = (d, state) => {
  const full = /** @type {delta.DeltaBuilderAny} */ (delta.create())
  let cur = state == null ? null : state.children.start
  let off = 0
  const advance = () => {
    if (cur != null && off >= cur.length) {
      cur = cur.next
      off = 0
    }
  }
  /**
   * Read ≤ `rem` positions of one uniform run at the cursor, advancing. Node
   * elements are read one at a time so each node's attr lift can land on its
   * own position.
   *
   * @param {number} rem
   * @return {{ take: number, attr: {[k:string]:any}|null|undefined, el: any }}
   */
  const readRun = (rem) => {
    if (cur == null) return { take: rem, attr: undefined, el: null }
    let take = Math.min(cur.length - off, rem)
    let el = null
    if (delta.$insertOp.check(cur)) {
      el = cur.insert[off]
      if (delta.$deltaAny.check(el)) {
        take = 1
      } else {
        for (let i = 1; i < take; i++) {
          if (delta.$deltaAny.check(cur.insert[off + i])) {
            take = i
            break
          }
        }
      }
    }
    const attr = /** @type {any} */ (cur).attribution
    off += take
    advance()
    return { take, attr, el }
  }
  /**
   * Consume `n` state positions without emitting attribution (gap).
   * @param {number} n
   */
  const consume = (n) => {
    let rem = n
    while (rem > 0) {
      if (cur == null) break
      const take = Math.min(cur.length - off, rem)
      off += take
      rem -= take
      advance()
    }
  }
  for (const op of d.children) {
    if (delta.$retainOp.check(op)) {
      if (op.attribution === undefined) {
        full.retain(op.retain) // untouched — gap; still consume state positions
        consume(op.retain)
      } else {
        let rem = op.retain
        while (rem > 0) {
          const { take, attr, el } = readRun(rem)
          const stateChild = delta.$deltaAny.check(el) ? el : null
          full.retain(take, undefined, mergeLiftedInstruction(resolveAttr(attr, op.attribution), stateChild))
          rem -= take
        }
      }
    } else if (delta.$textOp.check(op)) {
      // data op: its attribution comes from the render diff and is already
      // complete — gap; consume the state positions it occupies
      full.retain(op.insert.length)
      consume(op.insert.length)
    } else if (delta.$insertOp.check(op)) {
      // data op: content attribution comes from the render diff and is
      // already complete, but a node element's *attr* attribution still needs
      // the lift onto its own position. Skip insert-attributed ops — a
      // freshly suggested node's attrs are part of the insertion.
      const liftable = !nodeContentAttributed(/** @type {any} */ (op).attribution)
      for (const elm of op.insert) {
        const nodeLift = liftable && delta.$deltaAny.check(elm) ? liftAttrAttributions(elm) : null
        full.retain(1, undefined, nodeLift == null ? undefined : { format: nodeLift })
        consume(1)
      }
    } else if (delta.$deleteOp.check(op)) {
      // deleted content has no position in the post-change render — no state
      // consumption, no entry in `full`
    } else { // $modifyOp
      const { attr, el } = readRun(1)
      const stateChild = delta.$deltaAny.check(el) ? el : null
      // A change that touches attr attribution (including instruction-form
      // clears from an accepted/rejected attr suggestion) must re-emit the
      // node's complete attribution even when the op itself carries none.
      const emitAttribution = op.attribution !== undefined || touchesAttrAttribution(op.value)
      full.modify(
        buildFull(op.value, stateChild),
        undefined,
        emitAttribution ? mergeLiftedInstruction(resolveAttr(attr, op.attribution), stateChild) : undefined
      )
    }
  }
  full.done(false)
  return full
}

/**
 * @extends {Transformer<any,any>}
 */
export class RenderedAttributionsTransformer extends Transformer {
  /**
   * @param {import('lib0/schema').Schema<delta.Delta<any>>} $in
   * @param {import('lib0/schema').Schema<delta.Delta<any>>} $out
   * @param {() => delta.DeltaAny} getState
   */
  constructor ($in, $out, getState) {
    super($in, $out)
    this.getState = getState
  }

  /**
   * @param {delta.DeltaBuilderAny} d
   * @return {import('lib0/delta/transformer').TransformResultAny}
   */
  applyA (d) {
    const full = buildFull(d, this.getState())
    d.apply(full, { move: true })
    return createTransformResult(null, d)
  }

  /**
   * @param {delta.DeltaBuilderAny} d
   * @return {import('lib0/delta/transformer').TransformResultAny}
   */
  applyB (d) {
    return createTransformResult(d, null)
  }
}

/**
 * @template {delta.DeltaConf} [IN=any]
 * @extends {Template<IN, IN>}
 */
export class RenderedAttributions extends Template {
  /**
   * @param {import('lib0/schema').Schema<delta.Delta<IN>>} $d
   * @param {() => delta.DeltaAny} getState
   */
  constructor ($d, getState) {
    super($d, $d) // attribution is delta metadata — output schema equals input
    this.getState = getState
  }

  get name () { return 'y-prosemirror:renderedAttributions' }

  /**
   * @return {Transformer<IN, IN>}
   */
  init () {
    return new RenderedAttributionsTransformer(this.$in, this.$out, this.getState)
  }
}

/**
 * Expand every attribution-bearing op of an `applyA` change to the complete
 * accumulated attribution, resolved from the data side's current rendered
 * state — see the {@link module:transformers/rendered-attributions module
 * doc} for why this replaces lib0's stateful `fullAttributions` here.
 * Typically piped before `attributionToFormat`.
 *
 * @template {delta.DeltaConf} IN
 * @param {import('lib0/schema').Schema<delta.Delta<IN>>} $d
 * @param {() => delta.DeltaAny} getState the data-side RDT's current state
 * @return {RenderedAttributions<IN>}
 */
export const renderedAttributions = ($d, getState) => new RenderedAttributions($d, getState)
