# Upstream asks

Limitations this plugin cannot fix from inside a plugin. Each entry says what is
needed, why the plugin-side workaround is not enough, and what we do meanwhile.

## 1. `dsh-fs`: a compare-and-swap that holds a lock across compare AND write

**Status:** open, filed 2026-09-02 (board card k190).
**Impact:** cross-process board writes can lose an update ~10% of the time under
worst-case contention. Measured, not estimated.

### What is needed

A `writeText` precondition — or a separate CAS entry point — where the backend
holds a lock that spans **both** the version comparison and the write, and where
that lock is visible to **other OS processes** (an `O_EXCL`/rename lock file, an
`flock`, or a single syscall that does the compare atomically).

### Why the plugin cannot do it

`dsh-fs-local`'s `writeText` already holds `withLock(targetKey)` around its
compare-and-write, which reads like the guarantee we need — but `this.locks` is
an **in-memory `Map` on the `FileSystem` instance**. It serialises callers inside
one process, exactly like this plugin's own `workspaceQueues`, and does nothing
between two OS processes.

So the shipped precondition (`replaceIfVersion`) is **optimistic only**: two
processes can each probe, each compare equal, and each write. Last writer wins
and the loser is never told. The gap is in the backend's process model, not in
how the plugin calls it — no plugin-side change closes it.

### Measured evidence

Reproduce with `probes/probe-g-cross-process-claim.mjs` (four processes claiming
one card simultaneously):

- **6 of 60 runs produced two winners** — ~10% under four-way contention.
- An earlier **15-run sample showed 0/15**. A small sample cannot distinguish 0%
  from 10%; report a rate over a stated N, never a pass/fail from a handful of runs.
- Filesystem mtime granularity here is **1 ms** (50 rapid writes produced 13
  distinct `mtimeNs`, minimum gap 1,000,005 ns), so two **same-size** writes
  within one tick produce an **identical** version token — 260/300 measured
  undetectable. This **widens** the race window; it does not cause it. A backend
  CAS must not depend on timestamp resolution for identity.

### What we do meanwhile

**Single-writer discipline** (k190 option iii, decided 2026-09-02): board writes
assume one writing dsh process. Scheduled ticks already satisfy this —
`dsh-cron`'s `overlap: skip` guarantees one host never runs two at once. A second
concurrent dsh process writing the same board (a dev instance, a canary boot, a
human running the tick by hand) is **unsupported**.

The limitation is written at the seam in `index.js` above `save()`, and in
`slice-1-build-plan.md` under "Claim, not lock". The residual behaviour is pinned
by a deterministic test so that if real cross-process safety ever lands, the test
**fails** and forces this document to be revisited.

### Rejected alternative, and why

A plugin-side `O_EXCL` lock file would genuinely close it, but trades a rare race
for a failure mode that bites on **every** crash: a stale lock blocks all future
writes until a human clears it. The plan rejected that trade deliberately ("there
is no `board.yml.lock` and no `noclobber` dance").

Also rejected: adding a nonce or `writeSeq` so payloads never share a size. It
would cut the observed collision rate sharply, leave the race untouched, and turn
the probe green — a control that looks green and is inert.

### How to tell if this has been fixed upstream

`probe-g` run **at least 60 consecutive times with zero multi-winner runs**, with
the rate reported rather than a pass/fail. Then the pinning test fails by design;
rewrite it, delete the seam comment, and correct the plan.
