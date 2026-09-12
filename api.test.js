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

function request(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = opts.rawBody !== undefined ? opts.rawBody : body === undefined ? null : JSON.stringify(body);
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

test("正常重复提交：同一配件同一 requestId 不重复扣减，返回首次记录与 duplicated=true", async () => {
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

test("跨钟表调校关联：调校不属于该钟表时返回400且不扣库存", async () => {
  const clockA = await createClock();
  const clockB = await createClock();

  const adjA = await request("POST", `/clocks/${clockA.id}/adjustments`, {
    currentDailyRateSeconds: 40,
    direction: "慢针方向",
    amount: "钟表A的调校"
  });
  assert.equal(adjA.status, 201, adjA.raw);

  const part = await createPart({ name: "错配齿轮", spec: "M1", stockQuantity: 3, warningThreshold: 1 });

  // clockId=B 但 adjustmentId 属于 A → 明确客户端错误
  const mismatch = await request("POST", `/parts/${part.id}/usages`, {
    requestId: "req-mismatch-1",
    quantity: 1,
    clockId: clockB.id,
    adjustmentId: adjA.body.data.id
  });
  assert.equal(mismatch.status, 400, mismatch.raw);
  assert.equal(mismatch.body.code, "CLOCK_ADJUSTMENT_MISMATCH");
  assert.match(mismatch.body.error, /不匹配/);
  assert.ok(mismatch.body.error.includes(clockA.id));
  assert.ok(mismatch.body.error.includes(clockB.id));

  // 不扣库存、不生成明细
  const stock = (await request("GET", "/parts")).body.data.find((p) => p.id === part.id);
  assert.equal(stock.stockQuantity, 3);
  const usages = await request("GET", `/part-usages?partId=${part.id}`);
  assert.equal(usages.body.data.length, 0);

  // 被拒绝的请求未占用幂等键：同一 requestId 用正确归属重新提交应成功
  const fixed = await request("POST", `/parts/${part.id}/usages`, {
    requestId: "req-mismatch-1",
    quantity: 1,
    clockId: clockA.id,
    adjustmentId: adjA.body.data.id
  });
  assert.equal(fixed.status, 201, fixed.raw);
  assert.equal(fixed.body.data.clockId, clockA.id);

  // 只提交调校记录时，归属钟表自动取调校记录所属钟表
  const part2 = await createPart({ name: "错配齿轮2", spec: "M2", stockQuantity: 2, warningThreshold: 0 });
  const inferred = await request("POST", `/parts/${part2.id}/usages`, {
    requestId: "req-mismatch-2",
    quantity: 1,
    adjustmentId: adjA.body.data.id
  });
  assert.equal(inferred.status, 201, inferred.raw);
  assert.equal(inferred.body.data.clockId, clockA.id);
});

test("跨配件幂等键复用：同键换配件按新请求处理，各自只扣一次", async () => {
  const partX = await createPart({ name: "配件X", spec: "X1", stockQuantity: 3, warningThreshold: 1 });
  const partY = await createPart({ name: "配件Y", spec: "Y1", stockQuantity: 3, warningThreshold: 1 });

  // 同一 requestId 先用于配件X
  const onX = await request("POST", `/parts/${partX.id}/usages`, {
    requestId: "req-shared-key",
    quantity: 1
  });
  assert.equal(onX.status, 201, onX.raw);
  assert.equal(onX.body.data.partId, partX.id);

  // 同一个键换到配件Y：按新请求处理，Y 也扣减
  const onY = await request("POST", `/parts/${partY.id}/usages`, {
    requestId: "req-shared-key",
    quantity: 1
  });
  assert.equal(onY.status, 201, onY.raw);
  assert.equal(onY.body.duplicated, false);
  assert.equal(onY.body.data.partId, partY.id);
  assert.notEqual(onX.body.data.id, onY.body.data.id);

  // 各自重复提交：返回各自首次记录，库存不再变动
  const replayX = await request("POST", `/parts/${partX.id}/usages`, {
    requestId: "req-shared-key",
    quantity: 1
  });
  assert.equal(replayX.status, 200);
  assert.equal(replayX.body.duplicated, true);
  assert.equal(replayX.body.data.id, onX.body.data.id);
  assert.equal(replayX.body.part.stockQuantity, 2);

  const replayY = await request("POST", `/parts/${partY.id}/usages`, {
    requestId: "req-shared-key",
    quantity: 1
  });
  assert.equal(replayY.status, 200);
  assert.equal(replayY.body.duplicated, true);
  assert.equal(replayY.body.data.id, onY.body.data.id);
  assert.equal(replayY.body.part.stockQuantity, 2);

  // 同键换到第三个库存不足的配件：作为新请求被库存规则拒绝，不返回X的旧记录
  const partZ = await createPart({ name: "配件Z", spec: "Z1", stockQuantity: 0, warningThreshold: 0 });
  const onZ = await request("POST", `/parts/${partZ.id}/usages`, {
    requestId: "req-shared-key",
    quantity: 1
  });
  assert.equal(onZ.status, 409);
  assert.equal(onZ.body.code, "INSUFFICIENT_STOCK");

  // 两条明细各自独立可查
  const all = await request("GET", "/part-usages?requestId=req-shared-key");
  assert.equal(all.status, 200);
  const partIds = all.body.data.map((u) => u.partId).sort();
  assert.deepEqual(partIds, [partX.id, partY.id].sort());
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

test("配件登记校验：四字段的 null/非法类型/负数/缺失一律拒绝，失败不写入", async () => {
  const valid = {
    name: "标准发条",
    spec: "12x0.8x320",
    stockQuantity: 5,
    warningThreshold: 2
  };

  const before = (await request("GET", "/parts")).body.data.length;

  const invalidCases = [
    // 名称：null、非字符串、空串
    [{ ...valid, name: null }, /名称/],
    [{ ...valid, name: 123 }, /名称/],
    [{ ...valid, name: true }, /名称/],
    [{ ...valid, name: { zh: "发条" } }, /名称/],
    [{ ...valid, name: ["发条"] }, /名称/],
    [{ ...valid, name: "" }, /名称|缺少/],
    [{ ...valid, name: "   " }, /名称/],
    // 规格：null、非字符串、空串
    [{ ...valid, spec: null }, /规格/],
    [{ ...valid, spec: 42 }, /规格/],
    [{ ...valid, spec: false }, /规格/],
    [{ ...valid, spec: { s: 1 } }, /规格/],
    [{ ...valid, spec: "" }, /规格|缺少/],
    // 库存数量：null、非整数、字符串、布尔、负数
    [{ ...valid, stockQuantity: null }, /库存数量/],
    [{ ...valid, stockQuantity: 1.5 }, /库存数量/],
    [{ ...valid, stockQuantity: "5" }, /库存数量/],
    [{ ...valid, stockQuantity: true }, /库存数量/],
    [{ ...valid, stockQuantity: -1 }, /库存数量/],
    [{ ...valid, stockQuantity: -0.5 }, /库存数量/],
    // 预警阈值：null、非整数、字符串、布尔、负数
    [{ ...valid, warningThreshold: null }, /预警阈值/],
    [{ ...valid, warningThreshold: 2.5 }, /预警阈值/],
    [{ ...valid, warningThreshold: "2" }, /预警阈值/],
    [{ ...valid, warningThreshold: true }, /预警阈值/],
    [{ ...valid, warningThreshold: -3 }, /预警阈值/]
  ];

  for (const [payload, pattern] of invalidCases) {
    const res = await request("POST", "/parts", payload);
    assert.equal(res.status, 400, `非法输入应被拒绝：${JSON.stringify(payload)}，实际：${res.raw}`);
    assert.match(res.body.error, pattern);
  }

  // 字段逐个缺失：仍按必填处理，错误信息包含字段名
  for (const field of ["name", "spec", "stockQuantity", "warningThreshold"]) {
    const payload = { ...valid };
    delete payload[field];
    const res = await request("POST", "/parts", payload);
    assert.equal(res.status, 400, `缺失 ${field} 应被拒绝`);
    assert.match(res.body.error, new RegExp(field === "name" ? "name|名称" : field === "spec" ? "spec|规格" : field));
  }

  // 所有失败请求都没有写入配件记录
  const after = (await request("GET", "/parts")).body.data.length;
  assert.equal(after, before, "失败的登记请求不应产生配件记录");

  // 合法值：包含边界值 0 库存 / 0 阈值
  for (const payload of [
    valid,
    { ...valid, name: "零库存件", stockQuantity: 0 },
    { ...valid, name: "零阈值件", spec: "Z0", warningThreshold: 0 }
  ]) {
    const res = await request("POST", "/parts", payload);
    assert.equal(res.status, 201, `合法输入应登记成功：${JSON.stringify(payload)}，实际：${res.raw}`);
    assert.equal(res.body.data.name, payload.name);
    assert.equal(res.body.data.stockQuantity, payload.stockQuantity);
    assert.equal(res.body.data.warningThreshold, payload.warningThreshold);
    assert.equal(typeof res.body.data.id, "string");
  }
});

test("配件登记请求体：null/空请求体返回明确400且不写入，正常登记成功", async () => {
  const before = (await request("GET", "/parts")).body.data.length;

  // 客户端只发送字面量 null
  const nullBody = await request("POST", "/parts", null, { rawBody: "null" });
  assert.equal(nullBody.status, 400, nullBody.raw);
  assert.match(nullBody.body.error, /请求体|JSON|name/);

  // 空请求体（无 body）
  const empty = await request("POST", "/parts");
  assert.equal(empty.status, 400, empty.raw);
  assert.match(empty.body.error, /缺少字段/);

  // 非法 JSON 文本仍按原规则 400
  const malformed = await request("POST", "/parts", null, { rawBody: "{not-json" });
  assert.equal(malformed.status, 400, malformed.raw);
  assert.match(malformed.body.error, /合法JSON/);

  // 非对象 JSON（数字、字符串、数组）也给出明确 400
  for (const raw of ["123", '"发条"', "[]"]) {
    const res = await request("POST", "/parts", null, { rawBody: raw });
    assert.equal(res.status, 400, `请求体 ${raw} 应被拒绝，实际：${res.raw}`);
    assert.match(res.body.error, /请求体/);
  }

  // 失败请求均未写入
  const afterRejects = (await request("GET", "/parts")).body.data.length;
  assert.equal(afterRejects, before, "非法请求体不应产生配件记录");

  // 正常登记不受影响
  const ok = await request("POST", "/parts", {
    name: "请求体正常件",
    spec: "B1",
    stockQuantity: 4,
    warningThreshold: 1
  });
  assert.equal(ok.status, 201, ok.raw);
  assert.equal(ok.body.data.name, "请求体正常件");

  const afterOk = (await request("GET", "/parts")).body.data.length;
  assert.equal(afterOk, before + 1);
});

test("旧接口回归（本轮）：health/历史/登记/调校/复测闭环正常", async () => {
  const health = await request("GET", "/health");
  assert.equal(health.status, 200);

  // 种子钟表历史仍可读
  const history = await request("GET", "/clocks/clock_demo/history");
  assert.equal(history.status, 200);
  assert.equal(history.body.data.clock.id, "clock_demo");

  // 旧登记接口正常登记仍可用
  const clock = await createClock();
  assert.ok(clock.id);

  // 调校、复测闭环正常
  const adj = await request("POST", `/clocks/${clock.id}/adjustments`, {
    currentDailyRateSeconds: 33,
    direction: "慢针方向",
    amount: "微调0.2格"
  });
  assert.equal(adj.status, 201, adj.raw);

  const retest = await request("POST", `/clocks/${clock.id}/retests`, {
    dailyRateSeconds: 10,
    amplitude: 255
  });
  assert.equal(retest.status, 201, retest.raw);
  assert.equal(retest.body.data.qualified, true);
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
