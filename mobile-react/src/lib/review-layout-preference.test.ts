import assert from 'node:assert/strict'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { REVIEW_SIDE_BY_SIDE_STORAGE_KEY, readReviewLayout, writeReviewLayout } from './review-layout-preference'

assert.deepEqual(await readReviewLayout(), { sideBySide: null, wordWrap: false }, 'fresh install has no layout choice and no wrapping')
await writeReviewLayout({ sideBySide: false })
assert.deepEqual(await readReviewLayout(), { sideBySide: false, wordWrap: false }, 'an inline choice survives a re-read and leaves wrap alone')
await writeReviewLayout({ wordWrap: true })
assert.deepEqual(await readReviewLayout(), { sideBySide: false, wordWrap: true }, 'wrap persists independently of the layout choice')
await writeReviewLayout({ sideBySide: true, wordWrap: false })
assert.deepEqual(await readReviewLayout(), { sideBySide: true, wordWrap: false }, 'both keys update together')
await AsyncStorage.setItem(REVIEW_SIDE_BY_SIDE_STORAGE_KEY, 'garbage')
assert.deepEqual(await readReviewLayout(), { sideBySide: null, wordWrap: false }, 'an unrecognised stored layout falls back to the width default')

console.log('review layout preference persistence passed')
