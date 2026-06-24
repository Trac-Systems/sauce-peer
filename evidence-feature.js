// Sauce EVIDENCE FEATURE (PLAN §8 oracle). The operator's FREE write path for oracle
// assertions: valuation / usage_root / earn_root / retraction. Extends trac-peer's Feature: `append(key,
// value)` signs `JSON.stringify(value)+nonce` with the peer wallet and appends an admin-signed `feature`
// op; the contract's `evidence_feature` handler validates + dedups + O(1)-puts it (see contract.js).
// Writes are TNK-FREE (the feature path never touches the MSB).
//
// NOTE: `submission` is NO LONGER written here — it moved to the admin-gated PAID tx (submitEvidence,
// driven by the control endpoint in index.js). The submission() builder below stays only as a reference
// for the record shape; the contract rejects a submission that arrives via this Feature path.
//
// Requirements for a write to APPLY: the running peer must be (a) the subnet `admin` (the op signature
// is verified against the `admin` entry) and (b) base-writable. The operator node is admin + indexer.
//
// `start()`/`stop()` are inert: writes are emitted explicitly by the engine/rollers (valuation on
// scoring, usage/earn roots per epoch, retraction on takedown).
import { Feature } from 'trac-peer';

export class EvidenceFeature extends Feature {
  // Low-level: write any pre-built record at its ledger key. `value` MUST carry the record's `type`
  // and `ts` (the contract is deterministic — the timestamp is stamped here, off-ledger).
  async record(key, value) {
    await this.append(key, value);
  }

  // Reference builder for the §8 submission record shape (NOT used as a writer anymore — submission is a
  // paid admin-gated tx; the contract rejects submission via the Feature). Kept for parity/tests.
  async submission(vault, packId, ver, fields) {
    const key = `ev/${vault}/sub/${packId}/${ver}`;
    await this.append(key, { type: 'submission', schemaVersion: 1, vault, packId, ver, ts: Date.now(), ...fields });
    return key;
  }

  async valuation(vault, packId, ver, fields) {
    const key = `ev/${vault}/val/${packId}/${ver}`;
    await this.append(key, { type: 'valuation', schemaVersion: 1, vault, packId, ver, ts: Date.now(), ...fields });
    return key;
  }

  async usageRoot(vault, epoch, fields) {
    const key = `ev/${vault}/usage/${epoch}`;
    await this.append(key, { type: 'usage_root', schemaVersion: 1, vault, epoch, ts: Date.now(), ...fields });
    return key;
  }

  async earnRoot(vault, epoch, fields) {
    const key = `ev/${vault}/earn/${epoch}`;
    await this.append(key, { type: 'earn_root', schemaVersion: 1, vault, epoch, ts: Date.now(), ...fields });
    return key;
  }

  // Takedown tombstone (docs/PLAN-2026-06-19-takedown.md). The ledger is append-only — a Retraction is a
  // NEW immutable record that supersedes a prior Submission for all consumers (the content itself was
  // never on the ledger; only hashes). Fields are opaque (content hashes, reason code, counts) — no PII.
  async retraction(vault, packId, ver, fields) {
    const key = `ev/${vault}/ret/${packId}/${ver}`;
    await this.append(key, { type: 'retraction', schemaVersion: 1, vault, packId, ver, ts: Date.now(), ...fields });
    return key;
  }

  async start() { /* inert — writes are driven explicitly by the engine */ }
  async stop() { /* inert */ }
}

export default EvidenceFeature;
