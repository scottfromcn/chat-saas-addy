# Plan: Chat SaaS (Cloudflare Stack)

> 配套文档：[SPEC.md](./SPEC.md)（Phase 1 产物）。本文件是 Phase 2 实现计划，遵循 spec-driven-development skill 的 Plan 阶段要求：组件识别 → 依赖排序 → 风险与缓解 → 并行/串行 → 验证检查点。

---

## 1. 组件拆解与职责

按职责从底向上分层。**依赖箭头：A → B 表示 B 依赖 A**。

### Layer 0 — 基建（Foundation）

| ID | 组件 | 职责 | 关键产出 |
|---|---|---|---|
| F1 | Monorepo 脚手架 | pnpm workspace、biome、tsconfig、Husky pre-commit、`.dev.vars.example` | `package.json` / `pnpm-workspace.yaml` / `biome.json` |
| F2 | CI 骨架 | GitHub Actions：lint + typecheck + test + build，PR 触发 | `.github/workflows/ci.yml` |
| F3 | Drizzle + D1 配置 | `drizzle.config.ts`、`wrangler.toml` D1 绑定、空 migration 0000_init | `packages/api/migrations/0000_init.sql` |

### Layer 1 — Domain Core（领域核心，无 IO）

| ID | 组件 | 职责 | 关键产出 |
|---|---|---|---|
| D1 | DB Schema | `users` / `sessions` / `subscriptions` / `rooms` / `room_members` / `messages` | `packages/api/src/db/schema.ts` |
| D2 | Crypto lib | scrypt 哈希、`cuid2` id、随机 token | `packages/api/src/lib/crypto.ts` |
| D3 | Validators | Zod schemas：用户、消息、房间、订阅 webhook payload | `packages/api/src/lib/validators.ts` |
| D4 | 订阅状态机 | 纯函数：`free → trial → paid ↔ canceled → expired` 的合法转换判定 | `packages/api/src/services/subscription-state.ts` |
| D5 | 错误模型 | `AppError` + 错误码常量 + 错误响应形态 | `packages/api/src/lib/errors.ts` |

### Layer 2 — 服务与仓储（业务 + IO）

| ID | 组件 | 职责 | 依赖 |
|---|---|---|---|
| S1 | Drizzle client | D1 binding → Drizzle 实例 | D1 |
| S2 | `UserRepo` / `SessionRepo` / `RoomRepo` / `MessageRepo` | CRUD + cursor 分页 | D1, S1 |
| S3 | `UserService` | 注册、登录、session 签发/校验、登出 | D2, S2, D5 |
| S4 | `RoomService` | 建房间、加成员、鉴权成员身份、列房间 | S2, D5 |
| S5 | `MessageService` | 发消息（HTTP 兜底）、拉历史 cursor 分页 | S2, S4, D5 |
| S6 | `StripeStub` | mock Checkout URL、mock webhook（订阅状态机驱动） | D4 |
| S7 | `RateLimiter` | 滑动窗口（DO 内存版 + 降级到 KV 的预案） | — |

### Layer 3 — 实时（Durable Object）

| ID | 组件 | 职责 | 依赖 |
|---|---|---|---|
| R1 | `ChatRoomDO` | 单房间 WebSocket hub：连接管理、消息广播、批量 flush 到 D1、限流、订阅状态校验 | D1, S7, S4 |
| R2 | DO 路由与 wiring | `wrangler.toml` DO 绑定、`index.ts` export、HTTP 升级 WebSocket | R1 |

### Layer 4 — HTTP 路由层（Hono）

| ID | 组件 | 路径 | 依赖 |
|---|---|---|---|
| H1 | `authRequired` 中间件 | 解 cookie、校验 session、注入 `userId` | S3 |
| H2 | errorBoundary + traceId | 统一错误响应 | D5 |
| H3 | `/auth` | register / login / logout / me | S3 |
| H4 | `/rooms` | CRUD + 成员管理 | S4, H1 |
| H5 | `/messages` | list（cursor 分页）+ send（HTTP 兜底，主要走 WS） | S5, H1 |
| H6 | `/billing` | create-checkout、webhook（来自 StripeStub） | S6, H1 |
| H7 | `/rooms/:id/ws` | WebSocket 升级，转发到 `ChatRoomDO` | R2, H1 |
| H8 | `/health` | 存活检查 | — |

### Layer 5 — 前端（Pages / React）

| ID | 组件 | 职责 | 依赖 |
|---|---|---|---|
| W1 | Vite + Pages 脚手架 | `@cloudflare/vite-plugin`、tsconfig、路由（react-router） | F1 |
| W2 | `api/` fetch 封装 + 错误处理 | typed client | H1-H8 契约 |
| W3 | Zustand stores | `authStore` / `subscriptionStore` / `roomStore` | W2 |
| W4 | Auth 页面 | 注册/登录/登出 | W3 |
| W5 | 主壳布局 + 路由守卫 | 未登录跳转、订阅守卫 | W3 |
| W6 | `useRoomSocket` hook + 重连 | 指数退避、断线补发 | R2 |
| W7 | `RoomList` / `MessageList` / `Composer` 组件 | UI | W6, W3 |
| W8 | Billing 页面 | mock checkout、订阅状态展示 | W2, W3 |

### Layer 6 — 测试与可观测

| ID | 组件 | 职责 |
|---|---|---|
| T1 | Vitest 配置 + coverage 阈值 | 80%/70% |
| T2 | Miniflare 集成 harness | 真 D1 + 真 DO in-process |
| T3 | Playwright E2E + stack 启动脚本 | 3 条关键路径 |
| T4 | `wrangler tail` 抽样 + 结构化 logger | 冷启动观测 |

---

## 2. 实现顺序（依赖拓扑）

**强约束**：先领域核心（无 IO，易测），再仓储/服务（有 IO，需 D1），再实时（DO），最后路由与前端。每阶段有 gate（见 §4）。

```
Gate 0: F1, F2, F3                         (基建：能 pnpm install + CI 跑通空流水)
   ↓
Gate 1: D1, D2, D3, D4, D5                 (领域纯函数：单测 100%)
   ↓
Gate 2: S1 → S2 → S3, S4, S5, S6, S7       (仓储 + 服务：Miniflare 集成测试)
   ↓
Gate 3: R1 → R2                            (DO：WebSocket 集成测试)
   ↓
Gate 4: H1-H8 (并行)                       (HTTP 路由：API 契约锁定)
   ↓
Gate 5: W1 → W2 → W3 → W4/W5/W6/W7/W8      (前端：可联调)
   ↓
Gate 6: T3 E2E + 性能验证                  (验收对齐 Success Criteria)
```

---

## 3. 依赖图（细粒度）

```
            D1 schema ─────┬──► S1 client ──► S2 repos ──┬──► S3 UserService ──┐
                           │                              ├──► S4 RoomService  │
                           │                              └──► S5 MessageService
            D2 crypto ─────┤                                                  │
            D3 validators──┤                                                  │
            D4 state ──────┼──► S6 StripeStub                                 │
            D5 errors ─────┴──────────────────────────────────────────────────►│
                                                                              ▼
                                       S7 RateLimiter ──► R1 ChatRoomDO ──► R2 wiring
                                                              │
                                                              ▼
                                       H1 authRequired ◄── S3 ┘
                                       H2 errorBoundary ◄── D5
                                       H3 /auth ◄── S3
                                       H4 /rooms ◄── S4
                                       H5 /messages ◄── S5
                                       H6 /billing ◄── S6
                                       H7 /rooms/:id/ws ◄── R2
                                       H8 /health
                                                              │
                                                              ▼ (契约锁定后)
                                       W2 api client ──► W3 stores ──► W4-W8 (并行)
```

---

## 4. 并行 / 串行矩阵

### 必须串行（依赖硬约束）
- D1 → S1 → S2（schema 不定，仓储无法实现）
- D4 → S6（状态机不定，StripeStub 无依据）
- R1 → R2（DO 类未定义无法 wiring）
- H1 → H3/H4/H5/H6/H7（auth 中间件未就绪，所有受保护路由无法测）
- W2 → W3 → W4-W8（API client 与 store 未定，页面无法联调）

### 可并行（无依赖或弱依赖）
- Gate 1 内：D1/D2/D3/D4/D5 五个组件可**全并行**（纯函数互不依赖）
- Gate 4 内：H3/H4/H5/H6/H7 五个路由在 H1、H2 就绪后**全并行**
- Gate 5 内：W4/W5/W6/W7/W8 在 W2、W3 就绪后**全并行**
- 前端 W1-Vite 脚手架与后端 Gate 2/3/4 **跨层并行**（前端先用 mock api 开发）
- T1/T2 测试基建与 Gate 1 **跨层并行**

### 推荐并行批次（单 agent 视角）
> 即使单线程，按批次组织能减少上下文切换成本。

- **Batch A**：F1, F2, F3, T1（基建 + 测试配置一起）
- **Batch B**：D1, D2, D3, D4, D5（领域层一波）
- **Batch C**：S1, S2（数据访问）
- **Batch D**：S3, S4, S5, S6, S7（业务服务并行）
- **Batch E**：R1, R2（实时层）
- **Batch F**：H1, H2, H8（中间件 + 健康检查）
- **Batch G**：H3, H4, H5, H6, H7（业务路由并行）
- **Batch H**：W1, W2, W3（前端基建）
- **Batch I**：W4, W5, W6, W7, W8（前端页面并行）
- **Batch J**：T3 E2E + 性能验证

---

## 5. 风险与缓解

| 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|
| **D1 写入配额**：DO 每条消息直写 D1 易触发 limits | 高可用受损 | 高 | A7：DO 内存聚合，200ms 或 50 条 flush；`alarm()` 兜底未确认消息 |
| **DO 冷启动数据丢失**：DO evict 时未 flush 的消息丢 | 数据丢失 | 中 | `blockConcurrencyWhile()` 内做启动恢复 + flush 队列持久化到 DO Storage |
| **scrypt 在 Workers 性能**：可能超 CPU 限制 | 注册/登录失败 | 中 | D2 实现时测 P95；若超时，参数调低或改 PBKDF2（Web Crypto 原生） |
| **WebSocket cookie 跨域**：Pages 与 Workers 不同域 | 鉴权失败 | 中 | 用 Cloudflare 自定义域 + `SameSite=Lax` + Pages 函数代理；A5 决策有备案 |
| **`StripeStub` 接口偏离真 Stripe** | 后续替换工作量大 | 中 | OQ9：先对齐 Subscription API（更贴近 SaaS 状态机）；接口在 S6 用 `interface` 隔离 |
| **Drizzle D1 类型生成不一致** | 类型错误 | 低 | `pnpm db:generate` 入 CI；schema 单一真相源（D1） |
| **Miniflare DO 测试隔离**：用例间状态污染 | 测试假绿 | 中 | T2：每个 `describe` 用 `idFromDate(uniqueName)` + unique D1 name |
| **Workers bundle 超过 1MB**（Drizzle 较重） | 部署失败 | 中 | Success Criteria 已守护；必要时按表 lazy import 或 `drizzle-kit` 只生成用到表的类型 |
| **前端首屏超 2.5s** | UX 差 | 低 | W5 主壳按路由 code-split；Lighthouse CI 守护（Success Criteria） |
| **限流误杀正常用户**：5/s 是否过低 | UX 差 | 低 | A11 可调；先 5/s 跑，T3 E2E 真实负载测试后调 |

---

## 6. 验证检查点（Phase Gates）

每个 gate 进入下一个前必须满足，作为 plan 阶段的 reviewable checkpoint。

### Gate 0 → Gate 1：基建就绪
- `pnpm install` 无 error
- `pnpm typecheck && pnpm lint && pnpm test` 在空项目下全绿
- CI 在 PR 上跑通（即使只有 README）
- `wrangler d1 create` 模拟成功（local）

### Gate 1 → Gate 2：领域核心完整
- D1-D5 单元测试覆盖 ≥ 90%（纯函数易达）
- 状态机所有合法/非法转换都有用例
- Zod validator 拒绝所有畸形输入

### Gate 2 → Gate 3：服务层契约稳定
- S2-S7 集成测试（Miniflare + 真 D1）通过
- `UserService.register/login/logout` 端到端用例绿
- `MessageRepo.list` cursor 分页用例：跨页不重不漏
- `StripeStub` 触发状态机转换 4 条路径全绿

### Gate 3 → Gate 4：实时层稳定
- `ChatRoomDO` 双连接收发消息集成测试绿
- DO flush 后崩溃恢复（`alarm()` 兜底）用例绿
- 限流窗口超限返回 429 用例绿

### Gate 4 → Gate 5：HTTP 契约锁定
- OpenAPI 风格的接口列表（手写或 hono zod-openapi 生成）入 SPEC 附录
- 所有受保护路由在未认证时返回 401
- WebSocket 升级握手成功并双向收发

### Gate 5 → Gate 6：前端可联调
- 注册→登录→建房间→发消息在浏览器手动走通
- 订阅状态守卫生效（trial 用户付费前点发消息被拦）
- WebSocket 断线重连手动验证

### Gate 6 → Done：验收对齐
- 所有 SPEC.md Success Criteria 勾选
- 3 条 E2E 路径全绿
- `pnpm test:coverage` 达标
- CI ≤ 5 分钟
- 前端 Lighthouse LCP ≤ 2.5s

---

## 7. 不在本计划范围（Phase 2+）

明确划出，避免 scope creep：
- 富媒体消息（图片/文件上传，需 R2 接入）
- 消息搜索（需 D1 FTS5 或外部搜索服务）
- @提及与通知（需推送基建）
- 移动端
- 多区域 DO 分片
- 真实 Stripe 集成（替换 StripeStub）
- i18n 多语言
- 邮件发送（注册验证、密码重置）
