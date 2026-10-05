'use strict';

// 取样视野 / 细胞 id 身份歧义防护（保存校验 + 只读冲突标明）
//
// 历史版本的「整批保存视野/轮廓」不校验批次内 id 唯一性，两个不同对象可以使用同一个 id：
// 视野侧，合并统计按该 id 取到后一个，而覆盖核对、网格密度、最近质心责任区取前一个，
// 同一标识在不同分析中给出互相矛盾的结果；细胞侧，报告对比的细胞索引按 id 建 Map、
// 编辑页按 id 选中/定位细胞，重复 id 使后一个覆盖前一个，同批只留下一个细胞。
// 本模块集中提供：
//   - 保存前的 findFieldIdConflicts / findCellIdConflicts：保证本批 id 唯一，
//     冲突时由路由整批拒绝并指明位置；
//   - 草稿/报告/修订读取时的视野冲突标明（fieldIdConflicts）——历史数据不迁移、不静默改写。
//
// 「按 id / 名称解析时是否拒绝重复 id」的判定直接内建在各解析器中，且服务端与页端共用
// 同一份 merge-stats.js（field-grid/field-zones 的解析器同语义内建），保证两侧一致：
// 按 id 命中且该 id 重复 → 身份歧义拒绝；按唯一名称选中的视野照常分析。

// 找出批次内所有重复 id 的通用实现。
// 返回 [{ id, positions: [1 基位置…] }]，按首次出现顺序；id 仅接受非空字符串，
// 缺失/非字符串 id 由调用方负责补生成（新保存），不会进入本函数的冲突统计。
function findIdConflicts(items) {
  const all = Array.isArray(items) ? items : [];
  const order = [];
  const byId = new Map();
  all.forEach((item, i) => {
    if (!item || typeof item.id !== 'string' || !item.id) return;
    if (!byId.has(item.id)) {
      byId.set(item.id, []);
      order.push(item.id);
    }
    byId.get(item.id).push(i + 1); // 1 基位置，与几何校验的对象编号一致
  });
  return order
    .filter((id) => byId.get(id).length > 1)
    .map((id) => ({ id, positions: byId.get(id) }));
}

// 找出批次内所有重复的视野 id。
function findFieldIdConflicts(fields) {
  return findIdConflicts(fields);
}

// 找出批次内所有重复的细胞 id。
function findCellIdConflicts(cells) {
  return findIdConflicts(cells);
}

function describeConflicts(conflicts) {
  return (Array.isArray(conflicts) ? conflicts : [])
    .map((c) => `id「${c.id}」同时用于第 ${c.positions.join('、')} 个视野`)
    .join('；');
}

function describeCellConflicts(conflicts) {
  return (Array.isArray(conflicts) ? conflicts : [])
    .map((c) => `id「${c.id}」同时用于第 ${c.positions.join('、')} 个细胞`)
    .join('；');
}

module.exports = {
  findFieldIdConflicts,
  findCellIdConflicts,
  describeConflicts,
  describeCellConflicts
};
