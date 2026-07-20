/**
 * v13 → v14 document migration tests (upstream issue #260).
 *
 * These build documents with the REAL Yjs v13 (`yjs13` npm alias) exactly the
 * way old y-prosemirror stored them — `Y.XmlFragment > Y.XmlElement >
 * Y.XmlText` with formatting attributes and inline `XmlElement` siblings —
 * encode them to the binary update format, decode them with `@y/y` v14, and
 * verify migration into the new binding's representation.
 */

import * as Y13 from 'yjs13'
import * as Y from '@y/y'
import * as t from 'lib0/testing'
import { legacyFragmentToDelta, migrateLegacyDoc, needsLegacyMigration } from '@y/prosemirror'
import { schema } from './complexSchema.js'
import { createPMView } from './cohort.js'

/**
 * A legacy doc shaped the way old y-prosemirror wrote documents:
 *
 *   <p>Hello <strong>world</strong></p>
 *   <h2>Title</h2>
 *   <blockquote><p><em>quoted</em> plain<img/></p></blockquote>
 *   <p></p>
 *
 * @return {Uint8Array} the v13 binary update
 */
const buildLegacyUpdate = () => {
  const d13 = new Y13.Doc()
  const frag = d13.getXmlFragment('prosemirror')

  const p1 = new Y13.XmlElement('paragraph')
  const t1 = new Y13.XmlText()
  t1.insert(0, 'Hello ')
  t1.insert(6, 'world', { strong: {} })
  p1.insert(0, [t1])

  const h1 = new Y13.XmlElement('heading')
  h1.setAttribute('level', /** @type {any} */ (2))
  const ht = new Y13.XmlText()
  ht.insert(0, 'Title')
  h1.insert(0, [ht])

  const bq = new Y13.XmlElement('blockquote')
  const bqp = new Y13.XmlElement('paragraph')
  const bqt = new Y13.XmlText()
  bqt.insert(0, 'quoted', { em: {} })
  // explicit {} — a v13 insert without attributes inherits the formatting at
  // the insertion position (old y-prosemirror always passed explicit attrs)
  bqt.insert(6, ' plain', {})
  const img = new Y13.XmlElement('image')
  img.setAttribute('src', /** @type {any} */ ('test.png'))
  bqp.insert(0, [bqt, img])
  bq.insert(0, [bqp])

  const emptyP = new Y13.XmlElement('paragraph')

  frag.insert(0, [p1, h1, bq, emptyP])
  return Y13.encodeStateAsUpdate(d13)
}

/**
 * @param {Uint8Array} update
 * @return {Y.Doc}
 */
const loadInV14 = (update) => {
  const doc = new Y.Doc({ gc: false })
  Y.applyUpdate(doc, update)
  return doc
}

/** The PM doc JSON the legacy content must render as after migration. */
const expectedPmJSON = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world', marks: [{ type: 'strong' }] }
      ]
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'blockquote',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'quoted', marks: [{ type: 'em' }] },
          { type: 'text', text: ' plain' },
          { type: 'image', attrs: { src: 'test.png', alt: null, title: null } }
        ]
      }]
    },
    { type: 'paragraph' }
  ]
}

/**
 * Detection: a decoded v13 doc needs migration, a migrated (or natively new)
 * doc does not.
 */
export const testMigrationDetection = () => {
  const legacy = loadInV14(buildLegacyUpdate())
  t.assert(needsLegacyMigration(legacy.get('prosemirror')), 'v13 doc is detected as legacy')
  const migrated = migrateLegacyDoc(legacy)
  t.assert(!needsLegacyMigration(migrated.get('prosemirror')), 'migrated doc is not legacy')

  const native = new Y.Doc({ gc: false })
  const view = createPMView(native.get('prosemirror'))
  view.dispatch(view.state.tr.insert(0, schema.nodes.paragraph.create(null, schema.text('fresh content'))))
  t.assert(!needsLegacyMigration(native.get('prosemirror')), 'natively-written v14 doc is not legacy')
  view.destroy()
}

/**
 * Full migration: the migrated document renders in ProseMirror exactly as the
 * legacy content, structure/marks/attrs preserved, text inlined.
 */
export const testMigrationRendersInProsemirror = () => {
  const legacy = loadInV14(buildLegacyUpdate())
  const migrated = migrateLegacyDoc(legacy)
  const view = createPMView(migrated.get('prosemirror'))
  t.compare(
    JSON.parse(JSON.stringify(view.state.doc.toJSON())),
    expectedPmJSON,
    'migrated doc renders the legacy content'
  )
  view.destroy()
}

/**
 * The migrated document is fully editable through the binding: an edit
 * dispatched to the view lands in the migrated ydoc and renders back.
 */
export const testMigratedDocIsEditable = () => {
  const migrated = migrateLegacyDoc(loadInV14(buildLegacyUpdate()))
  const view = createPMView(migrated.get('prosemirror'))
  view.dispatch(view.state.tr.insertText('!!', 7))
  t.assert(
    view.state.doc.textContent.startsWith('Hello !!world'),
    'edit applied to the migrated doc'
  )
  // and the edit is in the Y document (visible to a second, fresh view)
  const view2 = createPMView(migrated.get('prosemirror'))
  t.compare(
    JSON.parse(JSON.stringify(view2.state.doc.toJSON())),
    JSON.parse(JSON.stringify(view.state.doc.toJSON())),
    'second view over the migrated ydoc sees the edit'
  )
  view.destroy()
  view2.destroy()
}

/**
 * `legacyFragmentToDelta` is pure: converting does not mutate the source doc.
 */
export const testMigrationIsNonDestructive = () => {
  const legacy = loadInV14(buildLegacyUpdate())
  const before = JSON.stringify(legacy.get('prosemirror').toDelta({ deep: true }).toJSON())
  legacyFragmentToDelta(legacy.get('prosemirror'))
  const after = JSON.stringify(legacy.get('prosemirror').toDelta({ deep: true }).toJSON())
  t.assert(before === after, 'source document unchanged by conversion')
}

/**
 * Migrating a document that is already in the new format is the identity
 * (content-wise) — safe to run unconditionally.
 */
export const testMigrationIdentityOnNewFormat = () => {
  const native = new Y.Doc({ gc: false })
  const view = createPMView(native.get('prosemirror'))
  view.dispatch(view.state.tr.insert(0, schema.nodes.paragraph.create(null, schema.text('already new'))))
  const migrated = migrateLegacyDoc(native)
  const view2 = createPMView(migrated.get('prosemirror'))
  t.compare(
    JSON.parse(JSON.stringify(view2.state.doc.toJSON())),
    JSON.parse(JSON.stringify(view.state.doc.toJSON())),
    'new-format doc migrates to identical content'
  )
  view.destroy()
  view2.destroy()
}
