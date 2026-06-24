# Sauce Evidence Ledger — read-only access (3rd-party how-to)

This guide is for developers who want to **independently read the Sauce evidence ledger**:
run your own read-only node, sync the ledger from the network, and iterate/retrieve records over a small
HTTP API. You do **not** need any of the operator's keys, secrets, or servers. You run your own copy.

The ledger is an append-only, indexer-signed log on a [Trac](https://github.com/Trac-Systems) subnet
(autobase + hyperbee under the hood). It records **proofs** about the marketplace: knowledge submissions,
quality valuations, per-epoch query-usage roots, per-epoch payout (earn) roots, and takedowns.

> **The records are opaque by design.** Identifiers and content/identity fields are written as hashed,
> peppered references (see [Opacity](#opacity)). The ledger proves *that* something happened and ties the
> records together; it does not expose the underlying content, titles, or wallet addresses. The per-epoch
> usage/earn roots are aggregate Merkle roots (and the earn root matches the on-chain payout root).

---

## 1. What's on the ledger

Every record lives under a key `ev/<vault>/<type>/…`, where `vault` is `crypto` or `fiat`:

| Key shape | Type | Meaning |
|---|---|---|
| `ev/<vault>/sub/<packRef>/<verRef>` | `submission` | a knowledge pack/bundle was published |
| `ev/<vault>/val/<packRef>/<verRef>` | `valuation` | a quality assessment of a pack |
| `ev/<vault>/usage/<epoch>` | `usage_root` | Merkle root of query usage for an epoch |
| `ev/<vault>/earn/<epoch>` | `earn_root` | Merkle root of payouts for an epoch (= on-chain root) |
| `ev/<vault>/ret/<packRef>/<verRef>` | `retraction` | a takedown tombstone |
| `ev/<vault>/fb/<packRef>/<verRef>` | `feedback` | an outcome signal |

`packRef`/`verRef` are opaque 128-bit refs (post-opacity). The record *value* is a small JSON object of
hashes, counts, and economic totals — never raw content.

---

## 2. Prerequisites

The node is a **Pear / bare app** (not a plain Node program), so it runs under the Pear runtime.

1. **Install Pear** (once):
   ```sh
   npm i -g pear
   pear            # first run initializes the runtime
   ```
   See the [Pear docs](https://docs.pears.com/) for details.

2. **Clone this repo and install** with **`npm ci`**, not `npm install`:
   ```sh
   git clone https://github.com/Trac-Systems/sauce-peer.git
   cd sauce-peer
   npm ci          # MUST be `npm ci` — the committed package-lock pins a vetted, mutually-compatible tree
   ```
   > `npm install` resolves newer transitive versions that crash hypercore-storage encoding. Always `npm ci`.

---

## 3. Run a read-only reader

A reader **joins the existing subnet** (it never deploys, never writes, never needs TNK or any secret) and
serves the read API on a local HTTP port. Point it at the published **subnet bootstrap key**:

From the repo root (where `package.json` is):

```sh
pear run . \
  --network mainnet \
  --reader 1 \
  --subnet-bootstrap b014e822ebeaa9ba62c5ae66d97f73b3b8b560110a41c9ee800aa785155ca440 \
  --peer-store-name my-sauce-reader \
  --control-port 61610
```

| Flag | Purpose |
|---|---|
| `--network mainnet` | the live network (uses the built-in mainnet MSB config) |
| `--reader 1` | read-only replica: no funding, no writes, no admin |
| `--subnet-bootstrap <hex>` | the subnet to join (the mainnet key is above). Persisted after first run, so later restarts need no flag. |
| `--peer-store-name <name>` | local store directory name (keep it stable across restarts) |
| `--control-port <port>` | where the HTTP read API listens (default `61600`) |
| `--repo-root <abs>` | optional; sets where stores live (`<repo-root>/local-state/trac/`) |

On boot it connects to the network, syncs the ledger, and prints:

```
evidence control endpoint on http://127.0.0.1:61610 (admin=false, reader=true, authRequired=false, reads=open)
```

First sync takes a few seconds. The reader stays running and keeps syncing new records.

---

## 4. The read API

All endpoints are **GET**, read-only, and need no auth. By default they bind to `127.0.0.1` (see
[Exposing to a network](#5-exposing-to-a-network-optional)).

### `GET /health`
```sh
curl -s http://127.0.0.1:61610/health
# {"ok":true,"admin":false,"network":"mainnet","authRequired":false}
```

### `GET /evidence/list` — iterate the ledger
Query params:

| Param | Default | Meaning |
|---|---|---|
| `prefix` | `ev/` | key prefix to scan. `ev/crypto/` = all crypto; `ev/crypto/sub/` = crypto submissions; `ev/crypto/earn/` = payout roots |
| `limit` | `1000` | page size (max `5000`) |
| `after` | — | pagination cursor: pass the previous page's `cursor` to continue |
| `values` | `false` | `true` to include each record's full value (else `{key,type,ts}`) |
| `reverse` | `false` | `true` to walk newest-key-first |

Response:
```json
{
  "ok": true,
  "count": 2,
  "records": [
    { "key": "ev/crypto/earn/2", "type": "earn_root", "ts": 1782315194628 },
    { "key": "ev/crypto/sub/…/…", "type": "submission", "ts": 1782312339081 }
  ],
  "cursor": "ev/crypto/sub/…/…"
}
```
`cursor` is the key to pass as `after` for the next page. It is `null` on the last page.

```sh
# all payout (earn) roots, newest first, full values
curl -s "http://127.0.0.1:61610/evidence/list?prefix=ev/crypto/earn/&values=true&reverse=true"
```

### `GET /evidence/get?key=<key>` — fetch one confirmed record
Returns the **indexer-signed (confirmed)** record for an exact key. A key returned by `list` is fetchable
here.
```sh
curl -s "http://127.0.0.1:61610/evidence/get?key=ev/crypto/earn/2"
# {"ok":true,"record":{ "type":"earn_root", "epoch":2, "merkleRoot":"0x…", … }}
```

### Paginate the whole ledger (Node example)
This talks plain HTTP from a normal Node process (outside the Pear app):
```js
async function* allEvidence(base = 'http://127.0.0.1:61610', prefix = 'ev/') {
  let after = null;
  do {
    const u = new URL(base + '/evidence/list');
    u.searchParams.set('prefix', prefix);
    u.searchParams.set('limit', '1000');
    u.searchParams.set('values', 'true');
    if (after) u.searchParams.set('after', after);
    const { records, cursor } = await fetch(u).then(r => r.json());
    for (const rec of records) yield rec;
    after = cursor;
  } while (after);
}

for await (const rec of allEvidence()) {
  console.log(rec.key, rec.value?.type);
}
```

---

## 5. Exposing to a network (optional)

By default the read API binds to `127.0.0.1` — run your reader and your consumer on the same host. To serve
the read API to other machines, bind a reader (only) to another interface:

```sh
pear run . --network mainnet --reader 1 \
  --subnet-bootstrap b014e822ebeaa9ba62c5ae66d97f73b3b8b560110a41c9ee800aa785155ca440 \
  --peer-store-name my-sauce-reader --control-port 61610 --control-host 0.0.0.0
```

> Only **read-only readers** may bind off-localhost; admin peers always stay on `127.0.0.1` (they expose
> write routes). A reader has no write routes, so this serves reads only. Still, put it behind your own
> firewall / reverse proxy / rate-limiter if it faces the internet.

---

## 6. Embedding the peer (in-process API)

If you run the peer inside your own Pear app instead of calling it over HTTP, the same reads are on the
protocol API (`extendApi`), so you never touch hypercore/hyperbee directly:

```js
peer.protocol.instance.getEvidence(key)          // confirmed record for a key (= getSigned)
peer.protocol.instance.listEvidence({ prefix, after, limit, values, reverse })
// → { records, count, cursor }
```

There is also a terminal command on the running peer:
```
/list --prefix "ev/crypto/sub/" --limit 50 [--after "<key>"] [--values true]
/get  --key "ev/crypto/earn/2"
```

---

## 7. Notes

<a name="opacity"></a>
- **Opacity / verification.** Identifiers and content/identity fields are opaque, peppered refs. Records
  prove activity and structure (counts, epochs, economic totals, the aggregate roots) without revealing
  *which* content or *whose*. Confirming a specific item against its source is an operator-mediated,
  on-request disclosure. Items published before the opacity cutover are cleartext (the ledger is
  append-only); records written after it are opaque.
- **Reader, never indexer.** Reads always come from a read-only replica. The admin/indexer (the sole
  writer) is never the retriever — including in your own setup: you run your own reader.
- **Confirmed reads.** `list` and `get` read the indexer-signed snapshot, so you only see agreed,
  confirmed ledger state.
- **Bare runtime.** The peer is a Pear/bare app: no Node globals, no `node:` builtins; the HTTP server is
  `bare-http1`. Your *consumer* can be anything that speaks HTTP.
