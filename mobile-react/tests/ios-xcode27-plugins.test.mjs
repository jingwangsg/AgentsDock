import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const withIosPodDeploymentTarget = require('../plugins/withIosPodDeploymentTarget.cjs')
const withIosSceneLifecycle = require('../plugins/withIosSceneLifecycle.cjs')

// The files `expo prebuild` starts from, taken from the installed Expo's template: an Expo upgrade
// that changes them fails here instead of in a native build.
const template = file => execFileSync('tar', ['-xzOf', require.resolve('expo/template.tgz'), `package/ios/${file}`], { encoding: 'utf8' })

async function runMod(plugin, mod, modResults) {
  const config = plugin({ name: 'AgentsDock', slug: 'agentsdock' })
  const result = await config.mods.ios[mod]({ ...config, modRequest: {}, modResults })
  return result.modResults
}

test('the Podfile raises every pod target below the app deployment target after react_native_post_install, once', async () => {
  const podfile = template('Podfile')
  const contents = (await runMod(withIosPodDeploymentTarget, 'podfile', { contents: podfile })).contents
  assert.match(contents, /\n( {4})react_native_post_install\([\s\S]*?\n\1\)\n\1# agentsdock: raise pod deployment targets\n\1minimum = podfile_properties\['ios\.deploymentTarget'\] \|\| '16\.4'\n\1installer\.pods_project\.targets\.each do \|target\|\n/)
  assert.match(contents, /if current && Gem::Version\.new\(current\) < Gem::Version\.new\(minimum\)\n\s*build_configuration\.build_settings\['IPHONEOS_DEPLOYMENT_TARGET'\] = minimum/)
  assert.equal(contents.replace(/ {4}# agentsdock: raise pod deployment targets\n[\s\S]*?\n {4}end\n/, ''), podfile, 'nothing else changes')
  assert.equal((await runMod(withIosPodDeploymentTarget, 'podfile', { contents })).contents, contents, 'prebuild reruns are idempotent')
  await assert.rejects(runMod(withIosPodDeploymentTarget, 'podfile', { contents: 'post_install do |installer|\nend\n' }), /react_native_post_install not found/)
})

test('the app adopts the scene life cycle: the Info.plist names SceneDelegate, which starts React Native', async () => {
  const plist = await runMod(withIosSceneLifecycle, 'infoPlist', {})
  assert.deepEqual(plist.UIApplicationSceneManifest, {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: { UIWindowSceneSessionRoleApplication: [{ UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate' }] },
  })

  const appDelegate = template('HelloWorld/AppDelegate.swift')
  const contents = (await runMod(withIosSceneLifecycle, 'appDelegate', { contents: appDelegate, language: 'swift' })).contents
  assert.doesNotMatch(contents, /window = UIWindow\(frame: UIScreen\.main\.bounds\)/, 'the app delegate no longer creates the window')
  assert.match(contents, /\n {4}\/\/ SceneDelegate creates the window and starts React Native\.\n/)
  assert.match(contents, /@objc\(SceneDelegate\)\nclass SceneDelegate: UIResponder, UIWindowSceneDelegate \{/)
  assert.match(contents, /let window = UIWindow\(windowScene: windowScene\)[\s\S]*?factory\.startReactNative\(withModuleName: "main", in: window, launchOptions: launchOptions\)/)
  for (const forwarded of ['applicationDidBecomeActive', 'applicationWillResignActive', 'applicationWillEnterForeground', 'applicationDidEnterBackground', 'open: context.url', 'continue: userActivity']) {
    assert.ok(contents.includes(forwarded), `SceneDelegate passes on ${forwarded}`)
  }
  assert.equal((await runMod(withIosSceneLifecycle, 'appDelegate', { contents, language: 'swift' })).contents, contents, 'prebuild reruns are idempotent')
  await assert.rejects(runMod(withIosSceneLifecycle, 'appDelegate', { contents: appDelegate, language: 'objcpp' }), /expected a Swift AppDelegate/)
  await assert.rejects(runMod(withIosSceneLifecycle, 'appDelegate', { contents: 'class AppDelegate {}', language: 'swift' }), /window setup not found/)
})

test('both Xcode 27 plugins are registered', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'))
  assert.ok(app.expo.plugins.includes('./plugins/withIosPodDeploymentTarget.cjs'))
  assert.ok(app.expo.plugins.includes('./plugins/withIosSceneLifecycle.cjs'))
})
