# Tasks: Chat SaaS (Cloudflare Stack)

> 配套：[SPEC.md](./SPEC.md) · [PLAN.md](./PLAN.md)。本文件是 Phase 3 任务分解，遵循 spec-driven-development skill 的 Tasks 阶段约束：单任务可一会话完成 / 有验收 / 有验证 / 按依赖排序 / 每任务 ≤ 5 文件。

任务 ID 前缀对应 PLAN.md 的 Batch（A-J）。完成顺序即依赖顺序，除非显式标注「可并行」。

---

## Batch A — 基建（Gate 0）

### A1 · 初始化 monorepo 脚手架
- [ ] **Task**: 用 pnpm workspace 初始化 `chat-saas-addy`，建 `packages/api` 与 `packages/web` 空目录骨架，配 Biome、根 tsconfig、Husky pre-commit、`.dev.vars.example`、`.gitignore`。
- **Acceptance**:
  - `pnpm install` 无 error
  - `pnpm -r ls` 列出两个空包
  - `pnpm lint` 在仅有占位文件时通过
  - `.dev.vars` 已在 `.gitignore`；`.dev.vars.example` 入库
- **Verify**: `pnpm install && pnpm lint && git check-ignore .dev.vars`（exit 0）
- **Files**:
  - `package.json`（root）
  - `pnpm-workspace.yaml`
  - `biome.json`
  - `tsconfig.base.json`
  - `.gitignore` + `.dev.vars.example`（计为 1 项配置块）

### A2 · 配 CI 流水线（lint + typecheck + test + build）
- [ ] **Task**: 写 `.github/workflows/ci.yml`，PR 触发，跑 install → lint → typecheck → test → build，cache pnpm store，coverage 不达 80%/70% 时 exit 1。
- **Acceptance**:
  - PR 上 CI 全绿（即便测试为空也跑通）
  - 失败的测试能阻塞 merge（手注入一个 fail 测试验证）
  - pnpm cache 命中（第二次 run 加速可见）
- **Verify**: 推一个 PR 触发 CI，确认 4 个 job 全绿；再推一个故意 fail 的测试，确认 CI 红
- **Files**:
  - `.github/workflows/ci.yml`
  - `packages/api/package.json`（加 `test`/`typecheck`/`build` script）
  - `packages/web/package.json`（同上）

### A3 · 配 D1 + Drizzle + 空 migration
- [ ] **Task**: 配 `packages/api/wrangler.toml`（D1 binding `DB`、DO binding 后续加）、`drizzle.config.ts`、生成 `0000_init.sql`（空表占位，仅 `PRAGMA user_version`）。
- **Acceptance**:
  - `pnpm db:migrate:local` 在本地成功
  - `wrangler d1 execute chat-saas --local --command "select 1"` 返回 1
- **Verify**: `pnpm db:migrate:local && pnpm db:studio`（能打开 studio 见空库）
- **Files**:
  - `packages/api/wrangler.toml`
  - `drizzle.config.ts`
  - `packages/api/migrations/0000_init.sql`
  - `packages/api/migrations_meta/`（drizzle 自动生成）

### A4 · 配 Vitest + coverage 阈值 + Miniflare 集成 harness 骨架
- [ ] **Task**: 配根 `vitest.config.ts`（threshold 80/70），写 `packages/api/tests/integration/setup.ts` Miniflare harness（创建临时 D1 + 临时 DO namespace），提供一个空用例验证 harness 可用。
- **Acceptance**:
  - `pnpm test` 跑通（哪怕只有一个 `it('ok')`）
  - `pnpm test:coverage` 在低于阈值时 exit 1（手注入未覆盖分支验证）
  - Miniflare harness 能拿到 `env.DB` 与 `env.CHAT_ROOM`（DO stub）
- **Verify**: `pnpm test:coverage`
- **Files**:
  - `vitest.config.ts`
  - `packages/api/tests/integration/setup.ts`
  - `packages/api/vitest.config.ts`（如有包级覆盖需要）

---

## Batch B — 领域核心（Gate 1，A1-A4 后全可并行）

### B1 · 写 D1 schema（Drizzle）
- [ ] **Task**: 在 `packages/api/src/db/schema.ts` 定义 6 张表：`users`、`sessions`、`subscriptions`、`rooms`、`room_members`、`messages`；列名 snake_case，TS 客户端 camelCase（`.mapWith` 转换）；索引：`sessions(token)`、`messages(room_id, created_at)`、`room_members(user_id, room_id)` 唯一。
- **Acceptance**:
  - `pnpm db:generate` 生成 migration `0001_init.sql` 含所有表与索引
  - `pnpm typecheck` 通过
  - Drizzle studio 能看到所有表
- **Verify**: `pnpm db:generate && pnpm db:migrate:local && pnpm db:studio`
- **Files**:
  - `packages/api/src/db/schema.ts`
  - `packages/api/migrations/0001_init.sql`（生成）
  - `packages/api/migrations_meta/_journal.json`（生成）

### B2 · 实现 crypto 与 id 工具
- [ ] **Task**: `packages/api/src/lib/crypto.ts`：`hashPassword(plain)`（scrypt + salt）、`verifyPassword(plain, hash)`、`newSessionToken()`（32B random base64url）、`newId()`（cuid2）。
- **Acceptance**:
  - 单测覆盖：相同明文两次哈希结果不同；正确密码 verify true；错误密码 verify false
  - scrypt 参数不超 Workers CPU 限制（在 Miniflare 集成测试里跑一次注册耗时 < 100ms）
- **Verify**: `pnpm test packages/api/tests/unit/crypto.test.ts`
- **Files**:
  - `packages/api/src/lib/crypto.ts`
  - `packages/api/tests/unit/crypto.test.ts`

### B3 · 写 Zod validators
- [ ] **Task**: `packages/api/src/lib/validators.ts`：注册（email+password 长度规则）、登录、创建房间、发送消息（max 2000 chars）、list 消息（cursor+limit）、StripeStub webhook payload。
- **Acceptance**:
  - 单测覆盖每条 validator 的合法与非法用例（至少 2 正 2 负）
  - 错误时能拿到结构化 issues
- **Verify**: `pnpm test packages/api/tests/unit/validators.test.ts`
- **Files**:
  - `packages/api/src/lib/validators.ts`
  - `packages/api/tests/unit/validators.test.ts`

### B4 · 实现订阅状态机（纯函数）
- [ ] **Task**: `packages/api/src/services/subscription-state.ts`：定义 `SubscriptionStatus = 'free'|'trial'|'paid'|'canceled'|'expired'`，`canTransition(from, event)` 纯函数判定合法转换，`nextStatus(from, event)` 返回新状态或抛 `IllegalTransitionError`。
- **Acceptance**:
  - 全部合法转换用例绿（free→trial、trial→paid、paid→canceled、canceled→paid、trial→expired、paid→expired）
  - 非法转换用例抛错（如 free→paid 直接跳过 trial）
  - 覆盖率 100%
- **Verify**: `pnpm test packages/api/tests/unit/subscription-state.test.ts`
- **Files**:
  - `packages/api/src/services/subscription-state.ts`
  - `packages/api/tests/unit/subscription-state.test.ts`

### B5 · 错误模型与错误码
- [ ] **Task**: `packages/api/src/lib/errors.ts`：`AppError` class（带 `code`、`status`、`issues?`），错误码常量（`UNAUTHORIZED`、`FORBIDDEN`、`NOT_FOUND`、`SUBSCRIPTION_REQUIRED`、`RATE_LIMITED`、`VALIDATION_FAILED`、`ILLEGAL_TRANSITION`）。
- **Acceptance**:
  - 单测：构造 `AppError` 序列化为 `{ error, message?, issues? }`
  - 不同错误码映射到正确 HTTP status
- **Verify**: `pnpm test packages/api/tests/unit/errors.test.ts`
- **Files**:
  - `packages/api/src/lib/errors.ts`
  - `packages/api/tests/unit/errors.test.ts`

---

## Batch C — 数据访问（Gate 2 起步，依赖 B1）

### C1 · Drizzle client + Repos
- [ ] **Task**: `packages/api/src/db/client.ts`（从 D1 binding 构造 drizzle 实例）+ `packages/api/src/repos/index.ts` 导出 `UserRepo`、`SessionRepo`、`RoomRepo`、`MessageRepo`。`MessageRepo.list` 实现 cursor 分页（`WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`）。
- **Acceptance**:
  - 集成测试：Miniflare 创建临时 D1，插入 100 条消息，分页拉取不重不漏
  - `UserRepo.create` 密码字段为哈希非明文
- **Verify**: `pnpm test packages/api/tests/integration/repos.test.ts`
- **Files**:
  - `packages/api/src/db/client.ts`
  - `packages/api/src/repos/index.ts`
  - `packages/api/tests/integration/repos.test.ts`
  - `packages/api/tests/integration/setup.ts`（已在 A4，扩展）

---

## Batch D — 业务服务（C1 后可并行）

### D1 · UserService（注册/登录/session）
- [ ] **Task**: `packages/api/src/services/user-service.ts`：`register`、`login`、`logout`、`verifySession`。注册时同时创建 `subscriptions` 行（status=trial, expires_at=now+14d）。
- **Acceptance**:
  - 集成测试：注册→登录→调 `verifySession` 返回 userId；错误密码登录失败；登出后 session 失效
  - 注册同时 trial 订阅自动生成
- **Verify**: `pnpm test packages/api/tests/integration/user-service.test.ts`
- **Files**:
  - `packages/api/src/services/user-service.ts`
  - `packages/api/tests/integration/user-service.test.ts`

### D2 · RoomService（房间与成员）
- [ ] **Task**: `packages/api/src/services/room-service.ts`：`createRoom`、`addMember`、`assertMember`、`listRoomsForUser`。
- **Acceptance**:
  - 创建者自动成为成员
  - `assertMember` 对非成员返回 false
  - `listRoomsForUser` 只返回该用户加入的房间
- **Verify**: `pnpm test packages/api/tests/integration/room-service.test.ts`
- **Files**:
  - `packages/api/src/services/room-service.ts`
  - `packages/api/tests/integration/room-service.test.ts`

### D3 · MessageService（HTTP 兜底与历史）
- [ ] **Task**: `packages/api/src/services/message-service.ts`：`send`（校验成员 + 订阅 active + 限流）、`list`（委托 MessageRepo cursor 分页）。
- **Acceptance**:
  - 非成员发送返回 FORBIDDEN
  - 订阅 expired 发送返回 SUBSCRIPTION_REQUIRED
  - 限流超限返回 RATE_LIMITED
- **Verify**: `pnpm test packages/api/tests/integration/message-service.test.ts`
- **Files**:
  - `packages/api/src/services/message-service.ts`
  - `packages/api/tests/integration/message-service.test.ts`

### D4 · StripeStub
- [ ] **Task**: `packages/api/src/services/stripe-stub.ts`：`createCheckoutSession(userId, plan)` 返回固定 mock URL；`handleWebhook(payload)` 根据 payload 类型驱动 `subscription-state` 转换并写库。接口设计为 interface，便于后续替换真 Stripe。
- **Acceptance**:
  - 4 条状态转换路径集成测试全绿
  - mock URL 含可识别的 test 标记
  - webhook 重放幂等（同一 event id 第二次处理无副作用）
- **Verify**: `pnpm test packages/api/tests/integration/stripe-stub.test.ts`
- **Files**:
  - `packages/api/src/services/stripe-stub.ts`
  - `packages/api/tests/integration/stripe-stub.test.ts`

### D5 · RateLimiter（DO 内存版 + KV 降级预案）
- [ ] **Task**: `packages/api/src/services/rate-limiter.ts`：滑动窗口（5 req/s/user），纯函数 + 状态注入（便于 DO 持有窗口数组）。预留 `RateLimiterKV` 适配器签名（不实现）。
- **Acceptance**:
  - 单测：5 条通过、第 6 条拒
  - 窗口过期后重新计数
- **Verify**: `pnpm test packages/api/tests/unit/rate-limiter.test.ts`
- **Files**:
  - `packages/api/src/services/rate-limiter.ts`
  - `packages/api/tests/unit/rate-limiter.test.ts`

---

## Batch E — 实时层（D5 后）

### E1 · ChatRoomDO
- [ ] **Task**: `packages/api/src/do/chat-room-do.ts`：连接管理（`Map<connectionId, {userId, ws}>`）、消息广播、批量 flush（200ms 或 50 条）、`alarm()` 兜底、订阅状态校验、调 `RateLimiter`。
- **Acceptance**:
  - 集成测试：双连接收发消息延迟 < 100ms
  - flush 后 DO 重启不丢消息（用 `blockConcurrencyWhile` 模拟 evict）
  - 订阅 expired 时新消息被拒，连接收到 `subscription_required` 帧后关闭
  - 超限消息返回 `rate_limited` 帧不广播
- **Verify**: `pnpm test packages/api/tests/integration/chat-room-do.test.ts`
- **Files**:
  - `packages/api/src/do/chat-room-do.ts`
  - `packages/api/src/do/chat-room-do.test.ts`（即上面 integration test）
  - `packages/api/tests/integration/chat-room-do.test.ts`

### E2 · DO wiring 与 WebSocket 升级路由
- [ ] **Task**: `packages/api/wrangler.toml` 加 DO binding（`CHAT_ROOM` → `ChatRoomDO`，`migrations` 加 new class）；`packages/api/src/index.ts` export DO + 加 `GET /rooms/:id/ws` 路由（Hono WebSocket upgrade → DO.fetch）。
- **Acceptance**:
  - `wrangler dev` 本地启动后，curl WebSocket upgrade 返回 101
  - 未认证握手返回 4401 close code
- **Verify**: `pnpm dev:api`（手动 wscat 连接验证），或集成测试覆盖
- **Files**:
  - `packages/api/wrangler.toml`
  - `packages/api/src/index.ts`
  - `packages/api/src/routes/ws.ts`

---

## Batch F — HTTP 中间件与基础路由（E2 后）

### F1 · authRequired 中间件 + errorBoundary + /health
- [ ] **Task**: `packages/api/src/middleware/auth.ts`（解 `__Host-session` cookie → `verifySession` → 注入 `userId`）；`packages/api/src/middleware/error.ts`（catch AppError → 统一响应 + traceId via `crypto.randomUUID()`）；`/health` 返回 `{ ok: true, sha }`。
- **Acceptance**:
  - 集成测试：受保护路由未带 cookie 返回 401；带有效 cookie 注入正确 userId
  - 抛任意 AppError 都被捕获并返回正确 status 与 code
  - /health 返回 200
- **Verify**: `pnpm test packages/api/tests/integration/middleware.test.ts`
- **Files**:
  - `packages/api/src/middleware/auth.ts`
  - `packages/api/src/middleware/error.ts`
  - `packages/api/src/routes/health.ts`
  - `packages/api/tests/integration/middleware.test.ts`

---

## Batch G — 业务路由（F1 后全可并行）

### G1 · /auth 路由
- [ ] **Task**: `packages/api/src/routes/auth.ts`：`POST /auth/register`、`POST /auth/login`、`POST /auth/logout`、`GET /auth/me`。注册/登录成功 Set-Cookie。
- **Acceptance**:
  - 端到端：register → me → logout → me（401）
  - 错误密码 login 返回 401
  - cookie 是 `__Host-` 前缀、HttpOnly、Secure、SameSite=Lax
- **Verify**: `pnpm test packages/api/tests/integration/routes-auth.test.ts`
- **Files**:
  - `packages/api/src/routes/auth.ts`
  - `packages/api/tests/integration/routes-auth.test.ts`

### G2 · /rooms 路由
- [ ] **Task**: `packages/api/src/routes/rooms.ts`：`POST /rooms`、`GET /rooms`、`POST /rooms/:id/members`、`GET /rooms/:id/members`。
- **Acceptance**:
  - 创建者自动成员
  - 列表只返回当前用户房间
  - 非成员访问 `/rooms/:id/members` 返回 403
- **Verify**: `pnpm test packages/api/tests/integration/routes-rooms.test.ts`
- **Files**:
  - `packages/api/src/routes/rooms.ts`
  - `packages/api/tests/integration/routes-rooms.test.ts`

### G3 · /messages 路由
- [ ] **Task**: `packages/api/src/routes/messages.ts`：`GET /messages?roomId=&before=&limit=`（cursor 分页）、`POST /messages`（HTTP 兜底，主路径走 WS）。
- **Acceptance**:
  - 非成员 403、订阅 expired 402、限流 429
  - 分页 cursor 正确
- **Verify**: `pnpm test packages/api/tests/integration/routes-messages.test.ts`
- **Files**:
  - `packages/api/src/routes/messages.ts`
  - `packages/api/tests/integration/routes-messages.test.ts`

### G4 · /billing 路由
- [ ] **Task**: `packages/api/src/routes/billing.ts`：`POST /billing/checkout`（返回 StripeStub URL）、`POST /billing/webhook`（处理 StripeStub webhook）。webhook 端点豁免 authRequired（用签名校验替代）。
- **Acceptance**:
  - checkout 返回 mock URL
  - webhook 触发状态机转换并影响后续 /messages 访问
- **Verify**: `pnpm test packages/api/tests/integration/routes-billing.test.ts`
- **Files**:
  - `packages/api/src/routes/billing.ts`
  - `packages/api/tests/integration/routes-billing.test.ts`

### G5 · 整合 index.ts + API 契约快照
- [ ] **Task**: 在 `packages/api/src/index.ts` 装配所有路由 + 中间件，确保所有路径可达；导出 OpenAPI 风格接口清单（手写 markdown 附录或 hono zod-openapi 生成）。
- **Acceptance**:
  - 集成测试覆盖：所有路由 happy path 走通
  - OpenAPI 附录入 SPEC.md（或独立 `docs/api.md`）
- **Verify**: `pnpm test packages/api/tests/integration/api-smoke.test.ts`
- **Files**:
  - `packages/api/src/index.ts`
  - `packages/api/tests/integration/api-smoke.test.ts`
  - `docs/api.md`（新生成）

---

## Batch H — 前端基建（可与 G 并行，但依赖 API 契约锁定）

### H1 · Vite + Pages 脚手架
- [ ] **Task**: `packages/web`：Vite 6 + React 19 + TypeScript + react-router + `@cloudflare/vite-plugin`；`pnpm dev:web` 启动；空 `/` 渲染 hello world。
- **Acceptance**:
  - `pnpm dev:web` 启动后浏览器见 hello world
  - `pnpm build:web` 产物 ≤ 200KB gzip（Success Criteria 守护）
- **Verify**: `pnpm build:web && du -sh packages/web/dist`
- **Files**:
  - `packages/web/package.json`
  - `packages/web/vite.config.ts`
  - `packages/web/index.html`
  - `packages/web/src/main.tsx`

### H2 · API client（typed fetch 封装）
- [ ] **Task**: `packages/web/src/api/client.ts`：base fetch with credentials:include，统一错误形态，typed 方法对齐后端所有路由。
- **Acceptance**:
  - 单测：mock fetch 返回成功/失败，client 正确抛 AppError 或返回 typed data
- **Verify**: `pnpm test packages/web/tests/api-client.test.ts`
- **Files**:
  - `packages/web/src/api/client.ts`
  - `packages/web/src/api/types.ts`
  - `packages/web/tests/api-client.test.ts`

### H3 · Zustand stores
- [ ] **Task**: `packages/web/src/stores/auth.ts`、`subscription.ts`、`room.ts`：登录状态、订阅状态、当前房间 + 消息列表。
- **Acceptance**:
  - 单测：store actions 正确更新状态
- **Verify**: `pnpm test packages/web/tests/stores.test.ts`
- **Files**:
  - `packages/web/src/stores/auth.ts`
  - `packages/web/src/stores/subscription.ts`
  - `packages/web/src/stores/room.ts`
  - `packages/web/tests/stores.test.ts`

---

## Batch I — 前端页面（H 后全可并行）

### I1 · Auth 页面（注册/登录）
- [ ] **Task**: `packages/web/src/routes/auth.tsx`：注册表单 + 登录表单 + 错误展示；提交后调 store。
- **Acceptance**:
  - 表单校验（email 格式、密码长度）客户端先拦
  - 成功后跳转 `/`
- **Verify**: 组件测试 `pnpm test packages/web/tests/auth-page.test.tsx`
- **Files**:
  - `packages/web/src/routes/auth.tsx`
  - `packages/web/tests/auth-page.test.tsx`

### I2 · 主壳布局 + 路由守卫
- [ ] **Task**: `packages/web/src/App.tsx` + `packages/web/src/components/Layout.tsx`：react-router 配置、未登录跳转 `/auth`、订阅守卫。
- **Acceptance**:
  - 未登录访问 `/` 自动跳 `/auth`
  - 订阅 expired 访问 `/rooms/:id` 重定向到 `/billing`
- **Verify**: 组件测试 `pnpm test packages/web/tests/route-guard.test.tsx`
- **Files**:
  - `packages/web/src/App.tsx`
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/tests/route-guard.test.tsx`

### I3 · useRoomSocket hook（含重连）
- [ ] **Task**: `packages/web/src/hooks/use-room-socket.ts`：连接管理、指数退避重连（max 5 次）、收到消息推入 roomStore。
- **Acceptance**:
  - 单测：mock WebSocket，open/close/message 事件正确更新 store
  - 重连退避时序正确
- **Verify**: `pnpm test packages/web/tests/use-room-socket.test.ts`
- **Files**:
  - `packages/web/src/hooks/use-room-socket.ts`
  - `packages/web/tests/use-room-socket.test.ts`

### I4 · 聊天 UI（RoomList / MessageList / Composer）
- [ ] **Task**: 三个组件 + 装配到 `/rooms/:id` 页面。
- **Acceptance**:
  - MessageList 渲染 cursor 分页数据
  - Composer 输入超 2000 chars 禁用发送
  - RoomList 高亮当前房间
- **Verify**: 组件测试 + 手动 `pnpm dev` 联调
- **Files**:
  - `packages/web/src/components/RoomList.tsx`
  - `packages/web/src/components/MessageList.tsx`
  - `packages/web/src/components/Composer.tsx`
  - `packages/web/src/routes/room.tsx`

### I5 · Billing 页面
- [ ] **Task**: `packages/web/src/routes/billing.tsx`：展示当前订阅状态、跳转 StripeStub checkout URL、模拟回调。
- **Acceptance**:
  - 状态从 trial → paid 后 UI 正确刷新
- **Verify**: 组件测试 + 手动联调
- **Files**:
  - `packages/web/src/routes/billing.tsx`
  - `packages/web/tests/billing-page.test.tsx`

---

## Batch J — E2E 与验收（I 后）

### J1 · Playwright 配置 + stack 启动脚本
- [ ] **Task**: `e2e/playwright.config.ts` + `e2e/fixtures.ts`（启动 Miniflare API + Vite preview + 初始化测试数据）。
- **Acceptance**:
  - `pnpm test:e2e --grep @smoke` 跑通一个最简用例
- **Verify**: `pnpm test:e2e --grep @smoke`
- **Files**:
  - `e2e/playwright.config.ts`
  - `e2e/fixtures.ts`
  - `package.json`（加 e2e script）

### J2 · E2E 关键路径 1：注册到首条消息
- [ ] **Task**: `e2e/specs/onboarding.spec.ts`：打开页 → 注册 → 自动登录 → 进默认房间 → 发消息 → 见消息上屏。
- **Acceptance**:
  - 全绿，端到端 ≤ 10s
- **Verify**: `pnpm test:e2e specs/onboarding.spec.ts`
- **Files**:
  - `e2e/specs/onboarding.spec.ts`

### J3 · E2E 关键路径 2：trial 过期付费解锁
- [ ] **Task**: `e2e/specs/billing.spec.ts`：手动让 trial 过期（直接改 D1）→ 发消息被拦 → 走 mock checkout → 状态变 paid → 发消息成功。
- **Acceptance**:
  - 状态转换正确驱动 UI 与 API
- **Verify**: `pnpm test:e2e specs/billing.spec.ts`
- **Files**:
  - `e2e/specs/billing.spec.ts`

### J4 · E2E 关键路径 3：WebSocket 断线重连补发
- [ ] **Task**: `e2e/specs/reconnect.spec.ts`：双浏览器窗口连同一房间 → 断其中一个网络（Playwright 模拟）→ 期间另一窗口发消息 → 重连后断线窗口补发可见。
- **Acceptance**:
  - 补发消息无丢失
- **Verify**: `pnpm test:e2e specs/reconnect.spec.ts`
- **Files**:
  - `e2e/specs/reconnect.spec.ts`

### J5 · 验收对齐 Success Criteria
- [ ] **Task**: 跑完所有验证项，逐条勾选 SPEC.md 的 Success Criteria；不达标的写 follow-up task。
- **Acceptance**:
  - 所有可量化指标达标（coverage 80/70、CI ≤5min、bundle ≤1MB/200KB、LCP ≤2.5s、消息延迟 P95 ≤500ms）
  - 不达标项有明确 follow-up
- **Verify**: 手动跑各项命令并记录结果到 PR 描述
- **Files**:
  - `SPEC.md`（勾选 checkbox）
  - PR 描述（含验证截图/日志）

---

## 依赖关系速查

```
A1 → A2 → A3, A4（A2 后并行）
A4 → B1-B5（全并行，B1 最早因为 C1 依赖）
B1 → C1
C1 → D1-D5（全并行）
D5 → E1
E1 → E2
F1 → G1-G5（全并行）
H1 → H2 → H3 → I1-I5（I 全并行）
G5 + I5 → J1 → J2-J5
```

## 任务统计

- 总任务：29 个
- 每任务文件数：均 ≤ 5（符合 skill 约束）
- 关键路径长度：A1 → A3 → B1 → C1 → D3 → E1 → E2 → F1 → G3 → G5 → H1 → H3 → I4 → J5（约 14 步）
- 并行批次：10 个（A-J）
