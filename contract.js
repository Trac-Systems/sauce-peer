// Sauce EVIDENCE LEDGER
// Two write paths: the admin-signed `evidence_feature` oracle
// (FREE; valuation/usage/earn/retraction) and the admin-gated PAID `submitEvidence` tx (submission).
// Vault-namespaced keyspace `ev/<vault>/…` keeps the fiat and crypto stacks' evidence fully separate.
//
// RUNTIME: this file runs inside the trac-peer contract engine under Pear/bare — it must replay
// byte-identically on every indexer. So: b4a (NOT global Buffer — bare has none), no node: builtins, no
// Date/random/IO. Imports resolve via the Pear app's deps ('trac-peer', 'b4a').
//
// Never mutate this.op / this.value — clone first (this.protocol.safeClone), per Contract rules.
//
// Write model:
//   - Oracle assertions (valuation / usage_root / earn_root / retraction) are operator-computed truth →
//     written FREE via the admin-signed `evidence_feature` Feature path (#writeEvidence).
//   - `submission` is NOT an operator assertion — it is a provider/content datum, so it goes the normal
//     TNK-COSTING tx route (submitEvidence), but ADMIN-GATED: the contract only applies it if the tx
//     value carries a valid admin signature over the record. The payer/transactor (this.address, the
//     api.tx signer) is decoupled from the authority (admin) → a watchtower may broadcast+pay; for the
//     release the operator does both from the admin account. Wallet.verify is pure ed25519 (deterministic
//     → contract-safe).
import { Contract, Wallet } from 'trac-peer';
import b4a from 'b4a';

// Version lock: every peer on the subnet must run the identical contract/protocol, or state diverges
// ("INVALID SIGNATURE"). Bump this whenever the applied logic changes, and redeploy to every connected
// peer in lockstep.
const CONTRACT_VERSION = 3;

const VAULTS = Object.freeze({ fiat: true, crypto: true });
const MAX_RECORD_BYTES = 4096;

// Allowed record types → the fixed required-field set for each (deterministic, O(1) validation).
// `req` = required keys; everything is checked with direct
// property access (no loops over dynamic data).
const RECORD_TYPES = Object.freeze({
  submission: { prefix: 'sub', req: ['schemaVersion', 'packId', 'ver', 'contentHash', 'merkleRoot', 'ownerKeyHash', 'okfVersion', 'license', 'ts'] },
  valuation:  { prefix: 'val', req: ['schemaVersion', 'packId', 'ver', 'contentHash', 'dims', 'score', 'rubricVer', 'modelVer', 'rationaleHash', 'ts'] },
  usage_root: { prefix: 'usage', req: ['schemaVersion', 'epoch', 'merkleRoot', 'totalValueUsd', 'packsTouched', 'ts'] },
  earn_root:  { prefix: 'earn', req: ['schemaVersion', 'epoch', 'merkleRoot', 'ts'] },
  feedback:   { prefix: 'fb', req: ['schemaVersion', 'vault', 'packId', 'ver', 'outcomeSignal', 'ts'] },
  // Supersedes a prior submission for all consumers.
  // Opaque: a fixed-size contentDigest + counts + reason code — never content.
  retraction: { prefix: 'ret', req: ['schemaVersion', 'packId', 'ver', 'reasonCode', 'contentDigest', 'ts'] },
});

class EvidenceContract extends Contract {
  constructor(protocol, options = {}) {
    super(protocol, options);
    const _this = this;
    console.log('[evidence-contract] version', CONTRACT_VERSION, '(submission = admin-gated paid tx; oracles = free Feature)');

    // The ORACLE write path: an admin-signed Feature dispatch (see evidence-feature.js). Registered as
    // `<feature-name>_feature` — the feature is added to the peer under the name "evidence", so the
    // contract handler key is "evidence_feature" (trac-peer feature dispatch convention). FREE; writes
    // valuation/usage_root/earn_root/retraction. `submission` is rejected here (paid path only).
    this.addFeature('evidence_feature', async function () {
      await _this.#writeEvidence();
    });

    // The ADMIN-GATED PAID write path: a normal tx (costs TNK) carrying { key, record, adminSig }. Mapped
    // from a `submitEvidence` command by protocol.mapTxCommand. No schema — the value is validated
    // manually below (the record body is dynamic; #validateAndStore enforces its full shape).
    this.addFunction('submitEvidence');

    // Read-only helper (no writes) — surfaced to peers through the protocol's read commands/API.
    this.addSchema('readEvidence', {
      value: { $$strict: true, $$type: 'object', op: { type: 'string', min: 1, max: 64 }, key: { type: 'string', min: 1, max: 256 } },
    });
  }

  // ── the evidence write (Feature/oracle path) ────────────────────────────────────────────────────
  // this.op = { type:'evidence_feature', key, hash, value, nonce, address }  (address = admin pubkey,
  // already signature-verified against the `admin` entry by FeatureOperation before we run). FREE.
  async #writeEvidence() {
    const key = this.op?.key;
    const rec = this.value; // = this.op.value

    // Submissions are not written through the free Feature; they come through the admin-gated paid tx
    // (submitEvidence). Reject any submission that arrives on the oracle path; this path is oracles only.
    if (typeof key === 'string') {
      const p = this.#parseKey(key);
      if (p !== null && p.type === 'submission') return;
    }
    await this.#validateAndStore(key, rec);
  }

  // Shared validate→dedup→put (used by BOTH the Feature path and the admin-gated submitEvidence tx).
  // Loopless O(1): fixed-field checks + ONE get (dedup) + ONE put. Returns the parsed {vault,type} on a
  // successful store, else undefined (caller need not branch on it).
  async #validateAndStore(key, rec) {
    // 1) key must be a well-formed, vault-namespaced evidence key for a known record type.
    if (typeof key !== 'string') return;
    const parsed = this.#parseKey(key);
    if (parsed === null) return;
    const spec = RECORD_TYPES[parsed.type];

    // 2) value must be an object carrying a matching `type` + all required fields + matching vault.
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return;
    if (rec.type !== parsed.type) return;
    if (rec.vault !== undefined && rec.vault !== parsed.vault) return;
    let ok = true;
    for (let i = 0; i < spec.req.length; i++) { if (rec[spec.req[i]] === undefined) { ok = false; break; } }
    if (!ok) return; // bounded by the fixed schema (constant length), not data — still O(1).
    // A consent submission (schemaVersion >= 2) must carry its consent provenance. Single-phase submissions
    // (schemaVersion 1) do not. This is a presence-only, deterministic check (the signature itself is
    // verified off the VM, by the writer), which keeps the contract loopless and replay-stable.
    if (parsed.type === 'submission' && Number(rec.schemaVersion) >= 2) {
      if (rec.consentSig === undefined || rec.offerHash === undefined || rec.offeredValue === undefined) return;
    }

    // 2b) The record body must agree with its key (provenance integrity). A signed op must not be able to
    // store under key ev/<v>/sub/A/1 while its value claims packId B / ver 2, since a consumer keying off
    // the body would trust the wrong identity. Same for the epoch in usage/earn roots. O(1) string compares.
    // `ts` must be a finite number within fixed bounds, never a wall-clock check: the contract is
    // deterministic, so comparing to Date.now() would diverge across indexer replays.
    const parts = key.split('/');
    if (parsed.type === 'submission' || parsed.type === 'valuation' || parsed.type === 'retraction') {
      if (String(rec.packId) !== parts[3] || String(rec.ver) !== parts[4]) return;
    } else if (parsed.type === 'usage_root' || parsed.type === 'earn_root') {
      if (String(rec.epoch) !== parts[3]) return;
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < 1500000000000 || rec.ts > 4200000000000) return;

    // 3) clone (never store this.value directly) + size cap (defense-in-depth; op is already capped).
    const cloned = this.protocol.safeClone(rec);
    this.assert(cloned !== null);
    const stringified = this.protocol.safeJsonStringify(cloned);
    this.assert(stringified !== null);
    if (b4a.byteLength(stringified, 'utf8') > MAX_RECORD_BYTES) return;

    // 4) dedup → append-only: write a key at most once. Single get, single put. O(1).
    if (null !== await this.get(key)) return;
    await this.put(key, cloned);
    return parsed;
  }

  // ── the admin-gated PAID submission tx (submitEvidence) ──────────────────────────────────────────
  // this.value = { key, record, adminSig }; this.address = the transactor (payer) — NOT necessarily the
  // admin. The gate is the admin SIGNATURE over the canonical record bytes, so authority (admin) is
  // decoupled from who pays/broadcasts (watchtower-friendly). Costs TNK (a normal tx). submission ONLY.
  async submitEvidence() {
    const v = this.value;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return;
    if (typeof v.key !== 'string' || v.record === null || typeof v.record !== 'object' || Array.isArray(v.record) || typeof v.adminSig !== 'string') return;

    // ADMIN GATE — Contract.get('admin') returns the admin PUBKEY HEX STRING directly (set by addAdmin).
    // Wallet.verify is the pure ed25519 static (returns false on any bad/length-mismatched input, never
    // throws) → deterministic, contract-safe. The bytes must match what the submitter signed:
    // safeJsonStringify(record) (JSON round-trip preserves key order, so signer and contract agree).
    const admin = await this.get('admin');
    if (typeof admin !== 'string' || admin.length === 0) return;
    const msg = this.protocol.safeJsonStringify(v.record);
    if (msg === null) return;
    if (true !== Wallet.verify(b4a.from(v.adminSig, 'hex'), b4a.from(msg, 'utf8'), b4a.from(admin, 'hex'))) return;

    // This path writes submissions ONLY (oracle types still go through the Feature). #parseKey enforces
    // the `sub/` prefix → type 'submission'; reject anything else so a paid tx can't forge an oracle root.
    const parsed = this.#parseKey(v.key);
    if (parsed === null || parsed.type !== 'submission') return;
    await this.#validateAndStore(v.key, v.record);
  }

  // Returns { vault, type } for a valid `ev/<vault>/<prefix>/…` key, else null. No iteration over
  // state — pure string parsing of the incoming key.
  #parseKey(key) {
    const parts = key.split('/');
    if (parts.length < 3) return null;
    if (parts[0] !== 'ev') return null;
    const vault = parts[1];
    if (VAULTS[vault] !== true) return null;
    const prefix = parts[2];
    // map the on-key prefix back to a record type (fixed, tiny table — constant work).
    if (prefix === 'sub'   && parts.length === 5) return { vault, type: 'submission' };
    if (prefix === 'val'   && parts.length === 5) return { vault, type: 'valuation' };
    if (prefix === 'usage' && parts.length === 4) return { vault, type: 'usage_root' };
    if (prefix === 'earn'  && parts.length === 4) return { vault, type: 'earn_root' };
    if (prefix === 'fb'    && parts.length >= 4)  return { vault, type: 'feedback' };
    if (prefix === 'ret'   && parts.length === 5) return { vault, type: 'retraction' };
    return null;
  }

  // ── reads (no state writes) ────────────────────────────────────────────────────────────────────
  async readEvidence() {
    const key = this.value?.key;
    const value = (typeof key === 'string') ? await this.get(key) : null;
    console.log('readEvidence', key, '=>', value);
    return value;
  }
}

export default EvidenceContract;
