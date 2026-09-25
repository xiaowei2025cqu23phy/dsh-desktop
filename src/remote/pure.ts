/**
 * PWA 纯逻辑的测试出口:只 re-export 不依赖 DOM 的函数,供 scripts/*-test.mjs 离线验证。
 *
 * 为什么单独一个入口:app.ts 是浏览器入口(运行时才拿 document),而 markdown 渲染、
 * 文本处理这类逻辑不碰 DOM,不该只能靠"连手机点一下"来验证。esbuild 把本文件打成
 * CJS(dist/remote/pure.js),页面不加载它。
 */

export { S, renderMarkdown } from './util'
