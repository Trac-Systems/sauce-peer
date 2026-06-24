/** @typedef {import('pear-interface')} */
// Sauce EVIDENCE-LEDGER PEER — Pear/bare app (headless). Boots the MSB client + our subnet
// peer (EvidenceContract/Protocol + EvidenceFeature), becomes the single subnet admin+indexer, and serves
// a localhost control endpoint (bare-http1) the Node engine drives for ledger writes:
//   • submission  → admin-gated PAID tx (submitEvidence), costs TNK
//   • valuation/usage/earn/retraction → FREE admin Feature (oracle assertions)
//
// RUNTIME: Pear/bare. No Node. No global Buffer (b4a). No `node:` builtins — `fs`/`path`/`crypto` resolve
// to bare-node-* via package.json aliases; `bare-http1` backs the control server. Config comes from FLAGS
// (Pear does not reliably pass env), secrets from FILES. Launch examples:
//   local : pear run . --network local  --repo-root <abs> --peer-store-name tk-peer \
//                               --subnet-channel tk-subnet-v1 --control-port 61600 --smoke 1
//   mainnet: pear run . --network mainnet --repo-root <abs> --peer-store-name tk-peer-mainnet \
//                               --control-port 61700 --control-secret-file <abs> --deploy-subnet 0
//   reader : pear run . --network mainnet --peer-store-name tk-peer-reader --reader 1 \
//                               --subnet-bootstrap <admin-subnet-key-hex> --control-port 61610 [--control-host 0.0.0.0]
//            (read-only replica: syncs the subnet + serves the read API; never funds/writes; for 3rd parties)
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import http from 'bare-http1'
import PeerWallet from 'trac-wallet'
import { Peer, Wallet, createConfig as createPeerConfig, ENV as PEER_ENV } from 'trac-peer'
import { MainSettlementBus } from 'trac-msb/src/index.js'
import { createConfig as createMsbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js'
import { ensureTextCodecs } from 'trac-peer/src/textCodec.js'
import { getPearRuntime } from 'trac-peer/src/runnerArgs.js'
import { bufferToBigInt, bigIntToDecimalString } from 'trac-msb/src/utils/amountSerialization.js'
import { createMessage } from 'trac-msb/src/utils/buffer.js'
import { MSB_OPERATION_TYPE } from 'trac-peer/src/msbClient.js'
import { blake3 } from '@tracsystems/blake3/dist/wasm/blake3.js'

import EvidenceContract from './contract.js'
import EvidenceProtocol from './protocol.js'
import { EvidenceFeature } from './evidence-feature.js'

// ── flags (Pear passes args, not env) ────────────────────────────────────────────────────────────
const { storeLabel, flags } = getPearRuntime()
const flag = (name, def = undefined) => (flags[name] !== undefined && flags[name] !== true ? String(flags[name]) : (flags[name] === true ? 'true' : def))
const boolFlag = (name, def) => { const v = flags[name]; if (v === undefined) return def; return v === true || ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()) }
const trailing = (s) => (s.endsWith('/') ? s : s + '/')

const onMainnet = flag('network', 'local') === 'mainnet'
const REPO_ROOT = flag('repo-root', null)
const PEER_STORE = flag('peer-store-name', storeLabel || 'tk-peer')
const STORES = trailing(flag('stores-dir', REPO_ROOT ? `${REPO_ROOT}/local-state/trac` : 'stores'))
const SUBNET_CHANNEL = flag('subnet-channel', 'tk-subnet-v1')
const CONTROL_URL = flag('control-url', 'http://127.0.0.1:61500')
const FUND_TNK = Number.parseInt(flag('fund-tnk', '10'), 10)
const SMOKE = boolFlag('smoke', false)
const DEPLOY_SUBNET = boolFlag('deploy-subnet', true)
// Read-only replica: joins the EXISTING subnet (seeded bootstrap) to sync + serve READS only. It never
// deploys, never submits, never becomes admin/writer — so it needs no TNK. Used by the evidence explorer
// so the indexer/admin is never the API retriever.
const READ_ONLY = boolFlag('reader', false)
const CONTROL_PORT = Number.parseInt(flag('control-port', '61600'), 10)
// Control bind host. ADMIN peers are ALWAYS localhost (they expose write routes — never bind those to a
// network). A READ-ONLY reader has no write capability, so it MAY bind elsewhere (e.g. 0.0.0.0) to serve
// the read API to other machines: `--reader 1 --control-host 0.0.0.0`. Default stays localhost.
const CONTROL_HOST = READ_ONLY ? String(flag('control-host', '127.0.0.1')) : '127.0.0.1'
const CONTROL_LOCAL = CONTROL_HOST === '127.0.0.1' || CONTROL_HOST === 'localhost' || CONTROL_HOST === '::1'
const dht = flag('dht-bootstrap') ? { dhtBootstrap: flag('dht-bootstrap').split(',').map((s) => s.trim()).filter(Boolean) } : {}

// control-endpoint shared secret: read from a FILE (preferred — no leak in process args) or inline flag.
const readFileTrim = (p) => { try { return fs.readFileSync(p, 'utf8').trim() } catch { return null } }
const CONTROL_SECRET = (flag('control-secret-file') && readFileTrim(flag('control-secret-file'))) || flag('control-secret', null)
// The secret protects the WRITE routes (admin-gated submissions). A READ-ONLY reader has no write routes, so
// it needs no secret — a 3rd party runs a mainnet reader without the operator's secret. Admin peers still
// fail-closed: a mainnet admin MUST set a secret.
if (onMainnet && !READ_ONLY && !CONTROL_SECRET) throw new Error('fail-closed: --control-secret-file (or --control-secret) is REQUIRED on mainnet for an ADMIN evidence peer (readers need none)')
if (!onMainnet && !REPO_ROOT) throw new Error('--repo-root <abs path to repo> is required in local mode (to read local-state/msb/network.json)')

const log = (...a) => console.log('[peer]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// bare has no global fetch — minimal JSON HTTP client over bare-http1 (used only for the local fund call).
const httpRequestJson = (method, url, bodyObj) => new Promise((resolve, reject) => {
  const m = String(url).match(/^http:\/\/([^/:]+):(\d+)(\/.*)?$/)
  if (!m) return reject(new Error('bad control url: ' + url))
  const host = m[1], port = Number(m[2]), p = m[3] || '/'
  const payload = bodyObj != null ? JSON.stringify(bodyObj) : null
  const headers = { 'content-type': 'application/json' }
  if (payload) headers['content-length'] = b4a.byteLength(payload)
  const req = http.request({ host, port, path: p, method, headers }, (res) => {
    let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch (e) { reject(e) } })
  })
  req.on('error', reject)
  if (payload) req.write(payload)
  req.end()
})
const waitFor = async (label, fn, { tries = 60, delay = 1000 } = {}) => {
  for (let i = 0; i < tries; i++) { try { if (await fn()) return true } catch {} await sleep(delay) }
  throw new Error(`timeout waiting for: ${label}`)
}
// constant-time compare (no crypto dep): equal-length XOR-accumulate.
const constEq = (a, b) => { const ab = b4a.from(String(a ?? '')); const bb = b4a.from(String(b ?? '')); if (ab.length !== bb.length) return false; let r = 0; for (let i = 0; i < ab.length; i++) r |= ab[i] ^ bb[i]; return r === 0 }

// Keystores load HEADLESSLY with no password (vendored trac-peer/msb importFromFile has no password arg),
// so the working keystore is empty-passphrase, protected at rest by 600 + gitignore (+ the encrypted
// off-store backup for the funded admin key). Same model as the ETH operator key.
const walletPassphrase = () => b4a.alloc(0)
const ensureKeypairFile = async (keyPairPath) => {
  if (fs.existsSync(keyPairPath)) { try { fs.chmodSync(keyPairPath, 0o600); fs.chmodSync(path.dirname(keyPairPath), 0o700) } catch {} return }
  fs.mkdirSync(path.dirname(keyPairPath), { recursive: true })
  await ensureTextCodecs()
  const w = new PeerWallet()
  await w.ready
  if (!w.secretKey) await w.generateKeyPair()
  await w.ready
  w.exportToFile(keyPairPath, walletPassphrase())
  try { fs.chmodSync(keyPairPath, 0o600); fs.chmodSync(path.dirname(keyPairPath), 0o700) } catch {}
}

// ── 1) MSB config. mainnet → the REAL public Trac ledger (MSB_ENV.MAINNET defaults); local → our
//        self-hosted dev MSB from local-state/msb/network.json. ──────────────────────────────────────
let msbConfig
if (onMainnet) {
  log('target MSB: REAL Trac mainnet (MSB_ENV.MAINNET defaults)')
  msbConfig = createMsbConfig(MSB_ENV.MAINNET, { storeName: `${PEER_STORE}-msb`, storesDirectory: STORES, enableInteractiveMode: false, ...dht })
} else {
  const net = JSON.parse(fs.readFileSync(`${REPO_ROOT}/local-state/msb/network.json`, 'utf8'))
  log('target local MSB:', net.bootstrap.slice(0, 12) + '… channel', net.channel)
  msbConfig = createMsbConfig(MSB_ENV.DEVELOPMENT, { storeName: `${PEER_STORE}-msb`, storesDirectory: STORES, channel: net.channel, bootstrap: net.bootstrap, enableInteractiveMode: false, ...dht })
}

// ── 2) subnet (peer) config. First run: bootstrap=null → peer.base.key becomes the subnet bootstrap,
//        persisted so restarts rejoin the SAME subnet. ──────────────────────────────────────────────
const subnetBootstrapFile = path.join(STORES, PEER_STORE, 'subnet-bootstrap.hex')
let subnetBootstrap = null
// `--subnet-bootstrap <64-hex>` lets a peer JOIN an existing subnet explicitly (a 3rd-party reader joining
// mainnet passes the published bootstrap key — no manual file seeding). Takes precedence over the stored
// file; it is then persisted (below) so restarts rejoin the same subnet without the flag.
const subnetBootstrapFlag = String(flag('subnet-bootstrap', '') || '').trim().toLowerCase()
if (/^[0-9a-f]{64}$/.test(subnetBootstrapFlag)) {
  subnetBootstrap = subnetBootstrapFlag
} else if (fs.existsSync(subnetBootstrapFile)) {
  const hex = fs.readFileSync(subnetBootstrapFile, 'utf8').trim().toLowerCase()
  if (/^[0-9a-f]{64}$/.test(hex)) subnetBootstrap = hex
}
const peerConfig = createPeerConfig(PEER_ENV.MAINNET, {
  storesDirectory: STORES, storeName: PEER_STORE,
  bootstrap: subnetBootstrap || null, channel: SUBNET_CHANNEL,
  enableInteractiveMode: false, apiTxExposed: true, replicate: true,
  enableBackgroundTasks: true, enableUpdater: true, ...dht,
})

await ensureKeypairFile(msbConfig.keyPairPath)
await ensureKeypairFile(peerConfig.keyPairPath)

// ── 3) start MSB then peer ─────────────────────────────────────────────────────────────────────────
log('starting MSB client →', onMainnet ? 'mainnet' : 'local', '…')
const msb = new MainSettlementBus(msbConfig)
await msb.ready()

log('starting peer (subnet admin+indexer) …')
const peer = new Peer({ config: peerConfig, msb, wallet: new Wallet(), protocol: EvidenceProtocol, contract: EvidenceContract })
await peer.ready()

const subnetBootstrapHex = peer.base?.key ? b4a.toString(peer.base.key, 'hex')
  : (b4a.isBuffer(peer.config.bootstrap) ? b4a.toString(peer.config.bootstrap, 'hex') : String(peer.config.bootstrap ?? ''))
// Persist the subnet bootstrap once (admin first-run OR a reader that joined via --subnet-bootstrap), so a
// plain restart rejoins the SAME subnet with no flag. Idempotent — never overwrites an existing pin.
if (!fs.existsSync(subnetBootstrapFile)) { fs.mkdirSync(path.dirname(subnetBootstrapFile), { recursive: true }); fs.writeFileSync(subnetBootstrapFile, `${subnetBootstrapHex}\n`) }

const peerPubkey = peer.wallet.publicKey
const writerKey = peer.writerLocalKey
const peerMsbAddress = peer.msbClient.pubKeyHexToAddress(peerPubkey)
log('peer pubkey   :', peerPubkey)
log('peer writerKey:', writerKey)
log('subnet bstrap :', subnetBootstrapHex, '(channel', SUBNET_CHANNEL + ')')
log('peer MSB addr :', peerMsbAddress)

const peerBalance = async () => { const e = await peer.msbClient.getNodeEntryUnsigned(peerMsbAddress); return e?.balance ? bigIntToDecimalString(bufferToBigInt(e.balance)) : '0' }

// ── 4) fund (local) / require funded (mainnet) ──────────────────────────────────────────────────────
log('waiting for the MSB validator to connect …')
await waitFor('validator connected', async () => peer.msbClient.getConnectedValidatorsCount() > 0, { tries: 60 })
log('validator connected; current peer MSB balance =', await peerBalance())
if (READ_ONLY) {
  log('read-only replica — skipping MSB funding (never deploys/submits); will sync the subnet + serve reads.')
} else if (Number(await peerBalance()) <= 0) {
  if (onMainnet) throw new Error(`peer MSB wallet ${peerMsbAddress} holds 0 TNK on mainnet. Fund it with real TNK, then restart (it cannot deploy the subnet / pay for submissions without it).`)
  log(`requesting ${FUND_TNK} TNK from admin control endpoint ${CONTROL_URL}/fund …`)
  const j = await httpRequestJson('POST', `${CONTROL_URL}/fund`, { address: peerMsbAddress, amount: FUND_TNK })
  if (!j.ok) throw new Error('funding failed: ' + JSON.stringify(j))
  log('admin reports balance:', j.balance, '— waiting for the peer to sync the credit …')
  await waitFor('peer sees funded balance', async () => Number(await peerBalance()) > 0, { tries: 60 })
}
log('peer MSB balance =', await peerBalance(), 'TNK')

// Register the subnet on the MSB (BOOTSTRAP_DEPLOYMENT, ~0.03 TNK). Mirrors TerminalHandlers.deploySubnet.
const deploySubnet = async () => {
  const txvHex = await peer.msbClient.getTxvHex()
  const nonceHex = peer.protocol.instance.generateNonce()
  const bsHex = (b4a.isBuffer(peer.config.bootstrap) ? b4a.toString(peer.config.bootstrap, 'hex') : ('' + peer.config.bootstrap)).toLowerCase()
  const chHex = b4a.isBuffer(peer.config.channel) ? b4a.toString(peer.config.channel, 'hex') : null
  if (chHex === null) throw new Error('peer channel is not a buffer')
  const address = peer.msbClient.pubKeyHexToAddress(peer.wallet.publicKey)
  const msg = createMessage(peer.msbClient.networkId, b4a.from(txvHex, 'hex'), b4a.from(bsHex, 'hex'), b4a.from(chHex, 'hex'), b4a.from(nonceHex, 'hex'), MSB_OPERATION_TYPE.BOOTSTRAP_DEPLOYMENT)
  const txBuf = await blake3(msg)
  const txHex = b4a.toString(txBuf, 'hex')
  const is = peer.wallet.sign(txBuf)
  const payload = { type: MSB_OPERATION_TYPE.BOOTSTRAP_DEPLOYMENT, address, bdo: { tx: txHex, txv: txvHex, bs: bsHex, ic: chHex, in: nonceHex, is } }
  const ok = await peer.msbClient.broadcastBootstrapDeployment(payload)
  return { ok, tx: txHex }
}

// ── 5) become the single subnet admin + indexer (headless) ──────────────────────────────────────────
const adminEntry = await peer.base.view.get('admin')
const firstRun = !adminEntry
if (!adminEntry) {
  if (!peer.base.writable) throw new Error('peer is not the subnet bootstrap writer — cannot self-admin')
  log('/add_admin (self) …')
  await peer.base.append({ type: 'addAdmin', key: peerPubkey })
  await waitFor('admin entry set', async () => { const a = await peer.base.view.get('admin'); return a && a.value === peerPubkey })
  log('/add_indexer (self) …')
  const nonce = peer.protocol.instance.generateNonce()
  const msg = { type: 'addIndexer', key: writerKey }
  const hash = peer.wallet.sign(JSON.stringify(msg) + nonce)
  await peer.base.append({ op: 'append_writer', type: 'addIndexer', key: writerKey, value: { msg }, hash, nonce })
  await waitFor('peer is indexer', async () => { try { await peer.base.append(null) } catch {} return peer.base.isIndexer === true })
} else {
  log('admin already set:', adminEntry.value === peerPubkey ? '(self)' : adminEntry.value)
}
log('admin/indexer state → isIndexer:', peer.base.isIndexer, '| writable:', peer.base.writable)

// Subnet BOOTSTRAP_DEPLOYMENT (registers the subnet on the MSB; ~0.03 TNK, IRREVERSIBLE). Decoupled from
// firstRun + idempotent via a marker file → can be fired on a SEPARATE run (e.g. after a no-deploy connect
// check) and never double-deploys. Gate with --deploy-subnet 1.
const subnetDeployedFile = path.join(STORES, PEER_STORE, 'subnet-deployed.hex')
const subnetDeployed = fs.existsSync(subnetDeployedFile)
if (DEPLOY_SUBNET && !subnetDeployed) {
  try {
    log('/deploy_subnet → registering subnet on the MSB (IRREVERSIBLE) …')
    const d = await deploySubnet()
    if (d.ok === true) { fs.writeFileSync(subnetDeployedFile, `${d.tx}\n`); log(`subnet deployed ✅ (tx ${d.tx.slice(0, 16)}…)`) }
    else log(`deploy returned: ${JSON.stringify(d.ok)}`)
  } catch (e) { log('⚠️ deploy_subnet failed (non-fatal):', String(e?.message ?? e)) }
} else if (subnetDeployed) {
  log('subnet already deployed on the MSB (marker present) — skipping BOOTSTRAP_DEPLOYMENT')
} else {
  log('subnet NOT deployed on the MSB (--deploy-subnet 0) — paid-tx submissions require the deploy; oracle/Feature writes + reads work without it')
}

// ── 6) wire the evidence Feature (oracle writer; gated admin==self && writable) ──────────────────────
let feature = null
{
  const a = await peer.base.view.get('admin')
  if (a && a.value === peerPubkey && peer.base.writable) {
    feature = new EvidenceFeature(peer, {})
    await peer.protocol.instance.addFeature('evidence', feature)
    log('evidence Feature wired (oracle writer: valuation/usage/earn/retraction).')
  } else { log('NOT wiring evidence Feature (not admin/writable) — peer will be read-only.') }
}

// ── 6b) submission via the ADMIN-GATED PAID tx (NOT the free Feature) ────────────────────────────────
async function submitEvidencePaid(vault, packId, ver, fields, { sim = false } = {}) {
  const key = `ev/${vault}/sub/${packId}/${ver}`
  const record = { type: 'submission', schemaVersion: 1, vault, packId, ver, ts: Date.now(), ...fields }
  const canonical = peer.protocol.instance.safeJsonStringify(record)
  if (canonical === null) return { ok: false, key, error: 'failed to canonicalize record' }
  const adminSig = peer.wallet.sign(b4a.from(canonical, 'utf8')) // admin-sign the canonical record bytes
  const command = peer.protocol.instance.safeJsonStringify({ op: 'submitEvidence', key, record, adminSig })
  if (sim) {
    try { const r = await peer.protocol.instance.tx({ command }, true); const e = peer.protocol.instance.getError(r); return e !== null ? { ok: false, key, sim: true, error: e.message } : { ok: true, key, sim: true } }
    catch (e) { return { ok: false, key, sim: true, error: String(e?.message || e) } }
  }
  try { const r = await peer.protocol.instance.tx({ command }, true); const e = peer.protocol.instance.getError(r); if (e !== null) return { ok: false, key, error: 'sim rejected (not broadcast): ' + e.message } }
  catch (e) { log('submission sim preflight could not run (proceeding to broadcast):', String(e?.message || e)) }
  try {
    const res = await peer.protocol.instance.tx({ command }, false)
    const err = peer.protocol.instance.getError(res)
    if (err !== null) return { ok: false, key, error: err.message }
    const tx = (res && typeof res === 'object' && res.txo && res.txo.tx) ? res.txo.tx : null
    try { await peer.base.append(null) } catch {}
    return { ok: true, key, tx }
  } catch (e) { return { ok: false, key, error: String(e?.message || e) } }
}

// ── 7) write→read round-trip smoke (paid-tx submission) ──────────────────────────────────────────────
if (SMOKE && feature) {
  const key = `ev/crypto/sub/pack-phase1/1`
  if (null === await peer.protocol.instance.getSigned(key)) {
    log('SMOKE: paid-tx Submission (admin-gated) at', key, '…')
    const w = await submitEvidencePaid('crypto', 'pack-phase1', '1', { contentHash: 'h:' + 'ab'.repeat(16), merkleRoot: 'r:' + 'cd'.repeat(16), ownerKeyHash: 'o:' + 'ef'.repeat(16), okfVersion: '0.1', license: 'CC-BY-4.0' })
    log('SMOKE: submission broadcast →', JSON.stringify(w))
    if (w.ok) { await waitFor('unconfirmed write visible', async () => (await peer.protocol.instance.get(key)) !== null); await waitFor('confirmed write (getSigned)', async () => { try { await peer.base.append(null) } catch {} return (await peer.protocol.instance.getSigned(key)) !== null }) }
  }
  const confirmed = await peer.protocol.instance.getSigned(key)
  const ok = confirmed && confirmed.type === 'submission' && confirmed.packId === 'pack-phase1' && confirmed.vault === 'crypto'
  log(`SMOKE: ${ok ? '✅' : '❌'} paid-tx submission round-trip ${ok ? 'OK' : 'FAILED'} → ${JSON.stringify(confirmed)}`)
}

// ── 7b) evidence control endpoint (bare-http1, localhost) — the Node engine drives ledger writes here ─
function startEvidenceControl() {
  const PROD = onMainnet
  // When bound to localhost (the default, and ALWAYS for admin peers) require a localhost Host header. When a
  // reader is DELIBERATELY exposed off-localhost (--control-host), accept any Host — it serves reads only.
  const hostOk = (req) => { if (!CONTROL_LOCAL) return true; const host = String(req.headers.host || '').toLowerCase().split(':')[0]; return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' }
  const writeAuthed = (req) => { if (!CONTROL_SECRET) return true; const presented = req.headers['x-control-secret'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); return constEq(presented, CONTROL_SECRET) }
  const parseUrl = (u) => { const [p, qs = ''] = String(u || '/').split('?'); const params = {}; for (const kv of qs.split('&')) { if (!kv) continue; const i = kv.indexOf('='); const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i)); params[k] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1)) } return { pathname: p, params } }
  const readJson = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy() }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve(null) } }) })
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname, params } = parseUrl(req.url)
      if (!hostOk(req)) return send(res, 403, { ok: false, error: 'forbidden host' })
      if (req.method === 'POST' && pathname.startsWith('/evidence/') && !writeAuthed(req)) return send(res, 401, { ok: false, error: 'unauthorized control request' })
      if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true, admin: !!feature, network: onMainnet ? 'mainnet' : 'local', authRequired: !!CONTROL_SECRET })
      if (req.method === 'GET' && pathname === '/evidence/get') { const rec = await peer.protocol.instance.getSigned(params.key || ''); return send(res, 200, { ok: true, record: rec }) }
      // Iterate the confirmed ledger (read-only). Goes through the protocol read API (extendApi → listEvidence)
      // — no raw hyperbee access here. Paginate with ?after=<cursor from the previous page>; ?values=true
      // returns full records; ?reverse=true walks newest-key-first. Works on a read-only reader replica.
      if (req.method === 'GET' && pathname === '/evidence/list') {
        const out = await peer.protocol.instance.listEvidence({
          prefix: params.prefix || 'ev/',
          after: params.after || null,
          limit: Number.parseInt(params.limit || '1000', 10),
          values: params.values === 'true' || params.values === '1',
          reverse: params.reverse === 'true' || params.reverse === '1',
        })
        return send(res, 200, { ok: true, ...out })
      }
      // submission = ADMIN-GATED PAID tx (body.sim=true → preflight, no spend).
      if (req.method === 'POST' && pathname === '/evidence/submission') {
        if (!feature) return send(res, 503, { ok: false, error: 'peer is read-only (not admin)' })
        const body = await readJson(req)
        if (!body || !body.vault || !body.packId || !body.ver) return send(res, 400, { ok: false, error: 'vault, packId, ver required' })
        const r = await submitEvidencePaid(body.vault, body.packId, body.ver, body.fields || {}, { sim: body.sim === true })
        if (!r.ok) return send(res, 502, { ok: false, error: r.error, key: r.key })
        return send(res, 200, { ok: true, key: r.key, paid: true, sim: r.sim === true, tx: r.tx })
      }
      // oracle assertions = FREE admin Feature.
      if (req.method === 'POST' && (pathname === '/evidence/valuation' || pathname === '/evidence/retraction')) {
        if (!feature) return send(res, 503, { ok: false, error: 'peer is read-only (not admin)' })
        const body = await readJson(req)
        if (!body || !body.vault || !body.packId || !body.ver) return send(res, 400, { ok: false, error: 'vault, packId, ver required' })
        const kind = pathname.endsWith('retraction') ? 'retraction' : 'valuation'
        const key = await feature[kind](body.vault, body.packId, body.ver, body.fields || {})
        try { await peer.base.append(null) } catch {}
        return send(res, 200, { ok: true, key })
      }
      if (req.method === 'POST' && (pathname === '/evidence/usage' || pathname === '/evidence/earn')) {
        if (!feature) return send(res, 503, { ok: false, error: 'peer is read-only (not admin)' })
        const body = await readJson(req)
        if (!body || !body.vault || body.epoch == null) return send(res, 400, { ok: false, error: 'vault, epoch required' })
        const kind = pathname.endsWith('usage') ? 'usageRoot' : 'earnRoot'
        const key = await feature[kind](body.vault, body.epoch, body.fields || {})
        try { await peer.base.append(null) } catch {}
        return send(res, 200, { ok: true, key })
      }
      return send(res, 404, { ok: false, error: 'not found' })
    } catch (e) { return send(res, 500, { ok: false, error: String(e?.message || e) }) }
  })
  server.listen(CONTROL_PORT, CONTROL_HOST, () => log(`evidence control endpoint on http://${CONTROL_HOST}:${CONTROL_PORT} (admin=${!!feature}, reader=${READ_ONLY}, authRequired=${!!CONTROL_SECRET}, reads=${READ_ONLY || !CONTROL_LOCAL ? 'open' : 'localhost'})`))
  return server
}

// ── 8) stay alive (headless service) ────────────────────────────────────────────────────────────────
const control = startEvidenceControl()
log('staying alive — evidence peer up (admin+indexer).')
const close = async () => { log('closing…'); try { control.close() } catch {} try { await peer.close?.() } catch {} try { await msb.close() } catch {}; if (typeof Bare !== 'undefined' && Bare.exit) Bare.exit(0) }
if (typeof Pear !== 'undefined' && Pear.teardown) Pear.teardown(close)
await new Promise(() => {}) // never resolve — keep the peer running
