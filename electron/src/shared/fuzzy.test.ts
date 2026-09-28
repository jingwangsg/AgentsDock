import { describe, expect, it } from 'vitest'
import { fuzzyScore } from './fuzzy'

const score = (query: string, text: string) => fuzzyScore(query, text)?.score ?? null

describe('fuzzyScore', () => {
  it('matches when every query character appears in order, case-insensitively', () => {
    expect(fuzzyScore('cdx', 'Codex chat')?.indices).toEqual([0, 2, 4])
    expect(fuzzyScore('CODEX', 'codex')?.indices).toEqual([0, 1, 2, 3, 4])
    expect(fuzzyScore('codex', 'CODEX')).not.toBeNull()
  })

  it('returns null when a character is missing or out of order', () => {
    expect(fuzzyScore('abd', 'abc')).toBeNull()
    expect(fuzzyScore('ba', 'ab')).toBeNull()
    expect(fuzzyScore('a', '')).toBeNull()
  })

  it('treats an empty or whitespace-only query as matching everything without highlights', () => {
    expect(fuzzyScore('', 'anything')).toEqual({ score: 0, indices: [] })
    expect(fuzzyScore('  ', 'anything')).toEqual({ score: 0, indices: [] })
  })

  it('ignores whitespace inside the query so words can span separators', () => {
    expect(fuzzyScore('work a', '/work/a')?.indices).toEqual([1, 2, 3, 4, 6])
  })

  it('scores consecutive matches above word starts above scattered characters', () => {
    expect(score('abc', 'abc')!).toBeGreaterThan(score('abc', 'a-b-c')!)
    expect(score('abc', 'a-b-c')!).toBeGreaterThan(score('abc', 'axbxc')!)
  })

  it('rewards word starts at the text start and after separators', () => {
    expect(score('a', 'a')!).toBeGreaterThan(score('a', 'ba')!)
    expect(score('fb', 'foo bar')!).toBeGreaterThan(score('fb', 'xfxb')!)
    expect(score('wa', '/work/a')!).toBeGreaterThan(score('wa', 'xwxa')!)
  })

  it('counts every CJK character as a word start', () => {
    expect(fuzzyScore('会话', '本机会话')?.indices).toEqual([2, 3])
    expect(score('话', '会话')!).toBeGreaterThan(score('b', 'ab')!)
  })

  it('reports code-point indices so astral characters are not split', () => {
    expect(fuzzyScore('b', 'a😀b')?.indices).toEqual([2])
  })
})
