'use strict';

// 用户文本（上传文件名、细胞/视野名称、报告/比较标题、更正原因、错误提示等）
// 的页端 XSS 防护自测（node test-xss-dom.js，依赖 devDependency jsdom）：
//   - 把 <img src=x onerror=...> 等片段作为录入内容渲染到报告列表/详情、
//     草稿统计、比较工作台等位置后，页面中不得出现可执行的标签/事件，
//     只保留字面文本；
//   - 动态 <option> 的 value/文本、属性（data-key）与错误提示同样按字面量处理；
//   - 原始内容不经转义仍可读取（输入框 value 保持原文），CSV/ZIP 导出不经页端，不受影响。

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const PAYLOAD = '<img src=x onerror=alert(1)>';
const PAYLOAD2 = '"><script>alert(2)</script>';
const PAYLOAD3 = '<svg/onload=alert(3)>';

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;

// jsdom 不实现 canvas 2d 上下文：返回一个可任意链式调用的桩
const ctx2dStub = new Proxy({}, {
  get(t, p) {
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'getImageData') return () => ({ data: [] });
    if (p === 'canvas') return { width: 0, height: 0 };
    return typeof p === 'string' ? (() => {}) : undefined;
  },
  set() { return true; }
});
window.HTMLCanvasElement.prototype.getContext = function getContext() { return ctx2dStub; };
// CanvasView 构造时使用 ResizeObserver（jsdom 未实现）
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// crypto.randomUUID（编辑器创建/修正 id 时使用；jsdom 无 crypto 时补 webcrypto）
if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
  Object.defineProperty(window, 'crypto', { value: require('crypto').webcrypto });
}

let AppGlobal;
function load(script) {
  let code = fs.readFileSync(path.join(__dirname, 'public', script), 'utf8');
  if (script === 'app.js') code += '\nwindow.App = App;';
  window.eval(code);
  if (script === 'app.js') AppGlobal = window.App;
}

// 依 index.html 的顺序加载（merge-stats 依赖 ClientGeom）
['geometry-client.js'].forEach(load);
// merge-stats.js 由服务端同文件经 /merge-stats.js 提供
window.eval(fs.readFileSync(path.join(__dirname, 'server', 'merge-stats.js'), 'utf8'));
['dom-safe.js', 'api.js', 'canvas-view.js', 'editor.js', 'reports.js', 'compare.js',
  'coverage-diff-view.js', 'app.js'].forEach(load);

// 收集动态视图容器内的注入痕迹（忽略页面静态引入的 <script src> 标签）
function offenders(root = window.document) {
  const bad = [];
  const staticSrc = new Set(['/geometry-client.js', '/merge-stats.js', '/dom-safe.js',
    '/api.js', '/canvas-view.js', '/editor.js', '/reports.js', '/compare.js',
    '/coverage-diff-view.js', '/app.js']);
  root.querySelectorAll('img[onerror], script, svg[onload], img[src="x"]').forEach((n) => {
    if (n.tagName === 'SCRIPT' && staticSrc.has(n.getAttribute('src'))) return;
    bad.push(n.outerHTML);
  });
  // 任意元素上的 onerror/onload 等内联事件属性（退出/恢复预览按钮的静态 onclick 白名单）
  const staticHandlers = new Set([
    'BUTTON onclick=Editor.exitPreview()',
    'BUTTON onclick=Editor.restorePreviewed()'
  ]);
  root.querySelectorAll('*').forEach((n) => {
    for (const attr of n.getAttributeNames()) {
      if (/^on/i.test(attr)) {
        const sig = `${n.tagName} ${attr}=${n.getAttribute(attr)}`;
        if (staticHandlers.has(sig)) continue;
        bad.push(`<${n.tagName.toLowerCase()} ${attr}>`);
      }
    }
  });
  return bad;
}

let n = 0;
function ok(name, fn) {
  fn();
  n += 1;
  console.log('ok -', name);
}

// ---------- 1. escHtml 基本转义 ----------
ok('escHtml 把 < > & " \' 全部转义为实体', () => {
  const e = window.SafeDom.escHtml(PAYLOAD + PAYLOAD2);
  assert.ok(!e.includes('<') && !e.includes('>'));
  assert.ok(e.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(e.includes('&quot;&gt;'));
});

// ---------- 2. 首页草稿列表：文件名 / 加载错误 ----------
ok('首页草稿列表：文件名与错误提示只作文本', async () => {
  window.API.listImages = async () => [{
    id: 'im1', filename: PAYLOAD, width: 10, height: 10, version: 1,
    cells: [], calib: null, createdAt: '2026-01-01', published: false
  }];
  await AppGlobal.renderHome();
  assert.deepStrictEqual(offenders(), []);
  const list = window.document.getElementById('image-list');
  assert.ok(list.textContent.includes(PAYLOAD));
  assert.ok(!list.innerHTML.includes('<img src=x'));

  // 列表加载失败（错误信息可能含外部回显文本）按纯文本展示
  window.API.listImages = async () => { throw new Error(PAYLOAD); };
  await AppGlobal.renderHome();
  assert.deepStrictEqual(offenders(), []);
  assert.ok(list.textContent.includes(PAYLOAD));
  assert.ok(!list.innerHTML.includes('<img src=x'));
});

// ---------- 3. 报告列表（更正链视图）：文件名 / 更正原因 ----------
ok('报告列表：文件名与更正原因只作文本，不生成 img/事件', async () => {
  window.API.listReportChains = async () => ({
    chains: [{
      chainId: 'ch1', tipId: 'r1', length: 1,
      current: {
        id: 'r1', title: PAYLOAD, filename: PAYLOAD3, width: 10, height: 10,
        cellCount: 1, createdAt: '2026-01-01', draftVersion: 1
      },
      history: [], reason: PAYLOAD
    }]
  });
  await window.Reports.refresh();
  assert.deepStrictEqual(offenders(), []);
  const list = window.document.getElementById('report-list');
  assert.ok(list.textContent.includes(PAYLOAD));   // 标题原文可见
  assert.ok(list.textContent.includes(PAYLOAD3));  // 文件名原文可见
  assert.ok(list.textContent.includes(PAYLOAD));   // 更正原因原文可见
});

// ---------- 3. 报告详情：元信息、测量表、视野表、动态 option ----------
ok('报告详情：文件名/细胞名/视野名/选项 value 全部字面化', async () => {
  const report = {
    id: 'r1', title: PAYLOAD, filename: PAYLOAD, width: 100, height: 80,
    createdAt: '2026-01-01', draftVersion: 3,
    imageId: 'im1',
    calib: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, distanceUm: 10, scale: 1 },
    cells: [{
      id: 'c1', name: PAYLOAD, outer: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
      holes: [], areaUm2: 1, perimeterUm: 4
    }],
    fields: [{ id: 'f1', name: PAYLOAD2, outer: [], holes: [] }],
    fieldStats: [{
      name: PAYLOAD, holes: 0, areaText: '1', cellCount: 1,
      densityText: '1', countedCellAreaText: '1'
    }],
    fieldIdConflicts: []
  };
  window.API.getReport = async () => report;
  window.API.traceReport = async () => ({
    reportId: 'r1', isTip: true, length: 1, position: 1, tipId: 'r1', members: []
  });
  window.API.getImage = async () => null; // 更正框草稿加载失败也不应抛错
  // 跳过快照图片加载
  window.CanvasView.prototype.loadImage = async () => {};

  // Reports.showDetail 会操作 report 详情视图；stub 详情画布首次构造
  await window.Reports.showDetail('r1');

  assert.deepStrictEqual(offenders(), []);
  // 文件名/名称以字面文本出现在元信息与表格中
  const meta = window.document.getElementById('rp-meta').innerHTML;
  assert.ok(meta.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/<b><img/.test(meta));
  const table = window.document.getElementById('rp-table-wrap').textContent;
  assert.ok(table.includes(PAYLOAD));
  const fieldTable = window.document.getElementById('rp-field-wrap').textContent;
  assert.ok(fieldTable.includes(PAYLOAD));
  // 动态 datalist option：value 与文本均被转义
  const opt = window.document.querySelector('#rp-coverage-field-options option');
  assert.ok(opt);
  assert.strictEqual(opt.value, 'f1');
  assert.strictEqual(opt.textContent, PAYLOAD2);
  // 标题节点是 textContent 写入
  assert.strictEqual(window.document.getElementById('rp-title').textContent, PAYLOAD);

  // 报告内多视野合并：勾选视野后名称与统计安全
  window.Reports.mergeReportId = 'r1';
  window.Reports.mergeSelected = ['f1'];
  window.Reports.renderReportMerge(report);
  const mergeList = window.document.getElementById('rp-merge-field-list');
  assert.deepStrictEqual(offenders(), []);
  assert.ok(mergeList.textContent.includes(PAYLOAD2));

  // 报告覆盖核对：回显用户标识的错误提示按纯文本展示
  window.Reports.coverageReportId = 'r1';
  window.document.getElementById('rp-coverage-field-id').value = PAYLOAD;
  window.API.reportFieldCoverage = async () => {
    const e = new Error(`视野标识不存在：${PAYLOAD}，请求被拒绝`);
    throw e;
  };
  await window.Reports.runCoverageQuery();
  const rcov = window.document.getElementById('rp-coverage-result');
  assert.deepStrictEqual(offenders(), []);
  assert.ok(rcov.textContent.includes(PAYLOAD));
  assert.ok(!rcov.innerHTML.includes('<img'));
});

// ---------- 4. 草稿统计（编辑器侧栏）：细胞/视野名、合并统计、覆盖错误 ----------
ok('草稿统计表与合并/覆盖面板：名称与错误提示字面化', () => {
  const E = window.Editor;
  E.imageId = 'im1';
  E.img = {
    id: 'im1', filename: PAYLOAD, version: 1, width: 1000, height: 1000,
    calib: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, distanceUm: 10, scale: 1 }
  };
  E.cells = [{
    id: 'c1', name: PAYLOAD,
    outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }], holes: [],
    areaUm2: 1, perimeterUm: 1
  }];
  E.fields = [
    { id: 'f1', name: PAYLOAD2, outer: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }], holes: [] },
    { id: 'f2', name: '视野2', outer: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 10, y: 60 }], holes: [] }
  ];
  E.dirty = false; E.fieldsDirty = false;
  E.mergeSelected = ['f1', 'f2'];
  E.activeCellId = null; E.activeFieldId = null;
  E.migrate = null; E.coverageQuery = ''; E.coverageResult = null;
  E.view = null; // renderSidebar 不应触碰画布

  E.renderSidebar();
  assert.deepStrictEqual(offenders(), []);
  // 文件名（ed-title 为 textContent）与表格名称保留原文
  assert.strictEqual(window.document.getElementById('ed-title').textContent, PAYLOAD);
  assert.ok(window.document.getElementById('measure-table-wrap').textContent.includes(PAYLOAD));
  assert.ok(window.document.getElementById('field-stats-wrap').textContent.includes(PAYLOAD2));
  // 合并统计结果中的视野名被转义
  const mergeHtml = window.document.getElementById('merge-result').innerHTML;
  assert.ok(mergeHtml.includes('&lt;img'));
  assert.ok(!mergeHtml.includes('<img'));
  assert.ok(!mergeHtml.includes('onerror=alert(1)<'));

  // 覆盖核对：服务端错误（可能回显用户输入的视野标识）按纯文本展示
  E.coverageQuery = PAYLOAD;
  window.MergeStats.resolveFieldIdentifier = () => { throw new Error(`视野标识不存在：${PAYLOAD}`); };
  E.computeCoverage();
  assert.deepStrictEqual(offenders(), []);
  const cov = window.document.getElementById('coverage-result');
  assert.ok(cov.textContent.includes(PAYLOAD));
  assert.ok(!cov.innerHTML.includes('<img'));

  // 覆盖 datalist option value/文本转义
  const opt = window.document.querySelector('#coverage-field-options option');
  assert.strictEqual(opt.value, 'f1');
  assert.strictEqual(opt.textContent, PAYLOAD2);

  // 名称输入框保留原文（读取/编辑不受影响）
  const nameInput = window.document.querySelector('#cell-list input.name-edit');
  assert.strictEqual(nameInput.value, PAYLOAD);
});

// ---------- 5. 比较工作台：细胞 chip / 表格 / 固定报告头 ----------
ok('比较工作台：细胞名 data-key 保持可用、文本字面化；报告头安全', async () => {
  const C = window.Compare;
  C.mode = 'edit';
  C.id = 'cmp1'; C.version = 1;
  const mkReport = (id) => ({
    id, title: PAYLOAD, filename: `${PAYLOAD3}.png`, width: 10, height: 10,
    createdAt: '2026-01-01', draftVersion: 1,
    imageId: 'im' + id,
    calib: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, distanceUm: 10, scale: 1 },
    cells: [
      { id: 'k1', name: PAYLOAD, outer: [], holes: [], areaUm2: 1, perimeterUm: 2 },
      { id: 'k2', name: '安全细胞', outer: [], holes: [], areaUm2: 3, perimeterUm: 4 }
    ],
    fields: []
  });
  C.baselineReport = mkReport('b');
  C.retestReport = mkReport('r');
  C.pairs = [{ baselineCellKey: 'k1', retestCellKey: 'k2' }];
  C.selBase = null; C.selRetest = null;

  C.renderShell(); // 含固定报告头 + 工作台

  assert.deepStrictEqual(offenders(), []);
  const ws = window.document.getElementById('cmp-workspace');
  // chip 文本为原文
  const chip = ws.querySelector('.cmp-chip-name');
  assert.ok(chip.textContent.includes(PAYLOAD) || /安全细胞/.test(chip.textContent));
  // data-key 属性保持原始 key（未经实体转义），点击配对逻辑仍可用
  const chipBtn = ws.querySelector('.cmp-chip');
  assert.ok(['k1', 'k2'].includes(chipBtn.dataset.key));
  let clicked = null;
  C.clickCell = (side, key) => { clicked = [side, key]; };
  chipBtn.onclick({});
  assert.deepStrictEqual(clicked, [chipBtn.dataset.side, chipBtn.dataset.key]);
  // 配对表细胞名转义
  const tableHtml = ws.querySelector('table').innerHTML;
  assert.ok(tableHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
  // 固定报告头标题安全
  const fixed = window.document.getElementById('cmp-picker-fixed').innerHTML;
  assert.ok(fixed.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!fixed.includes('onerror=alert(1)<'));
});

// ---------- 6. 覆盖变化核对页元信息 ----------
ok('覆盖变化核对：报告标题/视野名/图片 id 字面化', () => {
  const V = window.CoverageDiffView;
  const result = {
    baseline: {
      reportId: 'b', title: PAYLOAD, draftVersion: 1, createdAt: 't',
      scaleUmPerPx: 1, imageId: PAYLOAD2, width: 10, height: 10,
      snapshotUrl: '/x', correctsReportId: null
    },
    retest: {
      reportId: 'r', title: PAYLOAD3, draftVersion: 2, createdAt: 't',
      scaleUmPerPx: 1, imageId: PAYLOAD2, width: 10, height: 10,
      snapshotUrl: '/y', correctsReportId: null
    },
    matchedBy: 'name',
    diff: {
      fieldName: PAYLOAD, fieldHoles: 0,
      classOrder: [], classes: {},
      sumAreaPx: 0, sumPercent: 0, fieldAreaText: '0',
      scale: { note: 'ok', same: true }
    }
  };
  V.lastResult = result;
  V.render(result);
  assert.deepStrictEqual(offenders(), []);
  const meta = window.document.getElementById('covdiff-meta').innerHTML;
  assert.ok(meta.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!meta.includes('onerror=alert(1)<'));
});

// ---------- 7. 修订时间线（历史草稿）note/typeLabel/细胞名 ----------
ok('历史修订时间线与预览快照：note 与名称字面化', () => {
  const E = window.Editor;
  E.imageId = 'im1';
  E.img = { id: 'im1', version: 2, calib: null };
  E.preview = null;
  E.revisions = [{
    id: 'rev1', seq: 1, type: 'contours', typeLabel: PAYLOAD,
    draftVersion: 1, createdAt: 't', calibrated: true,
    cellCount: 1, fieldCount: 0, isRestore: false, note: PAYLOAD2
  }];
  E.renderRevisionList();
  assert.deepStrictEqual(offenders(), []);
  const list = window.document.getElementById('revision-list').textContent;
  assert.ok(list.includes(PAYLOAD));
  assert.ok(list.includes(PAYLOAD2));

  E.preview = {
    rev: {
      id: 'rev1', seq: 1, typeLabel: PAYLOAD, draftVersion: 1,
      calib: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, distanceUm: 10, scale: 1 },
      cells: [{ name: PAYLOAD3, holes: [], areaUm2: 1, perimeterUm: 1 }],
      fields: [], fieldStats: []
    },
    readVersion: 2
  };
  E.renderRevisionPreview();
  assert.deepStrictEqual(offenders(), []);
  const pv = window.document.getElementById('revision-preview').innerHTML;
  assert.ok(pv.includes('&lt;svg/onload=alert(3)&gt;'));
});

// ---------- 8. 更正原因（历史报告链）字面化 ----------
ok('更正链追溯：标题与更正原因字面化', () => {
  const R = window.Reports;
  R.trace = {
    reportId: 'r1', isTip: true, length: 2, position: 2, tipId: 'r2',
    members: [{
      id: 'r1', seq: 1, draftVersion: 1, cellCount: 1, createdAt: 't',
      title: PAYLOAD, correctsReportId: null, isTip: false
    }, {
      id: 'r2', seq: 2, draftVersion: 2, cellCount: 1, createdAt: 't',
      title: PAYLOAD3, correctsReportId: 'r1', correctionReason: PAYLOAD2, isTip: true
    }]
  };
  R.renderTrace();
  assert.deepStrictEqual(offenders(), []);
  const trace = window.document.getElementById('rp-trace');
  assert.ok(trace.textContent.includes(PAYLOAD));
  assert.ok(trace.textContent.includes(PAYLOAD2));
});

console.log(`\n全部 ${n} 项页端 XSS 防护自测通过 ✔`);
