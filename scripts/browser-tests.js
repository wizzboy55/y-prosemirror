/**
 * Run the test suite in a real Chromium via playwright-core.
 *
 * Serves the repo root over a local HTTP server, opens `test.html` (which
 * loads the rollup test bundle `dist/test.js`), streams the page console to
 * stdout, and exits with the suite's success/failure. The page signals
 * completion by setting `globalThis.__ypmTestResult` (see tests/index.js).
 *
 * Chromium resolution order:
 *   1. `YPM_CHROMIUM` env var (explicit executable path)
 *   2. playwright-core's own registry (works after `npx playwright-core install chromium`)
 *   3. `${PLAYWRIGHT_BROWSERS_PATH}/chromium` symlink (preprovisioned environments)
 */

import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright-core'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.map': 'application/json',
  '.json': 'application/json',
  '.css': 'text/css'
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0]
  const file = path.normalize(path.join(root, urlPath === '/' ? '/test.html' : urlPath))
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

const resolveChromium = () => {
  if (process.env.YPM_CHROMIUM) return process.env.YPM_CHROMIUM
  try {
    const p = chromium.executablePath()
    if (p && fs.existsSync(p)) return p
  } catch (_) { /* registry has no matching revision installed */ }
  const preprovisioned = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH || '', 'chromium')
  if (preprovisioned !== 'chromium' && fs.existsSync(preprovisioned)) return preprovisioned
  return null
}

const main = async () => {
  const executablePath = resolveChromium()
  if (executablePath == null) {
    console.error('[browser-tests] no Chromium found. Run `npx playwright-core install chromium` or set YPM_CHROMIUM.')
    process.exit(2)
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('net').AddressInfo} */ (server.address())
  const browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage()
  page.on('console', msg => console.log(msg.text()))
  page.on('pageerror', err => console.error('[pageerror]', err.message))
  let success = false
  try {
    await page.goto(`http://127.0.0.1:${address.port}/test.html`, { waitUntil: 'load' })
    await page.waitForFunction('globalThis.__ypmTestResult !== undefined', null, { timeout: 300_000 })
    success = await page.evaluate('globalThis.__ypmTestResult === true')
  } catch (err) {
    console.error('[browser-tests]', /** @type {Error} */ (err).message)
  } finally {
    await browser.close()
    server.close()
  }
  console.log(`[browser-tests] ${success ? 'PASS' : 'FAIL'} (chromium: ${executablePath})`)
  process.exit(success ? 0 : 1)
}

main()
