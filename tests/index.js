// import * as prosemirror from './y-prosemirror.test.js'
import * as cursor from './cursor.test.js'
import * as delta from './delta.test.js'
import * as positions from './positions.test.js'
import * as suggestions from './suggestions.test.js'
import * as suggestionSimulation from './suggestion-simulation.test.js'
import * as attributedNodes from './attributed-nodes.test.js'
import * as undo from './undo.test.js'
import * as commands from './commands.test.js'
import * as overlappingMarks from './overlapping-marks.test.js'
import * as customCompare from './custom-compare.test.js'
import * as ySyncRdt from './y-sync-rdt.test.js'
import * as issueRepros from './issue-repros.test.js'
import * as convergenceFuzz from './convergence-fuzz.test.js'
import * as indexeddb from './indexeddb.test.js'
import * as migration from './migration.test.js'
import * as schemaConflict from './schema-conflict.test.js'
// import * as tr from './tr.test.js'

import { runTests } from 'lib0/testing'
import { isBrowser, isNode } from 'lib0/environment'
import * as log from 'lib0/logging'

if (isBrowser) {
  log.createVConsole(document.body)
}
runTests({
  cursor,
  delta,
  positions,
  suggestions,
  suggestionSimulation,
  attributedNodes,
  undo,
  commands,
  overlappingMarks,
  customCompare,
  ySyncRdt,
  issueRepros,
  convergenceFuzz,
  indexeddb,
  migration,
  schemaConflict
  // prosemirror,
  // tr
}).then(success => {
  /* istanbul ignore next */
  if (isNode) {
    // @ts-ignore
    process.exit(success ? 0 : 1)
  }
  // Signal completion to the browser-test harness (scripts/browser-tests.js).
  // @ts-ignore
  globalThis.__ypmTestResult = success
})
