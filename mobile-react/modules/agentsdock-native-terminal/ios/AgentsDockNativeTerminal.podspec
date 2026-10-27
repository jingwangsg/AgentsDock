require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'AgentsDockNativeTerminal'
  s.version          = package['version']
  s.summary          = 'App-wide keyboard dismissal for AgentsDock.'
  s.description      = 'Ends text editing in every window when AgentsDock leaves the foreground, so no keyboard comes back on return.'
  s.license          = package['license']
  s.author           = 'AgentsDock'
  s.homepage         = 'https://github.com/ZhengyiLuo/ZenithDock'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
