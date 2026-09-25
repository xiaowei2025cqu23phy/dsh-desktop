/**
 * ESLint 扁平配置(ESLint ≥9)。
 *
 * 分级:**错误级**规则必须清零(CI 会失败),警告级允许存量、但新代码不应再引入。
 * - 错误级
 *   - no-restricted-globals require:捕获 ESM(.mjs) 里误用全局 require(如 release.mjs 曾整份跑不起来);
 *   - no-duplicate-imports:同一模块拆成多行 import / import type 的残留;
 *   - @typescript-eslint/no-unused-vars:配合 tsconfig 的 noUnusedLocals,清掉改完留下的死变量;
 *   - @typescript-eslint/no-unused-private-class-members:私有方法/字段没人调用。
 * - 警告级(存量 16 条,不要求清零)
 *   - @typescript-eslint/no-floating-promises:捕获 `void API.x().then(...)` 缺少失败分支的隐患。
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

export default [
  {
    ignores: ['dist/**', 'release/**', 'node_modules/**', 'assets/**', '*.log'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        // 三份 tsconfig 分别覆盖 main/preload、renderer、remote,显式列出以便类型感知规则正确映射。
        project: ['./tsconfig.json', './tsconfig.renderer.json', './tsconfig.remote.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // 存量告警:允许,但新代码不该再出现。
      '@typescript-eslint/no-floating-promises': 'warn',
      // 必须清零。
      'no-duplicate-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      '@typescript-eslint/no-unused-private-class-members': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        URL: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      // 必须清零:这条曾经让 release.mjs 在 ESM 里用全局 require,整份发布脚本一跑就崩。
      'no-restricted-globals': ['error', { name: 'require', message: 'ESM(.mjs) 中不要用全局 require;请用 import 或 createRequire' }],
      'no-duplicate-imports': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
]
