'use strict';

// 统一的 HTML 转义与安全 DOM 构造工具。
//
// 原则：录入内容（上传文件名、细胞/视野名称、报告与比较标题、更正原因、
// 服务端错误提示等）原样存储、原样经 API / CSV / ZIP 导出；仅在把它们
// 拼入页面 HTML（标签文本、属性值、动态选项）时按字面文本转义，
// 使 <img src=x onerror=...> 等片段不会被解释为标签或事件。

// 转义为可安全放入 HTML 文本节点或双引号属性值的字面文本
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 纯文本节点（等价于 el.textContent = text，便于链式 appendChild）
function textNode(text) {
  return document.createTextNode(text == null ? '' : String(text));
}

// 构造 <tag ...>text</tag>：文本与属性均按字面量处理，不解释 HTML
// attrs 可为对象（值为 string|number|boolean：true 仅写属性名，false/null/undefined 跳过）
function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs && typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  if (text != null) node.appendChild(textNode(text));
  return node;
}

window.SafeDom = { escHtml, textNode, el };
