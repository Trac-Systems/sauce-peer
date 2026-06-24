// Evidence Feature: the operator's free write path for oracle assertions (valuation, usage_root,
// earn_root, retraction). It extends trac-peer's Feature: `append(key, value)` signs
// `JSON.stringify(value)+nonce` with the peer wallet and appends an admin-signed `feature` op, which the
// contract's `evidence_feature` handler validates, dedups, and stores (see contract.js). These writes are
// TNK-free; the Feature path never touches the MSB.
//
// Submissions do not go through this path. They are written by the admin-gated paid tx (submitEvidence),
// driven by the control endpoint in index.js. The submission() builder below documents the record shape;
// the contract rejects a submission that arrives via the Feature path.
//
// For a write to apply, the running peer must be (a) the subnet `admin` (the op signature is verified
// against the `admin` entry) and (b) base-writable. The operator node is both admin and indexer.
//
// `start()`/`stop()` are inert: writes are emitted explicitly (valuation on scoring, usage/earn roots per
// epoch, retraction on takedown).
import { Feature } from 'trac-peer';

export class EvidenceFeature extends Feature {
  // Low-level: write any pre-built record at its ledger key. `value` MUST carry the record's `type`
  // and `ts` (the contract is deterministic — the timestamp is stamped here, off-ledger).
  async record(key, value) {
    await this.append(key, value);
  }

  // Documents the submission record shape. This is not a writer: submissions go through the admin-gated
  // paid tx, and the contract rejects a submission sent via the Feature path.
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

  // Takedown tombstone. The ledger is append-only, so a retraction is a new immutable record that
  // supersedes a prior submission for all consumers (the content itself is never on the ledger, only
  // hashes). Fields are opaque (content hashes, reason code, counts); no PII.
  async retraction(vault, packId, ver, fields) {
    const key = `ev/${vault}/ret/${packId}/${ver}`;
    await this.append(key, { type: 'retraction', schemaVersion: 1, vault, packId, ver, ts: Date.now(), ...fields });
    return key;
  }

  async start() { /* inert — writes are driven explicitly by the engine */ }
  async stop() { /* inert */ }
}

export default EvidenceFeature;
