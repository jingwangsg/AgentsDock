import { describe, expect, it } from 'vitest'
import { trailingSequencesStart } from './terminal-replay'

describe('trailingSequencesStart', () => {
  const fishProbe = '\x1b[?u\x1b[>0q\x1b]11;?\x1b\\\x1b[?1049h\x1bP+q696e646e\x1b\\\x1b[?1049l\x1b[0c'

  it('takes a new shell’s whole startup probe as still waiting', () => {
    expect(trailingSequencesStart(fishProbe)).toBe(0)
    expect(trailingSequencesStart(`hello\r\n${fishProbe}`)).toBe(7)
  })

  it('ends at the last output, so queries that more output followed were answered', () => {
    expect(trailingSequencesStart(`${fishProbe}\r\n❮ `)).toBe(fishProbe.length + 4)
    expect(trailingSequencesStart('a\x1b[c b\x1b[0m\x1b]0;title\x07')).toBe(6)
    expect(trailingSequencesStart('')).toBe(0)
  })
})
