/**
 * Terminal rendering of harness session events.
 *
 * The web UI renders the session log as a conversation: streamed assistant
 * prose, collapsible reasoning, a card per tool call, and a status chip. This
 * module reproduces that reading order in a terminal — each session event maps
 * to one region of plain text, tools to a call line plus an indented result
 * preview, reasoning to a dim block that `--no-reasoning` drops, and turn
 * boundaries to a rule with the outcome and elapsed time.
 *
 * The renderer never decides control flow: it writes and returns. Callers own
 * the runtime lifecycle.
 *
 * @module dshcli/render
 */

import { style, visibleLength } from './theme.mjs'

/** Longest tool-result preview kept inline, in characters. */
const TOOL_RESULT_BUDGET = 900

/** Longest reasoning block kept inline, in characters. */
const REASONING_BUDGET = 1_200

/** Tool-result lines kept before the preview is elided. */
const TOOL_RESULT_LINES = 8

/** Argument characters shown next to a tool name. */
const TOOL_ARG_BUDGET = 110

/**
 * Wrap text to a width, honouring existing newlines and hanging indents.
 * @param text - the text to wrap.
 * @param width - maximum printable columns per line.
 * @param indent - prefix applied to the first line.
 * @param hangingIndent - prefix applied to continuation lines.
 * @returns the wrapped lines.
 */
export function wrapText(text, width, indent = '', hangingIndent = indent) {
  const out = []
  for (const rawLine of String(text).split('\n')) {
    if (rawLine === '') {
      out.push(indent.trimEnd())
      continue
    }
    const leading = rawLine.match(/^\s*/)[0]
    let current = indent + leading
    let used = visibleLength(current)
    for (const word of rawLine.trim().split(/\s+/)) {
      const cost = (used === visibleLength(indent + leading) ? 0 : 1) + word.length
      if (used + cost > width && used > visibleLength(indent)) {
        out.push(current)
        current = hangingIndent + word
        used = visibleLength(hangingIndent) + word.length
      } else {
        current += (used === visibleLength(indent + leading) ? '' : ' ') + word
        used += cost
      }
    }
    out.push(current)
  }
  return out
}

/**
 * Apply light inline markdown styling to one line.
 *
 * Only the constructs that read badly as raw text are transformed: inline code,
 * bold, and headings. Fenced code blocks are handled by the caller.
 * @param line - one line of assistant prose.
 * @returns the line with ANSI styling applied.
 */
function inlineMarkdown(line) {
  let out = line
  out = out.replace(/`([^`]+)`/g, (_, code) => style.cyan(code))
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, text) => style.bold(text))
  out = out.replace(/^(#{1,6})\s+(.*)$/, (_, __, text) => style.bold(style.brightCyan(text)))
  return out
}

/**
 * Summarise one tool call's raw argument JSON for a one-line heading.
 *
 * The model emits arguments unparsed, so a summary is best-effort: the first
 * recognised descriptive field when the JSON parses, otherwise a flattened
 * prefix of the raw text.
 * @param name - the tool name, used to pick the descriptive field.
 * @param rawArguments - the argument JSON exactly as the model produced it.
 * @returns a short preview string.
 */
export function summarizeToolArguments(name, rawArguments) {
  const raw = typeof rawArguments === 'string' ? rawArguments : ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }

  const preferred = {
    bash: ['command'],
    pwsh: ['command'],
    read: ['file_path', 'path'],
    write: ['file_path', 'path'],
    edit: ['file_path', 'path'],
    str_replace_editor: ['path', 'command'],
    glob: ['pattern'],
    grep: ['pattern'],
    web_search: ['query'],
    web_fetch: ['url'],
    task: ['description'],
    subagent: ['description'],
    workflow: ['name'],
    ask_user_question: ['question'],
  }[name] ?? []

  const fields = [...preferred, 'command', 'query', 'file_path', 'path', 'pattern', 'url', 'description', 'task', 'prompt']
  if (parsed !== null && typeof parsed === 'object') {
    for (const field of fields) {
      const value = parsed[field]
      if (typeof value === 'string' && value !== '') return truncateOneLine(value, TOOL_ARG_BUDGET)
    }
    const firstString = Object.values(parsed).find((value) => typeof value === 'string' && value !== '')
    if (typeof firstString === 'string') return truncateOneLine(firstString, TOOL_ARG_BUDGET)
    const keys = Object.keys(parsed)
    if (keys.length > 0) return truncateOneLine(keys.join(', '), TOOL_ARG_BUDGET)
  }
  return truncateOneLine(raw, TOOL_ARG_BUDGET)
}

/**
 * Collapse whitespace and clip a string to one line.
 * @param text - the source text.
 * @param budget - maximum characters kept.
 * @returns the collapsed, clipped preview.
 */
function truncateOneLine(text, budget) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim()
  return collapsed.length <= budget ? collapsed : `${collapsed.slice(0, budget - 1)}…`
}

/**
 * Extract the text of a content-block array, skipping non-text blocks.
 * @param content - a `ContentBlock[]` or a single block.
 * @returns the concatenated text.
 */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block === null || typeof block !== 'object') return ''
        if (block.type === 'text' && typeof block.text === 'string') return block.text
        if (block.type === 'reasoning' && typeof block.text === 'string') return block.text
        if (block.type === 'image') return '[image]'
        return ''
      })
      .filter((part) => part !== '')
      .join('\n')
  }
  return ''
}

/**
 * Extract only reasoning text from a content-block array.
 * @param content - a `ContentBlock[]`.
 * @returns the concatenated reasoning text.
 */
function reasoningText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Renders harness session events to a terminal stream.
 */
export class Renderer {
  #stream
  #width
  #showReasoning
  #verbose
  #spinnerTimer = null
  #spinnerStartedAt = 0
  #spinnerVisible = false
  #spinnerLabel = 'working'
  #running = false
  #turnStartedAt = 0
  #currentTurn = 0
  #currentStep = 0
  #toolNames = new Map()
  #sessionTitles = new Map()

  /**
   * @param options - output stream and display preferences.
   * @param options.stream - the writable stream to render into.
   * @param options.width - printable columns; defaults to the terminal width.
   * @param options.showReasoning - whether reasoning blocks are printed.
   * @param options.verbose - whether every event type is echoed.
   */
  constructor({ stream = process.stdout, width, showReasoning = true, verbose = false } = {}) {
    this.#stream = stream
    this.#width = width ?? Math.max(60, Math.min(stream.columns ?? 100, 120))
    this.#showReasoning = showReasoning
    this.#verbose = verbose
  }

  /** Printable width this renderer wraps to. */
  get width() {
    return this.#width
  }

  /**
   * Called immediately before anything is written.
   *
   * The interactive session sets this to hide the slash-command menu, so output
   * arriving while the user is typing cannot interleave with the menu rows.
   * @type {(() => void) | undefined}
   */
  beforeWrite = undefined

  /**
   * Asked before each spinner frame whether the spinner may draw.
   *
   * The spinner paints the current line, which is the prompt line whenever the
   * menu is open; drawing then would erase what the user is typing. Returning
   * false suspends the animation until the menu closes.
   * @type {(() => boolean) | undefined}
   */
  spinnerAllowed = undefined

  /** Whether reasoning blocks are printed. */
  get showReasoning() {
    return this.#showReasoning
  }

  /** Whether the runtime last reported `running`. */
  get busy() {
    return this.#running
  }

  /**
   * Show or hide reasoning blocks for the rest of the session.
   * @param value - the new setting.
   * @returns nothing.
   */
  set showReasoning(value) {
    this.#showReasoning = value === true
  }

  /**
   * Write one line, clearing any visible spinner first.
   * @param text - the line body, already styled.
   * @returns nothing.
   */
  write(text = '') {
    this.#clearSpinner()
    this.beforeWrite?.()
    this.#stream.write(`${text}\n`)
  }

  /**
   * Write text without a trailing newline.
   * @param text - the text to append.
   * @returns nothing.
   */
  writeRaw(text) {
    this.#clearSpinner()
    this.beforeWrite?.()
    this.#stream.write(text)
  }

  /**
   * Print a horizontal rule with an optional label.
   * @param label - text placed at the start of the rule.
   * @returns nothing.
   */
  rule(label = '') {
    if (label === '') {
      this.write(style.gray('─'.repeat(this.#width)))
      return
    }
    const fill = Math.max(0, this.#width - visibleLength(label) - 4)
    this.write(style.gray(`── ${label} ${'─'.repeat(fill)}`))
  }

  /**
   * Print a labelled block of fields.
   * @param fields - labelled values shown in order.
   * @param options - an optional heading; pass `null` to print only the fields.
   * @returns nothing.
   */
  banner(fields, { heading = 'dshcli  ·  DeepSeek Harness, terminal session' } = {}) {
    if (heading !== null) this.write(style.bold(style.brightCyan(heading.split('  ·  ')[0])) + (heading.includes('  ·  ') ? style.gray(`  ·  ${heading.split('  ·  ')[1]}`) : ''))
    const labelWidth = Math.max(...fields.map(([label]) => label.length))
    for (const [label, value] of fields) {
      this.write(`${style.gray(label.padEnd(labelWidth))}  ${value}`)
    }
    this.write('')
  }

  /**
   * Show a free-form notice line.
   * @param text - the message.
   * @param tone - one of `info`, `warn`, `error`, `ok`.
   * @returns nothing.
   */
  note(text, tone = 'info') {
    const prefix = { info: style.cyan('›'), warn: style.yellow('!'), error: style.red('✗'), ok: style.green('✓') }[tone]
    this.write(`${prefix} ${text}`)
  }

  /**
   * Start the working spinner shown while the runtime reports `running`.
   * @param label - the spinner caption.
   * @returns nothing.
   */
  startSpinner(label = 'working') {
    this.#running = true
    this.#spinnerLabel = label
    if (this.#spinnerTimer !== null || this.#stream.isTTY !== true) return
    this.#spinnerStartedAt = Date.now()
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let frame = 0
    this.#spinnerTimer = setInterval(() => {
      if (this.spinnerAllowed?.() === false) return
      const elapsed = ((Date.now() - this.#spinnerStartedAt) / 1000).toFixed(1)
      this.#stream.write(`\r\u001B[2K${style.cyan(frames[frame++ % frames.length])} ${style.gray(`${this.#spinnerLabel}… ${elapsed}s`)}`)
      this.#spinnerVisible = true
    }, 90)
    this.#spinnerTimer.unref?.()
  }

  /**
   * Stop the spinner and erase its line.
   * @returns nothing.
   */
  stopSpinner() {
    this.#running = false
    if (this.#spinnerTimer !== null) {
      clearInterval(this.#spinnerTimer)
      this.#spinnerTimer = null
    }
    this.#clearSpinner()
  }

  /**
   * Erase the spinner line when one is visible.
   *
   * The redraw interval keeps running: content writes erase the line, and the
   * next tick paints it again on the line the write left behind.
   * @returns nothing.
   */
  #clearSpinner() {
    if (!this.#spinnerVisible) return
    this.#stream.write('\r\u001B[2K')
    this.#spinnerVisible = false
  }

  /**
   * Handle a `session.status` notification.
   * @param status - `running` or `idle`.
   * @returns nothing.
   */
  handleStatus(status) {
    if (status === 'running') this.startSpinner(`turn ${this.#currentTurn || 1}`)
    else this.stopSpinner()
  }

  /**
   * Print the assistant prose of one step with light markdown handling.
   * @param text - the assistant text.
   * @returns nothing.
   */
  assistantText(text) {
    const trimmed = String(text).replace(/\s+$/, '')
    if (trimmed.trim() === '') return
    this.write('')
    let inFence = false
    for (const line of trimmed.split('\n')) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        this.write(style.gray(`  ${line.trim()}`))
        continue
      }
      if (inFence) {
        this.write(style.gray(`  ${line}`))
        continue
      }
      if (line.trim() === '') {
        this.write('')
        continue
      }
      for (const wrapped of wrapText(inlineMarkdown(line), this.#width, '  ', '  ')) this.write(wrapped)
    }
    this.write('')
  }

  /**
   * Print an indented dim block, used for reasoning and tool results.
   * @param text - the block body.
   * @param options - indentation, colour, and truncation budget.
   * @returns nothing.
   */
  block(text, { indent = '  ', paint = style.gray, budget = TOOL_RESULT_BUDGET, maxLines = TOOL_RESULT_LINES } = {}) {
    const lines = String(text).replace(/\s+$/, '').split('\n')
    const clipped = []
    let consumed = 0
    for (const line of lines) {
      if (clipped.length >= maxLines || consumed >= budget) break
      const room = budget - consumed
      const piece = line.length > room ? `${line.slice(0, Math.max(0, room - 1))}…` : line
      clipped.push(piece)
      consumed += piece.length + 1
    }
    for (const line of clipped) {
      for (const wrapped of wrapText(line, this.#width, indent, indent)) this.write(paint(wrapped))
    }
    const dropped = lines.length - clipped.length
    if (dropped > 0) this.write(paint(`${indent}… ${dropped} more line${dropped === 1 ? '' : 's'}`))
  }

  /**
   * Render one session event.
   * @param event - the `SessionEvent` envelope from `session.event`.
   * @returns nothing.
   */
  handleEvent(event) {
    if (event === null || typeof event !== 'object') return
    const { type, data } = event

    if (this.#verbose) {
      this.write(style.gray(`  · ${type} · ${truncateOneLine(JSON.stringify(data ?? {}), 160)}`))
    }

    switch (type) {
      case 'turn/start': {
        this.#currentTurn = data?.turn ?? 0
        this.#turnStartedAt = Date.now()
        this.write('')
        this.rule(style.bold(`turn ${this.#currentTurn}`))
        this.startSpinner(`turn ${this.#currentTurn}`)
        break
      }
      case 'step/start': {
        this.#currentStep = data?.step ?? 0
        break
      }
      case 'step/end':
        break
      case 'user/message': {
        const source = data?.source?.kind
        if (source === 'user') break
        const text = contentText(data?.content)
        if (text === '') break
        this.write(style.gray(`  ⓘ injected context (${source ?? 'unknown'}, ${text.length} chars)`))
        break
      }
      case 'session/title': {
        if (typeof data?.title === 'string' && data.title !== '') {
          this.#sessionTitles.set(event.seq, data.title)
        }
        break
      }
      case 'assistant/message': {
        const message = data?.message
        if (this.#showReasoning) {
          const reasoning = reasoningText(message?.content)
          if (reasoning.trim() !== '') {
            this.write(style.gray(style.italic('  ✻ reasoning')))
            this.block(reasoning, { indent: '    ', paint: style.gray, budget: REASONING_BUDGET, maxLines: 14 })
          }
        }
        const text = contentText(
          Array.isArray(message?.content)
            ? message.content.filter((block) => block?.type === 'text')
            : message?.content,
        )
        this.assistantText(text)
        const usage = data?.usage
        if (usage !== undefined && this.#verbose) {
          this.write(style.gray(`  · usage in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'}`))
        }
        break
      }
      case 'tool/call': {
        const name = data?.name ?? 'tool'
        this.#toolNames.set(data?.callId, name)
        const summary = summarizeToolArguments(name, data?.arguments)
        this.write(`${style.brightYellow('  ⏺')} ${style.bold(name)}${summary === '' ? '' : style.gray(`(${summary})`)}`)
        break
      }
      case 'tool/result': {
        // A tool result is a user-role message whose single block wraps the
        // tool's own content blocks.
        const block = data?.message?.content?.[0]
        const callId = block?.toolCallId ?? data?.message?.source?.callId
        const name = this.#toolNames.get(callId) ?? 'tool'
        const text = contentText(block?.content)
        const isError = data?.error !== undefined || block?.isError === true
        const label = isError
          ? style.red(`  ⎿ ${data?.error?.name ?? name} failed${data?.error?.code ? ` (${data.error.code})` : ''}`)
          : style.gray('  ⎿ result')
        this.write(label)
        if (text.trim() !== '') {
          this.block(text, { indent: '    ', paint: isError ? style.red : style.gray })
        }
        break
      }
      case 'turn/end': {
        this.stopSpinner()
        const reason = data?.reason?.kind ?? 'unknown'
        const seconds = this.#turnStartedAt === 0 ? undefined : ((Date.now() - this.#turnStartedAt) / 1000).toFixed(1)
        const suffix = seconds === undefined ? '' : style.gray(` · ${seconds}s`)
        const rendered = {
          completed: style.green('✓ completed'),
          aborted: style.yellow('■ aborted'),
          blocked: style.yellow('■ blocked'),
          'max-tokens': style.yellow('■ hit the output-token ceiling'),
          interrupted: style.yellow('■ interrupted'),
          error: style.red(`✗ error: ${data?.reason?.error?.message ?? 'unknown'}`),
        }[reason] ?? style.yellow(`■ ${reason}`)
        this.rule(rendered + suffix)
        this.write('')
        break
      }
      case 'dshcli/subagent-started': {
        this.write(style.magenta(`  ⇢ subagent ${String(data?.childSessionId ?? '').slice(0, 12)} started`))
        break
      }
      case 'dshcli/subagent-finished': {
        const tone = data?.status === 'ok' ? style.magenta : style.red
        this.write(tone(`  ⇠ subagent ${String(data?.childSessionId ?? '').slice(0, 12)} finished (${data?.status ?? '?'})`))
        break
      }
      case 'session/end-seed':
      case 'request/header':
      case 'request/context':
      case 'system/message':
      case 'assistant/attempt':
        break
      default:
        if (this.#verbose) this.write(style.gray(`  · unrendered event ${type}`))
        break
    }
  }
}
