/**
 * Visual verification of a frontend.
 *
 * dshcli drives a headless Chromium to rasterise a page, then submits those
 * bytes to the harness as an SDK image content block so a vision-capable model
 * reports what the page actually renders. That keeps the check inside the same
 * harness the rest of dshcli uses: the browser is only a camera, and the
 * judgement comes from the configured route.
 *
 * Capturing a live application needs more than a URL: the page may sit behind a
 * session cookie and may hold a socket open forever. Both are handled in
 * {@link module:dshcli/browser}, which installs harvested cookies before
 * navigating and decides when the page has settled.
 *
 * @module dshcli/vision
 */

import { readFileSync } from 'node:fs'
import { capturePage, findBrowser, harvestCookies, toTargetUrl } from './browser.mjs'
import { Runtime } from './runtime.mjs'

/** Largest raster admitted as an inline prompt block, in bytes. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** MIME types the harness admits for inline images. */
const ADMITTED_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export { findBrowser, toTargetUrl, harvestCookies, capturePage }

/**
 * Read a raster and describe it as an SDK image content block.
 * @param path - the image file path.
 * @returns the `{ type, data, mimeType }` block.
 * @throws when the extension is unsupported or the file is too large.
 */
export function imageBlock(path) {
  const lower = path.toLowerCase()
  const mimeType = Object.entries(ADMITTED_MIME).find(([extension]) => lower.endsWith(extension))?.[1]
  if (mimeType === undefined) {
    throw new Error(`dshcli: ${path} is not a PNG, JPEG, WebP, or GIF image`)
  }
  const bytes = readFileSync(path)
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `dshcli: ${path} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB, above the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB inline limit`,
    )
  }
  return { type: 'image', data: bytes.toString('base64'), mimeType }
}

/** Default instruction given to the vision model. */
export const DEFAULT_VISION_PROMPT = [
  'You are reviewing a screenshot of a web frontend.',
  '',
  'Report, in this order:',
  '1. VERDICT — one of RENDERS, BROKEN, or EMPTY, and one sentence of justification.',
  '2. WHAT IS VISIBLE — the layout regions, navigation, and primary content you can actually see.',
  '3. VISIBLE DEFECTS — overlapping or clipped elements, unreadable contrast, placeholder text,',
  '   missing images, a blank or partially painted area, or an error banner. Say "none" if none.',
  '4. UNVERIFIABLE — what a single static screenshot cannot prove (interaction, loading states, data).',
  '',
  'Describe only what is present in the image. Do not speculate about code you cannot see.',
].join('\n')

/**
 * Compose the evidence preamble that precedes the screenshot.
 * @param capture - the capture result.
 * @param instruction - the reviewer instruction.
 * @returns the full text block sent with the image.
 */
function buildPrompt(capture, instruction) {
  const lines = [instruction, '', '---', 'Page facts recorded during capture:']
  lines.push(`- requested URL: ${capture.url}`)
  lines.push(`- document title: ${capture.title === '' ? '(empty)' : JSON.stringify(capture.title)}`)
  lines.push(`- viewport: ${capture.width ?? 1280}x${capture.height ?? 800}`)
  if (capture.consoleErrors.length === 0) {
    lines.push('- browser console errors: none')
  } else {
    lines.push(`- browser console errors: ${capture.consoleErrors.length}`)
    for (const entry of capture.consoleErrors.slice(0, 15)) lines.push(`  - ${entry}`)
  }
  return lines.join('\n')
}

/**
 * Rasterise a frontend and have a vision model report what renders.
 * @param options - target, runtime route, output paths, and stream callbacks.
 * @returns the capture facts, the turn outcome, and the session id.
 */
export async function verifyFrontend({
  target,
  launcherEntry,
  cwd,
  provider,
  model,
  reasoningEffort,
  prompt = DEFAULT_VISION_PROMPT,
  width = 1280,
  height = 800,
  out,
  browser,
  cookies = [],
  settleMs,
  profile = 'sdk',
  env = process.env,
  onEvent,
  onStatus,
  onStderr,
  onProgress = () => {},
}) {
  const url = toTargetUrl(target)

  onProgress(`harvesting session cookies for ${url}`)
  const harvested = await harvestCookies(url, { extra: cookies })
  if (harvested.length > 0) {
    onProgress(`collected ${harvested.length} cookie${harvested.length === 1 ? '' : 's'} (${harvested.map((c) => c.name).join(', ')})`)
  }

  onProgress(`capturing ${url}`)
  const capture = await capturePage({
    url,
    out,
    width,
    height,
    cookies: harvested,
    settleMs,
    browser,
    env,
  })
  capture.width = width
  capture.height = height
  onProgress(`captured ${(capture.bytes / 1024).toFixed(0)} KiB, title ${JSON.stringify(capture.title)} -> ${capture.path}`)
  if (capture.consoleErrors.length > 0) {
    onProgress(`the page logged ${capture.consoleErrors.length} console error${capture.consoleErrors.length === 1 ? '' : 's'}`)
  }

  onProgress(`starting ${provider}/${model} for visual review`)
  const runtime = await Runtime.start({
    launcherEntry,
    profile,
    cwd,
    provider,
    model,
    reasoningEffort,
    env,
    onEvent: (event, params) => onEvent?.(event, params),
    onStatus,
    onStderr,
  })

  try {
    const sessionId = Runtime.newSessionId()
    await runtime.prompt(sessionId, [
      { type: 'text', text: buildPrompt(capture, prompt) },
      imageBlock(capture.path),
    ])
    const reason = await runtime.waitForTurnEnd()
    return { capture, reason, sessionId }
  } finally {
    await runtime.shutdown()
  }
}
