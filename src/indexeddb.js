/**
 * IndexedDB persistence for Yjs v14 (`@y/y`) documents — a port of
 * `y-indexeddb` (which targets the v13 `yjs` package and cannot be used
 * against `@y/y`). Import from `@wizzboy55/y-prosemirror/indexeddb`; it has
 * no dependency on the editor binding and can be used standalone.
 *
 * Semantics follow y-indexeddb:
 * - every doc update is appended to the `updates` object store
 * - on load, all stored updates are applied in one transaction, then the
 *   current state is appended (so a crash between load and first edit loses
 *   nothing) and `synced` fires
 * - when the store grows past `trimSize` entries, it is compacted to a
 *   single `encodeStateAsUpdate` snapshot (debounced by `trimDebounceMs`)
 * - a `custom` object store offers small key/value storage per document
 *
 * @module indexeddb
 */

import * as Y from '@y/y'
import * as idb from 'lib0/indexeddb'
import * as promise from 'lib0/promise'
import { ObservableV2 } from 'lib0/observable'

const customStoreName = 'custom'
const updatesStoreName = 'updates'

export const PREFERRED_TRIM_SIZE = 500

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {(store: IDBObjectStore) => void} [beforeApplyUpdatesCallback]
 * @param {(store: IDBObjectStore) => void} [afterApplyUpdatesCallback]
 * @return {Promise<IDBObjectStore>}
 */
export const fetchUpdates = (idbPersistence, beforeApplyUpdatesCallback = () => {}, afterApplyUpdatesCallback = () => {}) => {
  const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (idbPersistence.db), [updatesStoreName]) // , 'readonly')
  return idb.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(idbPersistence._dbref, false)).then(updates => {
    if (!idbPersistence._destroyed) {
      beforeApplyUpdatesCallback(updatesStore)
      Y.transact(idbPersistence.doc, () => {
        updates.forEach(val => Y.applyUpdate(idbPersistence.doc, val))
      }, idbPersistence, false)
      afterApplyUpdatesCallback(updatesStore)
    }
  })
    .then(() => idb.getLastKey(updatesStore).then(lastKey => { idbPersistence._dbref = /** @type {number} */ (lastKey) + 1 }))
    .then(() => idb.count(updatesStore).then(cnt => { idbPersistence._dbsize = cnt }))
    .then(() => updatesStore)
}

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {boolean} forceStore
 * @return {Promise<void>}
 */
export const storeState = (idbPersistence, forceStore = true) =>
  fetchUpdates(idbPersistence)
    .then(updatesStore => {
      if (forceStore || idbPersistence._dbsize >= idbPersistence._trimSize) {
        return idb.addAutoKey(updatesStore, /** @type {any} */ (Y.encodeStateAsUpdate(idbPersistence.doc)))
          .then(() => idb.del(updatesStore, idb.createIDBKeyRangeUpperBound(idbPersistence._dbref, true)))
          .then(() => idb.count(updatesStore).then(cnt => { idbPersistence._dbsize = cnt }))
      }
    })

/**
 * Delete a whole document database (all updates + custom entries).
 *
 * @param {string} name
 * @return {Promise<void>}
 */
export const clearDocument = name => idb.deleteDB(name)

/**
 * @typedef {object} IndexeddbPersistenceOpts
 * @property {number} [trimSize] compaction threshold, default {@link PREFERRED_TRIM_SIZE}
 * @property {number} [trimDebounceMs] debounce before compaction runs, default 1000
 */

/**
 * @extends {ObservableV2<{ synced: (idbPersistence: IndexeddbPersistence) => void }>}
 */
export class IndexeddbPersistence extends ObservableV2 {
  /**
   * @param {string} name database name (one per document)
   * @param {Y.Doc} doc
   * @param {IndexeddbPersistenceOpts} [opts]
   */
  constructor (name, doc, { trimSize = PREFERRED_TRIM_SIZE, trimDebounceMs = 1000 } = {}) {
    super()
    this.doc = doc
    this.name = name
    this._dbref = 0
    this._dbsize = 0
    this._destroyed = false
    this._trimSize = trimSize
    /**
     * @type {IDBDatabase | null}
     */
    this.db = null
    this.synced = false
    this._db = idb.openDB(name, db =>
      idb.createStores(db, [
        ['updates', { autoIncrement: true }],
        ['custom']
      ])
    )
    /**
     * @type {Promise<IndexeddbPersistence>}
     */
    this.whenSynced = promise.create(resolve => this.on('synced', () => resolve(this)))

    this._db.then(db => {
      this.db = db
      /**
       * @param {IDBObjectStore} updatesStore
       */
      const beforeApplyUpdatesCallback = (updatesStore) => idb.addAutoKey(updatesStore, /** @type {any} */ (Y.encodeStateAsUpdate(doc)))
      const afterApplyUpdatesCallback = () => {
        if (this._destroyed) return
        this.synced = true
        this.emit('synced', [this])
      }
      fetchUpdates(this, beforeApplyUpdatesCallback, afterApplyUpdatesCallback)
    })
    /**
     * Timeout in ms until data is merged and persisted in idb.
     */
    this._storeTimeout = trimDebounceMs
    /**
     * @type {any}
     */
    this._storeTimeoutId = null
    /**
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._storeUpdate = (update, origin) => {
      if (this.db != null && origin !== this) {
        const [updatesStore] = idb.transact(this.db, [updatesStoreName])
        idb.addAutoKey(updatesStore, /** @type {any} */ (update))
        if (++this._dbsize >= this._trimSize) {
          // debounce store call
          if (this._storeTimeoutId !== null) {
            clearTimeout(this._storeTimeoutId)
          }
          this._storeTimeoutId = setTimeout(() => {
            storeState(this, false)
            this._storeTimeoutId = null
          }, this._storeTimeout)
        }
      }
    }
    doc.on('update', /** @type {any} */ (this._storeUpdate))
    this.destroy = this.destroy.bind(this)
    doc.on('destroy', /** @type {any} */ (this.destroy))
  }

  /**
   * @return {Promise<void>}
   */
  destroy () {
    if (this._storeTimeoutId) {
      clearTimeout(this._storeTimeoutId)
    }
    this.doc.off('update', /** @type {any} */ (this._storeUpdate))
    this.doc.off('destroy', /** @type {any} */ (this.destroy))
    this._destroyed = true
    return this._db.then(db => {
      db.close()
    })
  }

  /**
   * Destroy this instance and remove all data from IndexedDB.
   *
   * @return {Promise<void>}
   */
  clearData () {
    return this.destroy().then(() => idb.deleteDB(this.name))
  }

  /**
   * @param {string | number | ArrayBuffer | Date} key
   * @return {Promise<string | number | ArrayBuffer | Date | any>}
   */
  get (key) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [customStoreName], 'readonly')
      return idb.get(custom, key)
    })
  }

  /**
   * @param {string | number | ArrayBuffer | Date} key
   * @param {string | number | ArrayBuffer | Date} value
   * @return {Promise<string | number | ArrayBuffer | Date>}
   */
  set (key, value) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [customStoreName])
      return idb.put(custom, value, key)
    })
  }

  /**
   * @param {string | number | ArrayBuffer | Date} key
   * @return {Promise<undefined>}
   */
  del (key) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [customStoreName])
      return idb.del(custom, key)
    })
  }
}
