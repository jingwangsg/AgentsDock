require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'AgentsDockBrowserLoopback'
  s.version          = package['version']
  s.summary          = 'Routes AgentsDock browser tabs through the selected server.'
  s.description      = 'A per-tab SOCKS5 listener on 127.0.0.1 that carries each web view connection over the server port tunnel.'
  s.license          = package['license']
  s.author           = 'AgentsDock'
  s.homepage         = 'https://github.com/ZhengyiLuo/AgentsDock'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WebKit', 'Network'
  # Top level only: Tests/ is a macOS test program, not part of the app.
  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
