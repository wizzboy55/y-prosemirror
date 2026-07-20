/**
 * Tests for the `@y/y`-v14 IndexedDB persistence (src/indexeddb.js).
 *
 * Under Node the suite runs against `fake-indexeddb` (registered globally in
 * tests/index.node.js); in the browser harness it runs against the real
 * IndexedDB. Every test deletes its database up front so runs stay
 * deterministic across repeated executions against a persistent origin.
 */

import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import * as promise from 'lib0/promise'
import * as t from 'lib0/testing'
import { IndexeddbPersistence, clearDocument, fetchUpdates } from '@y/prosemirror/indexeddb'

/**
 * @param {string} text
 * @return {Y.Doc}
 */
const mkDoc = (text) => {
  const doc = new Y.Doc({ gc: false })
  if (text !== '') {
    doc.get('prosemirror').applyDelta(
      delta.create().insert([delta.create('paragraph', {}, text)]).done()
    )
  }
  return doc
}

/**
 * @param {Y.Doc} doc
 * @return {any}
 */
const docJSON = (doc) => JSON.parse(JSON.stringify(doc.get('prosemirror').toDelta({ deep: true }).toJSON()))

/**
 * Persisted updates land through IndexedDB transactions that complete on the
 * event loop — yield a few macrotasks before reopening.
 */
const settle = () => promise.wait(50)

/**
 * Persist edits from one doc, then load them into a fresh doc via a second
 * persistence instance on the same database name.
 */
export const testIdbPersistRoundtrip = async () => {
  const dbName = 'ypm-idb-roundtrip'
  await clearDocument(dbName)
  const docA = mkDoc('hello')
  const pA = new IndexeddbPersistence(dbName, docA)
  await pA.whenSynced
  t.assert(pA.synced, 'persistence reports synced')
  // edit after initial sync — the update event path persists it
  docA.get('prosemirror').applyDelta(
    delta.create().retain(1).insert([delta.create('paragraph', {}, 'world')]).done()
  )
  await settle()
  await pA.destroy()

  const docB = mkDoc('')
  const pB = new IndexeddbPersistence(dbName, docB)
  await pB.whenSynced
  t.compare(docJSON(docB), docJSON(docA), 'reloaded doc equals the persisted doc')
  await pB.clearData()
  docA.destroy()
  docB.destroy()
}

/**
 * The `custom` store: set / get / del round-trip.
 */
export const testIdbCustomStore = async () => {
  const dbName = 'ypm-idb-custom'
  await clearDocument(dbName)
  const doc = mkDoc('x')
  const p = new IndexeddbPersistence(dbName, doc)
  await p.whenSynced
  await p.set('version', 7)
  t.assert(await p.get('version') === 7, 'custom value round-trips')
  await p.del('version')
  t.assert(await p.get('version') === undefined, 'deleted custom value is gone')
  await p.clearData()
  doc.destroy()
}

/**
 * Compaction: with a tiny trimSize and debounce, many small updates collapse
 * into a snapshot while preserving content.
 */
export const testIdbTrim = async () => {
  const dbName = 'ypm-idb-trim'
  await clearDocument(dbName)
  const doc = mkDoc('seed')
  const p = new IndexeddbPersistence(dbName, doc, { trimSize: 5, trimDebounceMs: 10 })
  await p.whenSynced
  for (let i = 0; i < 10; i++) {
    doc.get('prosemirror').applyDelta(
      delta.create().retain(1).insert([delta.create('paragraph', {}, `p${i}`)]).done()
    )
  }
  // let the debounced storeState run and its transactions settle
  await promise.wait(100)
  await fetchUpdates(p)
  t.assert(p._dbsize < 10, `store was compacted (size=${p._dbsize})`)
  await p.destroy()

  const doc2 = mkDoc('')
  const p2 = new IndexeddbPersistence(dbName, doc2)
  await p2.whenSynced
  t.compare(docJSON(doc2), docJSON(doc), 'content survives compaction')
  await p2.clearData()
  doc.destroy()
  doc2.destroy()
}

/**
 * clearData removes everything: a fresh load yields an empty doc.
 */
export const testIdbClearData = async () => {
  const dbName = 'ypm-idb-clear'
  await clearDocument(dbName)
  const doc = mkDoc('to be erased')
  const p = new IndexeddbPersistence(dbName, doc)
  await p.whenSynced
  await settle()
  await p.clearData()

  const doc2 = mkDoc('')
  const p2 = new IndexeddbPersistence(dbName, doc2)
  await p2.whenSynced
  t.assert(doc2.get('prosemirror').length === 0, 'database was cleared')
  await p2.clearData()
  doc.destroy()
  doc2.destroy()
}

/**
 * Two docs persisted under different names stay isolated.
 */
export const testIdbIsolation = async () => {
  const nameA = 'ypm-idb-iso-a'
  const nameB = 'ypm-idb-iso-b'
  await clearDocument(nameA)
  await clearDocument(nameB)
  const docA = mkDoc('doc a')
  const docB = mkDoc('doc b')
  const pA = new IndexeddbPersistence(nameA, docA)
  const pB = new IndexeddbPersistence(nameB, docB)
  await pA.whenSynced
  await pB.whenSynced
  await settle()
  await pA.destroy()
  await pB.destroy()
  const reA = mkDoc('')
  const reB = mkDoc('')
  const rpA = new IndexeddbPersistence(nameA, reA)
  const rpB = new IndexeddbPersistence(nameB, reB)
  await rpA.whenSynced
  await rpB.whenSynced
  t.compare(docJSON(reA), docJSON(docA), 'doc a reloads its own data')
  t.compare(docJSON(reB), docJSON(docB), 'doc b reloads its own data')
  await rpA.clearData()
  await rpB.clearData()
  docA.destroy()
  docB.destroy()
  reA.destroy()
  reB.destroy()
}
