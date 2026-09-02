import { afterEach, describe, expect, it, vi } from "vitest"
import { callKanban } from "../src/client/lib/api"

afterEach(() => vi.unstubAllGlobals())

describe("kanban API client", () => {
  it("serializes a comment mutation with its workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ board: { cards: [] } }),
    })
    vi.stubGlobal("fetch", fetchMock)

    await callKanban("addComment", { id: "k1", content: "Ready" }, "ws-1")

    expect(fetchMock).toHaveBeenCalledWith("/api/kanban", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ method: "addComment", args: { id: "k1", content: "Ready", workspaceId: "ws-1" } }),
    }))
  })

  it("rejects HTTP and business errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Unknown workspace" }),
    }))
    await expect(callKanban("get", {}, "missing")).rejects.toThrow("Unknown workspace")

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: "Card not found" }),
    }))
    await expect(callKanban("deleteCard", { id: "missing" }, "ws")).rejects.toThrow("Card not found")
  })

  // 409 means another process wrote first and NOTHING changed — the caller should
  // refetch rather than treat it as a generic failure. The flag is what lets the
  // view tell those apart; an ordinary 400 must NOT carry it.
  it("marks a 409 conflict as stale so the view can refetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "Board changed on disk since this process read it" }),
    }))
    await expect(callKanban("addCard", { title: "x" }, "ws"))
      .rejects.toMatchObject({ stale: true, message: expect.stringContaining("changed on disk") })

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Unknown workspace" }),
    }))
    const plain = await callKanban("get", {}, "ws").catch((e) => e)
    expect(plain.message).toContain("Unknown workspace")
    expect(plain.stale).toBeUndefined()
  })
})
