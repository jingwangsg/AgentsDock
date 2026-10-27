const { withAppDelegate, withInfoPlist } = require('expo/config-plugins')

// The iOS 27 SDK terminates an app at launch unless it adopts the scene life cycle
// (UIKit traps in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption). Expo 57's template
// still creates the window in the app delegate; Expo 58 moved it to ExpoAppSceneDelegate. This
// backports the part of that delegate this app uses. Delete it with the upgrade to Expo 58.

const WINDOW_START = /\n#if os\(iOS\) \|\| os\(tvOS\)\n {4}window = UIWindow\(frame: UIScreen\.main\.bounds\)\n {4}factory\.startReactNative\(\n {6}withModuleName: "main",\n {6}in: window,\n {6}launchOptions: launchOptions\)\n#endif\n/

const SCENE_DELEGATE = `
// Creates the window and starts React Native under the scene life cycle. UIKit no longer calls the
// app delegate's life-cycle, URL and user-activity methods, so each is passed on to it: ExpoAppDelegate
// hands them to the Expo subscribers, and the URL methods reach RCTLinkingManager.
@objc(SceneDelegate)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene, let appDelegate, let factory = appDelegate.reactNativeFactory else {
      return
    }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    // Linking.getInitialURL() reads the URL from the launch options, which a scene app no longer gets.
    let launchOptions = connectionOptions.urlContexts.first.map {
      [UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey"): $0.url as Any]
    }
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      _ = appDelegate?.application(UIApplication.shared, open: context.url)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = appDelegate?.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`

module.exports = function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, next => {
    next.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
        }],
      },
    }
    return next
  })
  return withAppDelegate(config, next => {
    if (next.modResults.language !== 'swift') throw new Error('withIosSceneLifecycle: expected a Swift AppDelegate')
    const contents = next.modResults.contents
    if (contents.includes('class SceneDelegate')) return next
    if (!WINDOW_START.test(contents)) throw new Error('withIosSceneLifecycle: AppDelegate window setup not found; check the Expo template')
    next.modResults.contents = contents.replace(WINDOW_START, '\n    // SceneDelegate creates the window and starts React Native.\n') + SCENE_DELEGATE
    return next
  })
}
