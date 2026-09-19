/**
 * ESLint 扁平配置(ESLint ≥9)。
 * 重点规则:
 * - @typescript-eslint/no-floating-promises:捕获 `void API.x().then(...)` 缺少失败分支的隐患;
 * - no-restricted-globals require:捕获 ESM(.mjs) 里误用全局 require 的问题(如 release.mjs)。
 * 历史告警不要求清零;新增代码不应再引入同类问题。
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
      '@typescript-eslint/no-floating-promises': 'warn',
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
      'no-restricted-globals': ['warn', { name: 'require', message: 'ESM(.mjs) 中不要用全局 require;请用 import 或 createRequire' }],
    },
  },
]
