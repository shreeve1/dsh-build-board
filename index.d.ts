/**
 * Minimal type declarations for dsh-build-board (fork of alpacachen/dsh-kanban).
 *
 * The host entry is plain ESM; this file exists so the package satisfies the
 * plugin packaging gate (missing-main-or-types). It declares the exported
 * surface that probes, tests and the migration chain rely on; it is not a
 * contract for the full internal API.
 */
export const name: string
export const inject: string[]

export const SCHEMA_VERSION: number
export const LEGACY_VERSION: number

export interface MigrationMap {
  [from: number]: (board: any) => any
}
export const MIGRATIONS: MigrationMap

export function migrateBoard(data: unknown, fromVersion?: number): {
  ok: boolean
  board?: unknown
  migrated?: boolean
  fromVersion?: number
  error?: string
}

export function validateBoard(data: unknown): {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export function parseBoardText(text: string): unknown

/** The eight reserved pipeline stage titles, in order. */
export const RESERVED_STAGE_TITLES: string[]

/** Refusal limits — over-limit input is rejected, never silently truncated. */
export const NOTE_LIMIT: number
export const TITLE_LIMIT: number

/**
 * A card's typed execution state (schema v5) — the object the unattended verbs
 * read and write. `dispatched` is the non-terminal outcome D that
 * kanban_finalize_card compare-and-sets against.
 */
export interface CardState {
  cardKey: string | null
  specPath: string | null
  owner: string | null
  ownerRunId: string | null
  dispatched: { stage: string; teamName: string; at: string } | null
  bounceCount: number
  bouncesByEdge: Record<string, number>
  lastBounceReason: string | null
  laneBranches: string[]
  heartbeatAt: string | null
}
export const EMPTY_STATE: CardState

/** Migration-only normaliser: fills a missing/legacy state. Never repairs a v5 file. */
export function normState(state: unknown): CardState

/** Validation: returns the reason a state is malformed, or null when it is well-formed. */
export function stateErrorOf(state: unknown): string | null

export function apply(ctx: any, config?: Record<string, unknown>): void | (() => void)