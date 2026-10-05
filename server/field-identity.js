'use strict';

// 细胞/视野 id 身份歧义防护（保存校验 + 只读冲突标明）
//
// 历史版本的「整批保存」不校验批次内 id 唯一性，两个不同对象可以使用同一个 id：
// 视野侧合并统计按该 id 取到后一个，而覆盖核对、网格密度、最近质心责任区取前一个；
// 细胞侧报告比较配对与编辑页按 id 定位只命中一个细胞，其余同 id 细胞被静默掩盖——
// 同一标识在不同环节给出互相矛盾的结果。本模块集中提供：
//   - 保存前的 findFieldIdConflicts / findCellIdConflicts：保证本批 id 唯一，
//     冲突时由路由整批拒绝并指明位置；
//   - 草稿/报告/修订读取时的冲突标明（fieldIdConflicts）——历史数据不迁移、不静默改写。
//
// 「按 id / 名称解析时是否拒绝重复 id」的判定直接内建在各解析器中，且服务端与页端共用
// 同一份 merge-stats.js（field-grid/field-zones 的解析器同语义内建），保证两侧一致：
// 按 id 命中且该 id 重复 → 身份歧义拒绝；按唯一名称选中的视野照常分析。

// 通用实现：找出批次内所有重复的 id。
// 返回 [{ id, positions: [1 基位置…] }]，按首次出现顺序；id 仅接受非空字符串，
// 缺失/非字符串 id 由调用方负责补生成（新保存），不会进入本函数的冲突统计。
function findIdConflicts(items) {
  const all = Array.isArray(items) ? items : [];
  const order = [];
  const byId = new Map();
  all.forEach((it, i) => {
    if (!it || typeof it.id !== 'string' || !it.id) return;
    if (!byId.has(it.id)) {
      byId.set(it.id, []);
      order.push(it.id);
    }
    byId.get(it.id).push(i + 1); // 1 基位置，与几何校验的对象编号一致
  });
  return order
    .filter((id) => byId.get(id).length > 1)
    .map((id) => ({ id, positions: byId.get(id) }));
}

function findFieldIdConflicts(fields) {
  return findIdConflicts(fields);
}

function findCellIdConflicts(cells) {
  return findIdConflicts(cells);
}

// unit 为对象称谓（视野/细胞），与对应保存接口的错误文案一致
function describeConflicts(conflicts, unit = '视野') {
  return (Array.isArray(conflicts) ? conflicts : [])
    .map((c) => `id「${c.id}」同时用于第 ${c.positions.join('、')} 个${unit}`)
    .join('；');
}

module.exports = {
  findFieldIdConflicts,
  findCellIdConflicts,
  describeConflicts
};
