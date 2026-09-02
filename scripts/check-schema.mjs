/**
 * dsh-kanban schema 迁移机制自检脚本（纯逻辑层，不触磁盘/不依赖 DSH 运行时）。
 *
 * 运行：node scripts/check-schema.mjs
 *
 * 覆盖：
 *   - 无 schemaVersion 的历史文件（v0）→ 自动升级为 v1，字段规范化
 *   - v3 文件原样通过，v1/v2 文件自动升级
 *   - 损坏 JSON → corrupt 分诊
 *   - 结构无效 → invalid 分诊
 *   - 版本超前（来自更新版本插件）→ unsupported 分诊且不迁移
 *   - 迁移链缺步 / 迁移输出无效 → 抛错
 */
import { SCHEMA_VERSION, LEGACY_VERSION, MIGRATIONS, migrateBoard, validateBoard, parseBoardText, RESERVED_STAGE_TITLES, EMPTY_STATE, NOTE_LIMIT, TITLE_LIMIT } from '../index.js'

let failed = 0
const check = (name, cond, detail) => {
  if (cond) {
    console.log('  ✓ ' + name)
  } else {
    failed++
    console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''))
  }
}

console.log('schemaVersion = ' + SCHEMA_VERSION + ', legacy = ' + LEGACY_VERSION)

// ---- 1. v0（历史无版本文件）→ 自动升级 ----
console.log('\n[1] v0 历史文件自动升级')
{
  const legacy = JSON.stringify({
    columns: [{ id: 'c1', title: 'Todo' }],
    labels: [{ name: 'bug', color: '#F87171' }],
    cards: [{ id: 'k1', columnId: 'c1', title: 'Fix login', note: 'x', label: 'bug', priority: 'high' }],
  })
  const r = parseBoardText(legacy)
  check('v0 → ok', r.ok && r.kind === 'ok', JSON.stringify(r))
  check('标记已迁移', r.ok && r.migrated === true)
  check('fromVersion = 0', r.ok && r.fromVersion === LEGACY_VERSION)
  check('升级到最新版', r.ok && r.data.schemaVersion === SCHEMA_VERSION)
  check('产生升级警告', r.ok && r.warnings.length >= 1)
  check('卡片字段规范化', r.ok && r.data.cards[0].label === 'bug' && r.data.cards[0].note === 'x' && r.data.cards[0].priority === 'high')
  check('颜色规范化', r.ok && r.data.labels[0].color === '#f87171')
  check('列/卡保留', r.ok && r.data.columns[0].id === 'c1' && r.data.cards[0].id === 'k1')
  check('新增 activities 空数组', r.ok && Array.isArray(r.data.activities) && r.data.activities.length === 0)
  check('历史卡片补 createdAt/createdBy 为 null', r.ok && r.data.cards[0].createdAt === null && r.data.cards[0].createdBy === null)
  check('历史卡片补 comments 空数组', r.ok && Array.isArray(r.data.cards[0].comments) && r.data.cards[0].comments.length === 0)
}

// ---- 2. v0 文件缺可选字段 ----
console.log('\n[2] v0 文件缺 note/label/priority')
{
  const r = parseBoardText(JSON.stringify({ columns: [{ id: 'c1', title: 'Todo' }], cards: [{ id: 'k1', columnId: 'c1', title: 't' }] }))
  check('v0(缺字段) → ok', r.ok, JSON.stringify(r))
  check('note 补空串', r.ok && r.data.cards[0].note === '')
  check('label 补 null', r.ok && r.data.cards[0].label === null)
  check('priority 补 null', r.ok && r.data.cards[0].priority === null)
}

// ---- 3. 当前版本文件原样通过 ----
console.log('\n[3] 当前版本文件直接通过')
{
  // 当前版本必须带齐八个阶段：这一层不再允许空列表（迁移已经补过一次）
  const stagesCur = RESERVED_STAGE_TITLES.map((t, i) => ({ id: 'c' + (i + 1), title: t }))
  const r = parseBoardText(JSON.stringify({ schemaVersion: SCHEMA_VERSION, columns: stagesCur, labels: [], cards: [], activities: [] }))
  check('当前版本 → ok 且不迁移', r.ok && r.migrated === false, JSON.stringify(r))
  check('当前版本无警告', r.ok && r.warnings.length === 0)
}

// ---- 3a. v2 文件 → 自动升级到当前版本 ----
console.log('\n[3a] v2 文件自动升级')
{
  const r = parseBoardText(JSON.stringify({
    schemaVersion: 2,
    columns: [{ id: 'c1', title: 'Todo' }],
    labels: [],
    cards: [{ id: 'k1', columnId: 'c1', title: 'Keep metadata', note: '', label: null, priority: null, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'human' }],
    activities: [{ id: 'e1', ts: '2026-01-01T00:00:00.000Z', cardId: 'k1', type: 'card_created', source: 'human' }],
  }))
  check('v2 → ok 且标记迁移', r.ok && r.migrated === true, JSON.stringify(r))
  check('fromVersion = 2', r.ok && r.fromVersion === 2)
  check('保留 v2 元数据', r.ok && r.data.cards[0].createdBy === 'human' && r.data.activities.length === 1)
  check('卡片补 comments 空数组', r.ok && Array.isArray(r.data.cards[0].comments) && r.data.cards[0].comments.length === 0)
}

// ---- 3b. v1 文件 → 自动升级到当前版本 ----
console.log('\n[3b] v1 文件自动升级')
{
  const r = parseBoardText(JSON.stringify({
    schemaVersion: 1,
    columns: [{ id: 'c1', title: 'Todo' }],
    labels: [{ name: 'bug', color: '#f87171' }],
    cards: [{ id: 'k1', columnId: 'c1', title: 'Fix', note: 'n', label: 'bug', priority: 'high' }],
  }))
  check('v1 → ok 且标记迁移', r.ok && r.migrated === true, JSON.stringify(r))
  check('fromVersion = 1', r.ok && r.fromVersion === 1)
  check('升级到当前版本', r.ok && r.data.schemaVersion === SCHEMA_VERSION)
  check('activities 空数组', r.ok && Array.isArray(r.data.activities) && r.data.activities.length === 0)
  check('卡片补 createdAt/createdBy null', r.ok && r.data.cards[0].createdAt === null && r.data.cards[0].createdBy === null)
  check('卡片补 comments 空数组', r.ok && Array.isArray(r.data.cards[0].comments) && r.data.cards[0].comments.length === 0)
  check('卡片数据保留', r.ok && r.data.cards[0].title === 'Fix' && r.data.cards[0].label === 'bug')
}

// ---- 4. 损坏 JSON ----
console.log('\n[4] 损坏 JSON')
{
  const r = parseBoardText('{"columns": [broken')
  check('corrupt 分诊', !r.ok && r.kind === 'corrupt', JSON.stringify(r))
  check('corrupt 有可读警告', !r.ok && r.warnings.length >= 1)
}

// ---- 5. 结构无效 ----
console.log('\n[5] 结构无效')
{
  const r = parseBoardText(JSON.stringify({ schemaVersion: 4, columns: [], labels: [], cards: 'oops', activities: [] }))
  check('invalid 分诊', !r.ok && r.kind === 'invalid', JSON.stringify(r))
  const dup = parseBoardText(JSON.stringify({ schemaVersion: 3, columns: [{ id: 'c1', title: 'Todo' }], labels: [], cards: [{ id: 'k1', columnId: 'c1', title: 'a', comments: [] }, { id: 'k1', columnId: 'c1', title: 'b', comments: [] }], activities: [] }))
  check('重复卡 id → invalid', !dup.ok && dup.kind === 'invalid', JSON.stringify(dup))
  const badComment = parseBoardText(JSON.stringify({ schemaVersion: 3, columns: [{ id: 'c1', title: 'Todo' }], labels: [], cards: [{ id: 'k1', columnId: 'c1', title: 'a', comments: [{ id: 'm1', content: ' ', source: 'human', createdAt: 'now' }] }], activities: [] }))
  check('空评论 → invalid', !badComment.ok && badComment.kind === 'invalid', JSON.stringify(badComment))
  const noAct = parseBoardText(JSON.stringify({ schemaVersion: 4, columns: [], labels: [], cards: [] }))
  check('缺 activities → invalid', !noAct.ok && noAct.kind === 'invalid', JSON.stringify(noAct))
}

// ---- 6. 版本超前 ----
console.log('\n[6] 版本超前（来自更新版本插件）')
{
  const r = parseBoardText(JSON.stringify({ schemaVersion: 99, columns: [], labels: [], cards: [] }))
  check('unsupported 分诊', !r.ok && r.kind === 'unsupported', JSON.stringify(r))
  check('保留 version 信息', !r.ok && r.version === 99)
  check('不尝试迁移', !r.ok && r.warnings.every((w) => !w.includes('upgraded')))
}

// ---- 7. 迁移链 ----
console.log('\n[7] 迁移链契约')
{
  const up = migrateBoard({ schemaVersion: 0, columns: [] }, 0)
  check('migrateBoard(v0) → 最新版', up.schemaVersion === SCHEMA_VERSION)
  check('注册表键覆盖 0..SCHEMA_VERSION-1', Object.keys(MIGRATIONS).map(Number).sort((a, b) => a - b).join(',') === Array.from({ length: SCHEMA_VERSION }, (_, i) => i).join(','))

  // 迁移输出缺 schemaVersion → 由 v0→v1 步骤宽松恢复为合法 v1（不抛错），这是预期行为
  const lenient = migrateBoard({ columns: [] }, 0)
  check('v0→v1 宽松恢复缺版本数据', lenient.schemaVersion === SCHEMA_VERSION)

  // 迁移输出版本号错误 → 抛错
  const saved = MIGRATIONS[0]
  MIGRATIONS[0] = () => ({ schemaVersion: 99, columns: [] })
  let threw = false
  try {
    migrateBoard({ schemaVersion: 0, columns: [] }, 0)
  } catch (e) {
    threw = true
  }
  MIGRATIONS[0] = saved
  check('迁移输出版本号错误会抛错', threw)

  // 缺迁移步 → 抛错
  const saved2 = MIGRATIONS[0]
  MIGRATIONS[0] = undefined
  let threw2 = false
  try {
    migrateBoard({ columns: [] }, 0)
  } catch (e) {
    threw2 = true
  }
  MIGRATIONS[0] = saved2
  check('缺迁移步会抛错', threw2)
}

// ---- 8. validateBoard ----
console.log('\n[8] validateBoard')
{
  check('合法当前版本通过', validateBoard({ schemaVersion: SCHEMA_VERSION, columns: RESERVED_STAGE_TITLES.map((t, i) => ({ id: 'c' + (i + 1), title: t })), labels: [], cards: [], activities: [] }).ok)
  check('缺 labels 失败', !validateBoard({ schemaVersion: 3, columns: [], cards: [], activities: [] }).ok)
  check('缺 activities 失败', !validateBoard({ schemaVersion: 4, columns: [], labels: [], cards: [] }).ok)
  check('非对象失败', !validateBoard(null).ok && !validateBoard('x').ok)
}

// ---- 9. v4：workspacePath / state / 文本上限 ----
// 全链路 v0→v4 往返 + 畸形输入。这一节存在的理由：v2→v3 曾经把 workspacePath
// 丢掉（每级迁移只复制自己认识的键），而它是 basename 冲突停机的唯一凭据。
console.log('\n[9] v4 字段：workspacePath / state / 上限')
{
  const stages = RESERVED_STAGE_TITLES.map((t, i) => ({ id: 'c' + (i + 1), title: t }))
  const cur = (extra, card) => JSON.stringify({
    schemaVersion: SCHEMA_VERSION, columns: stages, labels: [], activities: [],
    cards: [{ id: 'k1', columnId: 'c1', title: 'x', comments: [], state: { ...EMPTY_STATE }, ...(card || {}) }],
    ...extra,
  })

  // 往返：每一级都必须把 workspacePath 带到 v4
  for (const from of [2, 3]) {
    const src = { schemaVersion: from, columns: stages, labels: [], activities: [],
      cards: [{ id: 'k1', columnId: 'c1', title: 'x', ...(from >= 3 ? { comments: [] } : {}) }],
      workspacePath: '/home/james/dotfiles' }
    const up = migrateBoard(JSON.parse(JSON.stringify(src)), from)
    check('v' + from + '→v4 保留 workspacePath', up.workspacePath === '/home/james/dotfiles', JSON.stringify(up.workspacePath))
    check('v' + from + '→v4 卡片补 state', JSON.stringify(up.cards[0].state) === JSON.stringify(EMPTY_STATE))
  }
  // v0/v1 从来没有 workspacePath，必须是 null 而不是 undefined
  for (const from of [0, 1]) {
    const up = migrateBoard({ ...(from ? { schemaVersion: from } : {}), columns: stages, labels: [],
      cards: [{ id: 'k1', columnId: 'c1', title: 'x' }], ...(from ? { activities: [] } : {}) }, from)
    check('v' + from + '→最新版 workspacePath 为 null', up.workspacePath === null)
  }
  // 缺阶段的历史看板必须被修复而不是隔离（否则每个老看板都成损坏文件）
  const legacy = migrateBoard({ schemaVersion: 3, columns: [{ id: 'c1', title: 'Todo' }], labels: [],
    cards: [{ id: 'k1', columnId: 'c1', title: 'x', comments: [] }], activities: [] }, 3)
  check('缺阶段的老看板被补齐而非隔离', RESERVED_STAGE_TITLES.every((t) => legacy.columns.some((c) => c.title === t)))
  check('补阶段不动原有列', legacy.columns[0].title === 'Todo' && legacy.cards[0].columnId === 'c1')

  // 去重：已有列里若已含阶段名，绝不能补出重复列。上面那个 fixture 的列是
  // Todo/Done，跟阶段名不重叠，所以它验证不到这条——必须单独造一个重叠的。
  const overlap = migrateBoard({ schemaVersion: 3, labels: [], activities: [], cards: [],
    columns: [{ id: 'c1', title: 'Spec' }, { id: 'c2', title: 'Notes' }, { id: 'c3', title: 'Archive' }] }, 3)
  const overlapTitles = overlap.columns.map((c) => c.title)
  check('去重：原有 3 列(含 2 个阶段) → 3 + 6 = 9', overlap.columns.length === 9, JSON.stringify(overlapTitles))
  check('去重：无重复标题', new Set(overlapTitles).size === overlapTitles.length, JSON.stringify(overlapTitles))
  check('去重：已存在的阶段沿用原 id', overlap.columns.find((c) => c.title === 'Spec').id === 'c1' &&
    overlap.columns.find((c) => c.title === 'Archive').id === 'c3')
  check('去重：非阶段列保留', overlap.columns.find((c) => c.title === 'Notes').id === 'c2')

  // 保留阶段的两面性，成对断言——这是整节最容易搞反的地方：
  // 迁移路径修复（老看板不该被判死），当前版本路径隔离（v4 缺阶段只能是被改坏了）。
  const v3NoStages = JSON.stringify({ schemaVersion: 3, columns: [{ id: 'c1', title: 'Todo' }], labels: [],
    cards: [{ id: 'k1', columnId: 'c1', title: 'x', comments: [] }], activities: [] })
  const repaired = parseBoardText(v3NoStages)
  check('v3 缺阶段 → 迁移修复后通过', repaired.ok && repaired.migrated === true, JSON.stringify(repaired.warnings))
  check('修复后八阶段齐全', repaired.ok && RESERVED_STAGE_TITLES.every((t) => repaired.data.columns.some((c) => c.title === t)))
  const curNoStages = JSON.stringify({ schemaVersion: SCHEMA_VERSION, columns: [{ id: 'c1', title: 'Todo' }], labels: [],
    cards: [{ id: 'k1', columnId: 'c1', title: 'x', comments: [], state: { ...EMPTY_STATE } }], activities: [] })
  const rejected = parseBoardText(curNoStages)
  check('当前版本缺阶段 → 隔离（不修复）', !rejected.ok && rejected.kind === 'invalid', JSON.stringify(rejected))
  check('隔离原因点名缺失阶段', !rejected.ok && rejected.warnings[0].includes('missing reserved pipeline stages'))

  // 畸形 v4 必须隔离，不能被"顺手修好"
  check('workspacePath 非字符串 → invalid', !parseBoardText(cur({ workspacePath: 12345 })).ok)
  check('state 非对象 → invalid', !parseBoardText(cur({}, { state: 'nope' })).ok)
  check('bounceCount 负数 → invalid', !parseBoardText(cur({}, { state: { ...EMPTY_STATE, bounceCount: -5 } })).ok)
  check('owner 无 heartbeatAt → invalid', !parseBoardText(cur({}, { state: { ...EMPTY_STATE, owner: 'tick-1' } })).ok)
  check('state 未知字段 → invalid', !parseBoardText(cur({}, { state: { ...EMPTY_STATE, sneaky: 1 } })).ok)
  check('超长 note → invalid', !parseBoardText(cur({}, { note: 'x'.repeat(NOTE_LIMIT + 1) })).ok)
  check('超长 title → invalid', !parseBoardText(cur({}, { title: 'x'.repeat(TITLE_LIMIT + 1) })).ok)

  // 合法的边界与缺省
  check('workspacePath 缺失合法', parseBoardText(cur({})).ok)
  check('workspacePath = null 合法', parseBoardText(cur({ workspacePath: null })).ok)
  const filled = parseBoardText(cur({}, { state: undefined }))
  check('缺失 state 补为空 state', filled.ok && JSON.stringify(filled.data.cards[0].state) === JSON.stringify(EMPTY_STATE))
  check('恰好等于上限的 note 合法', parseBoardText(cur({}, { note: 'x'.repeat(NOTE_LIMIT) })).ok)
}

console.log('\n' + (failed === 0 ? '全部通过 ✓' : failed + ' 项失败 ✗'))
process.exit(failed === 0 ? 0 : 1)
