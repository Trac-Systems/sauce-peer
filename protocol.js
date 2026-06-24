// Evidence-ledger protocol. Pairs with contract.js. The one transaction command it maps is
// `submitEvidence`: the admin-gated paid submission write, where the contract verifies the admin signature
// carried in the value. Everything else returns null. The oracle writes (valuation, usage, earn,
// retraction) go through the admin-signed `evidence_feature` path, off the transaction rail. Reads are free
// via the protocol API (extendApi: getEvidence / listEvidence) and the `/get` + `/list` console commands;
// the peer's HTTP control endpoint re-exposes them, so code outside the Pear/bare process (a Node app, curl,
// a reader) can iterate and retrieve ledger data over HTTP.
//
// Runtime: this runs in the contract engine under Pear/bare, so it stays deterministic and bare-safe (no
// node: builtins, no global Buffer; use b4a). Imports resolve through the Pear app's deps ('trac-peer').
import { Protocol } from 'trac-peer';
import b4a from 'b4a';

// Exclusive upper bound for a key PREFIX scan: bump the last byte ('ev/' → 'ev0'). Empty prefix → no bound.
function prefixUpperBound(prefix) {
  const p = String(prefix || '');
  if (!p.length) return undefined;
  return p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
}
const asStr = (k) => (typeof k === 'string' ? k : b4a.toString(k));

class EvidenceProtocol extends Protocol {
  constructor(peer, base, options = {}) {
    super(peer, base, options);
  }

  // Read API surfaced to the operator/engine AND, via the HTTP control endpoint, to 3rd-party readers.
  // getEvidence = confirmed (indexer-signed) single record; listEvidence = iterate a key range of the
  // confirmed ledger with prefix filter + pagination. All free, read-only, no MSB tx, no admin needed.
  async extendApi() {
    const _this = this;
    this.api.getEvidence = async function (key) { return await _this.getSigned(key); };
    this.api.getEvidenceUnconfirmed = async function (key) { return await _this.get(key); };
    this.api.listEvidence = async function (opts) { return await _this.listEvidence(opts); };
  }

  /**
   * Iterate the CONFIRMED (indexer-signed) ledger view over a key range — the read primitive 3rd parties
   * need, so they never have to reach into hypercore/hyperbee directly. Reads the same signed snapshot as
   * getSigned (so a key listed here is fetchable+verifiable via getEvidence). Read-only; works on a
   * read-only reader replica (the indexer/admin is never the retriever).
   *
   * @param {{prefix?:string, after?:string|null, limit?:number, values?:boolean, reverse?:boolean}} opts
   *   prefix  — key prefix to scan (default 'ev/' = all evidence; e.g. 'ev/crypto/sub/' = crypto submissions)
   *   after   — pagination cursor: continue STRICTLY AFTER this key (pass the previous page's `cursor`)
   *   limit   — page size (1..5000, default 1000)
   *   values  — true → include the full record value per row; false (default) → {key, type, ts} only
   *   reverse — iterate newest-key-first within the range
   * @returns {Promise<{records:Array, count:number, cursor:string|null}>} cursor=null when the page is the last
   */
  async listEvidence({ prefix = 'ev/', after = null, limit = 1000, values = false, reverse = false } = {}) {
    const lim = Math.max(1, Math.min(Number(limit) || 1000, 5000));
    const p = String(prefix == null ? 'ev/' : prefix);
    const upper = prefixUpperBound(p);
    // Range over the prefix [p, upper). The cursor (`after`) tightens the open bound so paging never repeats
    // or skips a key: forward → gt=after; reverse → lt=after.
    const range = { reverse: !!reverse, limit: lim };
    if (reverse) { range.gte = p; range.lt = after || upper; }
    else { range.lt = upper; if (after) range.gt = after; else range.gte = p; }
    // Confirmed snapshot (indexer-signed length) — same view getSigned reads, then closed like getSigned.
    const view = this.peer.base.view.checkout(this.peer.base.view.core.signedLength);
    const records = [];
    try {
      for await (const node of view.createReadStream(range)) {
        const key = asStr(node.key);
        records.push(values ? { key, value: node.value } : { key, type: node.value?.type, ts: node.value?.ts });
        if (records.length >= lim) break;
      }
    } finally { await view.close(); }
    const cursor = records.length === lim ? records[records.length - 1].key : null;
    return { records, count: records.length, cursor };
  }

  // The single tx-writable contract function: `submitEvidence`. The command is a JSON string
  // { op:'submitEvidence', key, record, adminSig } (built by the peer's submission control route, which
  // admin-signs the record). We hand the contract { key, record, adminSig } as the tx value; the contract
  // re-verifies the admin signature before storing. Any other command → null (oracle writes are off-rail).
  mapTxCommand(command) {
    const json = this.safeJsonParse(command);
    if (json !== undefined && json !== null && json.op === 'submitEvidence') {
      if (typeof json.key !== 'string' || json.record === null || typeof json.record !== 'object' || typeof json.adminSig !== 'string') return null;
      return { type: 'submitEvidence', value: { key: json.key, record: json.record, adminSig: json.adminSig } };
    }
    return null;
  }

  async printOptions() {
    console.log(' ');
    console.log('- Evidence-ledger read commands:');
    console.log('- /get --key "<ev/...key>" [--confirmed true|false] | read an evidence key (confirmed defaults to true).');
    console.log('- /list [--prefix "ev/crypto/sub/"] [--limit 50] [--after "<key>"] [--values true] | iterate evidence keys (paged).');
  }

  async customCommand(input) {
    await super.tokenizeInput(input);
    // Shared flag reader: --name value | --name="value" | --name 'value'. Returns null when absent.
    const sval = (name) => { const m = input.match(new RegExp('(?:^|\\s)--' + name + "(?:=|\\s+)(\"[^\"]+\"|'[^']+'|\\S+)")); return m ? m[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1') : null; };
    if (this.input.startsWith('/get')) {
      const raw = sval('key');
      if (!raw) { console.log('Usage: /get --key "<ev/...>" [--confirmed true|false]'); return; }
      const key = raw;
      const cm = sval('confirmed');
      const confirmed = cm ? (cm === 'true' || cm === '1') : true;
      const v = confirmed ? await this.getSigned(key) : await this.get(key);
      console.log(v);
      return;
    }
    if (this.input.startsWith('/list')) {
      const r = await this.listEvidence({
        prefix: sval('prefix') || 'ev/',
        limit: Number.parseInt(sval('limit') || '50', 10),
        after: sval('after') || null,
        values: (sval('values') || 'false') === 'true',
        reverse: (sval('reverse') || 'false') === 'true',
      });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
  }
}

export default EvidenceProtocol;
