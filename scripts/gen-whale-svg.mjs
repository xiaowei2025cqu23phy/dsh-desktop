// 用 Gemini(gemini-3.6-flash,免费层可用)生成 DeepSeek 鲸鱼 SVG 图标
// 用法:GEMINI_KEY=xxx node scripts/gen-whale-svg.mjs <输出路径>
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const key = process.env.GEMINI_KEY || ''
if (key === '') { console.error('请设置 GEMINI_KEY'); process.exit(1) }
const out = resolve(process.argv[2] || 'assets/pet-whale.svg')

const prompt = [
  'Create a cute friendly whale mascot SVG icon for "DeepSeek AI".',
  'Requirements:',
  '- Output ONLY valid SVG code inside ```svg ... ```, nothing else.',
  '- 200x200 viewBox, flat vector style.',
  '- Deep blue to indigo gradient whale body, white belly.',
  '- One big friendly eye, small smile, tiny water bubbles near the mouth.',
  '- A small subtle white circuit/AI chip pattern on the whale back.',
  '- TRANSPARENT background (no rect background).',
  '- Clean minimal shapes, rounded, modern logo feel.',
  '- No text, no letters.',
].join('\n')

const res = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + key,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7 },
    }),
  },
)
if (!res.ok) {
  const txt = await res.text()
  console.error('HTTP', res.status, txt.slice(0, 400))
  process.exit(1)
}
const data = await res.json()
const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
const m = text.match(/```svg\s*([\s\S]*?)```/)
const svg = (m ? m[1] : text).trim()
if (!svg.includes('<svg')) {
  console.error('未获得有效 SVG:', text.slice(0, 300))
  process.exit(1)
}
writeFileSync(out, svg, 'utf8')
console.log('已保存:', out, svg.length + 'B')
