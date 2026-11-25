# TrustChain Study Guide: every concept, in simple words

Read this top to bottom once. Part 12 is a question bank for the demo and viva.
Where I give a number or a design detail, it comes from your project and paper as I
saw them. Check exact figures against `main.tex` before you quote them.

---

## Part 1. The problem and the idea

**KYC (Know Your Customer).** Before a bank or exchange serves you, it must check who you are.
You upload an ID and a selfie. Each company repeats this and stores its own copy.

**Problems with repeating KYC**
- It is slow and annoying for the user.
- It costs every company money.
- Many databases hold your documents, so there are many places to leak from.

**The TrustChain idea.** One trusted party checks you once and gives you a digital
credential. You then prove "I am verified" to other companies without re-uploading anything.

**Title of your paper:** "Reusable Identity Credentials Under Failure."
The key words are *reusable* (verify once, use many times) and *under failure*
(what happens when parts of the system break). Your main contribution is studying the
failure behaviour, not inventing a new identity system.

---

## Part 2. Core vocabulary

| Term | Meaning |
|---|---|
| **SSI (Self-Sovereign Identity)** | The user holds their own credentials instead of a company holding them for them |
| **Issuer** | The trusted party that checks identity and signs the credential (like a government) |
| **Holder** | The person who owns the credential and stores it in a wallet |
| **Verifier** | A company that checks the holder's credential |
| **Credential** | A signed digital statement: "Issuer X says this key belongs to a verified person at level N" |
| **Presentation** | What the holder sends to a verifier: the credential plus a fresh proof |
| **Wallet** | The holder's storage for the credential and private key (here, the browser) |
| **Assurance level** | How strongly the identity was checked (1, 2 or 3). A verifier can demand a minimum |
| **Revocation** | Cancelling a credential before it would naturally expire |
| **Status** | Whether a credential is currently valid or revoked |

Important: your credential format is **custom and signed with P-256**. It is **not** the
W3C Verifiable Credentials standard. Say this honestly if asked.

---

## Part 3. Cryptography you must understand

### 3.1 Key pairs and signatures
- A **private key** is secret. A **public key** can be shared.
- A **signature** is made with the private key. Anyone with the public key can check it.
- A valid signature proves two things: the message came from the key owner, and it was not changed.
- Nobody can forge a signature without the private key.

### 3.2 P-256
P-256 (also called secp256r1 or prime256v1) is an **elliptic-curve** scheme. It gives strong
signatures with small keys and fast operations, and it is supported by browsers (WebCrypto)
and by WebAuthn passkeys. That is why the project uses it.

### 3.3 Hashing
A hash turns any data into a fixed-size fingerprint. A tiny change in the data gives a
completely different hash. Signatures are made over hashes, not the whole message.

### 3.4 Nonce
A **nonce** is a random number used once. It makes each challenge unique, so an old answer
is useless.

### 3.5 Replay attack
An attacker records a valid proof and sends it again later. Defences in your design:
1. The verifier creates a **fresh challenge** every time.
2. The challenge is **single use**. After one check it is consumed.
3. The challenge **expires** (two minutes in the demo).
4. The proof is **bound to the verifier** (audience) and to a request ID.

That is why the second verify of the same presentation fails with
"Missing, consumed or expired challenge."

### 3.6 Audience binding
The signed proof names the verifier it is for. Verifier A cannot take it and replay it to Verifier B.

### 3.7 Holder binding
The credential contains the holder's **public key**. The holder proves ownership by signing the
verifier's challenge with the matching **private key**. Copying the credential alone is useless.

### 3.8 Non-exportable key
The browser stores the holder's private key as a **non-exportable WebCrypto key** in IndexedDB.
Code can ask the browser to sign with it but cannot read the key out.
**Limit:** this is an API property, not hardware protection. Malicious script on the same
page could still use the key to sign. Say this honestly.

---

## Part 4. Passkeys, WebAuthn and Touch ID

- **WebAuthn** is the browser standard for passwordless login using public-key cryptography.
- A **passkey** is a WebAuthn credential. The private key lives inside secure hardware.
- On a Mac, that hardware is the **Secure Enclave**. Touch ID unlocks the key.
- The fingerprint **never leaves the device** and is never seen by the app. The app only
  receives a signature.
- Only fingerprints enrolled on that Mac work. That is a device rule, not our code.

**In TrustChain**
- A passkey is registered at enrolment and tied to the holder's credential.
- For sensitive actions (key rotation, and presentations when the credential requires it), the
  holder must pass a passkey check.
- It is **issuer-mediated**: the issuer sends a challenge, the passkey signs it, and the issuer
  issues an **authorization that lasts 60 seconds**.
- This shows the holder was physically present.

**Tests use a "virtual CTAP2 authenticator."** That is a software stand-in for a real
authenticator, so automated tests can run. It proves the integration works. It does not prove
real-fingerprint behaviour. Your live Touch ID run is the real check.

**Negative tests that pass:** wrong origin, wrong challenge, unregistered credential and replay
are all rejected.

---

## Part 5. The full flow in detail

### Step 1. Holder requests a credential
1. The browser generates a new P-256 key pair. The private key stays local.
2. The passkey is registered (Touch ID).
3. The browser sends the issuer the public key, an enrolment ticket, and a signed proof of key possession.
4. The issuer stores a **pending application**. It lasts **15 minutes** and survives an issuer restart.

### Step 2. Issuer approves
1. The admin signs in with the **admin token**. The session lasts **15 minutes** and lives only in page memory.
2. The admin ticks the **simulated identity review** box. In reality, a human would check documents here.
3. On approval, the issuer **signs the credential** with its private key.
4. The issuer also writes the credential's status (see Part 7).

### Step 3. Holder collects
The holder uses an access token from step 1 to fetch the approved credential. The wallet stores
the credential and key. A **recovery code** is shown once and is not stored in the wallet.

### Step 4. Verifier creates a challenge
A fresh nonce, bound to this verifier, with a request ID and a two-minute expiry.
The required assurance level is set here.

### Step 5. Holder creates a presentation
The browser signs the challenge, audience and request ID with the private key, attaches the
credential, and, if the credential requires it, adds a passkey authorization.

### Step 6. Verifier checks
1. **Issuer signature** valid, using the issuer public key it already has.
2. **Holder proof** valid against the key named in the credential.
3. **Challenge** known, unexpired, unused, and for this audience.
4. **Assurance level** at least what was required.
5. **Status** not revoked (Part 7).

### Step 7. Replay
The challenge was consumed, so the second attempt fails.

### Step 8. Revocation
The issuer revokes. Status changes. New verifications fail even though signatures are still valid.

---

## Part 6. Key lifecycle: rotation, loss and recovery

- **Key rotation:** the holder wants a new key (for example, as routine hygiene). The request needs
  proof from the **old** key and the **new** key, plus passkey authorization, and the issuer approves.
  The old credential is revoked and a replacement is issued.
- **Key loss:** if the holder loses the key, they cannot sign. They use the **recovery code**.
- **Recovery:** needs the offline recovery code, a proof from the new key, and **issuer approval**.
  The code alone is never enough, so a stolen code cannot take over the credential.
- **Ordering:** replacement uses **revoke-then-register**. The old credential is revoked first, so
  there is never a moment when two credentials are valid.

---

## Part 7. Revocation and status: the heart of the paper

A credential is a signed file. A copy cannot know it was cancelled. So the verifier must check
**status** separately. Your paper compares **three backends**.

### 7.1 Signed per-credential status
- Verifier asks the issuer about one credential.
- Issuer returns a signed answer, bound to the verifier's nonce, so it is fresh.
- Fresh, but needs a network call every check.

### 7.2 Signed aggregate status list (bitstring)
- Issuer publishes one signed list with a bit per credential. Yours has **131,072 bits**.
- 0 means valid, 1 means revoked (as a bitstring list works).
- The verifier downloads it and looks up the bit.
- **Good for privacy and scale:** the issuer does not learn which credential you checked.
- Can be **cached**, which is faster but possibly stale.

### 7.3 Local-chain registry
- A smart contract (`CredentialStatus.sol`) stores status on a blockchain.
- The issuer sends transactions to register and revoke.
- The verifier reads the contract.
- Public, append-only, independent of the issuer's server being online.

### 7.4 Caching, TTL and freshness
- **Cache TTL (C):** how long the verifier reuses a copy before re-fetching.
- A longer TTL is faster but allows **staleness**. A revocation might not be seen until the cache expires.
- Your paper gives a **tolerance formula, A(C)**, with the condition
  **t < min(f + C, s + C, e)**, where the terms capture how long after revocation a stale answer can
  still be accepted (f, s and e are the paper's timing terms; read their exact definitions in the paper).
- Plain meaning: the verifier can accept a revoked credential for a window of time bounded by the cache
  lifetime and the other delays. You can tune that window.

### 7.5 Block lag
On a chain, a transaction is not visible to readers until it is in a block. This **lag** is another
source of staleness for the chain backend.

### 7.6 Results
- **4,320-attempt ablation:** with a 500 ms cached list at 75 ms network delay: **320.9 ms** for the cached
  list vs **475.9 ms** for signed status vs **477.3 ms** for the chain.
- **360 protected presentations:** about **35 to 51 ms** across the three backends (34.7, 36.7 and 50.5 ms
  in the paper; check which backend each number belongs to).
- **Takeaway:** caching is fastest but can be stale. The chain is comparable to signed status, not faster.
  So the chain is a trade-off, not a requirement.

---

## Part 8. Blockchain: what and why

- **Blockchain:** a record kept by many computers in blocks that are chained by hashes, so history is hard to rewrite.
- **Smart contract:** code stored on the chain. Yours stores credential status.
- **Hardhat:** a development tool that runs a **local, disposable test chain**. Yours is on port 8545 with
  **chain ID 31337** (Hardhat's default).
- **Gas and transactions:** writes cost gas on public chains. Locally it is free test money.
- **Account and nonce:** every transaction comes from an account with a counter called a transaction nonce.
  The counter must be in order.
- **Why use a chain here:** public, append-only, and verifiers can read it without trusting one server.
- **What goes on it:** only credential ID and status. **Never personal data.** A public permanent record would
  be a privacy mistake.
- **Polygon:** a real public network. Your project uses a local chain for the demo because it is free, fast
  and controllable. Moving to Polygon would be future work and needs real keys, fees and security review.
- **Honest limit:** the public Hardhat test key is not secret. It is only for a disposable local chain.

---

## Part 9. Reliability: the "under failure" part

The risk: the issuer approves, then crashes before it writes to the chain. Now the database and the
chain disagree. Your system handles this.

- **Durable signed-transaction outbox:** before sending a chain transaction, the issuer **signs it and
  saves it to disk**. If it crashes, it resumes from the saved record rather than guessing.
- **Encrypted SQLite journal:** the saved records are in an encrypted SQLite database. (Node's SQLite is marked experimental.)
- **Crash recovery:** on restart the issuer replays or reconciles pending operations.
- **Revoke-then-register ordering:** avoids two valid credentials at once.
- **Ambiguous broadcast:** if the issuer sent a transaction but is unsure whether the network received it, it
  **blocks** that operation instead of guessing. Then an admin uses **Reconcile operation**.
- **Nonce conflict:** if the account counter is out of step, the system detects it and blocks safely.
- **27-trial fault matrix:** **21 recovered automatically, 6 blocked safely.** Never silently wrong.
  "Blocked" is a deliberate safe stop, not a failure to handle.

Plain summary: when unsure, stop and ask a human. That is safer than risking a wrong "valid".

---

## Part 10. Privacy

- The **privacy trace** in your paper shows what each party can see.
- The issuer can see the **audiences** (which verifiers) in the issuer-mediated passkey step. That is a leak.
- Verifiers can **link** a holder across verifiers if the same credential or key is reused. That is also a limit.
- The aggregate status list helps because the issuer does not learn which credential was checked.
- Honest wording: privacy is *reduced* exposure, not *zero* exposure. Do not claim unlinkability.

---

## Part 11. Limits, scope and honesty

- **TRL 4:** technology validated in a lab. It is a research prototype, not a product.
- **Simulated identity review:** a checkbox stands in for a real identity check.
- **Local chain:** a disposable test chain, not a public network.
- **Virtual authenticator** in automated tests; real Touch ID was not part of the automated test.
- **Custom credential format**, not W3C VC.
- **Issuer trust:** the verifier must already know which issuers to trust. A real deployment needs a trusted-issuer list.
- **Same-origin pages** are not protected against malicious scripts.
- **Aadhaar, CKYC and DigiLocker** already solve "verify once" in India centrally. Your work is about reusable credentials under
  failure and measuring it, and Aadhaar eKYC could be the real check behind the issuer's review.

---

## Part 12. Questions you may be asked, with short answers

1. **Why not just use Aadhaar?** It solves getting verified once, centrally. We study how reusable credentials behave when issuer, status service or network fails, and Aadhaar could be the identity source.
2. **Where is the credential stored?** In the holder's browser wallet. The holder sends it to the verifier in the presentation.
3. **How does the verifier trust it if it is local?** Issuer signature (with a known public key), holder proof on a fresh challenge, and a separate status check.
4. **Where is blockchain used?** Only as a status registry for valid or revoked. No personal data.
5. **Is blockchain necessary?** No. We compare it with two non-blockchain methods, and it was not faster.
6. **Why is the cached list fastest?** It skips the network on most checks. The cost is possible staleness.
7. **What if the credential is stolen?** The thief cannot sign challenges without the private key, and the passkey adds a second lock.
8. **What if the key is lost?** Recovery code plus issuer approval. The code alone is not enough.
9. **What is replay protection?** Fresh, single-use, audience-bound, expiring challenges.
10. **Why does Touch ID accept only my finger?** The Mac's Secure Enclave checks enrolled fingerprints. The app only gets a signature.
11. **What if the issuer crashes mid-operation?** The signed transaction is saved in an encrypted outbox. We recover or block safely. 21 of 27 trials recovered, 6 blocked.
12. **Why block instead of guess?** A wrong "valid" is worse than a delay.
13. **Is it production-ready?** No. TRL 4, simulated review, local chain.
14. **Why P-256?** Strong, fast, and supported by browsers and passkeys.
15. **Why not W3C VC?** We used a simple custom signed format to keep the study focused. Standards alignment is future work.
16. **What does the 15-minute and 2-minute stuff mean?** Pending requests and admin sessions last 15 minutes, challenges last two minutes, passkey authorizations 60 seconds. Short lifetimes reduce misuse.
17. **Why Polygon was not used?** A local chain is free, fast and controllable for research. Public network use needs real keys, fees and review.
18. **What is the privacy limit?** Issuer-visible audiences and cross-verifier linkability remain.
19. **What does "assurance level" mean?** How strongly identity was checked. The verifier sets a minimum.
20. **What is TRL 4?** Validated in a laboratory environment.

---

## Part 13. Services and ports (for the demo)

| Piece | Port | Job |
|---|---|---|
| Local chain (Hardhat) | 8545 | Status registry contract |
| Issuer service | 4101 | Approves, signs, revokes, writes to chain |
| Verifier service | 4102 | Creates challenges, checks presentations |
| Web app (Vite + React) | 5173 | Holder, issuer and verifier pages |

Frontend: `src/ResearchApp.jsx`. Roles use `?role=holder`, `?role=issuer`, `?role=verifier`.
Demo identity folder: `.trustchain-demo` (admin token is in `issuer.json`).
