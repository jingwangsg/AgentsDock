const { withPodfile } = require('expo/config-plugins')

const MARKER = '# agentsdock: raise pod deployment targets'

/**
 * Xcode 27 rejects any target below iOS 15. A few pods still declare older targets for their
 * resource bundles (RNCAsyncStorage 13.4, RNSVGFilters 12.4), which fails the whole build.
 * Raise those targets to the app's own deployment target after React Native's post_install.
 */
module.exports = function withIosPodDeploymentTarget(config) {
  return withPodfile(config, next => {
    if (next.modResults.contents.includes(MARKER)) return next
    const anchor = /( *)react_native_post_install\(([\s\S]*?)\n\1\)\n/
    const match = next.modResults.contents.match(anchor)
    if (!match) throw new Error('withIosPodDeploymentTarget: react_native_post_install not found in Podfile')
    const indent = match[1]
    const block = [
      `${indent}${MARKER}`,
      `${indent}minimum = podfile_properties['ios.deploymentTarget'] || '16.4'`,
      `${indent}installer.pods_project.targets.each do |target|`,
      `${indent}  target.build_configurations.each do |build_configuration|`,
      `${indent}    current = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']`,
      `${indent}    if current && Gem::Version.new(current) < Gem::Version.new(minimum)`,
      `${indent}      build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum`,
      `${indent}    end`,
      `${indent}  end`,
      `${indent}end`,
      '',
    ].join('\n')
    next.modResults.contents = next.modResults.contents.replace(anchor, `${match[0]}${block}`)
    return next
  })
}
