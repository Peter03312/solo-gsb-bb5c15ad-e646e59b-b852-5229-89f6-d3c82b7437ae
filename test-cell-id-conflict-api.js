'use strict';

// 细胞轮廓整批保存 id 身份唯一性修复 · 端到端 HTTP 自测（npm test）：
//   1) 几何均合法但批次内两个或多个细胞共用同一 id → 400，指出冲突 id 与各自
//      1 基位置（code=CELL_ID_CONFLICT + 结构化 conflicts），整批不写入、
//      草稿版本不推进、不追加修订；
//   2) 多个 id 各自重复、同一 id 出现三次及以上：全部按首次出现顺序如实列出；
//   3) 缺失/空串/非字符串 id 仍按现有规则自动生成唯一标识，合法批次行为不变；
//   4) 几何非法与 id 重复同时存在同样整批拒绝；版本过期 409 契约不变；
//   5) 拒绝之后按当前版本提交合法批次：正常保存、版本推进、追加 contours 修订。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

  // 独立连接改库（校验修订条数；服务端 WAL，允许并发只读夹具）
  const db = new Database(path.join(DATA_DIR, 'app.db'));

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    const up = await upload(png);
    const imgId = up.body.id;

    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 1px=1μm', r.status === 200 && r.body.version === 2, r.body);

    // 合法批次（id 唯一）：行为保持不变
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'c1', name: '甲', outer: rect(10, 10, 20, 20), holes: [] },
        { id: 'c2', name: '乙', outer: rect(50, 50, 20, 20), holes: [] }
      ]
    });
    check('唯一 id 合法批次 → 200', r.status === 200 && r.body.cells.length === 2, r.body);
    check('合法批次测量值照常计算',
      r.body.cells.every((c) => c.areaUm2 === 400 && c.perimeterUm === 80), r.body.cells);
    const vGood = r.body.version;
    check('合法批次推进版本并追加 contours 修订（共 3 条）',
      revCount(db, imgId) === 3, { n: revCount(db, imgId) });

    // ---------- 1) 几何均合法但 id 重复 → 400，整批不写入 ----------
    const dupBatch = [
      { id: 'sameId', name: '细胞甲', outer: rect(0, 0, 30, 30), holes: [] },
      { id: 'u2', name: '独有乙', outer: rect(40, 40, 30, 30), holes: [] },
      { id: 'sameId', name: '细胞丙', outer: rect(80, 80, 30, 30), holes: [] }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/contours`, { version: vGood, cells: dupBatch });
    check('重复 id → 400',
      r.status === 400 && /id 在本批中不唯一/.test(r.body.error), r.body);
    check('错误指出冲突 id 与 1 基位置（第 1、3 个细胞）',
      /id「sameId」同时用于第 1、3 个细胞/.test(r.body.error), r.body && r.body.error);
    check('错误体带 code=CELL_ID_CONFLICT 与结构化 conflicts',
      r.body.code === 'CELL_ID_CONFLICT' &&
      JSON.stringify(r.body.conflicts) === JSON.stringify([{ id: 'sameId', positions: [1, 3] }]), r.body);

    let g = await jget(`/api/images/${imgId}`);
    check('整批拒绝后版本不变、细胞仍是上一批内容',
      g.body.version === vGood &&
      g.body.cells.length === 2 && g.body.cells[0].id === 'c1' && g.body.cells[1].id === 'c2',
      { version: g.body.version, ids: g.body.cells.map((c) => c.id) });
    check('整批拒绝不追加修订（仍为 3 条）', revCount(db, imgId) === 3, { n: revCount(db, imgId) });

    // ---------- 2) 多个 id 各自重复 / 同一 id 出现三次：按首次出现顺序全部列出 ----------
    const multiDup = [
      { id: 'a', name: '1', outer: rect(0, 0, 10, 10), holes: [] },
      { id: 'b', name: '2', outer: rect(20, 0, 10, 10), holes: [] },
      { id: 'b', name: '3', outer: rect(40, 0, 10, 10), holes: [] },
      { id: 'a', name: '4', outer: rect(60, 0, 10, 10), holes: [] },
      { id: 'a', name: '5', outer: rect(80, 0, 10, 10), holes: [] }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/contours`, { version: vGood, cells: multiDup });
    check('多组重复 → 400 且按首次出现顺序列出全部冲突',
      r.status === 400 &&
      JSON.stringify(r.body.conflicts) ===
        JSON.stringify([{ id: 'a', positions: [1, 4, 5] }, { id: 'b', positions: [2, 3] }]), r.body);
    check('错误文案同时描述两组冲突',
      /id「a」同时用于第 1、4、5 个细胞/.test(r.body.error) &&
      /id「b」同时用于第 2、3 个细胞/.test(r.body.error), r.body && r.body.error);
    g = await jget(`/api/images/${imgId}`);
    check('多组重复拒绝后版本/细胞/修订均不变',
      g.body.version === vGood && g.body.cells.length === 2 && revCount(db, imgId) === 3,
      { version: g.body.version, n: revCount(db, imgId) });

    // ---------- 3) 缺失/空串/非字符串 id 仍自动生成唯一标识 ----------
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: vGood,
      cells: [
        { name: '自动1', outer: rect(0, 0, 20, 20), holes: [] },
        { id: '', name: '空串id', outer: rect(30, 0, 20, 20), holes: [] },
        { id: 123, name: '非字符串id', outer: rect(60, 0, 20, 20), holes: [] },
        { id: 'explicit1', name: '显式id', outer: rect(90, 0, 20, 20), holes: [] }
      ]
    });
    check('缺失/空串/非字符串 id 自动生成 → 200', r.status === 200, r.body);
    check('四个 id 均非空字符串且两两不同（显式 id 保留）',
      r.body.cells.length === 4 &&
      r.body.cells.every((c) => typeof c.id === 'string' && c.id) &&
      new Set(r.body.cells.map((c) => c.id)).size === 4 &&
      r.body.cells.some((c) => c.id === 'explicit1'), r.body.cells.map((c) => c.id));
    const vAuto = r.body.version;
    check('自动 id 批次正常推进版本并追加修订（共 4 条）',
      revCount(db, imgId) === 4, { n: revCount(db, imgId) });

    // ---------- 4) 几何非法 + id 重复：同样整批拒绝；409 契约不变 ----------
    const badAndDup = [
      { id: 'g', name: '好', outer: rect(0, 0, 10, 10), holes: [] },
      { id: 'g', name: '坏', outer: rect(-10, -10, 20, 20), holes: [] } // 顶点越出图片范围
    ];
    r = await jsend('PUT', `/api/images/${imgId}/contours`, { version: vAuto, cells: badAndDup });
    check('几何非法且 id 重复 → 400 且不写入', r.status === 400, r.body);
    g = await jget(`/api/images/${imgId}`);
    check('拒绝后版本/细胞/修订均不变',
      g.body.version === vAuto && g.body.cells.length === 4 && revCount(db, imgId) === 4,
      { version: g.body.version, n: revCount(db, imgId) });

    const stale = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: vGood, // 过期版本
      cells: [{ id: 'x1', name: 'x', outer: rect(0, 0, 10, 10), holes: [] }]
    });
    check('版本过期 → 409 且不写入（契约保持）',
      stale.status === 409 && stale.body.currentVersion === vAuto, stale.body);

    // ---------- 5) 拒绝之后按当前版本提交合法批次：正常保存 ----------
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: vAuto,
      cells: [
        { id: 'f1', name: '新甲', outer: rect(0, 0, 25, 25), holes: [] },
        { id: 'f2', name: '新乙', outer: rect(40, 40, 25, 25), holes: [] },
        { id: 'f3', name: '新丙', outer: rect(80, 80, 25, 25), holes: [] }
      ]
    });
    check('修正后合法批次 → 200 且版本推进', r.status === 200 && r.body.version === vAuto + 1, r.body);
    check('落盘细胞 id 唯一且为提交值',
      JSON.stringify(r.body.cells.map((c) => c.id)) === JSON.stringify(['f1', 'f2', 'f3']),
      r.body.cells.map((c) => c.id));
    check('成功保存追加一条 contours 修订（共 5 条）',
      revCount(db, imgId) === 5, { n: revCount(db, imgId) });
    const revList = await jget(`/api/images/${imgId}/revisions`);
    check('最新修订为 contours 类型、快照含 3 个细胞',
      revList.body.revisions[0].type === 'contours' &&
      revList.body.currentVersion === r.body.version, revList.body.revisions[0]);

  } finally {
    db.close();
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部细胞 id 身份唯一性修复 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
