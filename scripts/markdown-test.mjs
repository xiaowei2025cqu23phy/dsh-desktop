/**
 * PWA markdown 渲染器测试(离线,不需要浏览器)。
 *
 * renderMarkdown 是纯函数(输入文本 → HTML 字符串),因此可以脱离 DOM 直接验证。
 * 覆盖重点:转义安全、代码区不被行内替换破坏(旧实现的老毛病)、块级与行内语法、
 * 表格、以及流式中途"未闭合围栏"不能吞掉后续内容。
 *
 * 用法:node scripts/markdown-test.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { renderMarkdown } = require('../dist/remote/pure.js')

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`✓ ${name}`)
  } else {
    failures++
    console.log(`✗ ${name}\n    期望 ${e}\n    实际 ${a}`)
  }
}
/** 断言输出包含片段(用于结构复杂、不便整串比对的用例)。 */
function contains(name, haystack, needle) {
  const ok = haystack.includes(needle)
  if (ok) console.log(`✓ ${name}`)
  else {
    failures++
    console.log(`✗ ${name}\n    期望包含 ${JSON.stringify(needle)}\n    实际 ${JSON.stringify(haystack.slice(0, 200))}`)
  }
}
function notContains(name, haystack, needle) {
  const ok = !haystack.includes(needle)
  if (ok) console.log(`✓ ${name}`)
  else {
    failures++
    console.log(`✗ ${name}\n    不应包含 ${JSON.stringify(needle)}\n    实际 ${JSON.stringify(haystack.slice(0, 200))}`)
  }
}

// ---- 转义安全 ----
contains('HTML 被转义', renderMarkdown('<img src=x onerror=alert(1)>'), '&lt;img')
notContains('不产出可执行的 script 标签', renderMarkdown('<script>alert(1)</script>'), '<script>')
contains('行内代码里的尖括号也转义', renderMarkdown('用 `<div>` 包一层'), '&lt;div&gt;')

// ---- 代码块 ----
{
  const out = renderMarkdown('说明:\n```ts\nconst a = 1 < 2 && 3 > 2\n```\n结束')
  contains('围栏代码块 → pre/code', out, '<pre class="md-code lang-ts"><code>')
  contains('代码内容保留比较运算符', out, '1 &lt; 2 &amp;&amp; 3 &gt; 2')
  contains('代码块前后文本保留', out, '说明:')
  // 关键回归:代码里的 ** 与反引号不能被当成 markdown
  const codeOnly = renderMarkdown('```\n**not bold** and `not code`\n```')
  notContains('代码内的 ** 不被当粗体', codeOnly, '<strong>')
  notContains('代码内的反引号不被当行内代码', codeOnly, '<code>not code</code>')
}
{
  // 流式输出中途:围栏没闭合,内容也要渲染出来且不吞后续
  const out = renderMarkdown('开始\n```python\nprint(1)\n还没结束')
  contains('未闭合围栏仍渲染为代码块', out, '<pre class="md-code lang-python"><code>')
  contains('未闭合围栏保留代码内容', out, 'print(1)')
}

// ---- 块级 ----
contains('一级标题', renderMarkdown('# 标题'), '<h2>标题</h2>')
contains('二级标题', renderMarkdown('## 标题'), '<h3>标题</h3>')
contains('分割线', renderMarkdown('---'), '<hr />')
contains('引用', renderMarkdown('> 引用内容'), '<blockquote>引用内容</blockquote>')
contains('无序列表', renderMarkdown('- 甲\n- 乙'), '<ul><li>甲</li><li>乙</li></ul>')
contains('有序列表', renderMarkdown('1. 甲\n2. 乙'), '<li>甲</li>')
contains('空行分段', renderMarkdown('第一段\n\n第二段'), '<p>第一段</p><p>第二段</p>')
contains('单换行变 br', renderMarkdown('甲\n乙'), '甲<br />乙')

// ---- 行内 ----
contains('粗体', renderMarkdown('这是**重点**内容'), '<strong>重点</strong>')
contains('斜体', renderMarkdown('这是*强调*内容'), '<em>强调</em>')
contains('删除线', renderMarkdown('~~删掉~~'), '<del>删掉</del>')
contains('行内代码', renderMarkdown('运行 `npm test`'), '<code>npm test</code>')
{
  const out = renderMarkdown('见 [文档](https://example.com/a)')
  contains('链接生成 a 标签', out, 'href="https://example.com/a"')
  contains('外链带 noopener', out, 'rel="noopener noreferrer"')
}

// ---- 表格 ----
{
  const out = renderMarkdown('| 名 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |')
  contains('表格 → table', out, '<table class="md-table">')
  contains('表头', out, '<th>名</th>')
  contains('表体', out, '<td>1</td>')
  contains('两行数据', out, '<td>2</td>')
}
{
  // 不是表格的两行竖线文本不能误判
  const out = renderMarkdown('| 甲 |\n| 乙 |')
  notContains('无分隔行不误判为表格', out, '<table')
}

// ---- 边界输入 ----
check('空输入返回空串', renderMarkdown(''), '')
check('null 输入不抛异常', renderMarkdown(null), '')
check('数字输入可用', renderMarkdown(42), '<p>42</p>')

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✓')
