// react-native-draggable-flatlist for component tests: rows render in data order; tests drive onDragEnd.
import React from 'react'
import { ScrollView, View } from './react-native'

export const ScaleDecorator = ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children)
export const NestableScrollContainer = (props: Record<string, unknown>) => React.createElement(ScrollView, props)
/** Props of every rendered list, newest last. */
export const lists: Array<Record<string, any>> = []
export function NestableDraggableFlatList(props: Record<string, any>) {
  lists.push(props)
  return React.createElement(View, { testID: 'draggable-list' }, props.data.map((item: unknown, index: number) =>
    React.createElement(React.Fragment, { key: props.keyExtractor(item, index) }, props.renderItem({ item, drag: () => {}, isActive: false, getIndex: () => index }))))
}
export default NestableDraggableFlatList
