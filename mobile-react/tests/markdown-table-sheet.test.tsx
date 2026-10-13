import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Text } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { MarkdownTableSheet } from '../src/components/MarkdownTableSheet'
import { clipboardWrites } from './mocks/expo-clipboard'

test('the expanded table sheet copies the table as Markdown and confirms the tap', async () => {
  const markdown = '| Name | Note |\n|:-----|-----:|\n| **Alpha** | `a \\| b` |'
  let tree!: ReactTestRenderer
  await act(async () => { tree = create(<MarkdownTableSheet markdown={markdown} onClose={() => {}}><Text>rendered table</Text></MarkdownTableSheet>) })
  const copy = () => tree.root.find(node => typeof node.type === 'string' && node.props.testID === 'markdown-table-copy')
  assert.equal(copy().props.accessibilityLabel, 'Copy as Markdown')
  await act(async () => { copy().props.onPress() })
  assert.deepEqual(clipboardWrites, [markdown])
  assert.equal(copy().props.accessibilityLabel, 'Copied')
  await act(async () => { tree.unmount() })
})
