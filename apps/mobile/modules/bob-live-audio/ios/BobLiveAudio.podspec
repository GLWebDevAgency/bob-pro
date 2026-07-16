Pod::Spec.new do |s|
  s.name           = 'BobLiveAudio'
  s.version        = '0.1.0'
  s.summary        = 'Private low-latency PCM capture for Bob Live'
  s.description    = 'In-memory voice capture with platform voice processing for Bob Live.'
  s.author         = 'Bob Pro'
  s.homepage       = 'https://bob-pro.fr'
  s.platforms      = {
    :ios => '15.1'
  }
  s.license        = { :type => 'MIT', :file => '../LICENSE' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
