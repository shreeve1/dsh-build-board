/**
 * dsh-kanban 加载管线端到端自检（mock fs，驱动真实 apply()）。
 *
 * 运行：node scripts/check-pipeline.mjs
 *
 * 用临时目录 + 最小 fs 服务实现，直接调用 index.js 的 apply(ctx)，
 * 然后通过注册的 kanban_get 工具触发 boardOf 加载管线，验证：
 *   - v0 历史文件：自动迁移 → 写回当前 schemaVersion → 生成 .bak-v0 备份 → 返回警告
 *   - v3 文件：直接通过，不写回、不备份、无警告
 *   - v1/v2 文件：自动迁移 → 写回当前 schemaVersion → 生成对应备份
 *   - 损坏文件：备份为 .corrupt-* → 看板以空板可用 → 返回警告
 *   - 版本超前：备份为 .unsupported-vN → 只读打开空板 → 返回警告
 *   - 损坏文件备份成功后，后续保存会写入带 schemaVersion 的新格式
 *   - 活动日志：创建/更新/移动/删除均产生对应事件，来源正确
 *   - 数据写入 ~/.dsh-boards/<project>/board.json（仓库之外），更换 DSH 启动目录后仍可读取
 *   - 写入使用看板目录（而非工作区根目录）的逐次沙箱策略，否则 fs-sandbox 会拒写
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { SCHEMA_VERSION, RESERVED_STAGE_TITLES } from '../index.js'
import { apply } from '../index.js'

// 看板已移出工作区，落在 $HOME/.dsh-boards/<project>/board.json。
// 把 HOME 钉到临时目录，自检永远不会写到真实 HOME。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-kanban-check-home-'))
process.env.HOME = HOME
const boardPath = (wsPath, suffix = '') => join(HOME, '.dsh-boards', basename(wsPath), 'board.json' + suffix)

let failed = 0
const check = (name, cond, detail) => {
  if (cond) {
    console.log('  ✓ ' + name)
  } else {
    failed++
    console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''))
  }
}

/** 把 apply() 注册的工具按名字收集起来。 */
function bootPlugin(dir) {
  const tools = []
  const files = new Map() // 文件名 -> 内容（用路径模拟 FsTarget）
  const targetOf = (name) => join(dir, name)

  const fs = {
    async resolve(path, opts = {}) {
      return isAbsolute(path) ? path : targetOf(path)
    },
    async readText(target) {
      if (!existsSync(target)) throw new Error('ENOENT')
      return readFileSync(target, 'utf8')
    },
    async writeText(target, content) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return { version: 1 }
    },
    async listDir(target) {
      return readdirSync(target)
        .filter((n) => !n.startsWith('.'))
        .map((name) => ({ name, target: join(target, name) }))
    },
  }
  const workspace = { id: 'ws-test', path: dir, title: 'test' }
  const sandboxPolicy = {
    defaultMode: 'workspace-write',
    workspaceRoot: dir,
    resolve(request = {}) {
      return { mode: 'workspace-write', workspaceRoot: request.session?.header?.cwd || dir }
    },
  }
  const workspaceRegistry = {
    get(id) {
      return id === workspace.id ? workspace : undefined
    },
    list() {
      return [workspace]
    },
    async resolveByPath(path) {
      return path === workspace.path ? workspace : undefined
    },
  }
  const ctx = {
    get(key) {
      if (key === 'fs') return fs
      if (key === 'sandboxPolicy') return sandboxPolicy
      if (key === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    tools: {
      register(tool) {
        tools.push(tool)
      },
    },
  }
  apply(ctx)
  tools.exec = { agent: { session: { header: { cwd: dir } } } }
  return { tools, dir }
}

async function runTool(tools, name, args = {}, exec) {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error('tool not found: ' + name)
  return tool.execute(args, exec || tools.exec || {})
}

/** 驱动真实工作区定位：DSH 启动目录与项目根目录彼此独立。 */
function bootWorkspacePlugin(launchRoot, workspace) {
  const tools = []
  const fs = {
    async resolve(path, opts = {}) {
      return isAbsolute(path) ? path : join(opts.cwd || launchRoot, path)
    },
    async readText(target) {
      if (!existsSync(target)) throw new Error('ENOENT')
      return readFileSync(target, 'utf8')
    },
    async writeText(target, content, expected, signal, policy) {
      // 真实 fs-sandbox 以 policy.workspaceRoot 为唯一可写根；看板既然搬出工作区，
      // 围栏就必须跟着搬，否则 workspace-write 会话每次保存都会被拒。
      if (!policy || policy.workspaceRoot !== dirname(boardPath(workspace.path))) {
        throw new Error('FS_SANDBOX_DENIED: write policy does not match board directory')
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return { version: 1 }
    },
    async listDir(target) {
      return readdirSync(target)
        .filter((n) => !n.startsWith('.'))
        .map((name) => ({ name, target: join(target, name) }))
    },
  }
  const sandboxPolicy = {
    defaultMode: 'workspace-write',
    workspaceRoot: launchRoot,
    resolve(request = {}) {
      return {
        mode: 'workspace-write',
        workspaceRoot: request.session?.header?.cwd || launchRoot,
      }
    },
  }
  const workspaceRegistry = {
    get(id) {
      return id === workspace.id ? workspace : undefined
    },
    list() {
      return [workspace]
    },
    async resolveByPath(path) {
      return path === workspace.path ? workspace : undefined
    },
  }
  const ctx = {
    get(key) {
      if (key === 'fs') return fs
      if (key === 'sandboxPolicy') return sandboxPolicy
      if (key === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    tools: {
      register(tool) {
        tools.push(tool)
      },
    },
  }
  apply(ctx)
  return { tools }
}

const execAt = (cwd) => ({ agent: { session: { header: { cwd } } } })

const dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-check-'))
try {
  // ---- 场景 A：v0 历史文件自动升级 ----
  console.log('\n[A] v0 历史文件 → 自动迁移 + 备份 + 写回')
  {
    const { tools } = bootPlugin(dir)
    mkdirSync(dirname(boardPath(dir)), { recursive: true })
    writeFileSync(
      boardPath(dir),
      JSON.stringify({
        columns: [{ id: 'c1', title: 'Todo' }, { id: 'c2', title: 'Done' }],
        labels: [{ name: 'bug', color: '#F87171' }],
        cards: [{ id: 'k1', columnId: 'c1', title: 'Old card', note: 'n' }],
      }),
    )
    const r = await runTool(tools, 'kanban_get')
    check('工具返回 ok', r.ok === true, JSON.stringify(r))
    check('返回升级警告', Array.isArray(r.warnings) && r.warnings.length >= 1, JSON.stringify(r.warnings))
    check('警告提到自动升级', r.warnings.some((w) => w.includes('upgraded')))
    check('看板数据完整', r.board.cards.length === 1 && r.board.cards[0].title === 'Old card')

    const onDisk = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    check('写回当前 schemaVersion', onDisk.schemaVersion === SCHEMA_VERSION)
    // v4 起迁移会补齐缺失的流水线阶段，所以列数是"原有 2 列 + 补的 8 个阶段"。
    // 原有列必须原样保留，卡片也不能被搬动。
    check('写回保留数据', onDisk.cards.length === 1 && onDisk.columns[0].title === 'Todo' && onDisk.columns[1].title === 'Done')
    check('迁移补齐八阶段', RESERVED_STAGE_TITLES.every((t) => onDisk.columns.some((c) => c.title === t)))
    // 数量必须精确断言，否则补列的 off-by-one（漏补/重复补）不会被发现。
    // 这个 fixture 的两列是 Todo/Done，都不是阶段名，所以没有重名去重：2 + 8 = 10。
    // 断言写成"原有列数 + 缺失阶段数"而不是硬编码 10，这样它同时验证了去重逻辑：
    // 若将来 fixture 改成含 Spec 的列，期望值会自动收缩，补重了就会红。
    const preTitles = ['Todo', 'Done']
    const expectedRestored = RESERVED_STAGE_TITLES.filter((t) => !preTitles.includes(t)).length
    check('补列数量精确 = 原有 + 缺失阶段', onDisk.columns.length === preTitles.length + expectedRestored,
      'got ' + onDisk.columns.length + ' expected ' + (preTitles.length + expectedRestored))
    check('没有重复列标题', new Set(onDisk.columns.map((c) => c.title)).size === onDisk.columns.length)
    check('迁移不搬动卡片', onDisk.cards[0].columnId === 'c1')
    check('备份 .bak-v0 存在', existsSync(boardPath(dir, '.bak-v0')))
    const bak = JSON.parse(readFileSync(boardPath(dir, '.bak-v0'), 'utf8'))
    check('备份为迁移前原样（无版本字段）', bak.schemaVersion === undefined && bak.cards[0].id === 'k1')

    // 二次加载：不再迁移、不再警告
    const r2 = await runTool(tools, 'kanban_get')
    check('二次加载无警告', r2.warnings.length === 0)
  }

  // ---- 场景 B0：v3 文件 → 自动升级到 v4 ----
  // 这个场景不能被"改成 v4"顶掉：它是 v3→v4 这一级迁移在真实读写路径上的唯一覆盖，
  // 包括 workspacePath 必须被带过去（v2→v3 曾经把它丢掉）和卡片补 state。
  console.log('\n[B0] v3 文件 → 自动升级到 v4')
  {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(HOME, '.dsh-boards'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const { tools } = bootPlugin(dir)
    mkdirSync(dirname(boardPath(dir)), { recursive: true })
    writeFileSync(
      boardPath(dir),
      JSON.stringify({
        schemaVersion: 3,
        workspacePath: dir,
        columns: RESERVED_STAGE_TITLES.map((t, i) => ({ id: 'c' + (i + 1), title: t })),
        labels: [],
        cards: [{ id: 'k1', columnId: 'c1', title: 'v3 card', note: 'n', comments: [] }],
        activities: [],
      }),
    )
    const r = await runTool(tools, 'kanban_get')
    check('工具返回 ok', r.ok === true, JSON.stringify(r))
    check('返回升级警告', r.warnings.some((w) => w.includes('upgraded')), JSON.stringify(r.warnings))
    const onDisk = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    check('写回 v4', onDisk.schemaVersion === SCHEMA_VERSION)
    check('v3→v4 保留 workspacePath', onDisk.workspacePath === dir, JSON.stringify(onDisk.workspacePath))
    check('v3→v4 卡片补 state', onDisk.cards[0].state !== undefined && onDisk.cards[0].state.owner === null)
    check('生成 .bak-v3 备份', existsSync(boardPath(dir, '.bak-v3')))
    const r2 = await runTool(tools, 'kanban_get')
    check('二次加载无警告', r2.warnings.length === 0)
  }

  // ---- 场景 B：当前版本文件直接通过 ----
  console.log('\n[B] v4 文件 → 直接通过')
  {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(HOME, '.dsh-boards'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const { tools } = bootPlugin(dir)
    mkdirSync(dirname(boardPath(dir)), { recursive: true })
    writeFileSync(
      boardPath(dir),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, columns: RESERVED_STAGE_TITLES.map((t, i) => ({ id: 'c' + (i + 1), title: t })), labels: [], cards: [], activities: [] }),
    )
    const r = await runTool(tools, 'kanban_get')
    check('工具返回 ok', r.ok === true)
    check('无警告', r.warnings.length === 0)
    check('无 .bak 备份生成', !existsSync(boardPath(dir, '.bak-v0')) && !existsSync(boardPath(dir, '.bak-v1')) && !existsSync(boardPath(dir, '.bak-v2')))
  }

  // ---- 场景 B2：v1 文件 → 自动升级到 v3 ----
  console.log('\n[B2] v1 文件 → 自动升级到 v3')
  {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(HOME, '.dsh-boards'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const { tools } = bootPlugin(dir)
    mkdirSync(dirname(boardPath(dir)), { recursive: true })
    writeFileSync(
      boardPath(dir),
      JSON.stringify({ schemaVersion: 1, columns: [{ id: 'c1', title: 'Todo' }], labels: [], cards: [{ id: 'k1', columnId: 'c1', title: 'Old', note: 'n' }] }),
    )
    const r = await runTool(tools, 'kanban_get')
    check('工具返回 ok', r.ok === true, JSON.stringify(r))
    check('返回升级警告', r.warnings.some((w) => w.includes('upgraded')))
    const onDisk = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    check('写回当前 schemaVersion', onDisk.schemaVersion === SCHEMA_VERSION)
    check('activities 已初始化', Array.isArray(onDisk.activities) && onDisk.activities.length === 0)
    check('卡片 createdAt/createdBy 为 null', onDisk.cards[0].createdAt === null && onDisk.cards[0].createdBy === null)
    check('卡片 comments 已初始化', Array.isArray(onDisk.cards[0].comments) && onDisk.cards[0].comments.length === 0)
    check('备份 .bak-v1 存在', existsSync(boardPath(dir, '.bak-v1')))
  }

  // ---- 场景 B3：v2 文件 → 自动升级到 v3 ----
  console.log('\n[B3] v2 文件 → 自动升级到 v3')
  {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(HOME, '.dsh-boards'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const { tools } = bootPlugin(dir)
    mkdirSync(dirname(boardPath(dir)), { recursive: true })
    writeFileSync(
      boardPath(dir),
      JSON.stringify({
        schemaVersion: 2,
        columns: [{ id: 'c1', title: 'Todo' }],
        labels: [],
        cards: [{ id: 'k1', columnId: 'c1', title: 'Old', note: 'n', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'human' }],
        activities: [],
      }),
    )
    const r = await runTool(tools, 'kanban_get')
    check('工具返回 ok', r.ok === true, JSON.stringify(r))
    const onDisk = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    check('写回当前 schemaVersion', onDisk.schemaVersion === SCHEMA_VERSION)
    check('保留卡片元数据并补 comments', onDisk.cards[0].createdBy === 'human' && Array.isArray(onDisk.cards[0].comments))
    check('备份 .bak-v2 存在', existsSync(boardPath(dir, '.bak-v2')))
  }

  // ---- 场景 C：损坏文件 → 备份 + 空板可用 ----
  console.log('\n[C] 损坏文件 → 备份 + 空板可用')
  {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(HOME, '.dsh-boards'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const { tools } = bootPlugin(dir)
    mkdirSync(dirname(boardPath(dir)), { recursive: true })
    writeFileSync(boardPath(dir), '{"columns": [broken!!', 'utf8')
    const r = await runTool(tools, 'kanban_get')
    check('工具返回 ok（看板仍可用）', r.ok === true, JSON.stringify(r))
    check('返回损坏警告', r.warnings.some((w) => w.includes('backed up')))
    check('看板为空板 + 默认列', r.board.columns.length >= 1 && r.board.cards.length === 0)
    const backups = readdirSync(dirname(boardPath(dir))).filter((n) => n.includes('.corrupt-'))
    // 启动校验与加载管线都会各备份一次同一原文件，因此 ≥1 即可
    check('生成 .corrupt-* 备份', backups.length >= 1, JSON.stringify(backups))
    check('备份保留原始损坏内容', backups.every((b) => readFileSync(join(dirname(boardPath(dir)), b), 'utf8') === '{"columns": [broken!!'))

    // 隔离后必须只读。这里原来断言的是"损坏后仍可写卡"——那正是 2026-09-02 实测到的
    // 数据完整性缺陷：备份成功的损坏看板会以空白可写看板继续服务，把真看板挤掉。
    // 断言随行为一起反转：写入被拒，且磁盘上的文件没有被空板覆盖。
    const add = await runTool(tools, 'kanban_add_card', { title: 'New after corrupt' })
    check('隔离后拒绝写入', add.ok === false, JSON.stringify(add))
    check('拒绝原因点名备份文件', typeof add.message === 'string' && add.message.includes('quarantined'), add.message)
    check('原损坏文件未被空板覆盖', readFileSync(boardPath(dir), 'utf8') === '{"columns": [broken!!')
    check('读取仍然可用', (await runTool(tools, 'kanban_get')).ok === true)
  }

  // ---- 场景 D：版本超前 → 备份 + 空板可用 ----
  console.log('\n[D] 版本超前 → 备份 + 空板可用')
  {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(HOME, '.dsh-boards'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const { tools } = bootPlugin(dir)
    mkdirSync(dirname(boardPath(dir)), { recursive: true })
    writeFileSync(
      boardPath(dir),
      JSON.stringify({ schemaVersion: 99, columns: [{ id: 'c1', title: 'Future' }], labels: [], cards: [] }),
    )
    const r = await runTool(tools, 'kanban_get')
    check('工具返回 ok', r.ok === true)
    check('返回版本超前警告', r.warnings.some((w) => w.includes('newer plugin version')))
    check('看板为空板', r.board.cards.length === 0 && r.board.columns[0] && r.board.columns[0].title !== 'Future')
    check('生成 .unsupported-v99 备份', existsSync(boardPath(dir, '.unsupported-v99')))
    check('原文件未被覆盖', JSON.parse(readFileSync(boardPath(dir), 'utf8')).schemaVersion === 99)
  }

  // ---- 场景 E：启动校验扫描 ----
  console.log('\n[E] 启动校验扫描（apply 即触发）')
  {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(HOME, '.dsh-boards'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    mkdirSync(dirname(boardPath(dir)), { recursive: true })
    writeFileSync(boardPath(dir), '{"columns": [broken', 'utf8')
    writeFileSync(join(dir, 'kanban-board-old.json'), JSON.stringify({ columns: [], labels: [], cards: [] }), 'utf8')
    writeFileSync(join(dir, 'unrelated.txt'), 'hello', 'utf8')
    bootPlugin(dir) // apply 触发 maybeStartupCheck（异步 fire-and-forget）

    // 启动校验是异步的，轮询等待其完成（最多 2s）
    const deadline = Date.now() + 2000
    let backups = []
    while (Date.now() < deadline) {
      backups = readdirSync(dirname(boardPath(dir))).filter((n) => n.includes('.corrupt-'))
      if (backups.length > 0) break
      await new Promise((r) => setTimeout(r, 25))
    }
    check('启动校验备份损坏文件', backups.length === 1, JSON.stringify(backups))
    check('忽略旧启动目录格式文件', !existsSync(join(dir, 'kanban-board-old.json.bak-v0')))
    check('忽略无关文件', readdirSync(dir).filter((n) => n.includes('unrelated')).length === 1)
  }

  // ---- 场景 F：评论与活动日志记录（agent 工具来源）----
  console.log('\n[F] 评论与活动日志：创建 / 评论 / 更新 / 移动 / 删除')
  {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(HOME, '.dsh-boards'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const { tools } = bootPlugin(dir)

    const add = await runTool(tools, 'kanban_add_card', { title: 'Task A', label: 'build', priority: 'high' })
    check('addCard 成功', add.ok === true, JSON.stringify(add))
    const disk1 = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    const cardId = disk1.cards[0].id
    check('记录 card_created 且来源为 agent', disk1.activities.length === 1 && disk1.activities[0].type === 'card_created' && disk1.activities[0].source === 'agent')
    check('card_created 带初始标签/优先级', disk1.activities[0].meta && disk1.activities[0].meta.label === 'build' && disk1.activities[0].meta.priority === 'high')
    check('卡片记录 createdAt/createdBy', disk1.cards[0].createdBy === 'agent' && typeof disk1.cards[0].createdAt === 'string')

    const commented = await runTool(tools, 'kanban_add_comment', { id: cardId, content: '  Ready for review  ' })
    check('评论成功且 summary 返回数量', commented.ok === true && commented.board.cards[0].commentCount === 1, JSON.stringify(commented))
    const commentDisk = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    check('评论持久化且来源为 agent', commentDisk.cards[0].comments.length === 1 && commentDisk.cards[0].comments[0].content === 'Ready for review' && commentDisk.cards[0].comments[0].source === 'agent')
    check('评论写入活动日志', commentDisk.activities.some((a) => a.type === 'card_comment_added' && a.source === 'agent'))
    const details = await runTool(tools, 'kanban_get_card', { id: cardId })
    check('getCard 返回评论', details.ok === true && details.card.comments[0].content === 'Ready for review')

    await runTool(tools, 'kanban_add_label', { name: 'verify', color: '#34d399' })
    await runTool(tools, 'kanban_update_card', { id: cardId, priority: 'low', label: 'verify' })
    const disk2 = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    const types2 = disk2.activities.map((a) => a.type)
    check('记录 priority 与 label 变化', types2.includes('card_priority_changed') && types2.includes('card_label_changed'))

    const board2 = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    const buildCol = board2.columns.find((c) => c.title === 'Build')
    await runTool(tools, 'kanban_move_card', { id: cardId, columnId: buildCol.id })
    const disk3 = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    const moved = disk3.activities.find((a) => a.type === 'card_moved')
    check('记录 card_moved 跨列', !!moved && moved.from === 'Spec' && moved.to === 'Build')

    await runTool(tools, 'kanban_delete_card', { id: cardId })
    const disk4 = JSON.parse(readFileSync(boardPath(dir), 'utf8'))
    check('记录 card_deleted', disk4.activities.some((a) => a.type === 'card_deleted' && a.cardId === cardId))
  }

  // ---- 场景 G：看板跟随工作区，而不是 DSH 启动目录 ----
  console.log('\n[G] 更换 DSH 启动目录后仍读取同一工作区看板')
  {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(HOME, '.dsh-boards'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const launchA = join(dir, 'launch-a')
    const launchB = join(dir, 'launch-b')
    const workspacePath = join(dir, 'project')
    mkdirSync(launchA)
    mkdirSync(launchB)
    mkdirSync(workspacePath)
    const workspace = { id: 'ws-project', path: workspacePath, title: 'project' }

    const first = bootWorkspacePlugin(launchA, workspace)
    const added = await runTool(first.tools, 'kanban_add_card', { title: 'Survives restart' }, execAt(workspacePath))
    check('首次写卡成功', added.ok === true, JSON.stringify(added))
    check('数据写入 ~/.dsh-boards/<project>/', existsSync(boardPath(workspacePath)))
    check('工作区内不产生看板文件', !existsSync(join(workspacePath, '.dsh-kanban.json')) && !existsSync(join(workspacePath, 'board.json')))
    check('启动目录不产生看板文件', readdirSync(launchA).every((name) => !name.includes('kanban')))

    const second = bootWorkspacePlugin(launchB, workspace)
    const loaded = await runTool(second.tools, 'kanban_get', {}, execAt(workspacePath))
    check('更换启动目录后任务仍存在', loaded.board.cards.some((card) => card.title === 'Survives restart'))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}

console.log('\n' + (failed === 0 ? '全部通过 ✓' : failed + ' 项失败 ✗'))
process.exit(failed === 0 ? 0 : 1)
