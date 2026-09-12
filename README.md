# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录、配件库存与领用明细。

## 启动

```bash
npm start            # 等价于 PORT=3021 node server.js
npm test             # 运行接口测试（node:test，零依赖）
```

可用环境变量：`PORT`（默认 3021）、`DB_FILE`（数据文件路径，默认 `data/db.json`）。

## 接口列表

钟表与调校（旧接口，保持不变）：

- `GET /health`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

配件库存与领用（新增）：

- `POST /parts` — 配件登记
- `GET /parts` — 配件库存列表（含 `lowStock` 标记）
- `GET /parts/low-stock` — 低库存列表（库存 ≤ 预警阈值）
- `POST /parts/:id/usages` — 领用配件（调校时关联，幂等、库存校验）
- `GET /part-usages?partId=&clockId=&adjustmentId=&requestId=` — 领用明细查询

## 配件登记

```bash
curl -X POST http://127.0.0.1:3021/parts \
  -H 'Content-Type: application/json' \
  -d '{"name":"发条","spec":"12x0.8x320","stockQuantity":10,"warningThreshold":3}'
```

字段：`name` 登记名称、`spec` 规格（均为非空字符串，传 `null` 或非字符串返回 400）、`stockQuantity` 库存数量、`warningThreshold` 预警阈值（均为不小于 0 的整数，传 `null`、非整数、负数或非数字类型返回 400）。四个字段均必填；校验失败的请求不会写入配件记录。

## 领用配件

```bash
curl -X POST http://127.0.0.1:3021/parts/part_xxx/usages \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"req-20260912-001","quantity":2,"clockId":"clock_demo","adjustmentId":"adjustment_demo","note":"调校更换发条"}'
```

规则：

- `requestId`（必填）为客户端生成的领用请求标识，**幂等键绑定配件**：同一 `requestId` 在同一配件下重复提交返回首次记录（`duplicated: true`，HTTP 200），不重复扣减，并发重复提交同样只扣一次；同一个键换到另一个配件提交则按新请求处理。
- `quantity` 必填且为正整数；`clockId`、`adjustmentId` 可选，用于关联钟表与调校记录。钟表不存在返回 404，调校记录不存在返回 404；**钟表与调校记录不属于同一只钟表时返回 400（`code: "CLOCK_ADJUSTMENT_MISMATCH"`）且不扣库存**。只提交 `adjustmentId` 时，归属钟表自动取调校记录所属钟表。
- **库存不足拒绝领用**：HTTP 409，响应体 `{"error":"配件库存不足：…当前库存 X，申请领用 Y","code":"INSUFFICIENT_STOCK"}`，库存与明细均不变。
- 领用事务在服务端串行执行（查重 → 校验 → 扣减 → 原子落盘），并发领用不会超卖。

## 闭环示例

```bash
# 查询低库存配件
curl http://127.0.0.1:3021/parts/low-stock

# 调校后复测
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
```
