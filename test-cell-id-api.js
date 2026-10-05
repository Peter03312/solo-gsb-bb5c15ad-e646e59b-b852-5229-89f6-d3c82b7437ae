'use strict';

// 细胞轮廓批量保存「批次内 id 唯一」原子校验 · 端到端 HTTP 自测（npm test）：
//   1) 整批保存轮廓：批次内 id 重复 → 400，指出冲突 id 与 1 基位置，整批拒绝、
//      版本不变、不留修订；同 id 出现 3 次、多个不同重复 id 都能各自列出；
//   2) 缺失 id 仍自动生成 UUID：全缺/部分缺失均 200，自动 id 不与显式 id 撞车；
//   3) 合法批次行为不变：保存 200、推进版本、追加 contours 修订，重名但 id 唯一允许；
//   4) 几何非法与 id 冲突混合：同样整批 400 不写入（几何先报或 id 先报均可）；
//   5) 修复前遗留的重复 id 数据（直接改库）原样保留；再次保存该批次仍被整批拒绝，
//      需改为唯一 id 后才能保存成功（不能把重复 id“洗白”为新版本）；
//   6) 版本过期 → 409 契约不变；409/400 均不写入、不修订。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const PORT = 8259;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cellid-'));
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

async function jget(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}

const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
];
const revCount = (db, imgId) =>
  db.prepare('SELECT COUNT(*) n FROM draft_revisions WHERE image_id = ?').get(imgId).n;

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  // 独立连接改库（服务端 WAL，允许并发夹具写入）
  const db = new Database(path.join(DATA_DIR, 'app.db'));

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    const up = await upload(png);
    const imgId = up.body.id;

    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 1px=1μm（版本 2、基线+定标 2 条修订）',
      r.status === 200 && r.body.version === 2 && revCount(db, imgId) === 2, r.body);

    // ---------- 1) 批次内 id 重复 → 400，整批拒绝 ----------
    const dupBatch = [
      { id: 'sameId', name: '细胞甲', outer: rect(10, 10, 10, 10), holes: [] },
      { id: 'u2', name: '独有乙', outer: rect(30, 10, 10, 10), holes: [] },
      { id: 'sameId', name: '细胞丙', outer: rect(50, 10, 10, 10), holes: [] }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/contours`, { version: 2, cells: dupBatch });
    check('重复 id → 400', r.status === 400 && /id 在本批中不唯一/.test(r.body.error), r.body);
    check('错误指出冲突 id 与 1 基位置（第 1、3 个细胞）',
      /id「sameId」同时用于第 1、3 个细胞/.test(r.body.error), r.body && r.body.error);
    check('错误体带 code=CELL_ID_CONFLICT 与结构化 conflicts',
      r.body.code === 'CELL_ID_CONFLICT' &&
      JSON.stringify(r.body.conflicts) === JSON.stringify([{ id: 'sameId', positions: [1, 3] }]),
      r.body);

    let g = await jget(`/api/images/${imgId}`);
    check('整批拒绝后版本不变（仍 2）、轮廓仍为空',
      g.body.version === 2 && g.body.cells.length === 0,
      { version: g.body.version, cells: g.body.cells.length });
    check('整批拒绝不新增修订（仍为 2 条）', revCount(db, imgId) === 2, { n: revCount(db, imgId) });

    // 同一 id 出现 3 次：位置全部列出
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2,
      cells: [
        { id: 'tri', name: '甲', outer: rect(0, 0, 10, 10), holes: [] },
        { id: 'tri', name: '乙', outer: rect(20, 0, 10, 10), holes: [] },
        { id: 'tri', name: '丙', outer: rect(40, 0, 10, 10), holes: [] }
      ]
    });
    check('同 id 三次 → 400 且列出第 1、2、3 个细胞',
      r.status === 400 && /id「tri」同时用于第 1、2、3 个细胞/.test(r.body.error), r.body);

    // 多个不同的重复 id：按首次出现顺序各自列出
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2,
      cells: [
        { id: 'a', name: '甲', outer: rect(0, 0, 10, 10), holes: [] },
        { id: 'b', name: '乙', outer: rect(20, 0, 10, 10), holes: [] },
        { id: 'a', name: '甲2', outer: rect(40, 0, 10, 10), holes: [] },
        { id: 'b', name: '乙2', outer: rect(60, 0, 10, 10), holes: [] }
      ]
    });
    check('多个重复 id → 400 且按首次出现顺序全部列出',
      r.status === 400 &&
      /id「a」同时用于第 1、3 个细胞/.test(r.body.error) &&
      /id「b」同时用于第 2、4 个细胞/.test(r.body.error), r.body);
    check('结构化 conflicts 含两个冲突',
      JSON.stringify(r.body.conflicts) ===
      JSON.stringify([{ id: 'a', positions: [1, 3] }, { id: 'b', positions: [2, 4] }]),
      r.body.conflicts);
    g = await jget(`/api/images/${imgId}`);
    check('多次拒绝后仍未写入（版本 2、无细胞、2 条修订）',
      g.body.version === 2 && g.body.cells.length === 0 && revCount(db, imgId) === 2,
      { version: g.body.version, cells: g.body.cells.length, n: revCount(db, imgId) });

    // ---------- 2) 缺失 id 仍自动生成 ----------
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2,
      cells: [
        { name: '自动id1', outer: rect(0, 0, 10, 10), holes: [] },
        { id: 'explicit1', name: '显式id', outer: rect(20, 0, 10, 10), holes: [] },
        { name: '自动id2', outer: rect(40, 0, 10, 10), holes: [] }
      ]
    });
    check('缺失 id 自动生成 → 200', r.status === 200, r.body);
    check('三个 id 均非空且两两不同、显式 id 原样保留',
      r.body.cells.length === 3 && new Set(r.body.cells.map((c) => c.id)).size === 3 &&
      r.body.cells[1].id === 'explicit1' &&
      r.body.cells.every((c) => typeof c.id === 'string' && c.id.length > 0),
      r.body.cells.map((c) => c.id));
    check('成功保存推进版本到 3 并追加 contours 修订（共 3 条）',
      r.body.version === 3 && revCount(db, imgId) === 3,
      { version: r.body.version, n: revCount(db, imgId) });
    const revList = await jget(`/api/images/${imgId}/revisions`);
    const revView = await jget(`/api/images/${imgId}/revisions/${revList.body.revisions[0].id}`);
    check('最新修订为 contours 且快照 3 个细胞',
      revView.body.type === 'contours' && revView.body.cells.length === 3, revView.body);

    // 全缺 id 也能通过（各自独立 UUID）
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 3,
      cells: [
        { name: 'p', outer: rect(0, 0, 8, 8), holes: [] },
        { name: 'q', outer: rect(20, 0, 8, 8), holes: [] }
      ]
    });
    check('全部缺失 id → 200 且两个生成 id 不同',
      r.status === 200 && r.body.cells[0].id !== r.body.cells[1].id, r.body);
    const vGood = r.body.version;

    // ---------- 3) 合法批次行为不变：重名但 id 唯一允许 ----------
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: vGood,
      cells: [
        { id: 'n1', name: '同名', outer: rect(0, 0, 10, 10), holes: [] },
        { id: 'n2', name: '同名', outer: rect(20, 0, 10, 10), holes: [] }
      ]
    });
    check('重名但 id 唯一 → 200（既有契约不变）', r.status === 200, r.body);
    check('测量值照常按标尺计算',
      r.body.cells.every((c) => c.areaUm2 === 100 && c.perimeterUm === 40), r.body.cells);
    const vBefore = r.body.version;

    // ---------- 4) 几何非法 + id 冲突混合：整批不写入 ----------
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: vBefore,
      cells: [
        { id: 'g', name: '好', outer: rect(0, 0, 10, 10), holes: [] },
        { id: 'g', name: '坏', outer: [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 5, y: 5 }], holes: [] }
      ]
    });
    check('几何非法+id 冲突 → 400 且整批不写入', r.status === 400, r.body);
    g = await jget(`/api/images/${imgId}`);
    check('混合拒绝后版本/细胞不变（重名那批仍在）、无新修订',
      g.body.version === vBefore && g.body.cells.length === 2 &&
      g.body.cells.map((c) => c.id).join(',') === 'n1,n2' &&
      revCount(db, imgId) === vBefore,
      { version: g.body.version, n: revCount(db, imgId) });

    // 非字符串 id（数字/null）视同缺失：补生成唯一 UUID，不参与冲突
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: vBefore,
      cells: [
        { id: 123, name: '数字id', outer: rect(0, 0, 10, 10), holes: [] },
        { id: null, name: '空id', outer: rect(20, 0, 10, 10), holes: [] },
        { id: 'keep', name: '字符串', outer: rect(40, 0, 10, 10), holes: [] }
      ]
    });
    check('非字符串/空 id 视同缺失并自动生成 → 200',
      r.status === 200 && new Set(r.body.cells.map((c) => c.id)).size === 3 &&
      r.body.cells[2].id === 'keep', r.body.cells && r.body.cells.map((c) => c.id));
    const vMixed = r.body.version;

    // ---------- 5) 遗留重复 id 数据：原样保留；再保存仍拒绝，改唯一后成功 ----------
    const legacyCells = [
      { id: 'X', name: '遗留甲', outer: rect(0, 0, 10, 10), holes: [] },
      { id: 'X', name: '遗留乙', outer: rect(20, 0, 10, 10), holes: [] },
      { id: 'z', name: '独有', outer: rect(40, 0, 10, 10), holes: [] }
    ];
    db.prepare('UPDATE images SET cells = ? WHERE id = ?').run(JSON.stringify(legacyCells), imgId);

    g = await jget(`/api/images/${imgId}`);
    check('遗留重复 id 草稿：GET 原样返回（不静默迁移、不报错）',
      g.status === 200 && JSON.stringify(g.body.cells) === JSON.stringify(legacyCells),
      g.body.cells);
    const legacyVersion = g.body.version;

    // 原样再提交该遗留批次：仍按当前规则整批拒绝
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: legacyVersion, cells: legacyCells.map((c) => ({ ...c }))
    });
    check('遗留重复 id 批次再次保存 → 400（不能洗白）',
      r.status === 400 && /id「X」同时用于第 1、2 个细胞/.test(r.body.error), r.body);
    g = await jget(`/api/images/${imgId}`);
    check('拒绝后遗留数据与版本均不变',
      g.body.version === legacyVersion &&
      JSON.stringify(g.body.cells) === JSON.stringify(legacyCells), g.body);

    // 修正为唯一 id 后保存成功
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: legacyVersion,
      cells: [
        { id: 'X', name: '遗留甲', outer: rect(0, 0, 10, 10), holes: [] },
        { id: 'Y', name: '遗留乙', outer: rect(20, 0, 10, 10), holes: [] },
        { id: 'z', name: '独有', outer: rect(40, 0, 10, 10), holes: [] }
      ]
    });
    check('改为唯一 id 后保存 → 200 并推进版本',
      r.status === 200 && r.body.version === legacyVersion + 1 &&
      r.body.cells.map((c) => c.id).join(',') === 'X,Y,z', r.body);
    check('修正保存追加 1 条 contours 修订',
      revCount(db, imgId) === legacyVersion + 1, { n: revCount(db, imgId) });

    // ---------- 6) 版本过期 → 409 契约不变 ----------
    const stale = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: legacyVersion,
      cells: [
        { id: 'dup1', name: '甲', outer: rect(0, 0, 10, 10), holes: [] },
        { id: 'dup1', name: '乙', outer: rect(20, 0, 10, 10), holes: [] }
      ]
    });
    check('过期版本即使含重复 id 也先返回 409（版本校验在前）',
      stale.status === 409 && stale.body.currentVersion === legacyVersion + 1, stale.body);
    check('409 不写入、不修订',
      revCount(db, imgId) === legacyVersion + 1, { n: revCount(db, imgId) });
  } finally {
    db.close();
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部细胞 id 唯一性 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
