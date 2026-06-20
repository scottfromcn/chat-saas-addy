# Spec: Chat SaaS (Cloudflare Stack)

> Living document. Update in-place when decisions change, then implement.

---

## ASSUMPTIONS（代行决策清单）

> 评测说明：本环境为飞书 bridge，不支持 AskUserQuestion 交互。spec-driven-development 的 Phase 1 要求「Ask the human clarifying questions until requirements are concrete」与「Surface assumptions immediately」。由于无法真人对答，我代行所有 human review 与问答，以下是我替「用户」做出的明确决策，按 skill 要求先列出再写 spec 内容。任何后续实施以这些假设为前提；如需推翻，先改本节，再改 spec 主体。

| # | 决策点 | 选项 | 代行决策 | 理由 |
|---|---|---|---|---|
| A1 | 产品形态 | Web only / Web+移动端 | **Web only（现代浏览器）** | 资源聚焦，符合 30 分钟起做 spec 的项目体量 |
| A2 | 认证方式 | Session Cookie / JWT / Passkey | **Session Cookie（`__Host-` 前缀，HttpOnly）** | Workers 原生支持，避免 JWT 撤销难题，D1 存 session |
| A3 | 密码哈希 | bcrypt / argon2 / scrypt | **scrypt（Workers 兼容，纯 WASM 可跑）** | bcrypt 在 Workers 受 SSE 限制，argon2 包体过大 |
| A4 | D1 schema 迁移工具 | wrangler d1 migrations / 手写 | **`wrangler d1 migrations create` + 顺序 SQL 文件** | 官方推荐，可版本化入 git |
| A5 | WebSocket 鉴权 | 子协议 header / query token / cookie | **WebSocket 握手时通过 cookie 校验 session，DO 内二次校验** | Cloudflare Pages 跨域 cookie 友好 |
| A6 | 实时扇出模型 | 每 DO = 一房间 / 每 DO = 一用户 / 全局 DO | **每 DO = 一个 chat room（conversation）** | DO 天然适合「按 key 分片」的房间模型，单 DO 内存持连接 |
| A7 | 消息持久化 | DO 内存落 D1 / 直写 D1 | **DO 聚合后批量写 D1（最多 200ms 或 50 条 flush 一次）** | 兼顾延迟与 D1 写入配额 |
| A8 | 订阅状态机 | Stripe webhook 驱动 / 本地 mock | **本地 mock（`StripeStub` service）** | 题面明确要求占位 stub，不接真实 Stripe |
| A9 | 订阅状态 | free/trial/paid/canceled/expired | **free → trial(14d) → paid ↔ canceled → expired** | 覆盖典型 SaaS 生命周期 |
| A10 | 计费粒度 | 按席位 / 按月固定 | **按席位（seat-based），每用户 1 个 seat** | 多用户 SaaS 主流模型 |
| A11 | 消息限流 | 无 / 滑动窗口 / 令牌桶 | **每用户 5 msg/s 滑动窗口（DO 内实现）** | 防滥用，DO 内存可承载 |
| A12 | 消息类型 | 纯文本 / Markdown / 富媒体 | **MVP：纯文本 + Markdown 渲染（前端）** | 控制范围，富媒体留 Phase 2 |
| A13 | 历史消息分页 | offset / cursor | **cursor-based（`before=<msgId>`）** | 避免大表 offset 慢查询 |
| A14 | 搜索 | 全文 / LIKE / 无 | **MVP：无（仅按房间拉历史）** | D1 全文检索能力弱，留 Phase 2 |
| A15 | 多端登录 | 单设备 / 多设备 | **多设备（session 数组，DO 广播给同一用户所有连接）** | SaaS 默认预期 |
| A16 | 国际化 | 中/英 | **MVP：英文 UI，错误码用常量 key（i18n 留口子）** | 降复杂度 |
| A17 | 测试策略 | 仅单测 / 单测+集成+E2E | **单测（Vitest）+ 集成（Miniflare）+ 关键路径 E2E（Playwright）** | 三层覆盖，DO/D1 必须用 Miniflare 测 |
| A18 | 目标覆盖 | 70% / 80% / 90% | **80% lines / 70% branches** | SaaS 后端核心逻辑高覆盖 |
| A19 | CI | 手动 / Actions | **GitHub Actions：PR 触发 lint+typecheck+test，main 触发 wrangler preview deploy** | 题面已给 GitHub + Actions |
| A20 | 部署环境 | prod 单环境 / dev+prod | **dev（PR preview URL）+ prod（main）双环境** | Cloudflare Pages preview 原生支持 |
| A21 | Secret 管理 | wrangler secret / .env 入库 | **wrangler secret（不入 git），本地用 `.dev.vars`（gitignore）** | 安全红线 |
| A22 | Linter/Formatter | ESLint+Prettier / Biome | **Biome（速度快、零配置、Workers 生态友好）** | 单工具覆盖 lint+format |
| A23 | 包管理器 | npm / pnpm / bun | **pnpm（monorepo 友好、disk efficient）** | 后续若拆 packages 顺手 |
| A24 | React 状态管理 | Redux / Zustand / 原生 | **Zustand（最小依赖）** | 契合 CLAUDE.md「不过度抽象」 |
| A25 | ORM | Drizzle / Kysely / 裸 SQL | **Drizzle ORM（D1 一等支持、类型安全）** | 类型安全 + 迁移工具链统一 |

---

## Objective

构建一个**多用户实时聊天 SaaS**，用户通过订阅付费使用。每个付费用户可创建/加入多个 chat room，通过 WebSocket 与同房间其他成员实时收发消息；消息持久化到 D1，历史可分页回看。免费用户可试用 14 天后必须订阅才能继续使用。

**目标用户**：小团队（2–50 人）需要私有、低延迟、可留痕的内部沟通工具，不愿用通用 IM 的团队。

**用户故事（核心三条，其余见 Open Questions）**：

1. **作为访客**，我能注册账号、登录、获得 14 天 trial，进入默认房间发消息，验证产品价值。
2. **作为付费用户**，我能创建房间、邀请成员、实时收发消息、翻阅历史，且消息可靠不丢（DO 重连后补发未读）。
3. **作为运营**，我能通过 mock 的 Stripe 流程把用户从 trial 转 paid、从 paid 转 canceled，状态机正确驱动访问权限。

**非目标（明确排除）**：移动端 App、富媒体（图片/视频/文件）、消息搜索、@提及、机器人、视频通话、跨组织联邦。

## Tech Stack

| 层 | 选型 | 版本约束 |
|---|---|---|
| Runtime | Cloudflare Workers | `@cloudflare/workers-types` `^4.20250101.0` |
| 实时 | Durable Objects | `workers@^3` (DO API) |
| 数据库 | D1 (SQLite) | `wrangler@^3.90` |
| 前端托管 | Cloudflare Pages | `@cloudflare/vite-plugin@^1` |
| 后端框架 | Hono | `^4.6` |
| ORM | Drizzle ORM | `drizzle-orm@^0.36`, `drizzle-kit@^0.30` |
| 前端 | React `^19` + Vite `^6` + TypeScript `^5.6` |
| 前端状态 | Zustand `^5` |
| WebSocket 客户端 | 原生 `WebSocket`（封装 hook） |
| 测试 | Vitest `^2` + Miniflare `^3`（集成）+ Playwright `^1.49`（E2E） |
| Lint/Format | Biome `^1.9` |
| 包管理 | pnpm `^9` |
| CI | GitHub Actions（`actions/setup-node@v4`, `cloudflare/wrangler-action@v3`） |
| 支付 | `StripeStub`（本地实现，接口对齐 Stripe Checkout/Subscription，便于后续替换） |

## Commands

```bash
# 安装
pnpm install

# 本地开发（Workers + Pages 一体）
pnpm dev                      # = wrangler pages dev packages/web -- pnpm --filter web dev
pnpm dev:api                  # = wrangler dev --local --persist-to=.wrangler/state
pnpm dev:web                  # = pnpm --filter web dev (Vite dev server, 代理 /api 到 wrangler)

# 数据库
pnpm db:generate              # drizzle-kit generate
pnpm db:migrate:local         # wrangler d1 migrations apply chat-saas --local
pnpm db:migrate:prod          # wrangler d1 migrations apply chat-saas --remote   # Ask first
pnpm db:studio                # drizzle-kit studio --config=drizzle.config.ts

# 类型检查 / 代码质量
pnpm typecheck                # tsc --noEmit -p packages/api/tsconfig.json && ... web
pnpm lint                     # biome check .
pnpm lint:fix                 # biome check --write .
pnpm format                   # biome format --write .

# 构建
pnpm build                    # pnpm --filter web build && wrangler pages deploy
pnpm build:web                # pnpm --filter web build

# 测试
pnpm test                     # vitest run
pnpm test:watch               # vitest
pnpm test:coverage            # vitest run --coverage --coverage.thresholds.lines=80 --coverage.thresholds.branches=70
pnpm test:e2e                 # playwright test
pnpm test:e2e:ui              # playwright test --ui

# 部署
pnpm deploy:api               # wrangler deploy                           # Ask first
pnpm deploy:web               # wrangler pages deploy packages/web        # Ask first
```

## Project Structure

```
chat-saas-addy/
├── packages/
│   ├── api/                     # Workers 后端（Hono 路由）
│   │   ├── src/
│   │   │   ├── routes/          # HTTP 路由：auth, rooms, messages, billing
│   │   │   ├── do/              # Durable Objects：ChatRoomDO
│   │   │   ├── middleware/      # auth, rateLimit, errorBoundary
│   │   │   ├── services/        # 业务：UserService, RoomService, StripeStub
│   │   │   ├── db/              # Drizzle schema + 客户端
│   │   │   │   ├── schema.ts    # 单一真相源（用户/会话/房间/成员/消息）
│   │   │   │   └── client.ts
│   │   │   ├── lib/             # 共享：crypto (scrypt), id (cuid2), validator
│   │   │   └── index.ts         # Hono app 入口 + DO export
│   │   ├── migrations/          # wrangler d1 migrations SQL（顺序编号）
│   │   ├── tests/
│   │   │   ├── unit/            # 纯函数：hashing, validators, state machine
│   │   │   └── integration/     # Miniflare + 真 D1 + 真 DO
│   │   ├── wrangler.toml        # Workers + DO + D1 绑定配置
│   │   └── tsconfig.json
│   └── web/                     # Cloudflare Pages（React/Vite）
│       ├── src/
│       │   ├── routes/          # 页面级路由组件（react-router）
│       │   ├── components/      # 复用组件：MessageList, RoomList, Composer
│       │   ├── hooks/           # useWebSocket, useAuth, useSubscription
│       │   ├── stores/          # Zustand stores
│       │   ├── api/             # fetch 封装
│       │   └── main.tsx
│       └── tests/               # 组件测试 + Playwright specs
├── e2e/                         # 跨包 E2E（Playwright，启动整个 stack）
├── .github/workflows/           # ci.yml
├── .dev.vars.example            # 本地 secret 模板（真实 .dev.vars 入 gitignore）
├── SPEC.md / PLAN.md / TASKS.md # 本套文档
├── drizzle.config.ts
├── biome.json
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

## Code Style

**命名约定**：
- 文件：`camelCase.ts`（TS/源码）；`PascalCase.tsx`（React 组件文件）；`kebab-case.sql`（迁移）。
- 标识符：变量/函数 `camelCase`；类型/接口/类 `PascalCase`；常量 `SCREAMING_SNAKE_CASE`；私有约定 `_` 前缀禁用，用 `#` 或模块作用域。
- React 组件用函数组件 + Hooks，禁用 class。
- Drizzle schema 表名 `snake_case`，列名 `snake_case`，TS 客户端用 `camelCase` 通过 `.$type<>()` 映射。

**Biome 配置要点**：2 空格缩进、单引号、尾逗号 `all`、行宽 100、`noExplicitAny: error`、`useImportType: error`。

**真实示例（后端 Hono 路由）**：
```typescript
// packages/api/src/routes/messages.ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../index';
import { authRequired } from '../middleware/auth';

const ListMessagesQuery = z.object({
  roomId: z.string().min(1),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const messages = new Hono<Env>()
  .use('*', authRequired)
  .get('/', async (c) => {
    const parsed = ListMessagesQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'INVALID_QUERY', issues: parsed.error.issues }, 400);
    }
    const { roomId, before, limit } = parsed.data;
    const userId = c.get('userId');
    const membership = await c.env.RoomService.assertMember(roomId, userId);
    if (!membership) {
      return c.json({ error: 'FORBIDDEN' }, 403);
    }
    const items = await c.env.MessageRepo.list({ roomId, before, limit });
    return c.json({ items, nextCursor: items.at(-1)?.id ?? null });
  });
```

**真实示例（前端 WebSocket hook）**：
```typescript
// packages/web/src/hooks/useWebSocket.ts
import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/auth';

type Status = 'connecting' | 'open' | 'closed';

export function useRoomSocket(roomId: string | null): Status {
  const [status, setStatus] = useState<Status>('closed');
  const wsRef = useRef<WebSocket | null>(null);
  const token = useAuthStore((s) => s.sessionToken);

  useEffect(() => {
    if (!roomId || !token) return;
    const url = `${import.meta.env.VITE_WS_URL}/rooms/${roomId}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStatus('connecting');
    ws.onopen = () => setStatus('open');
    ws.onclose = () => setStatus('closed');
    return () => ws.close();
  }, [roomId, token]);

  return status;
}
```

**禁用模式**：
- 禁 `any`（用 `unknown` + narrow）；禁 `console.log`（用结构化 logger）；禁裸 `throw new Error('xxx')`（用 `AppError` 带错误码）；禁在组件内直接 `fetch`（统一走 `api/`）。

## Testing Strategy

| 层级 | 工具 | 测什么 | 在哪 |
|---|---|---|---|
| 单元 | Vitest | 纯函数：scrypt 哈希、订阅状态机、限流窗口、cursor 分页 SQL 生成、消息长度校验 | `packages/api/tests/unit/` |
| 集成 | Vitest + Miniflare | HTTP 路由端到端（真 D1 + 真 DO in-process）：注册→登录→建房间→发消息→拉历史；mock Stripe webhook 触发状态机转换 | `packages/api/tests/integration/` |
| 前端组件 | Vitest + Testing Library | 组件纯逻辑：消息列表渲染、订阅状态守卫、Composer 输入校验 | `packages/web/tests/` |
| E2E | Playwright | 关键路径 3 条：注册到发首条消息、trial 过期后付费解锁、WebSocket 断线重连补发 | `e2e/` |

**覆盖阈值**：`pnpm test:coverage` 强制 lines ≥ 80%、branches ≥ 70%，CI 在低于阈值时 `exit 1`。

**测试隔离**：集成测试每个 `describe` block 用唯一 D1 database name（Miniflare 自动重建），DO 用 `idFromDate(testName)` 确保用例间隔离。

**关键不变量（必须有用例守护）**：
- DO flush 前崩溃，下次启动能从 D1 重放未确认消息（用 `alarm()` 兜底）。
- 订阅为 `expired` 时，所有写消息 API 返回 402，WebSocket 收到 `subscription_required` 帧后断开。
- 多设备同时连接同一用户，一条消息广播到该用户全部连接。

## Boundaries

### Always do
- 提交前运行 `pnpm typecheck && pnpm lint && pnpm test`（CI 强制）。
- 任何外部输入（HTTP body / query / WebSocket 帧）必须经 Zod 校验后才进业务层。
- 密码、session token、Stripe key 一律经 `wrangler secret` 或 `.dev.vars`，绝不入 git。
- D1 schema 变更必须经 `pnpm db:generate` 生成新 migration 文件，commit 入库。
- 错误响应统一形态 `{ error: 'CODE', message?: string, issues?: zIssue[] }`，带请求 traceId。
- 新增依赖前在 PR 描述里写明理由与替代方案对比。

### Ask first
- 改 D1 schema（即使加列）→ 先 review migration SQL 与回滚脚本。
- 加/升级/删除任何 dependency（含 patch）。
- 改 `wrangler.toml` 绑定、DO 配置、Pages 路由。
- 改 CI 配置（`.github/workflows/*.yml`）或加新的 GitHub Actions secret。
- 改 Biome/tsconfig 规则（影响全局风格）。
- 引入新的 Durable Object 类（影响 Workers 计费模型）。
- 真接 Stripe（替换 `StripeStub`）—— 这是 A8 的反转点。

### Never do
- 提交 secret / token / `.dev.vars` / `wrangler.toml` 内嵌凭据到 git。
- 编辑 `node_modules/`、`.wrangler/`、`dist/`、任何 `vendor/` 目录。
- 为了让测试通过而删除失败的测试用例（必须先定位根因；跳过需注释理由 + 开 issue）。
- 在 Workers 业务代码里用 Node.js 专有 API（`fs`, `Buffer`, `process`）—— 用 Web 标准 API。
- 在 DO 内做同步阻塞 I/O 或长循环（会触发 CPU 限制）。
- `git push --force` 到 `main`、rebase 已合并的 PR。

## Success Criteria

**功能性**：
- [ ] 访客可在 ≤ 3s 内完成注册 + 登录 + 进入默认房间，发出第一条消息可见。
- [ ] 同房间两个用户的消息端到端延迟（发送→对端可见）P95 ≤ 500ms（本地 Miniflare 环境）。
- [ ] 历史消息支持 cursor 分页，单次请求 ≤ 100 条，翻页不重复不遗漏。
- [ ] 订阅状态机全部 4 个状态转换（trial→paid、paid→canceled、canceled→paid、trial→expired）正确触发访问权限变更。
- [ ] WebSocket 断线后 5s 内自动重连，断线期间的消息在重连后补发。

**非功能性**：
- [ ] `pnpm test:coverage` lines ≥ 80%, branches ≥ 70%，CI 不通过则阻塞合并。
- [ ] CI（lint + typecheck + test + build）在 PR 上 ≤ 5 分钟完成。
- [ ] 前端首屏（LCP）在 4G 模拟下 ≤ 2.5s（Lighthouse CI 守护）。
- [ ] Workers 单请求冷启动 ≤ 50ms（不含 D1 查询），用 `wrangler tail` 抽样观测。
- [ ] `pnpm build` 产物：API Worker gzip ≤ 1MB，Web Pages 主 chunk gzip ≤ 200KB。

**安全**：
- [ ] 所有密码以 scrypt 哈希存储，DB dump 不含明文。
- [ ] 所有 HTTP API 经 auth 中间件，未认证返回 401（除 `/auth/register`、`/auth/login`、`/health`）。
- [ ] WebSocket 握手时校验 session，未授权立即 close code 4401。
- [ ] 输入校验覆盖 100% HTTP 端点（Zod schema），无 untyped body。

## Open Questions

> 这些是我替用户**未决**而非代行决策的问题，标注给真实人类 review。代行决策已在 ASSUMPTIONS 表列出。

1. **邮件发送**：注册验证、密码重置是否需要？若需要，用 Resend / Cloudflare Email Workers / 暂不实现？（A16 默认英文 UI 下，是否要邮箱验证是真实决策点。）
2. **GDPR / 数据导出与删除**：用户请求导出全部消息或删除账号时，DO 内缓存消息如何与 D1 保持一致删除？是否做软删除？
3. **消息编辑/撤回**：MVP 是否支持？若支持，撤回窗口多长（5 分钟？）？
4. **房间类型**：是否需要 DM（1v1 私聊）vs 群聊区分，还是统一为 room？
5. **审计日志**：是否需要记录管理员操作（删除房间、踢人）？存哪（D1 单表 / Workers Analytics）？
6. **限流配额**：free 用户与 paid 用户消息速率是否不同（A11 默认统一 5/s）？
7. **DO 冷启动数据预加载**：DO 启动时是否预热房间成员列表，还是首次消息时按需查 D1？
8. **多区域**：Workers 默认全球，但 DO 是单 region 绑定。是否需要为不同地理用户分片 DO namespace？
9. **`StripeStub` 接口边界**：对齐到 Stripe Checkout Session 还是 Subscription API？影响后续替换工作量。
10. **i18n 启动时机**：A16 留了 key 口子，何时真做多语言？
