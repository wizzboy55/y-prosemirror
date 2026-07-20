/**
 * Multi-peer convergence fuzz.
 *
 * Complements suggestion-simulation.test.js (which drives one shared base
 * doc through renderer bridges) with a *network-shaped* topology: every peer
 * owns its own `Y.Doc` bound to its own PM view, edits offline, and exchanges
 * updates only at randomized sync points. This exercises real CRDT merge
 * behavior — concurrent edits, out-of-order delivery, long-offline peers —
 * plus the structural ops (join, wrap, lift, node-attr changes) the
 * suggestion sim does not cover.
 *
 * Invariant: after every peer has synced with every other (to quiescence),
 * all PM views and all Y docs must converge to the same document.
 */

import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import * as prng from 'lib0/prng'
import * as t from 'lib0/testing'
import { findWrapping } from 'prosemirror-transform'
import { schema } from './complexSchema.js'
import { createPMView, normalizeDoc, stableStringify } from './cohort.js'

/** @typedef {import('lib0/testing').TestCase} TestCase */

/**
 * @typedef {object} Peer
 * @property {number} idx
 * @property {Y.Doc} ydoc
 * @property {import('prosemirror-view').EditorView} view
 */

/**
 * @param {number} n number of peers
 * @return {Array<Peer>}
 */
const createPeers = (n) => {
  /** @type {Array<Peer>} */
  const peers = []
  for (let i = 0; i < n; i++) {
    const ydoc = new Y.Doc({ gc: false, guid: `peer-${i}` })
    ydoc.clientID = i + 1
    peers.push({ idx: i, ydoc, view: createPMView(ydoc.get('prosemirror')) })
  }
  return peers
}

/**
 * One bidirectional state-vector sync between two peers ("they meet").
 *
 * @param {Peer} a
 * @param {Peer} b
 */
const syncPair = (a, b) => {
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)))
  Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)))
}

/**
 * Sync every pair until no peer learns anything new (quiescence). Two full
 * mesh rounds always suffice for state-vector sync, a third is a cheap guard.
 *
 * @param {Array<Peer>} peers
 */
const syncAll = (peers) => {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        syncPair(peers[i], peers[j])
      }
    }
  }
}

// === Random op pickers ===
// Every op dispatch is wrapped in try/catch: random positions regularly
// produce schema-invalid transactions and PM throws — the fuzz tolerates
// skipped iterations, mirroring suggestion-simulation.test.js.

/**
 * @param {prng.PRNG} gen
 * @param {number} maxLen
 */
const randomWord = (gen, maxLen = 5) => {
  let s = ''
  const n = prng.int32(gen, 1, maxLen)
  for (let i = 0; i < n; i++) s += prng.letter(gen)
  return s
}

/**
 * @param {import('prosemirror-model').Node} doc
 * @param {prng.PRNG} gen
 */
const randomPos = (doc, gen) => {
  const size = doc.content.size
  if (size <= 1) return null
  return prng.int32(gen, 1, size - 1)
}

/**
 * @param {import('prosemirror-model').Node} doc
 * @param {prng.PRNG} gen
 */
const randomRange = (doc, gen) => {
  const size = doc.content.size
  if (size <= 2) return null
  let from = prng.int32(gen, 1, size - 1)
  let to = prng.int32(gen, 1, size - 1)
  if (from > to) [from, to] = [to, from]
  if (from === to) to = Math.min(size - 1, from + 1)
  if (from === to) return null
  return { from, to }
}

/**
 * The PM position right before each top-level child, plus doc end.
 *
 * @param {import('prosemirror-model').Node} doc
 */
const topLevelPositions = (doc) => {
  const tops = [0]
  let acc = 0
  doc.forEach(child => {
    acc += child.nodeSize
    tops.push(acc)
  })
  return tops
}

const MARK_NAMES = ['em', 'strong', 'code']

/** @type {Array<(peer: Peer, gen: prng.PRNG) => void>} */
const OPS = [
  // insert text at a random position (inherits marks at position)
  (peer, gen) => {
    const pos = randomPos(peer.view.state.doc, gen)
    if (pos == null) return
    peer.view.dispatch(peer.view.state.tr.insertText(randomWord(gen), pos))
  },
  // delete a random range
  (peer, gen) => {
    const range = randomRange(peer.view.state.doc, gen)
    if (range == null) return
    peer.view.dispatch(peer.view.state.tr.delete(range.from, range.to))
  },
  // add a random self-excluding mark
  (peer, gen) => {
    const range = randomRange(peer.view.state.doc, gen)
    if (range == null) return
    peer.view.dispatch(peer.view.state.tr.addMark(range.from, range.to, schema.marks[prng.oneOf(gen, MARK_NAMES)].create()))
  },
  // remove a random mark type from a range
  (peer, gen) => {
    const range = randomRange(peer.view.state.doc, gen)
    if (range == null) return
    peer.view.dispatch(peer.view.state.tr.removeMark(range.from, range.to, schema.marks[prng.oneOf(gen, MARK_NAMES)]))
  },
  // split a block
  (peer, gen) => {
    const pos = randomPos(peer.view.state.doc, gen)
    if (pos == null) return
    const $pos = peer.view.state.doc.resolve(pos)
    if (!$pos.parent.isTextblock) return
    peer.view.dispatch(peer.view.state.tr.split(pos))
  },
  // join two blocks at a top-level boundary
  (peer, gen) => {
    const tops = topLevelPositions(peer.view.state.doc).filter(p => p !== 0)
    if (tops.length < 2) return
    peer.view.dispatch(peer.view.state.tr.join(prng.oneOf(gen, tops.slice(0, -1))))
  },
  // insert a fresh paragraph at a top-level position
  (peer, gen) => {
    const tops = topLevelPositions(peer.view.state.doc)
    peer.view.dispatch(peer.view.state.tr.insert(
      prng.oneOf(gen, tops),
      schema.nodes.paragraph.create(null, schema.text(randomWord(gen, 4)))
    ))
  },
  // change a top-level block's type/attrs: paragraph <-> heading, or a
  // heading's level (node-attr change — exercises the setAttr path)
  (peer, gen) => {
    const doc = peer.view.state.doc
    if (doc.childCount === 0) return
    const index = prng.int32(gen, 0, doc.childCount - 1)
    let pos = 0
    for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
    const child = doc.child(index)
    if (!child.isTextblock) return
    if (prng.bool(gen)) {
      peer.view.dispatch(peer.view.state.tr.setNodeMarkup(pos, schema.nodes.heading, { level: prng.int32(gen, 1, 3) }))
    } else {
      peer.view.dispatch(peer.view.state.tr.setNodeMarkup(pos, schema.nodes.paragraph, {}))
    }
  },
  // wrap a block range in a blockquote (ReplaceAroundStep → diff fallback)
  (peer, gen) => {
    const range = randomRange(peer.view.state.doc, gen)
    if (range == null) return
    const $from = peer.view.state.doc.resolve(range.from)
    const $to = peer.view.state.doc.resolve(range.to)
    const blockRange = $from.blockRange($to)
    if (blockRange == null) return
    const wrapping = findWrapping(blockRange, schema.nodes.blockquote)
    if (wrapping == null) return
    peer.view.dispatch(peer.view.state.tr.wrap(blockRange, wrapping))
  },
  // lift the first block out of a blockquote, when one exists
  (peer, _gen) => {
    const doc = peer.view.state.doc
    let bqPos = -1
    let acc = 0
    doc.forEach(child => {
      if (bqPos === -1 && child.type.name === 'blockquote') bqPos = acc
      acc += child.nodeSize
    })
    if (bqPos === -1) return
    const inner = doc.resolve(bqPos + 2)
    const blockRange = inner.blockRange()
    if (blockRange == null) return
    peer.view.dispatch(peer.view.state.tr.lift(blockRange, 0))
  }
]

/**
 * Drive a randomized session: peers edit locally; at random points two random
 * peers sync ("meet"); at the end everyone syncs to quiescence.
 *
 * @param {Array<Peer>} peers
 * @param {prng.PRNG} gen
 * @param {number} iterations
 * @param {number} syncProbabilityPct chance (0-100) that an iteration is a pairwise sync instead of an edit
 */
const runConvergenceSim = (peers, gen, iterations, syncProbabilityPct = 25) => {
  for (let i = 0; i < iterations; i++) {
    if (peers.length >= 2 && prng.int32(gen, 0, 99) < syncProbabilityPct) {
      const a = prng.oneOf(gen, peers)
      const b = prng.oneOf(gen, peers.filter(p => p !== a))
      syncPair(a, b)
    } else {
      const peer = prng.oneOf(gen, peers)
      const op = prng.oneOf(gen, OPS)
      try {
        op(peer, gen)
      } catch (_) { /* schema-invalid random op — skip */ }
    }
  }
  syncAll(peers)
}

/**
 * Assert every peer's PM view and Y doc converged.
 *
 * @param {Array<Peer>} peers
 * @param {string} label
 */
const assertConverged = (peers, label) => {
  // JSON round-trip: PM mark attrs are null-prototype objects, and format
  // values written locally keep that prototype inside the Y delta while
  // remotely-decoded ones are plain objects — t.compare checks constructors,
  // so normalize both sides to plain JSON first.
  const pmDocs = peers.map(p => JSON.parse(JSON.stringify(normalizeDoc(p.view.state.doc.toJSON()))))
  const yDocs = peers.map(p => JSON.parse(JSON.stringify(p.ydoc.get('prosemirror').toDelta({ deep: true }).toJSON())))
  for (let i = 1; i < peers.length; i++) {
    if (stableStringify(yDocs[i]) !== stableStringify(yDocs[0])) {
      console.log(`\n=== Y divergence (${label}) peer 0 vs peer ${i} ===`)
      console.log(JSON.stringify(yDocs[0], null, 1))
      console.log(JSON.stringify(yDocs[i], null, 1))
    }
    t.compare(yDocs[i], yDocs[0], `${label}: Y state of peer ${i} matches peer 0`)
    if (stableStringify(pmDocs[i]) !== stableStringify(pmDocs[0])) {
      console.log(`\n=== PM divergence (${label}) peer 0 vs peer ${i} ===`)
      console.log(JSON.stringify(pmDocs[0], null, 1))
      console.log(JSON.stringify(pmDocs[i], null, 1))
    }
    t.compare(pmDocs[i], pmDocs[0], `${label}: PM doc of peer ${i} matches peer 0`)
  }
}

/**
 * @param {Array<Peer>} peers
 */
const destroyPeers = (peers) => {
  peers.forEach(p => p.view.destroy())
}

/**
 * @param {Array<Peer>} peers
 * @param {string} text
 */
const seed = (peers, text) => {
  peers[0].ydoc.get('prosemirror').applyDelta(
    delta.create().insert([delta.create('paragraph', {}, text)]).done()
  )
  syncAll(peers)
}

// === Tests ===

/**
 * Sanity: seed syncs to all peers and everyone agrees.
 * @param {TestCase} _tc
 */
export const testConvergenceSetup = (_tc) => {
  const peers = createPeers(3)
  seed(peers, 'hello world')
  assertConverged(peers, 'init')
  destroyPeers(peers)
}

/**
 * Two peers make concurrent offline edits to the same paragraph, then sync:
 * both edits must survive on both sides.
 * @param {TestCase} _tc
 */
export const testConvergenceConcurrentOfflineEdits = (_tc) => {
  const peers = createPeers(2)
  seed(peers, 'hello world')
  // offline: no syncs between these edits
  peers[0].view.dispatch(peers[0].view.state.tr.insertText('AA', 1))
  peers[1].view.dispatch(peers[1].view.state.tr.insertText('ZZ', 12))
  syncAll(peers)
  assertConverged(peers, 'concurrent offline edits')
  const text = peers[0].view.state.doc.textContent
  t.assert(text.includes('AA') && text.includes('ZZ'), 'both concurrent edits survived the merge')
  destroyPeers(peers)
}

/**
 * The headline randomized run: 4 peers, mixed edits and randomized pairwise
 * syncs. "repeat" prefix → lib0/testing re-runs it with fresh seeds.
 * @param {TestCase} tc
 */
export const testRepeatConvergenceFuzz = (tc) => {
  const peers = createPeers(4)
  seed(peers, 'lorem ipsum dolor sit amet')
  runConvergenceSim(peers, tc.prng, 40)
  assertConverged(peers, `seed=${tc.seed}`)
  destroyPeers(peers)
}

/**
 * Long-offline variant: peers 0-1 collaborate while peers 2-3 edit fully
 * offline; everything merges only at the end (the risky reconnect case from
 * CAVEATS.md "Schema mismatches under concurrency").
 * @param {TestCase} tc
 */
export const testRepeatConvergenceLongOffline = (tc) => {
  const peers = createPeers(4)
  seed(peers, 'lorem ipsum dolor sit amet')
  const online = peers.slice(0, 2)
  const offline = peers.slice(2)
  runConvergenceSim(online, tc.prng, 20, 40)
  for (let i = 0; i < 20; i++) {
    const peer = prng.oneOf(tc.prng, offline)
    try {
      prng.oneOf(tc.prng, OPS)(peer, tc.prng)
    } catch (_) { /* skip */ }
  }
  syncAll(peers)
  assertConverged(peers, `long-offline seed=${tc.seed}`)
  destroyPeers(peers)
}

/**
 * Heavier run for digging: 5 peers, 120 iterations.
 * @param {TestCase} tc
 */
export const testConvergenceLongRunningFuzz = (tc) => {
  const peers = createPeers(5)
  seed(peers, 'lorem ipsum dolor sit amet')
  runConvergenceSim(peers, tc.prng, 120)
  assertConverged(peers, `long seed=${tc.seed}`)
  destroyPeers(peers)
}
