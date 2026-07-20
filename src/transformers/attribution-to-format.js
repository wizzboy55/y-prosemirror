/**
 * # `movedAttributionToFormat` — lib0's `attributionToFormat` with move-aware reverse
 *
 * Data → view (`applyA`): identical to lib0's `attributionToFormat` — the
 * delta's attribution dimension renders into the reserved `y-attributed-*`
 * format keys (delegated to a lib0 transformer instance).
 *
 * View → data (`applyB`): lib0's reverse is a pure strip ("the view never
 * attributes"). That is right for instructions and for freshly inserted
 * content — but it is exactly what flattened *moved* pending suggestions into
 * base content (upstream #245): a view-mode split/join re-inserts suggestion
 * content whose `y-attributed-insert` marks the correction deliberately kept
 * (see `buildAttributionCorrection` move detection), and a bare strip turns
 * that into a plain base write. This reverse therefore **converts** a
 * `y-attributed-insert` format on *data* ops (text / insert, recursively
 * through inserted subtrees) into delta `attribution` (`{ insert: userIds }`)
 * before stripping the rest of the namespace. The attribution dimension
 * passes through the data side untouched by any strip, so `YSyncRdt` can
 * route those ops back into the suggestion overlay
 * ({@link module:sync-utils splitMovedInsertions}).
 *
 * Instruction ops (retain / modify formats) are still stripped wholesale —
 * user edits to the projection remain read-only.
 *
 * @module transformers/attribution-to-format
 */

import * as delta from 'lib0/delta'
import * as dt from 'lib0/delta/transformer'
import { Transformer, Template, createTransformResult } from 'lib0/delta/transformer'

const Y_PREFIX = 'y-attributed-'
const Y_INSERT_KEY = 'y-attributed-insert'

/**
 * Remove every reserved `y-attributed-*` key from a format. Mirrors lib0's
 * `stripY`: input returned verbatim when nothing was stripped, `undefined`
 * when stripping emptied it.
 *
 * @param {{[k:string]:any}|null|undefined} format
 * @return {{[k:string]:any}|null|undefined}
 */
const stripY = (format) => {
  if (format == null) return format
  /** @type {{[k:string]:any}} */
  const r = {}
  let stripped = false
  for (const k in format) {
    if (k.startsWith(Y_PREFIX)) stripped = true
    else r[k] = format[k]
  }
  return stripped ? (Object.keys(r).length === 0 ? undefined : r) : format
}

/**
 * The attribution for a data op whose format carries `y-attributed-insert` —
 * a moved pending suggestion. Authorship comes from the mark's `userIds`
 * (default mapper shape; a custom mapper without `userIds` yields `[]`, and
 * the renderer re-attributes on render anyway).
 *
 * @param {{[k:string]:any}|null|undefined} format
 * @return {import('lib0/delta').Attribution | null}
 */
const movedAttribution = (format) => {
  const v = format?.[Y_INSERT_KEY]
  if (v == null) return null
  return { insert: Array.isArray(v.userIds) ? v.userIds : [] }
}

/**
 * The move-aware reverse walk: convert `y-attributed-insert` on data ops to
 * attribution, strip the rest of the namespace, recurse through nested
 * deltas. Preserves each op's existing attribution (there is none coming
 * from the view today, but the builder API keeps it explicit).
 *
 * @param {delta.DeltaAny} d
 * @return {delta.DeltaBuilderAny}
 */
const reverse = (d) => {
  const out = /** @type {any} */ (delta.cloneShallow(d))
  for (const op of d.children) {
    if (delta.$textOp.check(op)) {
      const attribution = movedAttribution(op.format)
      out.insert(op.insert, stripY(op.format), attribution ?? /** @type {any} */ (op).attribution ?? undefined)
    } else if (delta.$insertOp.check(op)) {
      const attribution = movedAttribution(op.format)
      for (const el of op.insert) {
        out.insert(
          [delta.$deltaAny.check(el) ? reverse(el).done(false) : el],
          stripY(op.format),
          attribution ?? /** @type {any} */ (op).attribution ?? undefined
        )
      }
    } else if (delta.$retainOp.check(op)) {
      out.retain(op.retain, stripY(op.format))
    } else if (delta.$deleteOp.check(op)) {
      out.delete(op.delete)
    } else { // $modifyOp
      out.modify(reverse(op.value).done(false), stripY(op.format))
    }
  }
  return out
}

/**
 * @extends {Transformer<any,any>}
 */
export class MovedAttributionToFormatTransformer extends Transformer {
  /**
   * @param {import('lib0/schema').Schema<delta.Delta<any>>} $in
   * @param {import('lib0/schema').Schema<delta.Delta<any>>} $out
   * @param {import('../sync-utils.js').AttributionConf} conf
   */
  constructor ($in, $out, conf) {
    super($in, $out)
    /** forward (data→view) direction delegates to lib0's transformer */
    this._inner = dt.attributionToFormat(/** @type {any} */ ($in), conf).init()
  }

  /**
   * @param {delta.DeltaBuilderAny} d
   * @return {import('lib0/delta/transformer').TransformResultAny}
   */
  applyA (d) {
    return this._inner.applyA(d)
  }

  /**
   * @param {delta.DeltaBuilderAny} d
   * @return {import('lib0/delta/transformer').TransformResultAny}
   */
  applyB (d) {
    const out = reverse(d)
    out.done(false)
    return createTransformResult(out, null)
  }
}

/**
 * @template {delta.DeltaConf} [IN=any]
 * @extends {Template<IN, any>}
 */
export class MovedAttributionToFormat extends Template {
  /**
   * @param {import('lib0/schema').Schema<delta.Delta<IN>>} $d
   * @param {import('../sync-utils.js').AttributionConf} conf
   */
  constructor ($d, conf) {
    // reuse lib0's output-schema computation by instantiating its template
    super($d, /** @type {any} */ (dt.attributionToFormat(/** @type {any} */ ($d), conf).$out))
    this.conf = conf
  }

  get name () { return 'y-prosemirror:movedAttributionToFormat' }

  /**
   * @return {Transformer<IN, any>}
   */
  init () {
    return new MovedAttributionToFormatTransformer(this.$in, this.$out, this.conf)
  }
}

/**
 * lib0's `attributionToFormat` with the move-aware reverse — see the
 * {@link module:transformers/attribution-to-format module doc}.
 *
 * @template {delta.DeltaConf} IN
 * @param {import('lib0/schema').Schema<delta.Delta<IN>>} $d
 * @param {import('../sync-utils.js').AttributionConf} conf
 * @return {MovedAttributionToFormat<IN>}
 */
export const movedAttributionToFormat = ($d, conf) => new MovedAttributionToFormat($d, conf)
