// Probe: does the surviving `deepseek-flash` id accept an image?
import { readFileSync } from 'node:fs'

const key = process.env.DEEPSEEK_API_KEY
const png = readFileSync(process.argv[2])
const dataUrl = `data:image/png;base64,${png.toString('base64')}`

const models = ['deepseek-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']

for (const model of models) {
  const body = {
    model,
    max_tokens: 40,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What single word is written in this image? Answer with just that word.' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  }
  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    let summary
    try {
      const parsed = JSON.parse(text)
      summary = parsed.error
        ? `ERROR ${parsed.error.code ?? ''}: ${String(parsed.error.message).slice(0, 140)}`
        : `OK model=${parsed.model} answer=${JSON.stringify(parsed.choices?.[0]?.message?.content ?? '').slice(0, 80)}`
    } catch {
      summary = text.slice(0, 160)
    }
    console.log(`${model.padEnd(32)} -> ${summary}`)
  } catch (error) {
    console.log(`${model.padEnd(32)} -> REQUEST FAILED ${error.message}`)
  }
}
