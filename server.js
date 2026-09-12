const http = require("http");
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  parts: [],
  partUsages: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "POST /parts",
  "GET /parts",
  "GET /parts/low-stock",
  "POST /parts/:id/usages",
  "GET /part-usages"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  // 兼容旧数据文件：补齐新增集合
  if (!Array.isArray(db.parts)) db.parts = [];
  if (!Array.isArray(db.partUsages)) db.partUsages = [];
  return db;
}

async function writeDb(data) {
  // 同目录临时文件 + rename，保证落盘原子性
  const tmp = `${DB_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, DB_FILE);
}

// 进程内串行写锁：领用事务（查重→校验库存→扣减→落盘）在锁内完成，避免并发超卖
let writeChain = Promise.resolve();
function withLock(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function nonNegativeInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    const error = new Error(`${field}必须是不小于0的整数`);
    error.status = 400;
    throw error;
  }
  return n;
}

function positiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    const error = new Error(`${field}必须是正整数`);
    error.status = 400;
    throw error;
  }
  return n;
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function findPart(db, partId) {
  const part = db.parts.find((item) => item.id === partId);
  if (!part) {
    const error = new Error("配件不存在");
    error.status = 404;
    throw error;
  }
  return part;
}

function partSummary(part) {
  return {
    ...part,
    lowStock: part.stockQuantity <= part.warningThreshold
  };
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    return send(res, 200, { data: { clock, adjustments, retests, latestRetest: latestRetest(db, clock.id) } });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      testedAt: body.testedAt || new Date().toISOString(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  // ===== 配件库存 =====

  if (req.method === "POST" && pathname === "/parts") {
    const body = await parseBody(req);
    required(body, ["name", "spec", "stockQuantity", "warningThreshold"]);
    const part = {
      id: makeId("part"),
      name: String(body.name),
      spec: String(body.spec),
      stockQuantity: nonNegativeInt(body.stockQuantity, "库存数量"),
      warningThreshold: nonNegativeInt(body.warningThreshold, "预警阈值"),
      createdAt: new Date().toISOString()
    };
    return withLock(async () => {
      const latest = await readDb();
      latest.parts.push(part);
      await writeDb(latest);
      return send(res, 201, { data: partSummary(part) });
    });
  }

  if (req.method === "GET" && pathname === "/parts") {
    return send(res, 200, { data: db.parts.map(partSummary) });
  }

  if (req.method === "GET" && pathname === "/parts/low-stock") {
    const data = db.parts
      .filter((part) => part.stockQuantity <= part.warningThreshold)
      .map(partSummary);
    return send(res, 200, { data });
  }

  const partUsageMatch = pathname.match(/^\/parts\/([^/]+)\/usages$/);
  if (partUsageMatch && req.method === "POST") {
    const partId = partUsageMatch[1];
    const body = await parseBody(req);
    required(body, ["requestId", "quantity"]);
    const requestId = String(body.requestId);
    const quantity = positiveInt(body.quantity, "领用数量");

    return withLock(async () => {
      const latest = await readDb();
      const part = findPart(latest, partId);

      // 幂等：同一 requestId 重复提交直接返回首次记录，不重复扣减
      const existing = latest.partUsages.find((item) => item.requestId === requestId);
      if (existing) {
        return send(res, 200, { duplicated: true, data: existing, part: partSummary(findPart(latest, existing.partId)) });
      }

      if (body.clockId) findClock(latest, String(body.clockId));
      if (body.adjustmentId) {
        const adjustment = latest.adjustments.find((item) => item.id === body.adjustmentId);
        if (!adjustment) {
          const error = new Error("调校记录不存在");
          error.status = 404;
          throw error;
        }
      }

      if (part.stockQuantity < quantity) {
        const error = new Error(
          `配件库存不足：配件「${part.name}(${part.spec})」当前库存 ${part.stockQuantity}，申请领用 ${quantity}`
        );
        error.status = 409;
        error.code = "INSUFFICIENT_STOCK";
        throw error;
      }

      part.stockQuantity -= quantity;
      const usage = {
        id: makeId("part_usage"),
        requestId,
        partId: part.id,
        partName: part.name,
        partSpec: part.spec,
        quantity,
        clockId: body.clockId ? String(body.clockId) : null,
        adjustmentId: body.adjustmentId ? String(body.adjustmentId) : null,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      latest.partUsages.push(usage);
      await writeDb(latest);
      return send(res, 201, { duplicated: false, data: usage, part: partSummary(part) });
    });
  }

  if (req.method === "GET" && pathname === "/part-usages") {
    const partId = url.searchParams.get("partId");
    const clockId = url.searchParams.get("clockId");
    const adjustmentId = url.searchParams.get("adjustmentId");
    const requestId = url.searchParams.get("requestId");
    const data = db.partUsages.filter((item) => {
      return (!partId || item.partId === partId)
        && (!clockId || item.clockId === clockId)
        && (!adjustmentId || item.adjustmentId === adjustmentId)
        && (!requestId || item.requestId === requestId);
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, {
    error: error.message || "服务器错误",
    code: error.code
  }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${server.address().port}`);
});

module.exports = { server, withLock, readDb, writeDb, DB_FILE };
