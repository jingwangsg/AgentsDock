import 'react-native-gesture-handler'
import { useEffect, useLayoutEffect } from 'react'
import { Appearance, useColorScheme } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { AppTypographyProvider } from './src/components/AppText'
import { AppShell } from './src/components/AppShell'
import { trackEvent } from './src/lib/analytics'
import { useAppStore } from './src/store/useAppStore'
import { ColorSchemeProvider, dark, light } from './src/theme'

export default function App() {
  const appearance = useAppStore(state => state.appearance)
  const systemScheme = useColorScheme()
  const scheme = appearance === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : appearance
  const colors = scheme === 'light' ? light : dark
  // Native UI (alerts, menus, keyboard, window background) follows the same choice.
  useLayoutEffect(() => {
    Appearance.setColorScheme(appearance === 'system' ? 'unspecified' : appearance)
  }, [appearance])
  useEffect(() => {
    trackEvent('app_launched')
  }, [])
  return (
    <ColorSchemeProvider value={scheme}>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
        <KeyboardProvider preload={false}>
          <AppTypographyProvider>
            <SafeAreaProvider>
              <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'left', 'right']}>
                <AppShell />
              </SafeAreaView>
              <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
            </SafeAreaProvider>
          </AppTypographyProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </ColorSchemeProvider>
  )
}
