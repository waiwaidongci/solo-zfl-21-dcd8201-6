const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { mkdtemp, rm } = require("fs/promises");
const os = require("os");
const path = require("path");

let baseUrl;
let child;
let tmpDir;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${baseUrl}${urlPath}`,
      {
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, body: json, raw });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "clock-parts-test-"));
  const dbFile = path.join(tmpDir, "db.json");
  child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: "0", DB_FILE: dbFile },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 10000);
    child.stdout.on("data", function onData(chunk) {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务意外退出，code=${code}`));
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;

  // 等待 /health 就绪
  for (let i = 0; i < 50; i++) {
    const res = await request("GET", "/health").catch(() => null);
    if (res && res.status === 200) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("/health 未就绪");
});

test.after(async () => {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r)).catch(() => {});
  }
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

async function createPart(overrides = {}) {
  const res = await request("POST", "/parts", {
    name: "测试发条",
    spec: "12x0.8x320",
    stockQuantity: 10,
    warningThreshold: 3,
    ...overrides
  });
  assert.equal(res.status, 201, res.raw);
  return res.body.data;
}

async function createClock() {
  const res = await request("POST", "/clocks", {
    code: `CLK-TEST-${Date.now()}`,
    escapementType: "瑞士杠杆式",
    balanceFrequency: "21600vph",
    targetDailyRateSeconds: 20
  });
  assert.equal(res.status, 201, res.raw);
  return res.body.data;
}

test("正常领用：扣减库存并生成领用明细", async () => {
  const part = await createPart({ name: "正常发条", spec: "A1", stockQuantity: 5, warningThreshold: 2 });
  const clock = await createClock();

  const res = await request("POST", `/parts/${part.id}/usages`, {
    requestId: "req-normal-1",
    quantity: 2,
    clockId: clock.id,
    note: "调校更换发条"
  });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.duplicated, false);
  assert.equal(res.body.data.quantity, 2);
  assert.equal(res.body.data.partId, part.id);
  assert.equal(res.body.data.clockId, clock.id);
  assert.equal(res.body.part.stockQuantity, 3);
  assert.equal(res.body.part.lowStock, false);

  const list = await request("GET", `/part-usages?partId=${part.id}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].requestId, "req-normal-1");
  assert.equal(list.body.data[0].partName, "正常发条");
});

test("并发领用：库存不超卖，成功者数量之和等于库存", async () => {
  const part = await createPart({ name: "并发擒纵轮", spec: "C1", stockQuantity: 5, warningThreshold: 1 });

  // 8 个并发请求，每个领 1 件，库存只有 5
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      request("POST", `/parts/${part.id}/usages`, {
        requestId: `req-conc-${i}`,
        quantity: 1
      })
    )
  );

  const succeeded = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 409);
  assert.equal(succeeded.length, 5);
  assert.equal(rejected.length, 3);
  for (const r of rejected) {
    assert.equal(r.body.code, "INSUFFICIENT_STOCK");
    assert.match(r.body.error, /库存不足/);
  }

  const detail = await request("GET", `/part-usages?partId=${part.id}`);
  assert.equal(detail.body.data.length, 5);

  const stock = await request("GET", "/parts");
  const refreshed = stock.body.data.find((p) => p.id === part.id);
  assert.equal(refreshed.stockQuantity, 0);
});

test("重复提交：同一 requestId 不重复扣减，返回首次记录与 duplicated=true", async () => {
  const part = await createPart({ name: "重复垫片", spec: "D1", stockQuantity: 4, warningThreshold: 1 });
  const payload = { requestId: "req-idem-1", quantity: 3 };

  const first = await request("POST", `/parts/${part.id}/usages`, payload);
  assert.equal(first.status, 201, first.raw);
  assert.equal(first.body.duplicated, false);
  assert.equal(first.body.part.stockQuantity, 1);
  const firstId = first.body.data.id;

  const second = await request("POST", `/parts/${part.id}/usages`, payload);
  assert.equal(second.status, 200, second.raw);
  assert.equal(second.body.duplicated, true);
  assert.equal(second.body.data.id, firstId);
  assert.equal(second.body.part.stockQuantity, 1);

  // 并发重复提交同样只能扣一次
  const part2 = await createPart({ name: "重复垫片2", spec: "D2", stockQuantity: 2, warningThreshold: 0 });
  const raced = await Promise.all([
    request("POST", `/parts/${part2.id}/usages`, { requestId: "req-idem-race", quantity: 2 }),
    request("POST", `/parts/${part2.id}/usages`, { requestId: "req-idem-race", quantity: 2 })
  ]);
  const statuses = raced.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 201]);
  const ids = raced.map((r) => r.body.data.id);
  assert.equal(ids[0], ids[1]);
  const stock = (await request("GET", "/parts")).body.data.find((p) => p.id === part2.id);
  assert.equal(stock.stockQuantity, 0);
});

test("库存不足：拒绝领用并返回明确错误，库存不变", async () => {
  const part = await createPart({ name: "稀缺摆轮", spec: "S1", stockQuantity: 1, warningThreshold: 1 });

  const res = await request("POST", `/parts/${part.id}/usages`, {
    requestId: "req-short-1",
    quantity: 2
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "INSUFFICIENT_STOCK");
  assert.match(res.body.error, /当前库存 1/);
  assert.match(res.body.error, /申请领用 2/);

  // 失败后库存与明细均无变化
  const stock = (await request("GET", "/parts")).body.data.find((p) => p.id === part.id);
  assert.equal(stock.stockQuantity, 1);
  const usages = await request("GET", `/part-usages?partId=${part.id}`);
  assert.equal(usages.body.data.length, 0);

  // 同一个被拒绝的 requestId 重新以合理数量提交应当成功（未占库存的请求不被幂等吞掉）
  const retry = await request("POST", `/parts/${part.id}/usages`, {
    requestId: "req-short-1",
    quantity: 1
  });
  assert.equal(retry.status, 201, retry.raw);
  assert.equal(retry.body.part.stockQuantity, 0);
});

test("低库存查询：返回库存<=阈值的配件并标记 lowStock", async () => {
  const warnPart = await createPart({ name: "预警宝石", spec: "W1", stockQuantity: 2, warningThreshold: 5 });
  const equalPart = await createPart({ name: "临界游丝", spec: "W2", stockQuantity: 3, warningThreshold: 3 });
  const okPart = await createPart({ name: "充足发条", spec: "W3", stockQuantity: 10, warningThreshold: 2 });

  const res = await request("GET", "/parts/low-stock");
  assert.equal(res.status, 200);
  const ids = res.body.data.map((p) => p.id);
  assert.ok(ids.includes(warnPart.id));
  assert.ok(ids.includes(equalPart.id));
  assert.ok(!ids.includes(okPart.id));
  for (const p of res.body.data) {
    assert.equal(p.lowStock, true);
    assert.ok(p.stockQuantity <= p.warningThreshold);
  }

  // 库存列表同样带 lowStock 标记
  const all = await request("GET", "/parts");
  const okView = all.body.data.find((p) => p.id === okPart.id);
  assert.equal(okView.lowStock, false);
});

test("领用校验：缺字段、非法数量、不存在配件/钟表", async () => {
  const part = await createPart({ stockQuantity: 3, warningThreshold: 1 });

  const missing = await request("POST", `/parts/${part.id}/usages`, { quantity: 1 });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /requestId/);

  const badQty = await request("POST", `/parts/${part.id}/usages`, { requestId: "req-bad-1", quantity: 0 });
  assert.equal(badQty.status, 400);

  const unknownPart = await request("POST", "/parts/part_not_exist/usages", {
    requestId: "req-bad-2",
    quantity: 1
  });
  assert.equal(unknownPart.status, 404);

  const unknownClock = await request("POST", `/parts/${part.id}/usages`, {
    requestId: "req-bad-3",
    quantity: 1,
    clockId: "clock_not_exist"
  });
  assert.equal(unknownClock.status, 404);
  assert.match(unknownClock.body.error, /钟表不存在/);
});

test("配件登记校验：名称/规格/库存/阈值必填且数量合法", async () => {
  const missing = await request("POST", "/parts", { name: "只有名称" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /spec|stockQuantity|warningThreshold/);

  const negative = await request("POST", "/parts", {
    name: "负数件",
    spec: "X",
    stockQuantity: -1,
    warningThreshold: 1
  });
  assert.equal(negative.status, 400);
});

test("旧接口回归：钟表/调校/复测闭环不受影响", async () => {
  // health 中包含旧路由
  const health = await request("GET", "/health");
  assert.equal(health.status, 200);
  for (const route of [
    "GET /clocks",
    "POST /clocks/:id/adjustments",
    "POST /clocks/:id/retests",
    "GET /clocks/:id/history",
    "GET /retests",
    "GET /adjustments"
  ]) {
    assert.ok(health.body.routes.includes(route), `health 缺少旧路由 ${route}`);
  }

  // 种子数据仍可访问
  const demo = await request("GET", "/clocks/clock_demo/history");
  assert.equal(demo.status, 200);
  assert.equal(demo.body.data.clock.id, "clock_demo");
  assert.ok(demo.body.data.adjustments.length >= 1);
  assert.ok(demo.body.data.retests.length >= 1);

  // 新钟表 → 调校 → 关联领用 → 复测 全链路
  const clock = await createClock();

  const adj = await request("POST", `/clocks/${clock.id}/adjustments`, {
    currentDailyRateSeconds: 45,
    direction: "慢针方向",
    amount: "快慢针微调0.3格"
  });
  assert.equal(adj.status, 201, adj.raw);

  const part = await createPart({ name: "回归发条", spec: "R1", stockQuantity: 6, warningThreshold: 2 });
  const usage = await request("POST", `/parts/${part.id}/usages`, {
    requestId: "req-regression-1",
    quantity: 1,
    clockId: clock.id,
    adjustmentId: adj.body.data.id
  });
  assert.equal(usage.status, 201, usage.raw);
  assert.equal(usage.body.data.adjustmentId, adj.body.data.id);

  const retest = await request("POST", `/clocks/${clock.id}/retests`, {
    dailyRateSeconds: 12,
    amplitude: 260,
    adjustmentId: adj.body.data.id,
    note: "进入目标范围"
  });
  assert.equal(retest.status, 201, retest.raw);
  assert.equal(retest.body.data.qualified, true);

  const history = await request("GET", `/clocks/${clock.id}/history`);
  assert.equal(history.body.data.adjustments.length, 1);
  assert.equal(history.body.data.retests.length, 1);

  const latest = await request("GET", `/clocks/${clock.id}/latest-retest`);
  assert.equal(latest.body.data.dailyRateSeconds, 12);

  // 列表过滤
  const notQualified = await request("GET", "/clocks/not-qualified");
  assert.equal(notQualified.status, 200);
  assert.ok(Array.isArray(notQualified.body.data));

  const retests = await request("GET", `/retests?clockId=${clock.id}&qualified=true`);
  assert.equal(retests.body.data.length, 1);

  const adjustments = await request("GET", `/adjustments?clockId=${clock.id}`);
  assert.equal(adjustments.body.data.length, 1);

  // 领用明细可按调校记录过滤
  const byAdj = await request("GET", `/part-usages?adjustmentId=${adj.body.data.id}`);
  assert.equal(byAdj.body.data.length, 1);
  assert.equal(byAdj.body.data[0].id, usage.body.data.id);
});
