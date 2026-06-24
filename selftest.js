// Bare/Pear runtime de-risk. Run: `pear run ./selftest.js`
// Proves, under the ACTUAL bare runtime (not Node): bare specifiers resolve through the symlinked
// node_modules; b4a + trac-wallet's static ed25519 verify work; the contract/protocol/feature modules
// load; and bare-http1 serves a localhost round-trip (the control-endpoint transport). Exits 0 on pass.
import b4a from 'b4a';
import fs from 'fs';
import http from 'bare-http1';
import { Wallet } from 'trac-peer';
import EvidenceContract from './contract.js';
import EvidenceProtocol from './protocol.js';
import { EvidenceFeature } from './evidence-feature.js';

const OUT = '/tmp/tk-peer-selftest.out';
const lines = [];
const exit = (code) => { try { fs.writeFileSync(OUT, lines.join('\n') + `\nEXIT ${code}\n`); } catch {} if (typeof Bare !== 'undefined' && Bare.exit) Bare.exit(code); else if (typeof process !== 'undefined') process.exit(code); };
let fails = 0;
const ok = (c, label) => { const l = `  ${c ? 'PASS' : 'FAIL'}  ${label}`; console.log(l); lines.push(l); if (!c) fails++; };

console.log('== sauce-evidence-peer bare/Pear selftest ==');
ok(typeof b4a.from === 'function' && typeof b4a.byteLength === 'function', 'b4a resolves (from/byteLength)');
ok(typeof Wallet === 'function' && typeof Wallet.verify === 'function', "trac-peer 'Wallet' + static verify resolve");
ok(typeof EvidenceContract === 'function' && typeof EvidenceProtocol === 'function' && typeof EvidenceFeature === 'function', 'contract/protocol/feature modules load under bare');

// the admin-gate primitive, with the contract's exact call shape (b4a buffers, never global Buffer).
const w = new Wallet(); await w.ready; if (!w.secretKey) await w.generateKeyPair(); await w.ready;
const msg = b4a.from('{"type":"submission","packId":"p"}', 'utf8');
const sig = w.sign(msg);
const good = Wallet.verify(b4a.from(sig, 'hex'), msg, b4a.from(w.publicKey, 'hex'));
const bad = Wallet.verify(b4a.from(sig, 'hex'), b4a.from('tampered', 'utf8'), b4a.from(w.publicKey, 'hex'));
ok(good === true && bad === false, `Wallet.verify gate: valid→true, tampered→false (got ${good}/${bad})`);

// bare-http1 localhost round-trip (the control transport the Node engine fetches).
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: req.url })); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const body = await new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b));
  });
  r.on('error', reject); r.end();
});
let parsed = null; try { parsed = JSON.parse(body); } catch {}
ok(parsed && parsed.ok === true && parsed.path === '/health', `bare-http1 localhost round-trip (port ${port}) → ${body}`);
server.close();

const summary = fails === 0 ? '\nSELFTEST OK — bare runtime + contract + bare-http1 all green' : `\nSELFTEST FAILED — ${fails} check(s)`;
console.log(summary); lines.push(summary);
exit(fails === 0 ? 0 : 1);
