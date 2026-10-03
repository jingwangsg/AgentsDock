/**
 * A tool's input the way a person would write it, instead of the JSON object
 * the provider sent: a Bash command, a file path with its line range, an Edit
 * as removed and added lines. Any other tool lists its fields one per line.
 * Mirrors the desktop renderer's lib/tool-input.ts.
 */
// Claude and current Codex name the shell tool Bash; older Codex rows say exec.
const SHELL_TOOLS = new Set(['bash', 'exec', 'shell', 'sh', 'zsh', 'commandexecution'])

export function readableToolInput(name: string | undefined, input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return readableValue(input)
  const fields = input as Record<string, unknown>
  const leaf = (name ?? '').split(/[/.]/).pop()?.toLowerCase() ?? ''
  if (SHELL_TOOLS.has(leaf) && typeof fields.command === 'string') {
    const description = typeof fields.description === 'string' ? fields.description.trim() : ''
    return [...(description ? [description] : []), `$ ${fields.command}`, ...fieldLines(fields, ['command', 'description'])].join('\n')
  }
  if (leaf === 'read' && typeof fields.file_path === 'string') {
    const offset = typeof fields.offset === 'number' ? fields.offset : undefined
    const limit = typeof fields.limit === 'number' ? fields.limit : undefined
    const range = offset != null && limit != null ? ` (lines ${offset}-${offset + limit - 1})`
      : offset != null ? ` (from line ${offset})`
        : limit != null ? ` (first ${limit} lines)` : ''
    return [`${fields.file_path}${range}`, ...fieldLines(fields, ['file_path', 'offset', 'limit'])].join('\n')
  }
  if (leaf === 'edit' && typeof fields.file_path === 'string' && typeof fields.old_string === 'string' && typeof fields.new_string === 'string') {
    const header = fields.replace_all === true ? `${fields.file_path} (replace all)` : fields.file_path
    const removed = fields.old_string ? fields.old_string.split('\n').map(line => `- ${line}`) : []
    const added = fields.new_string ? fields.new_string.split('\n').map(line => `+ ${line}`) : []
    return [header, ...removed, ...added, ...fieldLines(fields, ['file_path', 'old_string', 'new_string', 'replace_all'])].join('\n')
  }
  if (leaf === 'write' && typeof fields.file_path === 'string' && typeof fields.content === 'string') {
    return [fields.file_path, '', fields.content, ...fieldLines(fields, ['file_path', 'content'])].join('\n')
  }
  if (leaf === 'apply_patch' && Array.isArray(fields.changes)) {
    const changes = fields.changes.filter((change): change is Record<string, unknown> => Boolean(change) && typeof change === 'object' && !Array.isArray(change))
    if (changes.length && changes.every(change => typeof change.path === 'string' && typeof change.diff === 'string')) {
      return changes.map(change => {
        const kind = change.kind && typeof change.kind === 'object' ? (change.kind as Record<string, unknown>).type : change.kind
        const verb = kind === 'add' ? 'Add' : kind === 'delete' ? 'Delete' : 'Update'
        return `*** ${verb} File: ${change.path}\n${String(change.diff).trimEnd()}`
      }).join('\n\n')
    }
  }
  return readableValue(fields)
}

function fieldLines(fields: Record<string, unknown>, skip: string[]): string[] {
  const rest = Object.fromEntries(Object.entries(fields).filter(([key, value]) => !skip.includes(key) && value !== undefined))
  return Object.keys(rest).length ? [readableValue(rest)] : []
}

/**
 * Nested data as indented `key: value` lines (lists as `- ` items, multi-line
 * text as an indented block), so a tool's input or result never reads as JSON.
 */
export function readableValue(value: unknown, depth = 0): string {
  const pad = '  '.repeat(depth)
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`
    return value.map(item => (item && typeof item === 'object' && !isEmpty(item))
      ? `${pad}- ${readableValue(item, depth + 1).trimStart()}`
      : `${pad}- ${scalar(item).replaceAll('\n', `\n${pad}  `)}`).join('\n')
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return `${pad}{}`
    return entries.map(([key, item]) => {
      if (item && typeof item === 'object') {
        return isEmpty(item) ? `${pad}${key}: ${Array.isArray(item) ? '[]' : '{}'}` : `${pad}${key}:\n${readableValue(item, depth + 1)}`
      }
      if (typeof item === 'string' && item.includes('\n')) return `${pad}${key}:\n${item.split('\n').map(line => `${pad}  ${line}`).join('\n')}`
      return `${pad}${key}: ${scalar(item)}`
    }).join('\n')
  }
  return `${pad}${scalar(value)}`
}

function isEmpty(value: object): boolean {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0
}

function scalar(value: unknown): string {
  return value === null ? 'null' : typeof value === 'string' ? value : String(value)
}

