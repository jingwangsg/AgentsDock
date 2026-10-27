import { RefreshControl, ScrollView, type ScrollViewProps } from 'react-native'

export type RefreshScrollViewProps = ScrollViewProps & { refreshing: boolean; onRefresh: () => void }

/** A ScrollView with pull-to-refresh: Android's SwipeRefreshLayout here, an app-drawn copy on iOS. */
export function RefreshScrollView({ refreshing, onRefresh, ...props }: RefreshScrollViewProps) {
  return <ScrollView {...props} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} />
}
