import AVFoundation
import ExpoModulesCore
import UIKit

public final class AgentsDockNativeVideoModule: Module {
  private let thumbnailRequests = VideoThumbnailRequests()

  public func definition() -> ModuleDefinition {
    Name("AgentsDockNativeVideo")

    // One still frame for a timeline tile, read straight from the remote file
    // with AVAssetImageGenerator: no AVPlayer, no player item, no rendering
    // surface. Same frame and size limit as Android's expo-video thumbnail
    // (min(0.5 s, 5% of the duration), at most 320x180 pixels).
    AsyncFunction("generateThumbnailAsync") { (requestId: String, uri: String, headers: [String: String]) async throws -> String in
      guard let url = URL(string: uri), url.scheme == "http" || url.scheme == "https" else {
        throw Exception(name: "InvalidThumbnailSource", description: "The video thumbnail source must be an http(s) URL.")
      }
      let asset = AVURLAsset(url: url, options: headers.isEmpty ? nil : ["AVURLAssetHTTPHeaderFieldsKey": headers])
      let generator = AVAssetImageGenerator(asset: asset)
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: 320, height: 180)
      generator.requestedTimeToleranceBefore = .zero
      generator.requestedTimeToleranceAfter = .zero
      guard thumbnailRequests.begin(requestId, asset: asset, generator: generator) else {
        throw Exception(name: "ThumbnailCancelled", description: "The video thumbnail request was cancelled.")
      }
      defer { thumbnailRequests.end(requestId) }

      let duration = try await asset.load(.duration).seconds
      let seconds = min(0.5, max(0, duration.isFinite ? duration * 0.05 : 0))
      let frame = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600)).image
      guard let jpeg = UIImage(cgImage: frame).jpegData(compressionQuality: 0.9) else {
        throw Exception(name: "ThumbnailEncodingFailed", description: "The video thumbnail could not be encoded.")
      }
      return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
    }

    Function("cancelThumbnail") { (requestId: String) in
      self.thumbnailRequests.cancel(requestId)
    }

    View(AgentsDockNativeVideoView.self) {
      Events("onStatus")

      Prop("sourceURI") { (view: AgentsDockNativeVideoView, sourceURI: String) in
        view.setSourceURI(sourceURI)
      }

      Prop("autoplay") { (view: AgentsDockNativeVideoView, autoplay: Bool?) in
        view.setAutoplay(autoplay ?? true)
      }

      Prop("contentFit") { (view: AgentsDockNativeVideoView, contentFit: String?) in
        view.setContentFit(contentFit ?? "contain")
      }

      AsyncFunction("play") { (view: AgentsDockNativeVideoView) in
        view.play()
      }.runOnQueue(.main)

      AsyncFunction("pause") { (view: AgentsDockNativeVideoView) in
        view.pause()
      }.runOnQueue(.main)
    }
  }
}

/// In-flight thumbnail requests keyed by the id JavaScript chose, so an
/// unmounted tile can stop the asset's network reads.
private final class VideoThumbnailRequests: @unchecked Sendable {
  private let lock = NSLock()
  private var active: [String: (asset: AVURLAsset, generator: AVAssetImageGenerator)] = [:]
  // load-bearing: JS may cancel before the async body registers the request.
  private var cancelledBeforeStart: Set<String> = []

  func begin(_ id: String, asset: AVURLAsset, generator: AVAssetImageGenerator) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if cancelledBeforeStart.remove(id) != nil { return false }
    active[id] = (asset, generator)
    return true
  }

  func end(_ id: String) {
    lock.lock()
    active[id] = nil
    lock.unlock()
  }

  func cancel(_ id: String) {
    lock.lock()
    let request = active.removeValue(forKey: id)
    if request == nil { cancelledBeforeStart.insert(id) }
    lock.unlock()
    request?.generator.cancelAllCGImageGeneration()
    request?.asset.cancelLoading()
  }
}
