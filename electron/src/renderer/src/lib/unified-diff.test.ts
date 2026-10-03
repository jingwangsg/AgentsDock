import { describe, expect, it } from 'vitest'
import { parseReviewableDiff, parseUnifiedDiff, reviewTargetBelongsToSession, sameCodeReviewTarget } from './unified-diff'

describe('parseUnifiedDiff', () => {
  it('counts additions and deletions while retaining line numbers', () => {
    const files = parseUnifiedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 1 })
    expect(files[0].lines.some(line => line.kind === 'add' && line.newLine === 1)).toBe(true)
  })

  it('does not present git status output as a line-level code review', () => {
    const source = [
      ' M robot/rl/scripts/sim2sim/run_eval.py',
      '?? robot/rl/scripts/sim2sim/configs/new.yaml'
    ].join('\n')

    expect(parseUnifiedDiff(source)).toHaveLength(2)
    expect(parseReviewableDiff(source)).toEqual([])
  })

  it('retains complete git patches for the code review workspace', () => {
    const source = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new'
    expect(parseReviewableDiff(source)).toMatchObject([{ path: 'a.ts', additions: 1, deletions: 1 }])
  })

  it('parses every file and hunk in a complete Git patch without advancing metadata lines', () => {
    const files = parseUnifiedDiff([
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,2 +10,3 @@',
      ' same',
      '-old',
      '+new',
      '+extra',
      'diff --git a/b.ts b/b.ts',
      'index 3333333..4444444 100644',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -40 +40 @@',
      '-before',
      '+after'
    ].join('\n'))

    expect(files.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions }))).toEqual([
      { path: 'a.ts', additions: 2, deletions: 1 },
      { path: 'b.ts', additions: 1, deletions: 1 }
    ])
    expect(files[0].lines.find(line => line.kind === 'context')).toMatchObject({ oldLine: 10, newLine: 10 })
    expect(files[1].lines.find(line => line.kind === 'remove')).toMatchObject({ oldLine: 40 })
  })
})

describe('reviewTargetBelongsToSession', () => {
  it('accepts only the currently selected chat as the owner of a review', () => {
    expect(reviewTargetBelongsToSession({ sessionId: 'chat-1', runId: 'run-1' }, 'chat-1')).toBe(true)
    expect(reviewTargetBelongsToSession({ sessionId: 'chat-1', runId: 'run-1' }, 'chat-2')).toBe(false)
    expect(reviewTargetBelongsToSession(null, 'chat-1')).toBe(false)
  })
})

describe('sameCodeReviewTarget', () => {
  it('matches the same provider run so its Review button can toggle the dock', () => {
    expect(sameCodeReviewTarget(
      { sessionId: 'chat-1', runId: 'run-1' },
      { sessionId: 'chat-1', runId: 'run-1', additions: 3 }
    )).toBe(true)
    expect(sameCodeReviewTarget(
      { sessionId: 'chat-1', runId: 'run-1' },
      { sessionId: 'chat-1', runId: 'run-2' }
    )).toBe(false)
  })

  it('matches legacy inline reviews by their complete diff', () => {
    expect(sameCodeReviewTarget(
      { sessionId: 'chat-1', source: 'diff --git a/a b/a' },
      { sessionId: 'chat-1', source: 'diff --git a/a b/a' }
    )).toBe(true)
    expect(sameCodeReviewTarget(
      { sessionId: 'chat-1', source: 'diff --git a/a b/a' },
      { sessionId: 'chat-2', source: 'diff --git a/a b/a' }
    )).toBe(false)
  })
})
