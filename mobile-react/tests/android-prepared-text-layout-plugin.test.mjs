import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { applyAndroidPreparedTextLayout, MARKER } = require('../plugins/withAndroidPreparedTextLayout.cjs')

const generatedMainApplication = `package com.zhengyiluo.agentsdock

import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint

class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }
}
`

test('the flag is forced right after the entry point applied the stable set, once', () => {
  const result = applyAndroidPreparedTextLayout(generatedMainApplication)
  assert.match(result, /loadReactNative\(this\)\n[^\n]*withAndroidPreparedTextLayout[\s\S]*?check\(DefaultNewArchitectureEntryPoint\.releaseLevel == ReleaseLevel\.STABLE\)[\s\S]*?dangerouslyForceOverride\(object : ReactNativeNewArchitectureFeatureFlagsDefaults\(\) \{\n\s*override fun enablePreparedTextLayout\(\): Boolean = true/)
  assert.match(result, /import com\.facebook\.react\.internal\.featureflags\.ReactNativeFeatureFlags\n/)
  assert.ok(result.indexOf('dangerouslyForceOverride') < result.indexOf('ApplicationLifecycleDispatcher'), 'before any React host or view manager is created')
  assert.equal(applyAndroidPreparedTextLayout(result), result, 'prebuild reruns are idempotent')
  assert.equal(result.split(MARKER).length - 1, 1)
})

test('an unexpected MainApplication fails prebuild instead of shipping without the flag', () => {
  assert.throws(() => applyAndroidPreparedTextLayout('class MainApplication {}'), /loadReactNative/)
})

test('the plugin is registered for Android builds', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'))
  assert.ok(app.expo.plugins.includes('./plugins/withAndroidPreparedTextLayout.cjs'))
})
