// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { apply, parseBoardText, SCHEMA_VERSION, RESERVED_STAGE_TITLES, EMPTY_STATE, NOTE_LIMIT } from "../index.js"

const workspaces = []

// The board now lives at $HOME/.dsh-boards/<basename(workspace.path)>/board.json,
// so HOME is pinned to a temp dir — the suite must never touch the real one.
const realHome = process.env.HOME
let homeDir

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "dsh-kanban-home-"))
  process.env.HOME = homeDir
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (homeDir) rmSync(homeDir, { recursive: true, force: true })
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Where the board file for a workspace directory now lands. */
const boardPath = (dir, suffix = "") => join(homeDir, ".dsh-boards", basename(dir), "board.json" + suffix)

/**
 * File version the fake backend reports. This MUST mirror dsh-fs-local's identity
 * (`dev:ino:size:mtimeNs:ctimeNs`, lib/index.js:142) — NANOSECOND precision.
 * An earlier version used mtimeMs and two writes inside the same millisecond
 * produced an identical version, so a stale write compared EQUAL and slipped
 * through the CAS. Measured: 166 of 200 back-to-back writes collide at ms
 * granularity. Trap 9 once more — a mock coarser than the backend hides the bug.
 */
const versionOf = (target) => {
  if (!existsSync(target)) return undefined
  const info = statSync(target, { bigint: true })
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}



/** Seed a board file at the new location, creating the board directory first. */
const seedBoard = (dir, content) => {
  const target = boardPath(dir)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

// Every path the fake backend is asked to write, so a test can prove no write
// escaped the temp HOME. BOARD_ROOT is read inside apply() (index.js:359), not at
// import time, so the beforeEach HOME swap does redirect it — this asserts that
// rather than assuming it.
let writeLog = []
beforeEach(() => { writeLog = [] })

function boot(dir = mkdtempSync(join(tmpdir(), "dsh-kanban-test-")), options = {}) {
  workspaces.push(dir)
  const workspace = { id: "ws-test", path: dir, title: "Test" }
  const registered = []
  const tokenOf = versionOf
  const fs = {
    async resolve(path, options = {}) {
      // Match the real backend: an absolute path ignores cwd (node:path.resolve semantics).
      return isAbsolute(path) ? path : join(options.cwd || dir, path)
    },
    async readText(target) {
      if (!existsSync(target)) {
        const error = new Error("ENOENT")
        error.code = "ENOENT"
        throw error
      }
      return readFileSync(target, "utf8")
    },
    // Trap 9 again: a mock that is WEAKER than the real backend hides exactly the
    // bug it should catch. dsh-fs-local's writeText enforces an optional `expected`
    // precondition inside its own lock and throws FS_STALE_VERSION on mismatch;
    // stat() exposes the version. Without both, probe-g's cross-process lost
    // update is invisible to this suite.
    async stat(target) {
      const version = tokenOf(target)
      return version === undefined ? undefined : { version, type: "file" }
    },
    async writeText(target, content, expected) {
      writeLog.push(target)
      if (options.writeDelay) await new Promise((resolve) => setTimeout(resolve, options.writeDelay(content)))
      if (options.failWrites) throw new Error("ENOSPC")
      const current = tokenOf(target)
      if (expected && expected.kind === "replaceIfVersion") {
        if (current === undefined || current !== expected.version) {
          const error = new Error("cannot write: file changed since it was read")
          error.code = "FS_STALE_VERSION"
          throw error
        }
      } else if (expected && expected.kind === "createIfAbsent" && current !== undefined) {
        const error = new Error("cannot overwrite existing file without reading it first")
        error.code = "FS_NOT_OBSERVED"
        throw error
      }
      // THE CROSS-PROCESS GAP (k190), modelled faithfully. In dsh-fs-local the
      // compare above and the write below sit inside withLock(targetKey) — but
      // `this.locks` is an in-memory Map on the FileSystem INSTANCE, so it holds
      // only within one process. Between two OS processes there is a real window
      // right here, and `gap` lets a test step into it deterministically instead
      // of waiting for the measured ~10% to happen by luck.
      if (options.gap) await options.gap(target)
      // The real backend's writeFileAtomic does mkdir(dirname, {recursive:true}).
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, "utf8")
      return { version: tokenOf(target) }
    },
  }
  const ctx = {
    get(name) {
      if (name === "fs") return fs
      if (name === "sandboxPolicy") return { defaultMode: "workspace-write", resolve: () => ({ mode: "workspace-write" }) }
      // Lets a test capture the /api/kanban handler and drive it directly, so the
      // HTTP abuse guards are pinned by execution rather than by reading the code.
      if (name === "webServer" && options.captureRoute) return {
        register: (route) => { options.captureRoute(route); return () => {} },
      }
      if (name === "workspaceRegistry") return {
        // `extra` lets a test register a SECOND workspace, so explicit-id routing
        // can be proven to reach a board the calling cwd could never resolve.
        get: (id) => [workspace, ...(options.extra || [])].find((w) => w.id === id),
        list: () => [workspace, ...(options.extra || [])],
        resolveByPath: async (path) => [workspace, ...(options.extra || [])].find((w) => w.path === path),
      }
      return undefined
    },
    tools: {
      register(tool) { registered.push(tool) },
    },
  }
  apply(ctx)
  const exec = { agent: { session: { header: { cwd: dir } } } }
  return { dir, workspace, registered, exec }
}

const tool = (registered, name) => {
  const found = registered.find((candidate) => candidate.name === name)
  expect(found, `missing registered tool ${name}`).toBeTruthy()
  return found
}

describe("host board seam", () => {
  it("migrates legacy data through the public parser contract", () => {
    const parsed = parseBoardText(JSON.stringify({
      columns: [{ id: "c1", title: "Todo" }],
      cards: [{ id: "k1", columnId: "c1", title: "Migrate me" }],
    }))

    expect(parsed.ok).toBe(true)
    expect(parsed.data.schemaVersion).toBe(SCHEMA_VERSION)
    expect(parsed.data.activities).toEqual([])
    expect(parsed.data.cards[0]).toMatchObject({ note: "", label: null, priority: null, createdAt: null, createdBy: null, comments: [] })
  })

  it("rejects malformed entities and dangling references", () => {
    const malformed = parseBoardText(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      columns: [null],
      labels: [],
      cards: [],
      activities: [],
    }))
    expect(malformed).toMatchObject({ ok: false, kind: "invalid" })

    const dangling = parseBoardText(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      columns: [{ id: "c1", title: "Todo" }],
      labels: [],
      cards: [{ id: "k1", columnId: "missing", title: "Broken", note: "", label: null, priority: null, comments: [] }],
      activities: [],
    }))
    expect(dangling).toMatchObject({ ok: false, kind: "invalid" })

    const invalidComments = parseBoardText(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      columns: [{ id: "c1", title: "Todo" }],
      labels: [],
      cards: [{
        id: "k1",
        columnId: "c1",
        title: "Broken comments",
        comments: [{ id: "m1", content: "  ", source: "human", createdAt: "now" }],
      }],
      activities: [],
    }))
    expect(invalidComments).toMatchObject({ ok: false, kind: "invalid" })

    const duplicateComments = parseBoardText(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      columns: [{ id: "c1", title: "Todo" }],
      labels: [],
      cards: [
        { id: "k1", columnId: "c1", title: "One", comments: [{ id: "m1", content: "A", source: "human", createdAt: "now" }] },
        { id: "k2", columnId: "c1", title: "Two", comments: [{ id: "m1", content: "B", source: "agent", createdAt: "now" }] },
      ],
      activities: [],
    }))
    expect(duplicateComments).toMatchObject({ ok: false, kind: "invalid" })
  })

  it("registers every model tool with a usable schema", () => {
    const { registered } = boot()
    const names = registered.map(({ name }) => name)

    // 15 base tools + item 6's six unattended verbs.
    expect(names).toHaveLength(21)
    expect(new Set(names).size).toBe(21)
    for (const verb of ["kanban_claim_card", "kanban_dispatch_card", "kanban_finalize_card",
      "kanban_bounce_card", "kanban_reap", "kanban_ready_cards"]) {
      expect(names).toContain(verb)
    }
    for (const registeredTool of registered) {
      expect(registeredTool.name).toMatch(/^kanban_/)
      expect(registeredTool.parameters).toMatchObject({ type: "object" })
      expect(typeof registeredTool.execute).toBe("function")
      expect(registeredTool.output.schema).toMatchObject({ type: "object", required: ["ok", "message"] })
    }

    expect(tool(registered, "kanban_add_card").parameters.required).toEqual(["title"])
    expect(tool(registered, "kanban_update_card").parameters.required).toEqual(["id"])
    expect(tool(registered, "kanban_add_comment").parameters.required).toEqual(["id", "content"])
    expect(tool(registered, "kanban_move_card").parameters.properties.toIndex).toMatchObject({ type: "integer" })
    expect(tool(registered, "kanban_add_card").parameters.properties.priority.enum).toEqual(["high", "medium", "low"])
    expect(tool(registered, "kanban_update_card").parameters.properties.priority.enum).toEqual(["high", "medium", "low", ""])
  })

  it("executes CRUD through registered tools and persists activity history", async () => {
    const { dir, registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Ship tests", note: "Keep the gate green", priority: "high" }, exec)
    expect(add).toMatchObject({ ok: true, message: expect.stringContaining("Card added") })
    const card = add.board.cards[0]
    const target = add.board.columns.find((column) => column.title === "Verify")

    const update = await tool(registered, "kanban_update_card").execute({ id: card.id, priority: "low" }, exec)
    expect(update).toMatchObject({ ok: true, message: "Card updated" })
    const commented = await tool(registered, "kanban_add_comment").execute({ id: card.id, content: "  Ready for review  " }, exec)
    expect(commented).toMatchObject({ ok: true, message: "Comment added", board: { cards: [{ id: card.id, commentCount: 1 }] } })
    const details = await tool(registered, "kanban_get_card").execute({ id: card.id }, exec)
    expect(details.card.comments).toEqual([
      expect.objectContaining({ content: "Ready for review", source: "agent", createdAt: expect.any(String) }),
    ])
    expect(tool(registered, "kanban_get_card").output.render({}, details)[0].text).toContain("Ready for review")
    const move = await tool(registered, "kanban_move_card").execute({ id: card.id, columnId: target.id }, exec)
    expect(move).toMatchObject({ ok: true, message: 'Moved to "Verify"' })
    const deleted = await tool(registered, "kanban_delete_card").execute({ id: card.id }, exec)
    expect(deleted).toMatchObject({ ok: true, message: "Card deleted" })

    const persisted = JSON.parse(readFileSync(boardPath(dir), "utf8"))
    expect(persisted.schemaVersion).toBe(SCHEMA_VERSION)
    expect(persisted.cards).toEqual([])
    expect(persisted.activities.map(({ type }) => type)).toEqual([
      "card_created",
      "card_priority_changed",
      "card_comment_added",
      "card_moved",
      "card_deleted",
    ])
  })

  it("stores the board outside the workspace, under ~/.dsh-boards/<project>/", async () => {
    const { dir, registered, exec } = boot()
    await tool(registered, "kanban_add_card").execute({ title: "Off-repo" }, exec)

    // The board landed at the redirected path, and NOT inside the workspace.
    expect(existsSync(boardPath(dir))).toBe(true)
    expect(existsSync(join(dir, ".dsh-kanban.json"))).toBe(false)
    expect(existsSync(join(dir, "board.json"))).toBe(false)

    // No write escaped the temp HOME — this is what proves the HOME swap actually
    // redirects BOARD_ROOT rather than the suite silently writing to the real one.
    expect(writeLog.length).toBeGreaterThan(0)
    for (const target of writeLog) expect(target.startsWith(homeDir)).toBe(true)

    // The file records its owning workspace so a basename collision can be caught.
    expect(JSON.parse(readFileSync(boardPath(dir), "utf8")).workspacePath).toBe(dir)
  })

  it("refuses to open a board directory owned by a different workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kanban-collide-"))
    workspaces.push(dir)
    // Same basename, different workspace path — the collision the slug can produce.
    // The board must carry all eight stages: since v4 a current-version board missing
    // one is quarantined as corrupt, which would mask the collision stop being tested.
    seedBoard(dir, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      workspacePath: "/some/other/checkout/" + basename(dir),
      columns: RESERVED_STAGE_TITLES.map((title, i) => ({ id: "c" + (i + 1), title })),
      labels: [], cards: [], activities: [],
    }))
    const { registered, exec } = boot(dir)

    const result = await tool(registered, "kanban_add_card").execute({ title: "Must not merge" }, exec)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("Board directory collision")

    // Same durability requirement as the quarantine path: the stop must still be
    // reported on a later read, not consumed by whoever read first.
    await tool(registered, "kanban_get").execute({}, exec)
    const later = await tool(registered, "kanban_get").execute({}, exec)
    expect(later.warnings.some((w) => w.includes("Board directory collision"))).toBe(true)
    expect(later.board.readOnlyReason).toContain("Board directory collision")
  })

  // Reproduces the measured 2026-09-02 dogfooding loss: writing the real remaining
  // work to the board truncated 6 of 7 notes at exactly 500 chars, ok:true, no warning
  // — one card lost its own HARD DO-NOT mid-clause. Over-limit input must now be
  // REFUSED (the comment behaviour), never silently sliced.
  it("refuses an over-limit note instead of truncating it", async () => {
    const { registered, exec } = boot()
    const add = tool(registered, "kanban_add_card")

    const big = "x".repeat(NOTE_LIMIT + 1)
    const refused = await add.execute({ title: "Too long", note: big }, exec)
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("Note exceeds")
    // Nothing was written — a refusal must not half-create the card.
    expect(refused.board.cards ?? []).toHaveLength(0)

    // A long-but-legal note is kept in full: the old cap would have sliced this at 500.
    const long = "y".repeat(NOTE_LIMIT)
    const ok = await add.execute({ title: "Long but legal", note: long }, exec)
    expect(ok.ok).toBe(true)
    const card = ok.board.cards.find((c) => c.title === "Long but legal")
    const details = await tool(registered, "kanban_get_card").execute({ id: card.id }, exec)
    expect(details.card.note).toHaveLength(NOTE_LIMIT)

    // updateCard has the identical guard, and must not clobber the stored note on refusal.
    const upd = await tool(registered, "kanban_update_card").execute({ id: card.id, note: big }, exec)
    expect(upd).toMatchObject({ ok: false, message: expect.stringContaining("Note exceeds") })
    const after = await tool(registered, "kanban_get_card").execute({ id: card.id }, exec)
    expect(after.card.note).toHaveLength(NOTE_LIMIT)
  })

  it("gives every new card a typed v5 state and persists it", async () => {
    const { dir, registered, exec } = boot()
    const added = await tool(registered, "kanban_add_card").execute({ title: "Stateful" }, exec)
    const id = added.board.cards[0].id

    const persisted = JSON.parse(readFileSync(boardPath(dir), "utf8"))
    expect(persisted.schemaVersion).toBe(SCHEMA_VERSION)
    expect(persisted.cards[0].state).toEqual(EMPTY_STATE)
    // workspacePath is now a known validated field, not a tolerated unknown.
    expect(persisted.workspacePath).toBe(dir)

    // state survives the clone path the tools return through.
    const details = await tool(registered, "kanban_get_card").execute({ id }, exec)
    expect(details.card.state).toEqual(EMPTY_STATE)
  })

  it("routes by explicit workspaceId in preference to the calling cwd", async () => {
    const other = mkdtempSync(join(tmpdir(), "dsh-kanban-other-"))
    workspaces.push(other)
    const otherWorkspace = { id: "ws-other", path: other, title: "Other" }
    const { dir, registered, exec } = boot(undefined, { extra: [otherWorkspace] })

    // Same exec (cwd = dir) for both calls; only workspaceId differs.
    await tool(registered, "kanban_add_card").execute({ title: "Belongs to other" , workspaceId: "ws-other" }, exec)
    await tool(registered, "kanban_add_card").execute({ title: "Belongs to cwd" }, exec)

    const otherBoard = JSON.parse(readFileSync(boardPath(other), "utf8"))
    const cwdBoard = JSON.parse(readFileSync(boardPath(dir), "utf8"))
    expect(otherBoard.cards.map((c) => c.title)).toEqual(["Belongs to other"])
    expect(cwdBoard.cards.map((c) => c.title)).toEqual(["Belongs to cwd"])

    // Reads honour it too, and the id never leaks into the persisted board.
    const read = await tool(registered, "kanban_get").execute({ workspaceId: "ws-other" }, exec)
    expect(read.board.cards.map((c) => c.title)).toEqual(["Belongs to other"])
    expect(otherBoard.workspaceId).toBeUndefined()
  })

  it("rejects an unknown workspaceId instead of falling back to the cwd board", async () => {
    const { dir, registered, exec } = boot()

    const result = await tool(registered, "kanban_add_card").execute({ title: "Nowhere", workspaceId: "ws-missing" }, exec)
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Unknown workspaceId: ws-missing") })
    // The point of refusing: a typo must not silently write to the cwd board.
    expect(existsSync(boardPath(dir))).toBe(false)
  })

  // Reproduces the measured 2026-09-02 defect: a cron agent with no cwd of its own
  // resolves `cwd:/home/james`, invents a board there, and reports plain success.
  // The board is still written (the fallback is deliberate), but it can no longer be silent.
  it("warns when the workspace came from an unregistered cwd", async () => {
    const stray = mkdtempSync(join(tmpdir(), "dsh-kanban-stray-"))
    workspaces.push(stray)
    const { registered } = boot()
    const strayExec = { agent: { session: { header: { cwd: stray } } } }

    const result = await tool(registered, "kanban_add_card").execute({ title: "Phantom" }, strayExec)
    expect(result.ok).toBe(true)
    expect(result.warnings[0]).toContain("Workspace not registered")
    expect(result.warnings[0]).toContain(boardPath(stray))

    // kanban_get_label takes its own path to the workspace; it must warn too.
    const labels = await tool(registered, "kanban_get_label").execute({}, strayExec)
    expect(labels.warnings[0]).toContain("Workspace not registered")

    // A registered workspace stays quiet — this is what makes the warning attributable.
    // Note the control must use its OWN boot's tools: the registry is per-boot, so
    // reusing `registered` here would make the control's cwd unregistered too.
    const control = boot()
    const clean = await tool(control.registered, "kanban_get").execute({}, control.exec)
    expect(clean.warnings).toEqual([])
  })

  it("refuses to rename or delete a reserved pipeline stage", async () => {
    const { registered, exec } = boot()
    const board = await tool(registered, "kanban_get").execute({}, exec)
    const spec = board.board.columns.find((c) => c.title === "Spec")

    const renamed = await tool(registered, "kanban_rename_column").execute({ id: spec.id, title: "Backlog" }, exec)
    expect(renamed).toMatchObject({ ok: false, message: expect.stringContaining("reserved pipeline stage") })

    const deleted = await tool(registered, "kanban_delete_column").execute({ id: spec.id }, exec)
    expect(deleted).toMatchObject({ ok: false, message: expect.stringContaining("reserved pipeline stage") })

    // A non-reserved column is still fully editable — the guard is structural, not blanket.
    const added = await tool(registered, "kanban_add_column").execute({ title: "Scratch" }, exec)
    const scratch = added.board.columns.find((c) => c.title === "Scratch")
    expect(await tool(registered, "kanban_rename_column").execute({ id: scratch.id, title: "Scratch2" }, exec)).toMatchObject({ ok: true })
    expect(await tool(registered, "kanban_delete_column").execute({ id: scratch.id }, exec)).toMatchObject({ ok: true })
  })

  it("rejects invalid comment mutations", async () => {
    const { registered, exec } = boot()
    const addCard = await tool(registered, "kanban_add_card").execute({ title: "Comment target" }, exec)
    const cardId = addCard.board.cards[0].id
    const addComment = tool(registered, "kanban_add_comment")

    expect(await addComment.execute({ id: "missing", content: "Hello" }, exec)).toMatchObject({ ok: false, message: expect.stringContaining("Card not found") })
    expect(await addComment.execute({ id: cardId, content: "   " }, exec)).toMatchObject({ ok: false, message: "Comment content required" })
    expect(await addComment.execute({ id: cardId, content: "x".repeat(2001) }, exec)).toMatchObject({ ok: false, message: "Comment exceeds 2000 characters" })
  })

  it("backs up and writes back a migrated workspace file on first tool access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kanban-migration-"))
    workspaces.push(dir)
    seedBoard(dir, JSON.stringify({
      schemaVersion: 1,
      columns: [{ id: "c1", title: "Todo" }],
      labels: [],
      cards: [{ id: "k1", columnId: "c1", title: "Old" }],
    }))
    const { registered, exec } = boot(dir)
    const result = await tool(registered, "kanban_get").execute({}, exec)

    expect(result).toMatchObject({ ok: true, board: { cards: [{ id: "k1", title: "Old" }] } })
    expect(result.warnings.some((warning) => warning.includes("automatically upgraded"))).toBe(true)
    expect(existsSync(boardPath(dir, ".bak-v1"))).toBe(true)
    expect(JSON.parse(readFileSync(boardPath(dir), "utf8"))).toMatchObject({ schemaVersion: SCHEMA_VERSION, activities: [], cards: [{ comments: [] }] })
  })

  it("serializes concurrent mutations before persisting", async () => {
    const { dir, registered, exec } = boot(undefined, {
      writeDelay: (content) => content.includes("First") && !content.includes("Second") ? 30 : 0,
    })
    const add = tool(registered, "kanban_add_card")
    const [first, second] = await Promise.all([
      add.execute({ title: "First" }, exec),
      add.execute({ title: "Second" }, exec),
    ])

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const persisted = JSON.parse(readFileSync(boardPath(dir), "utf8"))
    expect(persisted.cards.map(({ title }) => title)).toEqual(["First", "Second"])
  })

  // ---- item 6's verbs, item 8's concurrency (cards k36 / k40) ----
  // Probe E measured 8/8 lost writers for a read-then-write claim. A SEQUENTIAL
  // claim test passes against that broken shape, so these fire the calls
  // concurrently and assert exactly one winner — that is the whole point.
  it("claims a card atomically: exactly one of N concurrent claimants wins", async () => {
    const { registered, exec } = boot(undefined, {
      // Stall the first persist so every claimant is in flight together; without
      // the queue this window is exactly where the second writer clobbers the first.
      writeDelay: (content) => (content.includes("run-a") ? 30 : 0),
    })
    const add = await tool(registered, "kanban_add_card").execute({ title: "Contended" }, exec)
    const id = add.board.cards[0].id
    const claim = tool(registered, "kanban_claim_card")

    const runs = ["run-a", "run-b", "run-c", "run-d", "run-e", "run-f", "run-g", "run-h"]
    const results = await Promise.all(runs.map((r) => claim.execute({ id, ownerRunId: r }, exec)))

    const winners = results.filter((r) => r.ok)
    expect(winners).toHaveLength(1)
    // Every loser is told it lost, naming the holder — never a silent no-op.
    for (const lost of results.filter((r) => !r.ok)) expect(lost.message).toContain("claim lost")

    // The board agrees with the single winner, and the winner is one of the callers.
    const after = await tool(registered, "kanban_get_card").execute({ id }, exec)
    expect(runs).toContain(after.card.state.owner)
    expect(after.card.state.owner).toBe(after.card.state.ownerRunId)
    expect(after.card.state.heartbeatAt).toBeTruthy()
  })

  // finalize guards a DIFFERENT race than claim: two reconcilers both observing
  // one finished team. Same card, same dispatched stage, concurrent finalize.
  it("finalizes a dispatched stage atomically: the second reconciler is rejected", async () => {
    const { registered, exec } = boot(undefined, {
      writeDelay: (content) => (content.includes("Decompose") ? 30 : 0),
    })
    const add = await tool(registered, "kanban_add_card").execute({ title: "Dispatched work" }, exec)
    const id = add.board.cards[0].id
    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "run-1" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id, stage: "Spec", teamName: "t-1" }, exec)

    const finalize = tool(registered, "kanban_finalize_card")
    const [a, b] = await Promise.all([
      finalize.execute({ id, stage: "Spec", outcome: "promote" }, exec),
      finalize.execute({ id, stage: "Spec", outcome: "promote" }, exec),
    ])

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect((a.ok ? b : a).message).toContain("finalize lost")
    // Exactly ONE promote was applied — a double-write would land it in Build.
    const after = await tool(registered, "kanban_get_card").execute({ id }, exec)
    const cols = after.card ? (await tool(registered, "kanban_get").execute({}, exec)).board.columns : []
    expect(cols.find((c) => c.id === after.card.columnId).title).toBe("Decompose")
    expect(after.card.state.dispatched).toBe(null)
    expect(after.card.state.owner).toBe(null)
  })

  it("bounces backward with counters and a reason, in one atomic write", async () => {
    const { registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Failing work" }, exec)
    const id = add.board.cards[0].id
    const board = await tool(registered, "kanban_get").execute({}, exec)
    const verify = board.board.columns.find((c) => c.title === "Verify")
    await tool(registered, "kanban_move_card").execute({ id, columnId: verify.id }, exec)

    const bounced = await tool(registered, "kanban_bounce_card").execute(
      { id, toStage: "Build", reason: "pytest exit 1: test_notify.py::test_dedup — assert 2 == 1" }, exec)
    expect(bounced.ok).toBe(true)

    const after = await tool(registered, "kanban_get_card").execute({ id }, exec)
    expect(after.card.state.bounceCount).toBe(1)
    expect(after.card.state.bouncesByEdge["Verify->Build"]).toBe(1)
    expect(after.card.state.lastBounceReason).toContain("pytest exit 1")
    // A bounce ends the stage: the claim is released so the next run can take it.
    expect(after.card.state.owner).toBe(null)
    // A vague reason is refused rather than stored.
    const vague = await tool(registered, "kanban_bounce_card").execute({ id, toStage: "Build", reason: "" }, exec)
    expect(vague.ok).toBe(false)
  })

  it("reaps only stale claims and never promotes them", async () => {
    const { dir, registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Crashed mid-flight" }, exec)
    const fresh = await tool(registered, "kanban_add_card").execute({ title: "Healthy" }, exec)
    const staleId = add.board.cards[0].id
    const freshId = fresh.board.cards[1].id
    await tool(registered, "kanban_claim_card").execute({ id: staleId, ownerRunId: "dead-run" }, exec)
    await tool(registered, "kanban_claim_card").execute({ id: freshId, ownerRunId: "live-run" }, exec)

    // Age only the first card's heartbeat, through the file, then reload.
    const onDisk = JSON.parse(readFileSync(boardPath(dir), "utf8"))
    onDisk.cards.find((c) => c.id === staleId).state.heartbeatAt = "2020-01-01T00:00:00.000Z"
    seedBoard(dir, JSON.stringify(onDisk))
    const reloaded = boot(dir)

    const reaped = await tool(reloaded.registered, "kanban_reap").execute({ staleAfterSeconds: 600 }, reloaded.exec)
    expect(reaped.ok).toBe(true)
    expect(reaped.message).toContain("1 stale claim")

    const stale = await tool(reloaded.registered, "kanban_get_card").execute({ id: staleId }, reloaded.exec)
    expect(stale.card.state.owner).toBe(null)
    expect(stale.card.state.lastBounceReason).toContain("reaped")
    // Reaping must not move the card — the evidence-producing run is gone.
    expect(stale.card.columnId).toBe(add.board.cards[0].columnId)
    const healthy = await tool(reloaded.registered, "kanban_get_card").execute({ id: freshId }, reloaded.exec)
    expect(healthy.card.state.owner).toBe("live-run")
  })

  // k311: promote must walk the PIPELINE (six working stages), not the eight
  // reserved titles. RESERVED_STAGE_TITLES is a storage list in which Blocked and
  // Archive merely sit at the end, so idx+1 promoted Merge INTO Blocked and
  // Blocked into Archive. Merge is the pipeline's success terminus, so the first
  // card ever to complete the flow landed in the blocked pile — logged as a
  // legitimate promote, with no reason recorded. No human error required.
  it("promotes along the pipeline: Merge exits to Archive, never into Blocked", async () => {
    const { registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Walks the ladder" }, exec)
    const id = add.board.cards[0].id
    const claim = tool(registered, "kanban_claim_card")
    const dispatch = tool(registered, "kanban_dispatch_card")
    const finalize = tool(registered, "kanban_finalize_card")

    const titleOf = (res) => {
      const card = res.board.cards.find((c) => c.id === id)
      return res.board.columns.find((c) => c.id === card.columnId).title
    }

    // The six ordinary steps still work, in order.
    for (const stage of ["Spec", "Decompose", "Build", "Verify", "Review"]) {
      await claim.execute({ id, ownerRunId: "run-" + stage }, exec)
      await dispatch.execute({ id, stage, teamName: "t" }, exec)
      const res = await finalize.execute({ id, stage, outcome: "promote" }, exec)
      expect(res.ok, `promote from ${stage}`).toBe(true)
    }
    // Now in Merge — the success terminus. THE BUG: this used to land in Blocked.
    await claim.execute({ id, ownerRunId: "run-merge" }, exec)
    await dispatch.execute({ id, stage: "Merge", teamName: "t" }, exec)
    const merged = await finalize.execute({ id, stage: "Merge", outcome: "promote" }, exec)
    expect(merged.ok).toBe(true)
    expect(titleOf(merged), "a merged card must not be promoted into Blocked").toBe("Archive")
  })

  it("refuses to promote a card parked in Blocked", async () => {
    const { registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Parked" }, exec)
    const id = add.board.cards[0].id
    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "run-a" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id, stage: "Spec", teamName: "t" }, exec)
    const parked = await tool(registered, "kanban_finalize_card")
      .execute({ id, stage: "Spec", outcome: "blocked", reason: "upstream API is down" }, exec)
    expect(parked.ok).toBe(true)

    // A blocked card is unparked by a human or bounced — never promoted.
    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "run-b" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id, stage: "Blocked", teamName: "t" }, exec)
    const res = await tool(registered, "kanban_finalize_card")
      .execute({ id, stage: "Blocked", outcome: "promote" }, exec)
    expect(res.ok).toBe(false)
    expect(res.message).toContain("not a pipeline stage")
  })

  // k226: three of the four stage-taking verbs accept a stage TITLE; moveCard
  // accepted only an id, and answered "Card or list not found" for both possible
  // causes. The last assertion is the one that would have saved a round trip: the
  // natural reading of that string sent me to check the card list when the card
  // was fine and only the column argument's FORM was wrong.
  it("moves by stage title as well as id, and says which argument was wrong", async () => {
    const { registered, exec } = boot()
    const move = tool(registered, "kanban_move_card")
    const add = tool(registered, "kanban_add_card")
    const byTitle = (await add.execute({ title: "By title" }, exec)).board.cards[0].id
    const byId = (await add.execute({ title: "By id" }, exec)).board.cards.find((c) => c.title === "By id").id

    const titleMove = await move.execute({ id: byTitle, columnId: "Build" }, exec)
    expect(titleMove, "a stage title must work here as it does in bounce/finalize").toMatchObject({
      ok: true,
      message: 'Moved to "Build"',
    })

    // The id form must keep working — this is an added fallback, not a swap.
    const buildId = titleMove.board.columns.find((c) => c.title === "Build").id
    expect(await move.execute({ id: byId, columnId: buildId }, exec)).toMatchObject({ ok: true, message: 'Moved to "Build"' })

    const badCard = await move.execute({ id: "nope", columnId: "Build" }, exec)
    const badColumn = await move.execute({ id: byId, columnId: "Nonsense" }, exec)
    expect(badCard.message).toContain("Card not found: nope")
    expect(badColumn.message).toContain("Unknown target list: Nonsense")
    expect(badCard.message, "two independent causes must not share one message").not.toBe(badColumn.message)
  })

  // k179 (decision (ii), 2026-09-03): a human drag is ALWAYS allowed — refusing it
  // would be the transition guard plan:710 rejects. But moving a card to another
  // STAGE clears the claim, so the agent's finalize is rejected through the
  // existing "lost" path instead of silently promoting from the card's new column.
  it("clears the claim when a human moves a claimed card to another stage", async () => {
    const { registered, exec, workspace } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Contested" }, exec)
    const id = add.board.cards[0].id
    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "run-a" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id, stage: "Spec", teamName: "team-1" }, exec)

    const build = add.board.columns.find((c) => c.title === "Build").id
    const moved = await tool(registered, "kanban_move_card").execute({ id, columnId: build }, exec)
    expect(moved.ok).toBe(true)
    expect(moved.message).toContain("released the claim")

    const after = await tool(registered, "kanban_get_card").execute({ id }, exec)
    expect(after.card.state.owner).toBe(null)
    expect(after.card.state.dispatched).toBe(null)

    // THE POINT: the agent's finalize is now rejected as lost, rather than
    // promoting from Build (where the human put it) as if it had worked there.
    const late = await tool(registered, "kanban_finalize_card")
      .execute({ id, stage: "Spec", ownerRunId: "run-a", outcome: "promote" }, exec)
    expect(late.ok).toBe(false)
    expect(late.message).toContain("finalize lost")
    expect(workspace).toBeTruthy()
  })

  // A same-column REORDER is not a stage change: the team is still working the
  // same stage, so destroying its claim because a human tidied the column order
  // would burn live work for nothing.
  it("preserves the claim when a human reorders within the same column", async () => {
    const { registered, exec } = boot()
    await tool(registered, "kanban_add_card").execute({ title: "first" }, exec)
    const second = await tool(registered, "kanban_add_card").execute({ title: "second" }, exec)
    const id = second.board.cards[1].id
    const spec = second.board.columns.find((c) => c.title === "Spec").id
    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "run-a" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id, stage: "Spec", teamName: "team-1" }, exec)

    const moved = await tool(registered, "kanban_move_card").execute({ id, columnId: spec, toIndex: 0 }, exec)
    expect(moved.ok).toBe(true)
    expect(moved.message).not.toContain("released the claim")

    const after = await tool(registered, "kanban_get_card").execute({ id }, exec)
    expect(after.card.state.owner, "a reorder must not steal a live claim").toBe("run-a")
    expect(after.card.state.dispatched).toMatchObject({ stage: "Spec", teamName: "team-1" })
  })

  // k183: a DISPATCHED card keeps its claim by design, because the team outlives
  // the run that started it — so nothing can ever refresh its heartbeat and the
  // clock is not a valid staleness signal for it. Before this, any team slower
  // than the threshold had its card stolen deterministically, and a later tick
  // dispatched a SECOND team for the same stage.
  it("never reaps a dispatched card on the clock alone", async () => {
    const { dir, registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Long build" }, exec)
    const id = add.board.cards[0].id
    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "run-a" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id, stage: "Build", teamName: "team-1" }, exec)

    // Age the heartbeat far past any threshold: the team is simply slow.
    const onDisk = JSON.parse(readFileSync(boardPath(dir), "utf8"))
    onDisk.cards.find((c) => c.id === id).state.heartbeatAt = "2020-01-01T00:00:00.000Z"
    seedBoard(dir, JSON.stringify(onDisk))
    const reloaded = boot(dir)

    const reaped = await tool(reloaded.registered, "kanban_reap").execute({ staleAfterSeconds: 60 }, reloaded.exec)
    expect(reaped.message).toContain("0 stale claim")
    const card = await tool(reloaded.registered, "kanban_get_card").execute({ id }, reloaded.exec)
    expect(card.card.state.owner, "a slow team must not have its card stolen").toBe("run-a")
    expect(card.card.state.dispatched).toMatchObject({ stage: "Build", teamName: "team-1" })
  })

  // The authoritative branch: absence from a COMPLETE live-run snapshot is a fact
  // the caller vouches for, so it reaps even a dispatched card.
  it("reaps a dispatched card when its run is absent from a live-run snapshot", async () => {
    const { registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Orphaned build" }, exec)
    const id = add.board.cards[0].id
    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "dead-run" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id, stage: "Build", teamName: "team-x" }, exec)

    const reaped = await tool(registered, "kanban_reap").execute({
      staleAfterSeconds: 86400,
      liveRunIds: ["some-other-run"],
      liveRunsAsOf: new Date(Date.now() + 1000).toISOString(),
    }, exec)
    expect(reaped.message).toContain("1 stale claim")
    expect(reaped.released[0].basis).toBe("run-not-live")
    const card = await tool(registered, "kanban_get_card").execute({ id }, exec)
    expect(card.card.state.owner).toBe(null)
    // The reason must name the evidence, and must NOT claim the run "went stale".
    expect(card.card.state.lastBounceReason).toContain("not among the live runs")
  })

  // THE SNAPSHOT RACE. A claim made AFTER the snapshot was taken could not
  // possibly have appeared in it, so its absence proves nothing. Reaping it would
  // steal a brand-new, perfectly healthy claim — the same theft this card fixes,
  // just sourced from a stale snapshot instead of a clock.
  it("never reaps a claim newer than the live-run snapshot", async () => {
    const { registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Just claimed" }, exec)
    const id = add.board.cards[0].id
    const snapshotAt = new Date(Date.now() - 60_000).toISOString()
    // Claimed now, i.e. a full minute after the snapshot was taken.
    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "brand-new-run" }, exec)

    const reaped = await tool(registered, "kanban_reap").execute({
      staleAfterSeconds: 86400,
      liveRunIds: [],
      liveRunsAsOf: snapshotAt,
    }, exec)
    expect(reaped.message).toContain("0 stale claim")
    const card = await tool(registered, "kanban_get_card").execute({ id }, exec)
    expect(card.card.state.owner, "a claim newer than the snapshot must survive").toBe("brand-new-run")
  })

  // Fail closed: a half-supplied or malformed snapshot must REFUSE, never silently
  // degrade to the weaker clock pass. A typo'd argument must not quietly change
  // which policy runs.
  it("refuses a liveness snapshot that cannot be trusted", async () => {
    const { registered, exec } = boot()
    const reap = tool(registered, "kanban_reap")
    const bad = [
      { staleAfterSeconds: 60, liveRunIds: ["a"] },
      { staleAfterSeconds: 60, liveRunsAsOf: new Date().toISOString() },
      { staleAfterSeconds: 60, liveRunIds: "a", liveRunsAsOf: new Date().toISOString() },
      { staleAfterSeconds: 60, liveRunIds: ["a", ""], liveRunsAsOf: new Date().toISOString() },
      { staleAfterSeconds: 60, liveRunIds: ["a"], liveRunsAsOf: "not-a-date" },
    ]
    for (const args of bad) {
      const res = await reap.execute(args, exec)
      expect(res.ok, `must refuse: ${JSON.stringify(args)}`).toBe(false)
    }
  })

  it("lists only unowned cards in working stages as ready", async () => {
    const { registered, exec } = boot()
    const a = await tool(registered, "kanban_add_card").execute({ title: "Free" }, exec)
    const freeId = a.board.cards[0].id
    const b = await tool(registered, "kanban_add_card").execute({ title: "Owned" }, exec)
    const ownedId = b.board.cards[1].id
    const c = await tool(registered, "kanban_add_card").execute({ title: "Parked" }, exec)
    const parkedId = c.board.cards[2].id

    await tool(registered, "kanban_claim_card").execute({ id: ownedId, ownerRunId: "run-1" }, exec)
    const cols = (await tool(registered, "kanban_get").execute({}, exec)).board.columns
    await tool(registered, "kanban_move_card").execute({ id: parkedId, columnId: cols.find((x) => x.title === "Blocked").id }, exec)

    const ready = await tool(registered, "kanban_ready_cards").execute({}, exec)
    const ids = ready.cards.map((k) => k.id)
    expect(ids).toContain(freeId)
    expect(ids).not.toContain(ownedId)
    expect(ids).not.toContain(parkedId)
  })

  // Ordering is JUDGEMENT, so the board owns it rather than the 3am prompt: the
  // plan's STEP 2 says priority high > medium > low (the board's own enum), then
  // oldest. Insertion order here is deliberately the REVERSE of the expected
  // order, so a verb that just returns board order fails this.
  it("returns ready cards in priority then oldest-first order", async () => {
    const { registered, exec } = boot()
    const add = tool(registered, "kanban_add_card")
    const mk = async (title, priority) => (await add.execute({ title, ...(priority ? { priority } : {}) }, exec))
      .board.cards.find((c) => c.title === title).id

    const none = await mk("no priority")
    const lowOld = await mk("low old", "low")
    const highNew = await mk("high new", "high")
    const medium = await mk("medium", "medium")
    // Same priority, created later than highNew — must come after it.
    const highOlder = await mk("high newer", "high")

    const ready = await tool(registered, "kanban_ready_cards").execute({}, exec)
    const ordered = ready.cards.map((c) => c.id)
    expect(ordered).toEqual([highNew, highOlder, medium, lowOld, none])
  })

  // Every verb's refusal path. A verb that fails silently, or half-applies, is
  // worse than one that errors: at 3am nobody reads the difference.
  it("refuses invalid verb input without mutating the card", async () => {
    const { registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Untouched" }, exec)
    const id = add.board.cards[0].id
    const before = (await tool(registered, "kanban_get_card").execute({ id }, exec)).card

    const cases = [
      ["kanban_claim_card", { id, ownerRunId: "" }, "ownerRunId is required"],
      ["kanban_claim_card", { id: "nope", ownerRunId: "r" }, "Card not found"],
      ["kanban_bounce_card", { id, toStage: "Nowhere", reason: "x" }, "Unknown target stage"],
      ["kanban_reap", { staleAfterSeconds: 0 }, "must be a positive number"],
      ["kanban_reap", { staleAfterSeconds: -5 }, "must be a positive number"],
      ["kanban_finalize_card", { id, stage: "Spec", outcome: "sideways" }, "outcome must be one of"],
      ["kanban_finalize_card", { id, stage: "Spec", outcome: "promote" }, "no dispatched stage"],
      ["kanban_dispatch_card", { id, stage: "Spec", teamName: "t" }, "not claimed"],
    ]
    for (const [name, args, expected] of cases) {
      const r = await tool(registered, name).execute(args, exec)
      expect(r.ok, name + " " + JSON.stringify(args)).toBe(false)
      expect(r.message).toContain(expected)
    }

    const after = (await tool(registered, "kanban_get_card").execute({ id }, exec)).card
    expect(after.state).toEqual(before.state)
    expect(after.columnId).toBe(before.columnId)
  })

  // finalize's CAS must reject a stage MISMATCH too, not just a missing dispatch —
  // that is the "another tick already finalized and re-dispatched" case.
  it("rejects a finalize for the wrong stage or the wrong run", async () => {
    const { registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Staged" }, exec)
    const id = add.board.cards[0].id
    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "run-1" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id, stage: "Spec", teamName: "t-1" }, exec)

    const wrongStage = await tool(registered, "kanban_finalize_card")
      .execute({ id, stage: "Build", outcome: "promote" }, exec)
    expect(wrongStage.ok).toBe(false)
    expect(wrongStage.message).toContain("is dispatched for Spec, not Build")

    const wrongRun = await tool(registered, "kanban_finalize_card")
      .execute({ id, stage: "Spec", outcome: "promote", ownerRunId: "run-2" }, exec)
    expect(wrongRun.ok).toBe(false)
    expect(wrongRun.message).toContain("held by run-1")

    // Still dispatched: a rejected finalize changed nothing.
    const after = await tool(registered, "kanban_get_card").execute({ id }, exec)
    expect(after.card.state.dispatched).toMatchObject({ stage: "Spec", teamName: "t-1" })
  })

  // readyCards is in READ_METHODS so it survives quarantine — but a quarantined
  // board is EMPTY, so it must report zero ready cards WITH the warning, never a
  // bare empty list that a tick would read as "no work to do".
  it("returns no ready cards but keeps warning on a quarantined board", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kanban-ready-q-"))
    workspaces.push(dir)
    seedBoard(dir, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      workspacePath: dir,
      columns: RESERVED_STAGE_TITLES.map((title, i) => ({ id: "c" + (i + 1), title })),
      labels: [],
      cards: [{ id: "k1", columnId: "c1", title: "Real work", comments: [], state: { ...EMPTY_STATE, owner: "tick-1" } }],
      activities: [],
    }))
    const { registered, exec } = boot(dir)

    const ready = await tool(registered, "kanban_ready_cards").execute({}, exec)
    expect(ready.ok).toBe(true)
    expect(ready.cards).toEqual([])
    expect(ready.warnings.some((w) => w.includes("quarantined"))).toBe(true)
    // And a second call still warns — the k101 durability rule applies here too.
    const again = await tool(registered, "kanban_ready_cards").execute({}, exec)
    expect(again.warnings.some((w) => w.includes("quarantined"))).toBe(true)
    // Mutating verbs remain refused on a quarantined board.
    const claim = await tool(registered, "kanban_claim_card").execute({ id: "k1", ownerRunId: "r" }, exec)
    expect(claim.ok).toBe(false)
    expect(claim.message).toContain("quarantined")
  })

  // THE RACE THE IN-PROCESS QUEUE CANNOT SEE (card k132). The Promise.all claim
  // test above passes with this bug present: workspaceQueues serializes callers
  // inside ONE apply() instance, but two dsh processes each boot their own board
  // cache, read the same file, and write it back — a lost update. Measured with
  // real forked processes in probes/probe-g-cross-process-claim.mjs (4/4 claimants
  // each believed they won). Two independent boot() instances over one board file
  // reproduce it deterministically, with no forking and no timing luck.
  it("refuses a claim when another instance wrote the board first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kanban-xproc-"))
    workspaces.push(dir)
    const first = boot(dir)
    const add = await tool(first.registered, "kanban_add_card").execute({ title: "Contended" }, first.exec)
    const id = add.board.cards[0].id

    // A SECOND instance reads the same file — the state a second dsh process,
    // a canary boot, or a human running the tick by hand would be in.
    const second = boot(dir)
    await tool(second.registered, "kanban_get").execute({}, second.exec)

    // Instance one claims and persists. Instance two is now holding a stale read.
    const won = await tool(first.registered, "kanban_claim_card").execute({ id, ownerRunId: "run-1" }, first.exec)
    expect(won.ok).toBe(true)

    // Instance two must NOT be able to write its own claim over that.
    const lost = await tool(second.registered, "kanban_claim_card").execute({ id, ownerRunId: "run-2" }, second.exec)
    expect(lost.ok).toBe(false)
    expect(lost.message).toContain("changed on disk")

    // The disk still shows the real winner, and nothing was clobbered.
    const persisted = JSON.parse(readFileSync(boardPath(dir), "utf8"))
    expect(persisted.cards.find((c) => c.id === id).state.owner).toBe("run-1")

    // The loser recovers: its next read reloads from disk and sees the truth, so a
    // rejected write never leaves an instance stuck on a stale board. The retry is
    // then refused as an ordinary lost claim — the documented, expected outcome.
    const reread = await tool(second.registered, "kanban_get_card").execute({ id }, second.exec)
    expect(reread.card.state.owner).toBe("run-1")
    const retry = await tool(second.registered, "kanban_claim_card").execute({ id, ownerRunId: "run-2" }, second.exec)
    expect(retry.ok).toBe(false)
    expect(retry.message).toContain("claim lost")
  })

  it("rolls back memory and reports a failed write", async () => {
    const { registered, exec } = boot(undefined, { failWrites: true })
    const result = await tool(registered, "kanban_add_card").execute({ title: "Must persist" }, exec)

    expect(result.ok).toBe(false)
    expect(result.message).toContain("ENOSPC")
    expect(result.board.cards).toEqual([])
  })

  it("rolls back a comment when persistence fails", async () => {
    const options = {}
    const { registered, exec } = boot(undefined, options)
    const add = await tool(registered, "kanban_add_card").execute({ title: "Must stay clean" }, exec)
    const cardId = add.board.cards[0].id
    options.failWrites = true

    const result = await tool(registered, "kanban_add_comment").execute({ id: cardId, content: "Do not retain" }, exec)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("ENOSPC")
    expect(result.board.cards[0].commentCount).toBe(0)
  })

  // The rollback snapshot is a deep clone of the whole board, so card.state must
  // come back with it. If a failed write left a stale owner/lease behind, item 6's
  // reap would see a card as held by a worker that never actually claimed it.
  it("restores card state when a write fails mid-mutation", async () => {
    const options = {}
    const { dir, registered, exec } = boot(undefined, options)
    const add = await tool(registered, "kanban_add_card").execute({ title: "Leased" }, exec)
    const cardId = add.board.cards[0].id

    // Put the card into a claimed-looking state through the persisted file, then reload.
    const onDisk = JSON.parse(readFileSync(boardPath(dir), "utf8"))
    onDisk.cards[0].state = { ...EMPTY_STATE, owner: "tick-1", ownerRunId: "cron-run-1", heartbeatAt: "2026-09-02T00:00:00.000Z", bounceCount: 2 }
    seedBoard(dir, JSON.stringify(onDisk))
    const fresh = boot(dir, options)
    const before = await tool(fresh.registered, "kanban_get_card").execute({ id: cardId }, fresh.exec)
    expect(before.card.state).toMatchObject({ owner: "tick-1", bounceCount: 2 })

    options.failWrites = true
    const failed = await tool(fresh.registered, "kanban_update_card").execute({ id: cardId, title: "Renamed" }, fresh.exec)
    expect(failed).toMatchObject({ ok: false, message: expect.stringContaining("ENOSPC") })

    options.failWrites = false
    const after = await tool(fresh.registered, "kanban_get_card").execute({ id: cardId }, fresh.exec)
    expect(after.card.title).toBe("Leased")
    expect(after.card.state).toMatchObject({ owner: "tick-1", ownerRunId: "cron-run-1", heartbeatAt: "2026-09-02T00:00:00.000Z", bounceCount: 2 })
  })

  // A quarantined board must be INERT, not an empty writable one. Measured live
  // 2026-09-02: a card written to a quarantined board returned 200 and persisted,
  // taking over the real board's file — an unattended tick would see zero cards and
  // could re-create the whole pipeline over it.
  it("disables writes after quarantining an invalid board", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kanban-quarantine-"))
    workspaces.push(dir)
    // Valid JSON, current version, but a card state that v4 rejects.
    seedBoard(dir, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      workspacePath: dir,
      columns: RESERVED_STAGE_TITLES.map((title, i) => ({ id: "c" + (i + 1), title })),
      labels: [],
      cards: [{ id: "k1", columnId: "c1", title: "Real work", comments: [], state: { ...EMPTY_STATE, owner: "tick-1" } }],
      activities: [],
    }))
    const { registered, exec } = boot(dir)

    const result = await tool(registered, "kanban_add_card").execute({ title: "Must not overwrite" }, exec)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("quarantined")
    expect(result.message).toContain("board.json.corrupt-")

    // The quarantine backup exists and still holds the original card.
    const backup = readdirSync(dirname(boardPath(dir))).find((f) => f.startsWith("board.json.corrupt-"))
    expect(backup).toBeTruthy()
    expect(JSON.parse(readFileSync(join(dirname(boardPath(dir)), backup), "utf8")).cards[0].title).toBe("Real work")

    // Reads still work — only mutations are refused.
    const read = await tool(registered, "kanban_get").execute({}, exec)
    expect(read.ok).toBe(true)

    // The quarantine must stay VISIBLE on every read, not just the first. Measured
    // live 2026-09-02: the second read reported "Board loaded", 0 cards, no warning
    // and no readOnlyReason, so a tick reading twice — or reading after a browser
    // poll consumed the one-shot warning — sees a healthy empty board.
    const second = await tool(registered, "kanban_get").execute({}, exec)
    expect(second.warnings.some((w) => w.includes("quarantined"))).toBe(true)
    expect(second.board.readOnlyReason).toContain("board.json.corrupt-")
  })

  // ---- /api/kanban trust boundary (item 7, card k38) ----
  // DECIDED OPTION B: this route has no authenticated session and cannot have one —
  // dsh-host-webserver hands the handler a raw (req, res) and nothing in the web
  // stack maps a request to a session. The real auth is the reverse proxy, one
  // layer out. So these are ABUSE GUARDS, NOT AUTHORIZATION, and the residual risk
  // is explicit: anything that reaches the port can address any registered board.
  // These tests pin the guards that DO exist so a refactor cannot quietly drop
  // them, and pin the residual behaviour so it cannot be mistaken for a control.
  describe("/api/kanban abuse guards", () => {
    const call = async (handler, { method = "POST", headers = {}, body = "" } = {}) => {
      const chunks = body ? [Buffer.from(body)] : []
      const req = Object.assign((async function* () { yield* chunks })(), {
        method,
        headers: { "content-type": "application/json", ...headers },
      })
      let status = 0
      let payload
      const res = {
        writeHead(code) { status = code },
        end(text) { payload = text ? JSON.parse(text) : undefined },
      }
      await handler(req, res)
      return { status, payload }
    }

    const bootRoute = (extra) => {
      let route
      const { workspace, registered, exec } = boot(undefined, {
        captureRoute: (r) => { route = r },
        ...(extra || {}),
      })
      expect(route, "the plugin must register /api/kanban").toBeTruthy()
      expect(route.path).toBe("/api/kanban")
      return { handler: route.handler, workspace, registered, exec }
    }

    it("refuses non-POST, non-JSON, oversized and cross-origin requests", async () => {
      const { handler, workspace } = bootRoute()
      const args = JSON.stringify({ method: "get", args: { workspaceId: workspace.id } })

      expect((await call(handler, { method: "GET" })).status).toBe(405)
      expect((await call(handler, { headers: { "content-type": "text/plain" } })).status).toBe(415)
      // Origin must match Host — the browser-side CSRF guard.
      const crossOrigin = await call(handler, {
        headers: { origin: "http://evil.example", host: "127.0.0.1:3080" },
        body: args,
      })
      expect(crossOrigin.status).toBe(403)
      // Same-origin is allowed through.
      expect((await call(handler, {
        headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" },
        body: args,
      })).status).toBe(200)
      // 1 MB body cap.
      const huge = await call(handler, { body: "x".repeat(1024 * 1024 + 10) })
      expect(huge.status).toBe(413)
    })

    it("refuses an unknown workspace instead of falling back to a default board", async () => {
      const { handler } = bootRoute()
      // The dangerous failure would be defaulting to SOME board; it must 400.
      for (const bad of [{ method: "get", args: { workspaceId: "no-such-ws" } }, { method: "get", args: {} }]) {
        const res = await call(handler, { body: JSON.stringify(bad) })
        expect(res.status).toBe(400)
        expect(res.payload.error).toContain("Unknown workspace")
      }
    })

    // A refused stale write is NOT a server fault: the host worked correctly and
    // declined to clobber another process's newer write. 500 reads as "outage" to
    // browsers, proxy logs and alert rules; 409 reads as "refetch and retry".
    // The HTTP path must be driven in ISOLATION here — if a tool call on the same
    // instance runs first it clears the stale cache (correct BOARD_STALE recovery)
    // and the HTTP call then succeeds with 200, hiding the bug. That false pass is
    // exactly what the first version of this check did.
    it("answers a stale-board write with 409, not 500", async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsh-kanban-409-"))
      workspaces.push(dir)
      const first = boot(dir)
      await tool(first.registered, "kanban_add_card").execute({ title: "seed" }, first.exec)

      // Second instance learns the file version through the HTTP path only.
      let route
      boot(dir, { captureRoute: (r) => { route = r } })
      const httpCall = (body) => call(route.handler, { body: JSON.stringify(body) })
      await httpCall({ method: "get", args: { workspaceId: "ws-test" } })

      // First instance writes; the second instance is now holding a stale version.
      await tool(first.registered, "kanban_add_card").execute({ title: "winner" }, first.exec)

      const stale = await httpCall({ method: "addCard", args: { workspaceId: "ws-test", title: "loser" } })
      expect(stale.status).toBe(409)
      expect(stale.payload.error).toContain("changed on disk")

      // The catch-all was NOT widened: malformed JSON is still a 400, and only
      // BOARD_STALE was carved out of the 500 branch.
      const malformed = await call(route.handler, { body: "{" })
      expect(malformed.status).toBe(400)
    })

    // RESIDUAL RISK, pinned deliberately: a body-supplied workspaceId IS honoured
    // for any registered workspace. This is not a control — it is the documented
    // consequence of having no session. If a future change adds real auth, this
    // test should FAIL and be rewritten; that is the point of pinning it.
    it("honours any registered workspaceId — the documented residual risk", async () => {
      const other = mkdtempSync(join(tmpdir(), "dsh-kanban-other-"))
      workspaces.push(other)
      const otherWorkspace = { id: "ws-other", path: other, title: "Other" }
      const { handler } = bootRoute({ extra: [otherWorkspace] })

      // A caller that never had anything to do with ws-other reaches its board.
      const res = await call(handler, {
        body: JSON.stringify({ method: "addCard", args: { workspaceId: "ws-other", title: "Reached it" } }),
      })
      expect(res.status).toBe(200)
      expect(res.payload.board.cards.map((c) => c.title)).toContain("Reached it")
    })
  })

  // k254: this MUST be a RENDER-level assertion. The readyCards case already
  // filtered and sorted correctly, and a result-object test passed the whole time
  // — while a live probe on the running host showed kanban_ready_cards printing
  // "2 ready card(s)" above a list of all THREE cards including the claimed one.
  // The sorted list was computed and then discarded, because every tool rendered
  // through renderBoard, which prints value.board.cards (the whole board) and
  // never reads value.cards. Assert what the agent actually READS.
  it("renders ONLY the ready cards, in priority order, and drops a claimed one", async () => {
    const { registered, exec } = boot()
    const add = tool(registered, "kanban_add_card")
    await add.execute({ title: "low card", priority: "low" }, exec)
    await add.execute({ title: "high card", priority: "high" }, exec)
    await add.execute({ title: "medium card", priority: "medium" }, exec)

    const readyTool = tool(registered, "kanban_ready_cards")
    const before = await readyTool.execute({}, exec)
    const textBefore = readyTool.output.render({}, before)[0].text

    // Ordering must be visible in the RENDERED text, not just the result object.
    expect(textBefore).toContain("3 ready card(s)")
    expect(textBefore.indexOf("high card")).toBeLessThan(textBefore.indexOf("medium card"))
    expect(textBefore.indexOf("medium card")).toBeLessThan(textBefore.indexOf("low card"))
    expect(textBefore).toContain("[high]")

    // Claim the top card; it must vanish from the rendered list, not just the count.
    const highId = before.cards[0].id
    await tool(registered, "kanban_claim_card").execute({ id: highId, ownerRunId: "run-1" }, exec)

    const after = await readyTool.execute({}, exec)
    const textAfter = readyTool.output.render({}, after)[0].text
    expect(textAfter).toContain("2 ready card(s)")
    expect(textAfter, "the claimed card must not be listed as ready").not.toContain(highId)
    expect(textAfter).toContain("medium card")
    expect(textAfter).toContain("low card")
  })

  // k386, instances two and three of the k254 pattern: a verb computes the right
  // answer, puts it in the result object, and the renderer never reads it. BOTH
  // assertions below MUST be render-level — a result-object assertion passed the
  // whole time for both, which is exactly why this survived two rounds.
  it("renders the state block of a claimed / dispatched card in get_card", async () => {
    const { registered, exec } = boot()
    const add = await tool(registered, "kanban_add_card").execute({ title: "Owned card" }, exec)
    const id = add.board.cards[0].id
    const getCard = tool(registered, "kanban_get_card")

    // An unclaimed card must say so rather than printing a misleading blank.
    const clean = await getCard.execute({ id }, exec)
    expect(getCard.output.render({}, clean)[0].text).toContain("State: unclaimed")

    await tool(registered, "kanban_claim_card").execute({ id, ownerRunId: "run-77" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id, stage: "Spec", teamName: "team-9" }, exec)

    const held = await getCard.execute({ id }, exec)
    const text = getCard.output.render({}, held)[0].text
    // "Who owns this card" is the single most operationally important question a
    // tick asks, and it was answerable only by reading board.json directly.
    expect(text, "the owner must be visible through the tool").toContain("run-77")
    expect(text).toContain("dispatched: Spec")
    expect(text).toContain("team-9")
  })

  it("renders which claims reap released, and on what basis", async () => {
    const { registered, exec } = boot()
    const add = tool(registered, "kanban_add_card")
    const dead = (await add.execute({ title: "Dead run card" }, exec)).board.cards[0].id
    await tool(registered, "kanban_claim_card").execute({ id: dead, ownerRunId: "dead-run" }, exec)
    await tool(registered, "kanban_dispatch_card").execute({ id: dead, stage: "Build", teamName: "team-d" }, exec)

    const reapTool = tool(registered, "kanban_reap")
    const reaped = await reapTool.execute({
      staleAfterSeconds: 86400,
      liveRunIds: ["still-alive"],
      liveRunsAsOf: new Date(Date.now() + 1000).toISOString(),
    }, exec)
    const text = reapTool.output.render({}, reaped)[0].text

    expect(text).toContain("1 stale claim")
    expect(text, "a count alone cannot tell a human WHICH claim went").toContain(dead)
    expect(text).toContain("dead-run")
    // basis distinguishes "the run is provably gone" from "the clock expired and we
    // do not know" — k183's whole point. It was computed and then thrown away.
    expect(text).toContain("run-not-live")
    // And it must NOT fall back to printing the whole board like renderBoard did.
    expect(text).not.toContain("Board state:")
  })

  // ---- k190: the residual cross-process hole, pinned deliberately ----
  //
  // RESIDUAL RISK, asserted rather than defended (the k38 pattern). The claim CAS
  // is OPTIMISTIC: dsh-fs-local's writeText holds withLock(targetKey) across its
  // compare-and-write, but `this.locks` is an in-memory Map on the FileSystem
  // INSTANCE — in-process only, exactly like this plugin's own workspaceQueues.
  // Across two OS processes, probe → compare → write has a genuine gap, so both
  // can compare equal and both can write. Measured 6/60 runs with two winners
  // (~10%) via probes/probe-g-cross-process-claim.mjs.
  //
  // The supported deployment is SINGLE-WRITER (k190 option iii, 2026-09-02):
  // scheduled ticks already satisfy it via dsh-cron's overlap: skip. A second
  // concurrent writing process is unsupported, not guarded.
  //
  // THIS TEST ASSERTS THE HOLE. If real cross-process safety ever lands (an
  // upstream dsh-fs CAS holding a lock across compare AND write — see
  // docs/upstream-asks.md), this test MUST FAIL and be rewritten. That failure is
  // the point: it forces the limitation to be revisited instead of quietly
  // persisting. Do not "fix" it by loosening the assertion.
  //
  // It pins the MECHANISM — the compare→write gap — not the ~10% timing race.
  // Committing a test that reproduces the race by luck would be flaky and would
  // prove nothing on a green run: 15 runs once showed 0/15 while the true rate was
  // ~10% (trap 19). Here Bob is released INTO Alice's open window on purpose, so
  // the outcome is the same every run.
  //
  // A NOTE ON WHAT IS AND IS NOT SIMULATED, because the first version of this test
  // got it wrong and the failure was informative (trap 18 in the other direction —
  // a mock that made the code look WORSE than it is). I first tried freezing the
  // mtime/ctime fields to force a token collision. It does not work, and the
  // reason matters: `size` is part of `dev:ino:size:mtimeNs:ctimeNs`, and a claim
  // ADDS an owner plus an activity record, so the file size changes and the tokens
  // differ anyway. The measured 1 ms granularity only collides SAME-SIZE writes.
  // So the honest reproduction is the interleaving, not a doctored token: the
  // version compare below is completely real.
  it("lets a second process overwrite a claim it never saw — the pinned residual hole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kanban-k190-"))
    workspaces.push(dir)

    let releaseBob
    const bobIsInTheGap = new Promise((resolve) => { releaseBob = resolve })
    // Armed only for the claim below — the seed write must not consume the pause.
    let gapArmed = false

    // Alice's instance pauses ONCE inside the compare→write gap — the window that
    // exists between two OS processes because dsh-fs-local's lock is in-process.
    const alice = boot(dir, {
      gap: async () => {
        if (!gapArmed) return
        gapArmed = false
        await bobIsInTheGap
      },
    })
    await tool(alice.registered, "kanban_add_card").execute({ title: "contested" }, alice.exec)
    const cardId = JSON.parse(readFileSync(boardPath(dir), "utf8")).cards[0].id

    // Bob is a second process: he reads the board, so he holds a version token.
    const bob = boot(dir)
    await tool(bob.registered, "kanban_get").execute({}, bob.exec)

    // Alice claims. She compares equal, then stalls before writing.
    gapArmed = true
    const aliceClaim = tool(alice.registered, "kanban_claim_card")
      .execute({ id: cardId, ownerRunId: "run-alice" }, alice.exec)

    // Bob claims the same card while Alice is mid-write. He compares against the
    // version he read, which is still what is on disk — Alice has not landed yet —
    // so his CAS passes and he writes. This is the hole: the precondition was
    // checked against a state that is already obsolete.
    const bobClaim = await tool(bob.registered, "kanban_claim_card")
      .execute({ id: cardId, ownerRunId: "run-bob" }, bob.exec)
    releaseBob()
    const aliceResult = await aliceClaim

    // BOTH callers are told they succeeded. One card, two winners, no loser
    // notified — the documented limitation of single-writer discipline.
    expect(bobClaim.ok, "pinning the hole: Bob's claim is ACCEPTED, not refused").toBe(true)
    expect(aliceResult.ok, "pinning the hole: Alice is also told she succeeded").toBe(true)

    // And the board agrees with only one of them.
    const owner = JSON.parse(readFileSync(boardPath(dir), "utf8")).cards[0].state.owner
    expect(["run-alice", "run-bob"]).toContain(owner)
  })

  // The CONTROL for the test above, and the reason it is a pin rather than a
  // blanket "CAS does not work" claim. With the real nanosecond token — the only
  // difference — the very same sequence IS refused. So the protection is real and
  // in force; the hole above is specifically the same-tick, same-size collision.
  // If this control ever goes green-by-vacuum (e.g. someone disables the
  // precondition), it fails here first.
  it("refuses that same second claim once version tokens actually differ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kanban-k190-control-"))
    workspaces.push(dir)

    const alice = boot(dir)
    await tool(alice.registered, "kanban_add_card").execute({ title: "contested" }, alice.exec)
    const cardId = JSON.parse(readFileSync(boardPath(dir), "utf8")).cards[0].id

    const bob = boot(dir)
    await tool(bob.registered, "kanban_get").execute({}, bob.exec)

    await tool(alice.registered, "kanban_claim_card")
      .execute({ id: cardId, ownerRunId: "run-alice" }, alice.exec)

    const bobClaim = await tool(bob.registered, "kanban_claim_card")
      .execute({ id: cardId, ownerRunId: "run-bob" }, bob.exec)
    expect(bobClaim.ok).toBe(false)
    expect(bobClaim.message).toContain("changed on disk")
    // Alice keeps the card and nothing was clobbered.
    expect(JSON.parse(readFileSync(boardPath(dir), "utf8")).cards[0].state.owner).toBe("run-alice")
  })

  it("keeps newer-schema files read-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kanban-future-"))
    workspaces.push(dir)
    const original = JSON.stringify({ schemaVersion: 99, columns: [], labels: [], cards: [], activities: [] })
    seedBoard(dir, original)
    const { registered, exec } = boot(dir)

    const result = await tool(registered, "kanban_add_card").execute({ title: "Do not overwrite" }, exec)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("newer plugin version")
    expect(readFileSync(boardPath(dir), "utf8")).toBe(original)
  })
})
