/**
 * dsh-kanban — DSH bundle 宿主插件（标准 Cordis 函数插件）
 *
 * 挂载方式：package.json 的 `dsh.bundle.patch` 指向 cordis.patch.yml，
 * 该补丁层把本插件行插入 profile 组合，Loader 按包名 dsh-kanban 解析本文件。
 *
 * 职责：
 *  - 按工作区（项目）隔离：boards 以 workspaceId 为键，每个工作区一块独立看板
 *  - 磁盘持久化：经 ctx.fs 写入 ~/.dsh-boards/<basename(workspace.path)>/board.json（仓库之外）
 *  - 模型工具：经 ctx.tools.register 注册 21 个 kanban_* 工具（含 item 6 的六个无人值守动词）
 *  - 浏览器数据层：经 ctx.get('webServer') 注册 /api/kanban 前缀路由
 *
 * 数据模型（每工作区，磁盘文件带 schemaVersion）：
 *   schemaVersion: 3
 *   columns: [{ id, title }]
 *   labels:  [{ name, color }]          —— 标签与颜色绑定，name 为唯一键
 *   cards:   [{ id, columnId, title, note, label, priority, createdAt, createdBy,
 *               comments: [{ id, content, source, createdAt }] }]
 *   activities: [{ id, ts, cardId, type, source, field?, from?, to?, meta? }]  —— 追加式活动日志
 *
 * 数据安全：
 *   - 无 schemaVersion 的历史文件按 v0 处理，首次打开自动升级（见 MIGRATIONS）
 *   - 升级/损坏/版本超前均先备份原文件（.bak-vN / .corrupt-<ts> / .unsupported-vN）
 *   - 启动时全量体检所有看板文件，损坏文件备份后不影响看板可用性
 */
export const name = 'dsh-build-board'

export const inject = ['tools']

// ---------------------------------------------------------------------------
// 持久化格式版本与迁移
//
// 磁盘文件结构：
//   { schemaVersion, columns, labels, cards }
//
// 版本约定：
//   v1 —— 首个带版本声明的格式，等价于 1.0.x ~ 1.2.x 时代无版本声明的三数组格式
//         （columns/labels/cards），并补齐了卡片的规范字段（note/label/priority）。
//   LEGACY_VERSION(0) —— 历史文件没有 schemaVersion 字段，一律归入 v0 处理。
//
// 新增/删除字段的流程：
//   1) SCHEMA_VERSION 自增
//   2) 在 MIGRATIONS 里以"旧版本号为键"注册 v(n)→v(n+1) 迁移函数
//   3) 迁移函数是纯函数，输出必须带 schemaVersion: n+1（migrateBoard 会校验）
// 旧文件在首次打开时自动沿迁移链升级，升级前原文件先备份。
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 5
export const LEGACY_VERSION = 0

// 八个流水线阶段。提到模块作用域是因为 validateBoard 也要用（v4 起把阶段集合
// 纳入 schema），而它在 apply() 外面。apply() 里的 DEFAULT_COLUMNS/RESERVED_STAGES
// 都从这里派生，保证种子、工具守卫、schema 校验三处不会各自漂移。
export const RESERVED_STAGE_TITLES = ['Spec', 'Decompose', 'Build', 'Verify', 'Review', 'Merge', 'Blocked', 'Archive']

// 卡片文本上限。旧实现用 slice() 静默截断：ok:true，无警告，内容直接消失
// ——实测（2026-09-02）把真实待办写上看板时，7 张卡有 6 张在第 500 字被切断，
// 其中一张丢的正是它自己的 HARD DO-NOT。改成与 comment 一致的硬拒绝：
// 宁可让调用方看见失败，也不要让它以为写成功了。校验侧同样按这个上限隔离，
// 所以手改的文件也塞不进超长内容。
export const NOTE_LIMIT = 8000
export const TITLE_LIMIT = 200

// 活动日志：追加式只读记录，随看板一起落盘；超过上限丢弃最旧事件，防止日志无界增长。
const ACTIVITY_LIMIT = 5000

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const strField = (v, fb) => (typeof v === 'string' && v ? v : fb)
const normColor = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '#94a3b8')

// v1 的规范实体形状（仅补缺省值，不改动合法数据）
const normColumn = (c) =>
  isObj(c) ? { id: strField(c.id, ''), title: strField(c.title, 'Untitled') } : null
const normLabel = (l) =>
  isObj(l) ? { name: strField(l.name, ''), color: normColor(l.color) } : null
const normCard = (c) =>
  isObj(c)
    ? {
        id: strField(c.id, ''),
        columnId: strField(c.columnId, ''),
        title: strField(c.title, 'Untitled'),
        note: typeof c.note === 'string' ? c.note : '',
        label: typeof c.label === 'string' && c.label ? c.label : null,
        priority: typeof c.priority === 'string' ? c.priority : null,
      }
    : null

// 卡片的类型化执行状态（v4）。五个动词读写的就是这块，所以字段只放它们真正需要的：
// 谁认领的、认领到什么时候（租约，用于 reap 回收卡死的认领）、退回过几次、上一次为什么退回。
// 全部可为 null —— 一张没被认领过的卡就是 owner:null / claimedAt:null / leaseUntil:null。
// v5：字段表来自 slice-1-build-plan.md:752-763，五个动词读写的就是这块。
// v4 只有 owner/claimedAt/leaseUntil/bounces/lastError，装不下 finalize 的 CAS 目标
// （dispatched）和 bounce 的三个计数器，所以 v4 是一个不完整的依赖，不是一个可选项。
// leaseUntil 在 v5 里由 heartbeatAt 取代：租约到期需要写入方持续续约，而心跳
// 恰好是计划里 reap 的判据（kanban_reap(staleAfterSeconds)），一个时间戳就够。
export const EMPTY_STATE = {
  cardKey: null,
  specPath: null,
  owner: null,
  ownerRunId: null,
  dispatched: null,
  bounceCount: 0,
  bouncesByEdge: {},
  lastBounceReason: null,
  laneBranches: [],
  heartbeatAt: null,
}
const nullableStr = (v) => (typeof v === 'string' && v ? v : null)

// 只在迁移里用：把 v3 及更早的卡片补上 state。已经是 v4 的文件不走这里——
// 那种文件里的坏 state 由 stateErrorOf 判为损坏并隔离，而不是被默默修好。
export const normState = (s) => {
  if (!isObj(s)) return { ...EMPTY_STATE }
  const count = Number(s.bounceCount ?? s.bounces)
  const edges = {}
  if (isObj(s.bouncesByEdge)) {
    for (const [edge, n] of Object.entries(s.bouncesByEdge)) {
      if (Number.isInteger(n) && n >= 0) edges[edge] = n
    }
  }
  return {
    cardKey: nullableStr(s.cardKey),
    specPath: nullableStr(s.specPath),
    owner: nullableStr(s.owner),
    ownerRunId: nullableStr(s.ownerRunId),
    dispatched: normDispatched(s.dispatched),
    bounceCount: Number.isInteger(count) && count >= 0 ? count : 0,
    bouncesByEdge: edges,
    // lastError 是 v4 的名字，语义一致，迁移时并入 lastBounceReason。
    lastBounceReason: nullableStr(s.lastBounceReason ?? s.lastError),
    laneBranches: Array.isArray(s.laneBranches) ? s.laneBranches.filter((b) => typeof b === 'string' && b) : [],
    heartbeatAt: nullableStr(s.heartbeatAt ?? s.claimedAt),
  }
}

// dispatched 是 finalize 的比较对象：{stage, teamName, at}，三个字段都必须是字符串。
// 形状不对就整体丢弃（迁移路径）或报错（校验路径）——半个 dispatched 比没有更危险。
const DISPATCHED_KEYS = ['stage', 'teamName', 'at']
const normDispatched = (d) => {
  if (!isObj(d)) return null
  const out = {}
  for (const k of DISPATCHED_KEYS) {
    if (typeof d[k] !== 'string' || !d[k]) return null
    out[k] = d[k]
  }
  return out
}

// v4 校验用：返回错误原因字符串，形状正确返回 null。
// 缺失 state 是允许的（下面由迁移补齐）；存在就必须完全合规。
const STATE_KEYS = Object.keys(EMPTY_STATE)
const STATE_STR_KEYS = ['cardKey', 'specPath', 'owner', 'ownerRunId', 'lastBounceReason', 'heartbeatAt']
export const stateErrorOf = (s) => {
  if (s == null) return null
  if (!isObj(s)) return 'not an object'
  for (const k of STATE_STR_KEYS) {
    if (s[k] != null && typeof s[k] !== 'string') return k + ' must be a string or null'
  }
  if (!Number.isInteger(s.bounceCount) || s.bounceCount < 0) return 'bounceCount must be a non-negative integer'
  if (!isObj(s.bouncesByEdge)) return 'bouncesByEdge must be an object'
  for (const [edge, n] of Object.entries(s.bouncesByEdge)) {
    if (!Number.isInteger(n) || n < 0) return 'bouncesByEdge.' + edge + ' must be a non-negative integer'
  }
  if (!Array.isArray(s.laneBranches)) return 'laneBranches must be an array'
  if (s.laneBranches.some((b) => typeof b !== 'string')) return 'laneBranches must contain only strings'
  if (s.dispatched != null) {
    if (!isObj(s.dispatched)) return 'dispatched must be an object or null'
    for (const k of DISPATCHED_KEYS) {
      if (typeof s.dispatched[k] !== 'string' || !s.dispatched[k]) return 'dispatched.' + k + ' must be a non-empty string'
    }
    const extra = Object.keys(s.dispatched).filter((k) => !DISPATCHED_KEYS.includes(k))
    if (extra.length > 0) return 'dispatched has unknown field(s): ' + extra.join(', ')
  }
  const unknown = Object.keys(s).filter((k) => !STATE_KEYS.includes(k))
  if (unknown.length > 0) return 'unknown field(s): ' + unknown.join(', ')
  // 认领必须可回收：有 owner 就必须有心跳，否则 reap 永远判不出这张卡卡死了。
  if (s.owner != null && s.heartbeatAt == null) return 'owner set without heartbeatAt'
  // dispatched 是"某个 run 派工中"，无主的 dispatched 没有人会去收尾。
  if (s.dispatched != null && s.owner == null) return 'dispatched set without owner'
  return null
}

/**
 * 逐版本迁移注册表：key = 旧版本号，value = (旧数据) => 新数据。
 * 输出必须设置 schemaVersion = key + 1，migrateBoard 会逐级校验。
 */
export const MIGRATIONS = {
  0: (data) => {
    // v0 → v1：历史无版本文件 —— 声明版本 + 规范化实体字段
    const src = isObj(data) ? data : {}
    const pick = (arr) => (Array.isArray(arr) ? arr : [])
    return {
      schemaVersion: 1,
      columns: pick(src.columns).map(normColumn).filter(Boolean),
      labels: pick(src.labels).map(normLabel).filter(Boolean),
      cards: pick(src.cards).map(normCard).filter(Boolean),
    }
  },
  1: (data) => {
    // v1 → v2：新增追加式活动日志 activities；卡片补 createdAt/createdBy（历史数据为 null）
    const src = isObj(data) ? data : {}
    const pick = (arr) => (Array.isArray(arr) ? arr : [])
    return {
      schemaVersion: 2,
      columns: pick(src.columns).map(normColumn).filter(Boolean),
      labels: pick(src.labels).map(normLabel).filter(Boolean),
      cards: pick(src.cards)
        .map((c) => {
          const card = normCard(c)
          return card ? { ...card, createdAt: null, createdBy: null } : null
        })
        .filter(Boolean),
      activities: [],
    }
  },
  2: (data) => {
    // v2 → v3：卡片新增评论数组；历史卡片默认没有评论
    const src = isObj(data) ? data : {}
    const pick = (arr) => (Array.isArray(arr) ? arr : [])
    return {
      schemaVersion: 3,
      // v3 时期 workspacePath 已经被 save() 写进文件了（只是当时没人校验它）。
      // 每一级迁移只复制自己认识的键，所以这一步不显式带上，v2 盘上的看板
      // 升到 v4 时冲突凭据就没了 —— 实测确实会变成 null。转发而不解释语义，
      // 类型检查留给 v3→v4。
      ...(typeof src.workspacePath === 'string' ? { workspacePath: src.workspacePath } : {}),
      columns: pick(src.columns),
      labels: pick(src.labels),
      cards: pick(src.cards)
        .map((c) => (isObj(c) ? { ...c, comments: [] } : null))
        .filter(Boolean),
      activities: pick(src.activities),
    }
  },
  3: (data) => {
    // v3 → v4：workspacePath 从"被容忍的未知字段"升级为已知字段，并给卡片加类型化 state。
    // 注意上面每一级迁移都只复制自己认识的键——v2→v3 就会把 workspacePath 丢掉。
    // 它是 basename 冲突停机的唯一凭据（:460），所以必须在这里显式带过去。
    const src = isObj(data) ? data : {}
    const pick = (arr) => (Array.isArray(arr) ? arr : [])
    // 缺失的流水线阶段在这里补齐，而不是在 schema 里拒绝：历史看板的列是
    // Todo/In Progress/Review/Done，一律隔离等于把用户数据判死。补列不动任何
    // 已有列，也不搬卡片——只保证八个阶段存在，卡片留在原处由人处理。
    const existing = pick(src.columns).filter(isObj)
    const titles = new Set(existing.map((c) => c.title))
    let n = existing.length
    const restored = RESERVED_STAGE_TITLES.filter((t) => !titles.has(t)).map((title) => ({
      id: 'c' + ++n + '-restored',
      title,
    }))
    return {
      schemaVersion: 4,
      // 非字符串一律丢弃：旧文件里的脏值不该升级成"已校验"的字段。
      workspacePath: typeof src.workspacePath === 'string' ? src.workspacePath : null,
      columns: [...existing, ...restored],
      labels: pick(src.labels),
      cards: pick(src.cards)
        .map((c) => (isObj(c) ? { ...c, state: normState(c.state) } : null))
        .filter(Boolean),
      activities: pick(src.activities),
    }
  },
  4: (data) => {
    // v4 → v5：state 扩到计划的字段表（:752-763），五个动词真正读写的形状。
    // v4 的 leaseUntil/claimedAt/bounces/lastError 由 normState 就地并入
    // heartbeatAt/bounceCount/lastBounceReason，不新增第二处真相。
    // 陷阱 16：每一级迁移只复制自己认识的键，所以 workspacePath 必须再转发一次。
    const src = isObj(data) ? data : {}
    const pick = (arr) => (Array.isArray(arr) ? arr : [])
    return {
      schemaVersion: 5,
      workspacePath: typeof src.workspacePath === 'string' ? src.workspacePath : null,
      columns: pick(src.columns),
      labels: pick(src.labels),
      cards: pick(src.cards)
        .map((c) => (isObj(c) ? { ...c, state: normState(c.state) } : null))
        .filter(Boolean),
      activities: pick(src.activities),
    }
  },
}

/**
 * 沿迁移链把数据从 fromVersion 逐级升级到 SCHEMA_VERSION。
 * 任一步缺失或产出无效都会抛错（由调用方备份并降级处理）。
 */
export function migrateBoard(data, fromVersion) {
  let out = data
  let v = fromVersion
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v]
    if (typeof step !== 'function') {
      throw new Error('missing migration v' + v + ' -> v' + (v + 1))
    }
    out = step(out)
    v += 1
    if (!isObj(out) || out.schemaVersion !== v) {
      throw new Error('migration v' + (v - 1) + ' -> v' + v + ' produced invalid data')
    }
  }
  return out
}

/**
 * 结构校验（迁移后的最终形态）。
 * 返回 { ok, errors }；errors 非空时文件应视为损坏处理。
 */
export function validateBoard(data) {
  const errors = []
  if (!isObj(data)) {
    errors.push('board is not an object')
    return { ok: false, errors }
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    errors.push('expected schemaVersion ' + SCHEMA_VERSION + ', got ' + String(data.schemaVersion))
  }
  if (!Array.isArray(data.columns)) errors.push('columns must be an array')
  if (!Array.isArray(data.labels)) errors.push('labels must be an array')
  if (!Array.isArray(data.cards)) errors.push('cards must be an array')
  if (!Array.isArray(data.activities)) errors.push('activities must be an array')
  // v4：workspacePath 是 basename 冲突停机的唯一凭据，不再是"被容忍的未知字段"。
  // 允许缺失/null（v0、v1 时代的文件本来就没有），但存在就必须是字符串——
  // 之前 workspacePath: 12345 能通过校验，然后在 :460 被 typeof 悄悄忽略。
  if (data.workspacePath != null && typeof data.workspacePath !== 'string') {
    errors.push('workspacePath must be a string when present')
  }
  // Gap A 候选 (iii)：八个阶段是 v4 结构的一部分。
  // 分两种情况，区别很重要：历史看板（v0..v3 的列是 Todo/In Progress/…）由
  // v3→v4 迁移补齐，绝不隔离——否则每个老看板都被判成损坏文件。但一个**已经是
  // v4** 的文件必然已经过那次补齐，此时还缺阶段就只能是事后被改坏的，
  // 必须隔离：工具侧守卫（:900 附近）拦不住手改文件，这里是最后一道。
  // 只在 schemaVersion 已经是当前版本时断言，避免在迁移前误杀。
  if (data.schemaVersion === SCHEMA_VERSION && Array.isArray(data.columns)) {
    const titles = new Set(data.columns.filter(isObj).map((c) => c.title))
    const missing = RESERVED_STAGE_TITLES.filter((t) => !titles.has(t))
    if (missing.length > 0) errors.push('board is missing reserved pipeline stages: ' + missing.join(', '))
  }

  const columnIds = new Set()
  if (Array.isArray(data.columns)) {
    for (const c of data.columns) {
      if (!isObj(c) || typeof c.id !== 'string' || !c.id || typeof c.title !== 'string' || !c.title) {
        errors.push('columns contain an invalid entry')
        break
      }
      if (columnIds.has(c.id)) {
        errors.push('duplicate column id: ' + c.id)
        break
      }
      columnIds.add(c.id)
    }
  }

  const labelNames = new Set()
  if (Array.isArray(data.labels)) {
    for (const l of data.labels) {
      if (!isObj(l) || typeof l.name !== 'string' || !l.name || typeof l.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(l.color)) {
        errors.push('labels contain an invalid entry')
        break
      }
      if (labelNames.has(l.name)) {
        errors.push('duplicate label name: ' + l.name)
        break
      }
      labelNames.add(l.name)
    }
  }

  if (Array.isArray(data.cards)) {
    const seen = new Set()
    const commentIds = new Set()
    for (const c of data.cards) {
      if (!isObj(c) || typeof c.id !== 'string' || !c.id || typeof c.columnId !== 'string' || typeof c.title !== 'string' || !Array.isArray(c.comments)) {
        errors.push('cards contain an invalid entry')
        break
      }
      if (seen.has(c.id)) {
        errors.push('duplicate card id: ' + c.id)
        break
      }
      if (!columnIds.has(c.columnId)) errors.push('card references missing column: ' + c.id)
      if (c.label != null && !labelNames.has(c.label)) errors.push('card references missing label: ' + c.id)
      if (c.priority != null && !['high', 'medium', 'low'].includes(c.priority)) errors.push('card has invalid priority: ' + c.id)
      if (c.title.length > TITLE_LIMIT) errors.push('card title exceeds ' + TITLE_LIMIT + ' characters: ' + c.id)
      if (typeof c.note === 'string' && c.note.length > NOTE_LIMIT) errors.push('card note exceeds ' + NOTE_LIMIT + ' characters: ' + c.id)
      // v4：state 是五个动词的租约/认领凭据，坏掉的 state 必须当成损坏文件隔离，
      // 不能在校验通过之后再"顺手修好"——那样 owner 或 leaseUntil 被悄悄清成 null，
      // 一张仍被别人持有的卡就会显示成可认领。
      const stateErr = stateErrorOf(c.state)
      if (stateErr) errors.push('card has invalid state (' + stateErr + '): ' + c.id)
      for (const comment of c.comments) {
        if (!isObj(comment) || typeof comment.id !== 'string' || !comment.id || typeof comment.content !== 'string' || !comment.content.trim() || comment.content.length > 2000 || !['human', 'agent'].includes(comment.source) || typeof comment.createdAt !== 'string' || !comment.createdAt) {
          errors.push('card comments contain an invalid entry: ' + c.id)
          break
        }
        if (commentIds.has(comment.id)) {
          errors.push('duplicate comment id: ' + comment.id)
          break
        }
        commentIds.add(comment.id)
      }
      seen.add(c.id)
    }
  }

  if (Array.isArray(data.activities)) {
    for (const a of data.activities) {
      if (!isObj(a) || typeof a.id !== 'string' || !a.id || typeof a.ts !== 'string' || typeof a.type !== 'string' || !['human', 'agent'].includes(a.source)) {
        errors.push('activities contain an invalid entry')
        break
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 解析并升级一段看板文件文本（纯函数，不触磁盘）。
 *
 * 返回：
 *   { ok: true, kind: 'ok', data, migrated, fromVersion, warnings } —— data 为可用的最新版
 *   { ok: false, kind: 'corrupt'|'invalid'|'unsupported', warnings } —— 需要调用方备份原文件
 *
 * kind 语义：
 *   corrupt     —— JSON 无法解析
 *   invalid     —— 结构校验失败 / 迁移失败
 *   unsupported —— schemaVersion 高于当前插件支持（文件来自更新版本插件）
 */
export function parseBoardText(text) {
  const warnings = []
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return {
      ok: false,
      kind: 'corrupt',
      warnings: [
        'Board data file could not be parsed as JSON; the original file has been backed up and the board opened empty.',
      ],
    }
  }

  const version =
    isObj(data) && typeof data.schemaVersion === 'number' ? data.schemaVersion : LEGACY_VERSION

  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      kind: 'unsupported',
      version,
      warnings: [
        'Board data file was written by a newer plugin version (schemaVersion ' +
          version +
          '); this plugin supports up to ' +
          SCHEMA_VERSION +
          '. The original file has been backed up and the board opened empty — please upgrade the plugin to read the original data.',
      ],
    }
  }

  let migrated = false
  if (version < SCHEMA_VERSION) {
    try {
      data = migrateBoard(data, version)
      migrated = true
      warnings.push(
        'Board data was automatically upgraded from schemaVersion ' +
          version +
          ' to ' +
          SCHEMA_VERSION +
          '; the pre-upgrade file has been backed up.',
      )
    } catch (err) {
      return {
        ok: false,
        kind: 'invalid',
        version,
        warnings: [
          'Board data upgrade failed (' +
            ((err && err.message) || err) +
            '); the original file has been backed up and the board opened empty.',
        ],
      }
    }
  }

  const check = validateBoard(data)
  if (!check.ok) {
    return {
      ok: false,
      kind: 'invalid',
      version: isObj(data) ? data.schemaVersion : undefined,
      warnings: [
        'Board data file structure is invalid (' +
          check.errors.join('; ') +
          '); the original file has been backed up and the board opened empty.',
      ],
    }
  }

  // 到这里 data 已经是通过 v4 严格校验的形状：workspacePath 要么缺失/null 要么是字符串，
  // 每张卡的 state 要么缺失要么完全合规。所以这里只补"缺失"这一种情况（迁移之外唯一的
  // 默认值来源，且不会掩盖任何坏数据——坏数据在上面就被判为 invalid 隔离了）。
  // 刻意不做强制转换：静默修好一个畸形的 v4 文件，会把"别人还持有这张卡"变成"可认领"。
  const filled = {
    ...data,
    workspacePath: data.workspacePath == null ? null : data.workspacePath,
    cards: data.cards.map((c) => (c.state == null ? { ...c, state: { ...EMPTY_STATE } } : c)),
  }
  return { ok: true, kind: 'ok', data: filled, migrated, fromVersion: version, warnings }
}

export function apply(ctx) {
  const getFs = () => ctx.get('fs')
  const getPolicy = () => ctx.get('sandboxPolicy')
  const getWorkspaceRegistry = () => ctx.get('workspaceRegistry')

  const boards = new Map() // workspaceId -> { columns, labels, cards }
  const boardLoads = new Map() // workspaceId -> Promise<board>，防止冷启动发布半初始化状态
  const workspaceQueues = new Map() // workspaceId -> Promise，串行化完整 mutation 临界区
  const fileTargets = new Map() // workspaceId -> FsTarget；解析失败不缓存，允许后续重试
  let seq = 0 // 全局自增，用于生成 cN（列）/ kN（卡）唯一 id

  // ---- id 生成 ----
  const nextId = (prefix) => prefix + (++seq)
  const bumpSeq = (id) => {
    if (typeof id !== 'string') return
    const n = Number(id.slice(1))
    if (Number.isFinite(n) && n > seq) seq = n
  }

  // ---- 默认看板 ----
  const DEFAULT_COLUMNS = RESERVED_STAGE_TITLES
  // Archive 取代回收站：本分支没有软删除路径，已合并卡片的审计轨迹只能存放在这里
  const DEFAULT_LABELS = [
    // 项目词汇；其余标签按需通过 kanban_add_label 添加
    { name: 'build', color: '#38bdf8' },
  ]
  // 八个阶段列是流水线结构的一部分，不是普通看板列：删除会把整列卡片静默挪进 Spec，
  // 重命名则留下结构合法、语义错误的看板。两者都在写入前拒绝，事后断言救不回来。
  const RESERVED_STAGES = new Set(DEFAULT_COLUMNS)
  const RESERVED_STAGE_REFUSAL = 'Refusing to modify a reserved pipeline stage: '

  // ---- 持久化定位 ----
  // 看板文件移出工作区，落到 ~/.dsh-boards/<project>/board.json：
  // 每个工作区只有一块看板，git worktree 因此与看板无关，卡片变更也不再进入仓库 diff。
  // ponytail: 仅按 POSIX 拼路径（process.env.HOME + '/'），与本分支只部署在 Linux 上一致；
  // 若将来要跨平台，换成 node:path / node:os 即可，这里不预先引入。
  const BOARD_FILE = 'board.json'
  const BOARD_ROOT = (process.env.HOME || '') + '/.dsh-boards'
  const slugOf = (ws) => String(ws.path || '').split('/').filter(Boolean).pop() || 'workspace'
  const boardDirOf = (workspace) => BOARD_ROOT + '/' + slugOf(workspace)
  const workspaceKey = (workspace) => String(workspace.id || workspace.path)
  const writePolicyFor = (workspace, session) => {
    const policy = getPolicy()
    const resolved =
      policy && typeof policy.resolve === 'function'
        ? policy.resolve(session ? { session } : {})
        : { mode: (policy && policy.defaultMode) || 'workspace-write' }
    // 写围栏必须跟着文件走。fs-sandbox 以 workspaceRoot 为唯一可写根，
    // 这里若仍填 workspace.path，workspace-write 会话的每次保存都会被 FS_SANDBOX_DENIED 拒绝。
    return { ...resolved, workspaceRoot: boardDirOf(workspace) }
  }
  const resolveFile = async (workspace) => {
    const fs = getFs()
    if (!fs) return null
    try {
      return await fs.resolve(boardDirOf(workspace) + '/' + BOARD_FILE)
    } catch (err) {
      console.log(
        'dsh-kanban: 解析工作区看板文件失败 ' + workspaceKey(workspace) + '：' + ((err && err.message) || err),
      )
      return null
    }
  }
  const targetOf = async (workspace) => {
    const key = workspaceKey(workspace)
    if (fileTargets.has(key)) return fileTargets.get(key)
    const target = await resolveFile(workspace)
    if (target) fileTargets.set(key, target)
    return target
  }
  const persistedFlag = (workspace) => fileTargets.has(workspaceKey(workspace))

  // ---- 看板读写 ----

  // 备份原文件为 board.json.<suffix>（复制而非移动，保证原文件在写回前始终存在）
  // 每个工作区最后一次读到/写出的看板文件版本，是跨进程 CAS 的比较基准。
  // 进程内的 workspaceQueues 只锁得住本进程的 boards 缓存：实测（probes/
  // probe-g-cross-process-claim.mjs，2026-09-02）四个进程并发认领同一张卡，
  // 4/4 都自认认领成功，盘上只留下最后一个写者。所以每次写盘都带上
  // replaceIfVersion 前置条件，让后端在它自己的锁里做比较。
  const boardVersions = new Map()
  const isStaleVersion = (err) =>
    err && (err.code === 'FS_STALE_VERSION' || /changed since it was read|no longer exists|without reading it first/i.test(String(err.message || '')))

  const backupFile = async (workspace, suffix, session) => {
    const fs = getFs()
    const target = await targetOf(workspace)
    if (!fs || !target) return null
    const key = workspaceKey(workspace)
    try {
      const text = await fs.readText(target)
      const backupTarget = await fs.resolve(boardDirOf(workspace) + '/' + BOARD_FILE + '.' + suffix)
      await fs.writeText(backupTarget, text, undefined, undefined, writePolicyFor(workspace, session))
      return backupTarget
    } catch (err) {
      console.log('dsh-kanban: 备份失败 ' + key + ' (' + suffix + ')：' + ((err && err.message) || err))
      return null
    }
  }

  // 记录一次性警告：进入看板 warnings 队列 + 写宿主日志
  const warn = (board, message) => {
    if (Array.isArray(board.warnings)) board.warnings.push(message)
    console.log('dsh-kanban: ' + message)
  }
  // 一次性警告取走即清空。但 readOnlyReason 不是"通知"而是持续状态：隔离/冲突的看板
  // 从第二次读起就会显示成一块健康的空看板（实测 2026-09-02）。所以只要该状态还在，
  // 每次读都重新播报一次——先读到的人不会把唯一的告警吃掉。
  const takeWarnings = (board) => {
    const w = Array.isArray(board.warnings) ? board.warnings : []
    board.warnings = []
    if (board.readOnlyReason && !w.includes(board.readOnlyReason)) return [board.readOnlyReason, ...w]
    return w
  }
  const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-')

  const isNotFound = (err) => err && (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND' || err.message === 'ENOENT')

  // 首次访问缓存初始化 Promise；完成读取、迁移和默认值建立后才发布 board。
  const boardOf = async (workspace, session) => {
    const key = workspaceKey(workspace)
    const existing = boards.get(key)
    if (existing) return existing
    if (boardLoads.has(key)) return boardLoads.get(key)

    const load = (async () => {
      const board = {
        schemaVersion: SCHEMA_VERSION,
        columns: [],
        labels: [],
        cards: [],
        activities: [],
        warnings: [],
        readOnlyReason: null,
      }
      const fs = getFs()
      const target = await targetOf(workspace)
      let migrated = false
      if (fs && target) {
        try {
          const text = await fs.readText(target)
          // 记下读到的版本：save() 的 replaceIfVersion 以它为基准，别的进程在这之后
          // 写过盘，我们的写就会被后端拒绝而不是把它盖掉。
          boardVersions.delete(key)
          if (typeof fs.stat === 'function') {
            try {
              const info = await fs.stat(target)
              if (info && info.version !== undefined) boardVersions.set(key, info.version)
            } catch {}
          }
          const parsed = parseBoardText(text)
          for (const w of parsed.warnings) warn(board, w)
          if (parsed.ok) {
            board.columns = parsed.data.columns
            board.labels = parsed.data.labels
            board.cards = parsed.data.cards
            board.activities = parsed.data.activities
            migrated = parsed.migrated
            // 目录名取自 basename(workspace.path)，两个同名仓库会解析到同一个文件。
            // 文件自带来源路径，不匹配就停下，而不是让两块看板悄悄合成一块。
            const owner = typeof parsed.data.workspacePath === 'string' ? parsed.data.workspacePath : null
            if (owner && owner !== workspace.path) {
              board.readOnlyReason =
                'Board directory collision: ' + boardDirOf(workspace) + ' already belongs to workspace ' + owner +
                ', not ' + workspace.path + '. Changes are disabled; rename one workspace directory or move the board file.'
              warn(board, board.readOnlyReason)
            }
            if (parsed.migrated) {
              const backup = await backupFile(workspace, 'bak-v' + parsed.fromVersion, session)
              if (!backup) {
                migrated = false
                board.readOnlyReason = 'Board migration backup failed; changes are disabled to protect the original file.'
                warn(board, board.readOnlyReason)
              }
            }
          } else {
            const suffix = parsed.kind === 'unsupported'
              ? 'unsupported-v' + parsed.version
              : 'corrupt-' + timestamp()
            const backup = await backupFile(workspace, suffix, session)
            // 隔离后必须只读。原逻辑只在"备份失败"时上锁，于是备份**成功**的损坏看板
            // 会以一块空白但可写的看板继续服务——实测（2026-09-02）往这种看板写卡
            // 会返回 200 并落盘，把真正的看板挤掉。无人值守的 tick 因此会看到零张卡，
            // 当成"没有工作"，或者把整条流水线重建一遍。备份路径写进原因里，人才知道去哪找。
            board.readOnlyReason = parsed.kind === 'unsupported'
              ? 'Board was created by a newer plugin version; changes are disabled until the plugin is upgraded.'
              : backup
                ? 'Board data was invalid and has been quarantined to ' + BOARD_FILE + '.' + suffix +
                  '; changes are disabled so the empty board cannot overwrite it. Inspect the backup, then repair or remove the board file.'
                : 'Board backup failed; changes are disabled to protect the original file.'
            warn(board, board.readOnlyReason)
          }
        } catch (err) {
          console.log('dsh-kanban: 读取看板失败 ' + key + '：' + ((err && err.message) || err))
          if (!isNotFound(err)) {
            board.readOnlyReason = 'Board could not be read; changes are disabled to protect the existing file.'
            warn(board, board.readOnlyReason)
          }
        }
      }
      for (const col of board.columns) bumpSeq(col.id)
      for (const card of board.cards) {
        bumpSeq(card.id)
        for (const comment of card.comments) bumpSeq(comment.id)
      }
      for (const act of board.activities) bumpSeq(act.id)
      if (board.columns.length === 0) {
        for (const title of DEFAULT_COLUMNS) board.columns.push({ id: nextId('c'), title })
      }
      if (board.labels.length === 0) board.labels = DEFAULT_LABELS.map((l) => ({ ...l }))
      boards.set(key, board)
      if (migrated && fs && target) {
        try {
          await save(workspace, session)
        } catch (err) {
          board.readOnlyReason = 'Migrated board could not be saved; changes are disabled to protect the original file.'
          warn(board, board.readOnlyReason)
        }
      }
      return board
    })()
    boardLoads.set(key, load)
    try {
      return await load
    } finally {
      boardLoads.delete(key)
    }
  }
  const save = async (workspace, session) => {
    const fs = getFs()
    const target = await targetOf(workspace)
    const key = workspaceKey(workspace)
    const board = boards.get(key)
    if (!fs || !target || !board) return
    // 读到这块看板时文件的版本。没有版本（新建）就用 createIfAbsent，
    // 让后端拒绝覆盖一个我们从没读过的文件——那正是"另一个进程刚建好"的情况。
    const expected = boardVersions.has(key)
      ? { kind: 'replaceIfVersion', version: boardVersions.get(key) }
      : { kind: 'createIfAbsent' }
    try {
      const written = await fs.writeText(
        target,
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          workspacePath: workspace.path,
          columns: board.columns,
          labels: board.labels,
          cards: board.cards,
          activities: Array.isArray(board.activities) ? board.activities : [],
        }),
        expected,
        undefined,
        writePolicyFor(workspace, session),
      )
      if (written && written.version !== undefined) boardVersions.set(key, written.version)
      else boardVersions.delete(key)
    } catch (err) {
      console.log('dsh-kanban: 保存失败 ' + key + '：' + ((err && err.message) || err))
      if (isStaleVersion(err)) {
        // 另一个进程在我们读到之后改过这个文件。绝不能覆盖：丢掉本进程的缓存，
        // 下一次调用会重新读盘，并把失败如实回给调用方——对 claim 来说
        // "认领失败"正是文档写明的正常结局（写不下去就结束这一轮）。
        boards.delete(key)
        boardVersions.delete(key)
        const conflict = new Error(
          'Board changed on disk since this process read it (another dsh process or run wrote first); nothing was written. Re-read the board and retry.',
        )
        conflict.code = 'BOARD_STALE'
        throw conflict
      }
      throw err
    }
  }

  // ---- 校验 / 查找 / 序列化 ----
  const str = (v, fb) => (typeof v === 'string' ? v : fb)
  const PRIORITIES = ['high', 'medium', 'low']
  const normPriority = (v) => (typeof v === 'string' && PRIORITIES.includes(v) ? v : undefined)
  const normColor = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined)
  const findCard = (b, id) => b.cards.find((c) => c.id === id)
  const findColumn = (b, id) => b.columns.find((c) => c.id === id)
  const findLabel = (b, name) => b.labels.find((l) => l.name === name)

  const cloneBoard = (b) => ({
    columns: b.columns.map((c) => ({ id: c.id, title: c.title })),
    labels: b.labels.map((l) => ({ name: l.name, color: l.color })),
    cards: b.cards.map((c) => ({
      id: c.id,
      columnId: c.columnId,
      title: c.title,
      note: c.note ?? '',
      label: c.label ?? null,
      priority: c.priority ?? null,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
      createdBy: typeof c.createdBy === 'string' ? c.createdBy : null,
      // v4：state 必须跟着 clone 走，否则认领/租约信息在返回调用方的路上就没了。
      state: { ...EMPTY_STATE, ...(isObj(c.state) ? c.state : {}) },
      comments: Array.isArray(c.comments)
        ? c.comments.map((comment) => ({
            id: comment.id,
            content: comment.content,
            source: comment.source,
            createdAt: comment.createdAt,
          }))
        : [],
    })),
    activities: Array.isArray(b.activities) ? b.activities.map((a) => ({ ...a })) : [],
    // 只读原因必须随 clone 出去：调用方（尤其无人值守的 tick）要能判断状态，
    // 而不是去匹配一条告警字符串。
    readOnlyReason: b.readOnlyReason ?? null,
  })
  // 单卡克隆：动词返回被改动的那张卡，调用方无需再拉整块看板。
  const cloneCard = (card) => cloneBoard({ columns: [], labels: [], cards: [card], activities: [] }).cards[0]
  // 六个真实阶段——Blocked 和 Archive 不是工作队列，就绪列表永远不返回它们。
  const WORKING_STAGES = new Set(RESERVED_STAGE_TITLES.filter((t) => t !== 'Blocked' && t !== 'Archive'))
  const OUTCOMES = new Set(['promote', 'bounce', 'blocked'])
  const summaryOfClone = (clone) => ({
    columns: clone.columns.map((c) => ({
      id: c.id,
      title: c.title,
      count: clone.cards.filter((k) => k.columnId === c.id).length,
    })),
    labels: clone.labels.map((l) => ({ name: l.name, color: l.color })),
    cards: clone.cards.map((c) => ({
      id: c.id,
      columnId: c.columnId,
      title: c.title,
      label: c.label ?? null,
      priority: c.priority ?? null,
      commentCount: c.comments.length,
    })),
    readOnlyReason: clone.readOnlyReason ?? null,
  })

  // 追加一条活动事件（只读日志，随看板一起落盘）
  const record = (board, ev) => {
    if (!Array.isArray(board.activities)) board.activities = []
    board.activities.push({
      id: nextId('e'),
      ts: new Date().toISOString(),
      ...ev,
    })
    if (board.activities.length > ACTIVITY_LIMIT) {
      board.activities.splice(0, board.activities.length - ACTIVITY_LIMIT)
    }
  }

  const overLimit = (a) => {
    if (typeof a.title === 'string' && a.title.length > TITLE_LIMIT) {
      return 'Title exceeds ' + TITLE_LIMIT + ' characters (' + a.title.length + '); shorten it or move the detail into the note.'
    }
    if (typeof a.note === 'string' && a.note.length > NOTE_LIMIT) {
      return 'Note exceeds ' + NOTE_LIMIT + ' characters (' + a.note.length + '); split it across kanban_add_comment instead — nothing was written.'
    }
    return null
  }

  // ---- 核心数据操作：工具与浏览器 HTTP 共用同一份逻辑 ----
  // readyCards 是读：它必须能在隔离/冲突的看板上照常返回（tick 靠它判断"有没有活"），
  // 同时不该触发写路径的快照回滚开销。
  const READ_METHODS = new Set(['get', 'getCard', 'readyCards'])
  const dispatchUnlocked = async (workspace, method, args, source, session) => {
    const board = await boardOf(workspace, session)
    const a = args || {}
    const actor = source === 'agent' ? 'agent' : 'human'
    const persisted = () => persistedFlag(workspace)
    const result = (extra) => ({ board: cloneBoard(board), persisted: persisted(), warnings: takeWarnings(board), ...extra })
    if (!READ_METHODS.has(method) && board.readOnlyReason) {
      return result({ error: board.readOnlyReason })
    }

    switch (method) {
      case 'get':
        return { board: cloneBoard(board), persisted: persisted(), warnings: takeWarnings(board), message: 'Board loaded' }

      case 'getCard': {
        const card = cloneBoard(board).cards.find((c) => c.id === str(a.id, ''))
        if (!card) return { warnings: takeWarnings(board), error: 'Card not found: ' + str(a.id, '') }
        return { card, warnings: takeWarnings(board) }
      }

      case 'addCard': {
        const col = findColumn(board, str(a.columnId, '')) || board.columns[0]
        if (!col) return result({ error: 'No list available' })
        const label = typeof a.label === 'string' ? a.label.slice(0, 20) : undefined
        if (label && !findLabel(board, label)) return result({ error: 'Label not found: ' + label })
        const tooLong = overLimit(a)
        if (tooLong) return result({ error: tooLong })
        const card = {
          id: nextId('k'),
          columnId: col.id,
          title: str(a.title, '') || 'Untitled card',
          note: str(a.note, ''),
          label,
          priority: normPriority(a.priority),
          createdAt: new Date().toISOString(),
          createdBy: actor,
          comments: [],
          state: { ...EMPTY_STATE },
        }
        board.cards.push(card)
        record(board, {
          cardId: card.id,
          type: 'card_created',
          source: actor,
          meta: {
            title: card.title,
            column: col.title,
            label: card.label ?? null,
            priority: card.priority ?? null,
          },
        })
        await save(workspace, session)
        return result({ message: 'Card added to "' + col.title + '"' })
      }

      case 'updateCard': {
        const card = findCard(board, str(a.id, ''))
        if (card) {
          const nextLabel = typeof a.label === 'string' ? a.label.slice(0, 20) : undefined
          if (nextLabel && !findLabel(board, nextLabel)) return result({ error: 'Label not found: ' + nextLabel })
          const tooLong = overLimit(a)
          if (tooLong) return result({ error: tooLong })
          const before = {
            title: card.title,
            note: card.note,
            label: card.label ?? null,
            priority: card.priority ?? null,
          }
          if (typeof a.title === 'string') card.title = a.title || card.title
          if (typeof a.note === 'string') card.note = a.note
          if (typeof a.label === 'string') card.label = nextLabel || undefined
          if (typeof a.priority === 'string') card.priority = normPriority(a.priority)
          const after = {
            title: card.title,
            note: card.note,
            label: card.label ?? null,
            priority: card.priority ?? null,
          }
          if (after.title !== before.title) {
            record(board, { cardId: card.id, type: 'card_title_changed', source: actor, field: 'title', from: before.title, to: after.title })
          }
          if (after.note !== before.note) {
            record(board, { cardId: card.id, type: 'card_note_changed', source: actor, field: 'note' })
          }
          if (after.label !== before.label) {
            record(board, { cardId: card.id, type: 'card_label_changed', source: actor, field: 'label', from: before.label, to: after.label })
          }
          if (after.priority !== before.priority) {
            record(board, { cardId: card.id, type: 'card_priority_changed', source: actor, field: 'priority', from: before.priority, to: after.priority })
          }
          await save(workspace, session)
        }
        return card
          ? result({ message: 'Card updated' })
          : result({ error: 'Card not found: ' + str(a.id, '') })
      }

      case 'addComment': {
        const card = findCard(board, str(a.id, ''))
        if (!card) return result({ error: 'Card not found: ' + str(a.id, '') })
        const content = str(a.content, '').trim()
        if (!content) return result({ error: 'Comment content required' })
        if (content.length > 2000) return result({ error: 'Comment exceeds 2000 characters' })
        const comment = {
          id: nextId('m'),
          content,
          source: actor,
          createdAt: new Date().toISOString(),
        }
        card.comments.push(comment)
        record(board, { cardId: card.id, type: 'card_comment_added', source: actor, meta: { title: card.title } })
        await save(workspace, session)
        return result({ message: 'Comment added' })
      }

      // ---- 无人值守 tick 的五个动词（item 6）----
      // 全部是 dispatchUnlocked 的 case 分支，绝不由现有工具拼装：dispatch 的每工作区
      // 串行队列 + 深拷贝快照回滚（:1091）就是它们的临界区。Probe E 实测 read-then-write
      // 形状 8/8 丢写者，所以"先查再写"在这里等于没写。

      // 认领 = 对 owner 的原子 test-and-set。同一个 run 重复认领是幂等的（续心跳），
      // 别人持有则失败——失败是正常结果，调用方应当什么都不做地结束这一轮。
      case 'claimCard': {
        const id = str(a.id, '')
        const runId = str(a.ownerRunId, '')
        const card = findCard(board, id)
        if (!card) return result({ error: 'Card not found: ' + id })
        if (!runId) return result({ error: 'ownerRunId is required to claim a card' })
        const now = new Date().toISOString()
        const st = card.state
        if (st.owner && st.owner !== runId) {
          return result({ error: 'Card ' + id + ' is already claimed by ' + st.owner + '; claim lost' })
        }
        st.owner = runId
        st.ownerRunId = runId
        st.heartbeatAt = now
        record(board, { cardId: id, type: 'card_claimed', source: actor, meta: { title: card.title, owner: runId } })
        await save(workspace, session)
        return result({ message: 'Claimed ' + id + ' for ' + runId, card: cloneCard(card) })
      }

      // 退回：后退一列 + 计数 + 理由，一次原子写。理由是必填的，因为它是下一轮的主输入。
      case 'bounceCard': {
        const id = str(a.id, '')
        const card = findCard(board, id)
        const target = findColumn(board, str(a.toStage, '')) || board.columns.find((c) => c.title === str(a.toStage, ''))
        const reason = str(a.reason, '')
        if (!card) return result({ error: 'Card not found: ' + id })
        if (!target) return result({ error: 'Unknown target stage: ' + str(a.toStage, '') })
        if (!reason) return result({ error: 'A bounce reason is required; it is the next run\'s primary input' })
        const fromCol = findColumn(board, card.columnId)
        const fromTitle = fromCol ? fromCol.title : String(card.columnId)
        const edge = fromTitle + '->' + target.title
        const st = card.state
        card.columnId = target.id
        st.bounceCount += 1
        st.bouncesByEdge[edge] = (st.bouncesByEdge[edge] || 0) + 1
        st.lastBounceReason = reason
        // 退回是这一阶段的终结：交还认领，让下一轮可以重新领。
        st.owner = null
        st.ownerRunId = null
        st.dispatched = null
        st.heartbeatAt = null
        record(board, { cardId: id, type: 'card_bounced', source: actor, field: 'columnId', from: fromTitle, to: target.title, meta: { title: card.title, edge, bounceCount: st.bounceCount } })
        await save(workspace, session)
        return result({ message: 'Bounced ' + id + ' ' + edge + ' (bounce #' + st.bounceCount + ')', card: cloneCard(card) })
      }

      // 回收：释放心跳过期的认领。这是崩溃残留的清扫，而崩溃残留是通宵循环的常态。
      // 不提升、不判定成败——只把卡片还回池子，由下一轮重新决定。
      case 'reap': {
        const seconds = Number(a.staleAfterSeconds)
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return result({ error: 'staleAfterSeconds must be a positive number' })
        }
        const cutoff = Date.now() - seconds * 1000
        const released = []
        for (const card of board.cards) {
          const st = card.state
          if (!st.owner) continue
          const beat = st.heartbeatAt ? Date.parse(st.heartbeatAt) : NaN
          if (Number.isFinite(beat) && beat >= cutoff) continue
          released.push({ id: card.id, owner: st.owner, heartbeatAt: st.heartbeatAt })
          st.lastBounceReason = 'reaped: owning run ' + st.owner + ' went stale before writing an exit'
          st.owner = null
          st.ownerRunId = null
          st.dispatched = null
          st.heartbeatAt = null
          record(board, { cardId: card.id, type: 'card_reaped', source: actor, meta: { title: card.title, owner: released[released.length - 1].owner } })
        }
        if (released.length > 0) await save(workspace, session)
        return result({ message: 'Reaped ' + released.length + ' stale claim(s)', released })
      }

      // 就绪列表是读操作：无主 + 处于六个真实阶段（Blocked/Archive 不是工作队列）。
      // 过滤放在插件里而不是留给提示词，是因为 3am 没有人复核模型的判断。
      case 'readyCards': {
        const wanted = str(a.column, '')
        const ready = board.cards.filter((card) => {
          if (card.state.owner) return false
          const col = findColumn(board, card.columnId)
          if (!col || !WORKING_STAGES.has(col.title)) return false
          return !wanted || col.id === wanted || col.title === wanted
        })
        return {
          board: cloneBoard(board),
          persisted: persisted(),
          warnings: takeWarnings(board),
          message: ready.length + ' ready card(s)',
          cards: ready.map(cloneCard),
        }
      }

      // 收尾：对 state.dispatched 的原子 compare-and-set。只有当这张卡仍然停在
      // 调用方声称的那个阶段的派工上，写入才生效；否则拒绝——另一个 tick 已经收过尾了。
      // 这跟 claimCard 是两个不同的竞态：claim 守派工，finalize 守收尾（Probe E）。
      case 'finalizeCard': {
        const id = str(a.id, '')
        const runId = str(a.ownerRunId, '')
        const stage = str(a.stage, '')
        const outcome = str(a.outcome, '')
        const card = findCard(board, id)
        if (!card) return result({ error: 'Card not found: ' + id })
        if (!OUTCOMES.has(outcome)) {
          return result({ error: 'outcome must be one of: ' + [...OUTCOMES].join(', ') })
        }
        const st = card.state
        if (!st.dispatched) {
          return result({ error: 'finalize lost: ' + id + ' has no dispatched stage to finalize' })
        }
        if (st.dispatched.stage !== stage) {
          return result({ error: 'finalize lost: ' + id + ' is dispatched for ' + st.dispatched.stage + ', not ' + stage })
        }
        if (runId && st.ownerRunId && st.ownerRunId !== runId) {
          return result({ error: 'finalize lost: ' + id + ' is held by ' + st.ownerRunId + ', not ' + runId })
        }
        const fromCol = findColumn(board, card.columnId)
        const fromTitle = fromCol ? fromCol.title : String(card.columnId)
        let target = fromCol
        if (outcome === 'promote') {
          const idx = RESERVED_STAGE_TITLES.indexOf(fromTitle)
          const nextTitle = idx >= 0 ? RESERVED_STAGE_TITLES[idx + 1] : null
          target = nextTitle ? board.columns.find((c) => c.title === nextTitle) : null
          if (!target) return result({ error: 'Cannot promote ' + id + ' beyond ' + fromTitle })
        } else if (outcome === 'bounce') {
          target = findColumn(board, str(a.toStage, '')) || board.columns.find((c) => c.title === str(a.toStage, ''))
          if (!target) return result({ error: 'Unknown target stage: ' + str(a.toStage, '') })
          const reason = str(a.reason, '')
          if (!reason) return result({ error: 'A bounce reason is required; it is the next run\'s primary input' })
          const edge = fromTitle + '->' + target.title
          st.bounceCount += 1
          st.bouncesByEdge[edge] = (st.bouncesByEdge[edge] || 0) + 1
          st.lastBounceReason = reason
        } else {
          target = board.columns.find((c) => c.title === 'Blocked')
          if (!target) return result({ error: 'No Blocked column to park ' + id })
          const reason = str(a.reason, '')
          if (!reason) return result({ error: 'Parking requires a concrete obstacle in reason' })
          st.lastBounceReason = 'CONCRETE OBSTACLE: ' + reason
        }
        card.columnId = target.id
        // 三个结局都是终结：清掉派工与认领，卡片回到可领状态。
        st.dispatched = null
        st.owner = null
        st.ownerRunId = null
        st.heartbeatAt = null
        record(board, { cardId: id, type: 'card_finalized', source: actor, field: 'columnId', from: fromTitle, to: target.title, meta: { title: card.title, outcome, stage } })
        await save(workspace, session)
        return result({ message: 'Finalized ' + id + ' (' + outcome + ') ' + fromTitle + ' -> ' + target.title, card: cloneCard(card) })
      }

      // 派工登记（结局 D，非终结）：保留认领，因为团队活得比这个进程久。
      case 'dispatchCard': {
        const id = str(a.id, '')
        const runId = str(a.ownerRunId, '')
        const stage = str(a.stage, '')
        const teamName = str(a.teamName, '')
        const card = findCard(board, id)
        if (!card) return result({ error: 'Card not found: ' + id })
        if (!stage || !teamName) return result({ error: 'stage and teamName are required to record a dispatch' })
        const st = card.state
        if (!st.owner) return result({ error: 'Cannot dispatch ' + id + ': it is not claimed' })
        if (runId && st.owner !== runId) {
          return result({ error: 'dispatch lost: ' + id + ' is held by ' + st.owner + ', not ' + runId })
        }
        if (st.dispatched) {
          return result({ error: 'dispatch lost: ' + id + ' is already dispatched for ' + st.dispatched.stage })
        }
        const now = new Date().toISOString()
        st.dispatched = { stage, teamName, at: now }
        st.heartbeatAt = now
        record(board, { cardId: id, type: 'card_dispatched', source: actor, meta: { title: card.title, stage, teamName } })
        await save(workspace, session)
        return result({ message: 'Dispatched ' + id + ' for ' + stage + ' (team ' + teamName + ')', card: cloneCard(card) })
      }

      case 'deleteCard': {
        const id = str(a.id, '')
        const card = findCard(board, id)
        if (!card) return result({ error: 'Card not found: ' + id })
        board.cards = board.cards.filter((c) => c.id !== id)
        record(board, { cardId: id, type: 'card_deleted', source: actor, meta: { title: card.title } })
        await save(workspace, session)
        return result({ message: 'Card deleted' })
      }

      case 'moveCard': {
        const card = findCard(board, str(a.id, ''))
        const target = findColumn(board, str(a.columnId, ''))
        if (!card || !target) return result({ error: 'Card or list not found' })
        const fromCol = findColumn(board, card.columnId)
        const fromTitle = fromCol ? fromCol.title : String(card.columnId)
        board.cards = board.cards.filter((c) => c.id !== card.id)
        card.columnId = target.id
        const inCol = board.cards.filter((c) => c.columnId === target.id)
        const toIndex = typeof a.toIndex === 'number' && Number.isFinite(a.toIndex)
          ? Math.max(0, Math.min(Math.floor(a.toIndex), inCol.length))
          : inCol.length
        const anchor = inCol[toIndex]
        if (anchor) board.cards.splice(board.cards.indexOf(anchor), 0, card)
        else board.cards.push(card)
        if (fromTitle !== target.title) {
          record(board, { cardId: card.id, type: 'card_moved', source: actor, field: 'columnId', from: fromTitle, to: target.title, meta: { title: card.title } })
        }
        await save(workspace, session)
        return result({ message: 'Moved to "' + target.title + '"' })
      }

      case 'addColumn': {
        const title = str(a.title, '').slice(0, 40) || 'New list'
        board.columns.push({ id: nextId('c'), title })
        record(board, { cardId: null, type: 'column_added', source: actor, meta: { column: title } })
        await save(workspace, session)
        return result({ message: 'List added: "' + title + '"' })
      }

      case 'renameColumn': {
        const col = findColumn(board, str(a.id, ''))
        if (col && RESERVED_STAGES.has(col.title)) return result({ error: RESERVED_STAGE_REFUSAL + col.title })
        if (col && typeof a.title === 'string') {
          const before = col.title
          col.title = a.title.slice(0, 40) || col.title
          if (col.title !== before) {
            record(board, { cardId: null, type: 'column_renamed', source: actor, field: 'title', from: before, to: col.title, meta: { column: col.title } })
          }
          await save(workspace, session)
        }
        return col ? result({ message: 'List renamed' }) : result({ error: 'List not found' })
      }

      case 'deleteColumn': {
        const id = str(a.id, '')
        if (board.columns.length <= 1) return result({ error: 'At least one list must remain' })
        const idx = board.columns.findIndex((c) => c.id === id)
        if (idx < 0) return result({ error: 'List not found' })
        const deleted = board.columns[idx]
        if (RESERVED_STAGES.has(deleted.title)) return result({ error: RESERVED_STAGE_REFUSAL + deleted.title })
        board.columns.splice(idx, 1)
        const fallback = board.columns[0].id
        for (const card of board.cards) {
          if (card.columnId === id) {
            card.columnId = fallback
            record(board, { cardId: card.id, type: 'card_moved', source: actor, field: 'columnId', from: deleted.title, to: board.columns[0].title, meta: { title: card.title } })
          }
        }
        record(board, { cardId: null, type: 'column_deleted', source: actor, meta: { column: deleted.title } })
        await save(workspace, session)
        return result({ message: 'List deleted, cards moved to "' + board.columns[0].title + '"' })
      }

      case 'moveColumn': {
        const id = str(a.id, '')
        const idx = board.columns.findIndex((c) => c.id === id)
        if (idx < 0) return result({ error: 'List not found' })
        const [col] = board.columns.splice(idx, 1)
        const toIndex = typeof a.toIndex === 'number' && Number.isFinite(a.toIndex)
          ? Math.max(0, Math.min(Math.floor(a.toIndex), board.columns.length))
          : board.columns.length
        board.columns.splice(toIndex, 0, col)
        await save(workspace, session)
        return result({ message: 'List order updated' })
      }

      case 'addLabel': {
        const name = str(a.name, '').slice(0, 20)
        if (!name) return result({ error: 'Label name required' })
        if (findLabel(board, name)) return result({ error: 'Label already exists' })
        board.labels.push({ name, color: normColor(a.color) || '#94a3b8' })
        record(board, { cardId: null, type: 'label_added', source: actor, meta: { label: name } })
        await save(workspace, session)
        return result({ message: 'Label added: "' + name + '"' })
      }

      case 'updateLabel': {
        const name = str(a.name, '')
        const label = findLabel(board, name)
        if (!label) return result({ error: 'Label not found' })
        const newName = str(a.newName, '').slice(0, 20)
        if (newName && newName !== name) {
          if (findLabel(board, newName)) return result({ error: 'Label name already exists' })
          label.name = newName
          for (const card of board.cards) {
            if (card.label === name) {
              card.label = newName
              record(board, { cardId: card.id, type: 'card_label_changed', source: actor, field: 'label', from: name, to: newName, meta: { title: card.title } })
            }
          }
          record(board, { cardId: null, type: 'label_renamed', source: actor, field: 'name', from: name, to: newName, meta: { label: newName } })
        }
        if (typeof a.color === 'string') {
          const beforeColor = label.color
          label.color = normColor(a.color) || label.color
          if (label.color !== beforeColor) {
            record(board, { cardId: null, type: 'label_color_changed', source: actor, field: 'color', from: beforeColor, to: label.color, meta: { label: label.name } })
          }
        }
        await save(workspace, session)
        return result({ message: 'Label updated' })
      }

      case 'deleteLabel': {
        const name = str(a.name, '')
        const idx = board.labels.findIndex((l) => l.name === name)
        if (idx < 0) return result({ error: 'Label not found' })
        board.labels.splice(idx, 1)
        for (const card of board.cards) {
          if (card.label === name) {
            card.label = undefined
            record(board, { cardId: card.id, type: 'card_label_changed', source: actor, field: 'label', from: name, to: null, meta: { title: card.title } })
          }
        }
        record(board, { cardId: null, type: 'label_deleted', source: actor, meta: { label: name } })
        await save(workspace, session)
        return result({ message: 'Label deleted' })
      }

      default:
        return result({ error: 'Unknown kanban method: ' + method })
    }
  }

  const dispatch = (workspace, method, args, source, session) => {
    const key = workspaceKey(workspace)
    const previous = workspaceQueues.get(key) || Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      const board = await boardOf(workspace, session)
      const snapshot = READ_METHODS.has(method) ? null : JSON.parse(JSON.stringify(board))
      try {
        return await dispatchUnlocked(workspace, method, args, source, session)
      } catch (err) {
        // BOARD_STALE 是例外：save() 已经故意丢掉了缓存，因为盘上的内容比我们的新。
        // 这里若把快照塞回去，等于把过期视图当成"回滚成功"，之后每次读都还是旧的
        // ——实测正是这样让认领失败的一方永远看不到真正的持有者。
        if (snapshot && !(err && err.code === 'BOARD_STALE')) boards.set(key, snapshot)
        throw err
      }
    })
    const settled = run.then(() => undefined, () => undefined)
    workspaceQueues.set(key, settled)
    settled.finally(() => {
      if (workspaceQueues.get(key) === settled) workspaceQueues.delete(key)
    })
    return run
  }

  // ---- 工具执行上下文 / 浏览器 workspaceId -> 工作区 ----
  const workspaceOfExec = async (exec) => {
    const agent = exec && exec.agent
    const session = agent && agent.session
    const cwd = session && session.header && session.header.cwd
    if (typeof cwd !== 'string' || !cwd) return null
    const registry = getWorkspaceRegistry()
    if (registry) {
      try {
        const workspace = await registry.resolveByPath(cwd)
        if (workspace) return workspace
      } catch (err) {
        console.log('dsh-kanban: 解析工作区失败：' + ((err && err.message) || err))
      }
    }
    // 未登记到 WorkspaceRegistry 的会话仍以自身 cwd 作为工作区根目录。
    return { id: 'cwd:' + cwd, path: cwd, title: cwd }
  }
  const workspaceOfId = (id) => {
    const registry = getWorkspaceRegistry()
    return registry && typeof registry.get === 'function' ? registry.get(id) : undefined
  }
  const emptyBoardSummary = { columns: [], labels: [], cards: [] }

  // 显式 workspaceId 优先于 cwd 推导，并且不允许回退：
  // 调用方指名了看板，解析不到就必须停，退回 cwd 只会写进另一块看板。
  // 无显式 id 时沿用 cwd 推导；一旦落到未登记的 cwd: 身份，就把警告一并带出去
  // ——实测（2026-09-02）一个没有 cwd 的 cron agent 会解析成 cwd:/home/james，
  // 凭空建出 ~/.dsh-boards/james/board.json，而工具输出与成功写入真看板完全一样。
  const targetWorkspace = async (args, exec) => {
    const id = args && typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
    if (id) {
      const workspace = workspaceOfId(id)
      if (!workspace) return { error: 'Unknown workspaceId: ' + id }
      return { workspace }
    }
    const workspace = await workspaceOfExec(exec)
    if (!workspace) return { error: 'Cannot determine the current workspace from the tool execution context' }
    if (String(workspace.id || '').startsWith('cwd:')) {
      return {
        workspace,
        warning:
          'Workspace not registered: resolved from the calling cwd ' + workspace.path + ', so this board is ' +
          boardDirOf(workspace) + '/' + BOARD_FILE + ' rather than a registered project board. ' +
          'Pass workspaceId explicitly to address a specific board.',
      }
    }
    return { workspace }
  }
  const withWarning = (warning, warnings) =>
    warning ? [warning, ...(Array.isArray(warnings) ? warnings : [])] : Array.isArray(warnings) ? warnings : []

  const runTool = async (method, args, exec) => {
    const { workspace, error, warning } = await targetWorkspace(args, exec)
    if (!workspace) {
      return { ok: false, message: error, board: emptyBoardSummary, warnings: [] }
    }
    const session = exec && exec.agent && exec.agent.session
    try {
      const r = await dispatch(workspace, method, args, 'agent', session)
      return {
        ok: !r.error,
        message: r.error || r.message || 'Done',
        board: summaryOfClone(r.board),
        warnings: withWarning(warning, r.warnings),
        // 动词返回被改动的那张卡 / 就绪清单；没有就不带这两个键。
        ...(r.card ? { card: r.card } : {}),
        ...(r.cards ? { cards: r.cards } : {}),
        ...(r.released ? { released: r.released } : {}),
      }
    } catch (err) {
      return {
        ok: false,
        message: 'Board change could not be persisted: ' + ((err && err.message) || err),
        board: summaryOfClone(cloneBoard(await boardOf(workspace, session))),
        warnings: withWarning(warning, []),
      }
    }
  }

  // ---- 浏览器数据层：经官方 webServer 扩展点注册 /api/kanban ----
  const MAX_HTTP_BODY = 1024 * 1024
  const sendJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  const httpHandler = async (req, res) => {
    try {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      const contentType = String(req.headers && req.headers['content-type'] || '').toLowerCase()
      if (!contentType.startsWith('application/json')) return sendJson(res, 415, { error: 'Expected application/json' })
      const origin = req.headers && req.headers.origin
      const host = req.headers && req.headers.host
      if (origin && host) {
        let originHost = ''
        try { originHost = new URL(origin).host } catch {}
        if (originHost !== host) return sendJson(res, 403, { error: 'Cross-origin request denied' })
      }

      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_HTTP_BODY) return sendJson(res, 413, { error: 'Request body too large' })
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) : {}
      const method = typeof body.method === 'string' ? body.method : 'get'
      const args = isObj(body.args) ? body.args : {}
      const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId : ''
      const workspace = workspaceId ? workspaceOfId(workspaceId) : undefined
      if (!workspace) return sendJson(res, 400, { error: 'Unknown workspace: ' + (workspaceId || '(missing)') })
      const result = await dispatch(workspace, method, args, 'human')
      return sendJson(res, result.error ? 400 : 200, result)
    } catch (err) {
      const status = err instanceof SyntaxError ? 400 : 500
      return sendJson(res, status, { error: String((err && err.message) || err) })
    }
  }

  const routeState = { registered: false, timer: null, dispose: null, disposed: false, attempts: 0 }
  const registerRoute = () => {
    if (routeState.registered || routeState.disposed) return
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    try {
      const dispose = webServer.register({ kind: 'prefix', path: '/api/kanban', handler: httpHandler })
      routeState.dispose = typeof dispose === 'function' ? dispose : null
      routeState.registered = true
      console.log('dsh-kanban: /api/kanban 路由已注册')
    } catch (err) {
      console.log('dsh-kanban: 路由注册失败：' + ((err && err.message) || err))
    }
  }
  registerRoute()
  if (!routeState.registered) {
    const timer = ctx.get('timer')
    if (timer) {
      routeState.timer = timer.interval(() => {
        routeState.attempts++
        registerRoute()
        maybeStartupCheck()
        if (routeState.registered || routeState.attempts >= 40) {
          if (routeState.timer) routeState.timer()
          routeState.timer = null
        }
      }, 500)
    }
  }

  // ---- 启动校验：逐个工作区体检 ~/.dsh-boards/<project>/board.json（只读 + 备份损坏文件）----
  const startupState = { done: false }
  const maybeStartupCheck = () => {
    if (startupState.done) return
    const registry = getWorkspaceRegistry()
    if (!getFs() || !registry || typeof registry.list !== 'function') return
    startupState.done = true
    runStartupCheck()
  }
  const runStartupCheck = async () => {
    const fs = getFs()
    const registry = getWorkspaceRegistry()
    if (!fs || !registry || typeof registry.list !== 'function') return
    try {
      const workspaces = registry.list()
      let found = 0
      let corrupt = 0
      let pendingUpgrade = 0
      let unsupported = 0
      let ok = 0
      for (const workspace of workspaces) {
        const key = workspaceKey(workspace)
        try {
          const target = await fs.resolve(boardDirOf(workspace) + '/' + BOARD_FILE)
          const text = await fs.readText(target)
          found++
          const parsed = parseBoardText(text)
          if (parsed.ok) {
            if (parsed.migrated) {
              pendingUpgrade++
              console.log('dsh-kanban: 启动校验 ' + key + '：schemaVersion ' + parsed.fromVersion + '，首次打开时将自动升级')
            } else {
              ok++
            }
          } else if (parsed.kind === 'unsupported') {
            unsupported++
            console.log('dsh-kanban: 启动校验 ' + key + '：文件由更新版本插件写入（schemaVersion ' + parsed.version + '）')
          } else {
            corrupt++
            const suffix = 'corrupt-' + timestamp()
            const backupTarget = await fs.resolve(boardDirOf(workspace) + '/' + BOARD_FILE + '.' + suffix)
            await fs.writeText(backupTarget, text, undefined, undefined, writePolicyFor(workspace))
            console.log('dsh-kanban: 启动校验 ' + key + '：数据文件损坏（' + parsed.kind + '），已备份为 ' + BOARD_FILE + '.' + suffix)
          }
        } catch (err) {
          if (!err || (err.code !== 'ENOENT' && err.message !== 'ENOENT')) {
            console.log('dsh-kanban: 启动校验 ' + key + '：检查失败 ' + ((err && err.message) || err))
          }
        }
      }
      if (found === 0) {
        console.log('dsh-kanban: 启动校验完成，未发现看板数据文件')
        return
      }
      console.log(
        'dsh-kanban: 启动校验完成：共 ' +
          found +
          ' 个看板文件，正常 ' +
          ok +
          '，损坏并已备份 ' +
          corrupt +
          '，待自动升级 ' +
          pendingUpgrade +
          '，版本超前 ' +
          unsupported,
      )
    } catch (err) {
      console.log('dsh-kanban: 启动校验失败：' + ((err && err.message) || err))
    }
  }
  maybeStartupCheck()

  // ---- 工具注册 ----
  const resultSchema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string' },
      board: { type: 'object' },
      warnings: { type: 'array', items: { type: 'string' } },
      // item 6 的动词：改动的卡 / 就绪清单 / 被回收的认领。
      card: { type: 'object' },
      cards: { type: 'array', items: { type: 'object' } },
      released: { type: 'array', items: { type: 'object' } },
    },
    required: ['ok', 'message'],
    additionalProperties: false,
  }
  const renderBoard = (value) => {
    const b = value && value.board
    const lines = []
    if (Array.isArray(value && value.warnings)) {
      for (const w of value.warnings) lines.push('⚠ ' + w)
    }
    lines.push(String((value && value.message) || ''))
    if (b && Array.isArray(b.columns)) {
      lines.push('Board state:')
      for (const col of b.columns) {
        lines.push('· ' + col.title + ' (' + col.count + ')')
      }
      if (Array.isArray(b.labels) && b.labels.length > 0) {
        lines.push('Labels: ' + b.labels.map((l) => l.name).join(' / '))
      }
      if (Array.isArray(b.cards)) {
        for (const card of b.cards) {
          lines.push(
            '  - [' + card.id + '] ' +
            (card.priority ? '[' + card.priority + '] ' : '') +
            (card.label ? '[' + card.label + '] ' : '') +
            card.title +
            (card.commentCount ? ' (' + card.commentCount + ' comments)' : ''),
          )
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const output = (render) => ({ schema: resultSchema, render: (args, value) => render(value) })

  // 每个工具都接受显式 workspaceId；省略即按调用会话的 cwd 推导。
  // 描述必须写明"未登记的 cwd 会写进一块新看板"这件事——模型只读得到描述，
  // 而这正是无人值守场景里唯一会出错、又完全不像出错的一步。
  const wsParam = {
    workspaceId: {
      type: 'string',
      description:
        'Workspace (project) id to act on (optional). Omit to use the calling session\'s working directory. ' +
        'An unknown id is rejected rather than falling back. Pass it explicitly from unattended jobs: a working ' +
        'directory outside any registered project resolves to a separate board of its own instead of failing.',
    },
  }
  const params = (properties, required) => ({
    type: 'object',
    properties: { ...properties, ...wsParam },
    ...(required ? { required } : {}),
  })

  const tools = [
    {
      name: 'kanban_get',
      description: 'Read the current state of the current project (workspace, or the one given by workspaceId) kanban board (all lists, labels and cards). Call it before planning to understand existing content and avoid duplicate cards.',
      parameters: params({}),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('get', args, exec)
      },
    },
    {
      name: 'kanban_get_card',
      description: "Read one card's full details (title, note, label, priority and comments) by id from the current project (workspace, or the one given by workspaceId) board. Use kanban_get first to discover card ids, then this tool to read the complete card and comment history.",
      parameters: params(
        {
          id: { type: 'string', description: 'Card id (see kanban_get output)' },
        },
        ['id'],
      ),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            card: { type: 'object' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (args, value) => {
          const c = value && value.card
          const lines = []
          if (Array.isArray(value && value.warnings)) {
            for (const w of value.warnings) lines.push('⚠ ' + w)
          }
          lines.push(String((value && value.message) || ''))
          if (c) {
            lines.push('[' + c.id + '] ' + c.title)
            if (c.priority) lines.push('Priority: ' + c.priority)
            if (c.label) lines.push('Label: ' + c.label)
            if (c.note) lines.push('Note: ' + c.note)
            if (Array.isArray(c.comments) && c.comments.length > 0) {
              lines.push('Comments:')
              for (const comment of c.comments) {
                lines.push('  - [' + comment.createdAt + '] ' + comment.source + ': ' + comment.content)
              }
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        const { workspace, error, warning } = await targetWorkspace(args, exec)
        if (!workspace) return { ok: false, message: error, warnings: [] }
        const session = exec && exec.agent && exec.agent.session
        const r = await dispatch(workspace, 'getCard', args, 'agent', session)
        if (r.error) return { ok: false, message: r.error, warnings: withWarning(warning, r.warnings) }
        return { ok: true, message: 'Card ' + String(args.id || '') + ' details', card: r.card, warnings: withWarning(warning, r.warnings) }
      },
    },
    {
      name: 'kanban_add_comment',
      description: 'Add a comment to a card in the current project (workspace, or the one given by workspaceId). Use it to leave progress updates, decisions, questions, or review feedback.',
      parameters: params(
        {
          id: { type: 'string', description: 'Card id' },
          content: { type: 'string', description: 'Comment text (1-2000 characters)' },
        },
        ['id', 'content'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('addComment', args, exec)
      },
    },
    {
      name: 'kanban_add_card',
      description: 'Add a card to the current project (workspace, or the one given by workspaceId) kanban board. Write feature breakdowns and plans to the board: one card per task step.',
      parameters: params(
        {
          title: { type: 'string', description: 'Card title (task name, concise and actionable)' },
          columnId: { type: 'string', description: 'Target list id; defaults to the first list (Spec)' },
          note: { type: 'string', description: 'Note: background, acceptance criteria or breakdown details (optional)' },
          label: { type: 'string', description: 'Label name (optional). Must already exist on the board — call kanban_get_label to list, kanban_add_label to create. An unknown name is rejected and the card is NOT created.' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority (optional): high=P0 / medium=P1 / low=P2' },
        },
        ['title'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('addCard', args, exec)
      },
    },
    {
      name: 'kanban_update_card',
      description: "Update a card's title, note, label or priority on the board.",
      parameters: params(
        {
          id: { type: 'string', description: 'Card id' },
          title: { type: 'string', description: 'New title (optional)' },
          note: { type: 'string', description: 'New note (optional)' },
          label: { type: 'string', description: 'New label name (optional); must already exist on the board (see kanban_add_label), an unknown name is rejected; pass empty string to clear' },
          priority: { type: 'string', enum: ['high', 'medium', 'low', ''], description: 'New priority (optional): high=P0 / medium=P1 / low=P2; pass empty string to clear' },
        },
        ['id'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('updateCard', args, exec)
      },
    },
    {
      name: 'kanban_delete_card',
      description: 'Delete a card from the board (permanent, not recoverable).',
      parameters: params({ id: { type: 'string', description: 'Card id' } }, ['id']),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('deleteCard', args, exec)
      },
    },
    {
      name: 'kanban_move_card',
      description: 'Move a card to the specified list (e.g. from Spec to Decompose). Use when a task status changes.',
      parameters: params(
        {
          id: { type: 'string', description: 'Card id' },
          columnId: { type: 'string', description: 'Target list id' },
          toIndex: { type: 'integer', description: 'Position within the target list (optional); takes effect when reordering within the same list, 0 = top' },
        },
        ['id', 'columnId'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('moveCard', args, exec)
      },
    },
    {
      name: 'kanban_claim_card',
      description: 'Atomically claim a card for an unattended run: takes the lease only if the card is unowned (or already yours, which just refreshes the heartbeat). A failed claim means another run holds the card — that is a normal result: write nothing and end the turn, do not pick a different card.',
      parameters: params(
        {
          id: { type: 'string', description: 'Card id' },
          ownerRunId: { type: 'string', description: "The claiming run's id (e.g. the dsh-cron run/session id)" },
        },
        ['id', 'ownerRunId'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('claimCard', args, exec)
      },
    },
    {
      name: 'kanban_dispatch_card',
      description: 'Record that work for a stage is in flight (outcome D, non-terminal): keeps the claim, because the team outlives the run that started it. Requires the card to be claimed and not already dispatched. A later run reconciles it with kanban_finalize_card.',
      parameters: params(
        {
          id: { type: 'string', description: 'Card id' },
          stage: { type: 'string', description: 'Stage being dispatched (e.g. Build)' },
          teamName: { type: 'string', description: 'Name of the team started for this stage' },
          ownerRunId: { type: 'string', description: "The dispatching run's id (optional; checked against the claim when given)" },
        },
        ['id', 'stage', 'teamName'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('dispatchCard', args, exec)
      },
    },
    {
      name: 'kanban_finalize_card',
      description: 'Atomically write the terminal outcome (promote / bounce / blocked) for a stage an EARLIER run dispatched. Compare-and-set against the card\'s dispatched stage: if another run finalized it first your call is REJECTED — that is expected. Never retry it, never fall back to kanban_move_card or kanban_bounce_card to force it through.',
      parameters: params(
        {
          id: { type: 'string', description: 'Card id' },
          stage: { type: 'string', description: 'The stage you believe the card is dispatched for' },
          outcome: { type: 'string', description: 'promote | bounce | blocked' },
          ownerRunId: { type: 'string', description: "The finalizing run's id (optional; checked against the claim when given)" },
          toStage: { type: 'string', description: 'Target stage; required when outcome is bounce' },
          reason: { type: 'string', description: 'Actionable reason naming a file, command, exit code or concrete defect; required for bounce and blocked' },
        },
        ['id', 'stage', 'outcome'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('finalizeCard', args, exec)
      },
    },
    {
      name: 'kanban_bounce_card',
      description: 'Move a card BACKWARD one or more stages and record why, atomically: increments the total bounce count, the per-edge count, and stores the reason, then releases the claim. The reason must be actionable — name a file, command, exit code or concrete defect and say what the next run should do differently. Vague reasons are void.',
      parameters: params(
        {
          id: { type: 'string', description: 'Card id' },
          toStage: { type: 'string', description: 'Target stage id or title to bounce back to' },
          reason: { type: 'string', description: 'Actionable reason; becomes the next run\'s primary input' },
        },
        ['id', 'toStage', 'reason'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('bounceCard', args, exec)
      },
    },
    {
      name: 'kanban_reap',
      description: 'Release claims whose heartbeat is older than staleAfterSeconds — the crash-residue pass for an unattended loop. Reaped cards are returned to the pool with a reason recorded; they are never promoted, because the run that would have produced the evidence is gone.',
      parameters: params(
        { staleAfterSeconds: { type: 'integer', description: 'Release claims whose heartbeat is older than this many seconds' } },
        ['staleAfterSeconds'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('reap', args, exec)
      },
    },
    {
      name: 'kanban_ready_cards',
      description: 'List cards that are ready to be worked: unowned AND in one of the six working stages (never Blocked, never Archive). Use this instead of filtering kanban_get yourself — the filter is the board\'s job, not the prompt\'s.',
      parameters: params({ column: { type: 'string', description: 'Restrict to one stage id or title (optional)' } }, []),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('readyCards', args, exec)
      },
    },
    {
      name: 'kanban_add_column',
      description: 'Add a list (column) to the board. Use when a new workflow stage (e.g. Review, Blocked) is needed.',
      parameters: params({ title: { type: 'string', description: 'List name' } }, ['title']),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('addColumn', args, exec)
      },
    },
    {
      name: 'kanban_rename_column',
      description: 'Rename a list on the board. The eight pipeline stages (Spec, Decompose, Build, Verify, Review, Merge, Blocked, Archive) are reserved and cannot be renamed.',
      parameters: params(
        {
          id: { type: 'string', description: 'List id' },
          title: { type: 'string', description: 'New name' },
        },
        ['id', 'title'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('renameColumn', args, exec)
      },
    },
    {
      name: 'kanban_delete_column',
      description: 'Delete a list from the board; its cards are moved into the first list. At least one list must remain. The eight pipeline stages (Spec, Decompose, Build, Verify, Review, Merge, Blocked, Archive) are reserved and cannot be deleted.',
      parameters: params({ id: { type: 'string', description: 'List id' } }, ['id']),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('deleteColumn', args, exec)
      },
    },
    {
      name: 'kanban_move_column',
      description: 'Reorder a list (column) on the board, moving it to the specified position.',
      parameters: params(
        {
          id: { type: 'string', description: 'List id to move' },
          toIndex: { type: 'integer', description: 'Target position (0 = first list)' },
        },
        ['id', 'toIndex'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('moveColumn', args, exec)
      },
    },
    {
      name: 'kanban_add_label',
      description: 'Create a new label on the board (name bound to a color). Use to categorize cards.',
      parameters: params(
        {
          name: { type: 'string', description: 'Label name (unique)' },
          color: { type: 'string', description: 'Label color (optional): #rrggbb hex; defaults to gray' },
        },
        ['name'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('addLabel', args, exec)
      },
    },
    {
      name: 'kanban_update_label',
      description: 'Modify a label on the board (rename or recolor). Renaming automatically updates cards referencing it.',
      parameters: params(
        {
          name: { type: 'string', description: 'Current label name' },
          newName: { type: 'string', description: 'New name (optional)' },
          color: { type: 'string', description: 'New color (optional): #rrggbb hex' },
        },
        ['name'],
      ),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('updateLabel', args, exec)
      },
    },
    {
      name: 'kanban_delete_label',
      description: 'Delete a label from the board. Cards referencing it will have their label cleared.',
      parameters: params({ name: { type: 'string', description: 'Label name' } }, ['name']),
      output: output(renderBoard),
      async execute(args, exec) {
        return runTool('deleteLabel', args, exec)
      },
    },
    {
      name: 'kanban_get_label',
      description: 'Read the label list (names and colors) of the current project (workspace, or the one given by workspaceId) board. Check available labels before tagging cards.',
      parameters: params({}),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            labels: { type: 'array', items: { type: 'object' } },
            warnings: { type: 'array', items: { type: 'string' } },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (args, value) => {
          const labels = value && value.labels
          const lines = []
          if (Array.isArray(value && value.warnings)) {
            for (const w of value.warnings) lines.push('⚠ ' + w)
          }
          lines.push(String((value && value.message) || ''))
          if (Array.isArray(labels)) {
            for (const l of labels) lines.push('- ' + l.name + ' (' + l.color + ')')
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        const { workspace, error, warning } = await targetWorkspace(args, exec)
        if (!workspace) return { ok: false, message: error, labels: [], warnings: [] }
        const session = exec && exec.agent && exec.agent.session
        const r = await dispatch(workspace, 'get', args, 'agent', session)
        const labels = (r.board && r.board.labels) || []
        return {
          ok: true,
          message: 'Labels (workspace ' + workspaceKey(workspace) + ')',
          labels,
          warnings: withWarning(warning, r.warnings),
        }
      },
    },
  ]

  for (const tool of tools) ctx.tools.register(tool)

  return () => {
    routeState.disposed = true
    if (routeState.timer) routeState.timer()
    routeState.timer = null
    if (routeState.dispose) routeState.dispose()
    routeState.dispose = null
    boards.clear()
    boardLoads.clear()
    workspaceQueues.clear()
    fileTargets.clear()
  }
}
