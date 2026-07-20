/**
 * Tests for the v1-compat conversion helpers (src/v1-compat.js).
 */
import * as Y from '@y/y'
import * as t from 'lib0/testing'
import { initProseMirrorDoc, prosemirrorToYXmlFragment, updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@y/prosemirror'
import { schema } from './complexSchema.js'

const pmDoc = (/** @type {string[]} */ texts) =>
  schema.node('doc', null, texts.map(text => schema.node('paragraph', null, [schema.text(text)])))

export const testV1CompatRoundtrip = () => {
  const ydoc = new Y.Doc({ gc: false })
  const fragment = ydoc.get('prosemirror')
  prosemirrorToYXmlFragment(pmDoc(['hello', 'world']), fragment)
  const back = yXmlFragmentToProseMirrorRootNode(fragment, schema)
  t.compare(JSON.parse(JSON.stringify(back.toJSON())), JSON.parse(JSON.stringify(pmDoc(['hello', 'world']).toJSON())),
    'prosemirrorToYXmlFragment/yXmlFragmentToProseMirrorRootNode round-trip')
  const { doc, mapping } = initProseMirrorDoc(fragment, schema)
  t.compare(JSON.parse(JSON.stringify(doc.toJSON())), JSON.parse(JSON.stringify(back.toJSON())), 'initProseMirrorDoc doc matches')
  t.assert(mapping instanceof Map, 'mapping placeholder returned')
}

export const testV1CompatUpdateYFragment = () => {
  const ydoc = new Y.Doc({ gc: false })
  const fragment = ydoc.get('prosemirror')
  prosemirrorToYXmlFragment(pmDoc(['hello', 'world']), fragment)
  updateYFragment(ydoc, fragment, pmDoc(['hello brave', 'world']))
  const back = yXmlFragmentToProseMirrorRootNode(fragment, schema)
  t.compare(JSON.parse(JSON.stringify(back.toJSON())), JSON.parse(JSON.stringify(pmDoc(['hello brave', 'world']).toJSON())),
    'updateYFragment applies the diff')
  // no-op update leaves the doc untouched
  const before = JSON.stringify(fragment.toDelta({ deep: true }).toJSON())
  updateYFragment(ydoc, fragment, pmDoc(['hello brave', 'world']))
  t.assert(JSON.stringify(fragment.toDelta({ deep: true }).toJSON()) === before, 'no-op update is a no-op')
}
