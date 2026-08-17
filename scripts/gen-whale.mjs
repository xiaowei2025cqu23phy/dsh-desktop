// 用 Gemini 图像模型生成 DeepSeek 鲸鱼图标
// 用法:GEMINI_KEY=xxx node scripts/gen-whale.mjs <输出路径>
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const key = process.env.GEMINI_KEY || ''
if (key === '') { console.error('请设置 GEMINI_KEY'); process.exit(1) }
const out = resolve(process.argv[2] || 'assets/pet-whale.png')

const prompt = 'A cute friendly whale mascot logo for "DeepSeek AI", flat vector style, deep blue to indigo gradient whale body with a small white AI circuit pattern on its back, big friendly eye, small smile, tiny bubbles, plain white background, centered, minimal, clean, high quality, no text'

const res = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=' + key,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  },
)
if (!res.ok) {
  const txt = await res.text()
  console.error('HTTP', res.status, txt.slice(0, 500))
  process.exit(1)
}
const data = await res.json()
const parts = data.candidates?.[0]?.content?.parts || []
const img = parts.find((p) => p.inlineData && p.inlineData.data)
if (!img) {
  console.error('无图片返回:', JSON.stringify(data).slice(0, 500))
  process.exit(1)
}
writeFileSync(out, Buffer.from(img.inlineData.data, 'base64'))
console.log('已保存:', out, img.inlineData.mimeType)
