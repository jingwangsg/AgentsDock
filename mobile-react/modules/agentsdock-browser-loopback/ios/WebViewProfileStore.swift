import CryptoKit
import Foundation

/// The identifier of the persistent WKWebsiteDataStore a web view profile names.
/// load-bearing: patches/react-native-webview@13.16.1.patch (RNCWebViewProfileIdentifier) derives the
/// same UUID for the tab's web view; a mismatch leaves that web view on a store without this proxy.
/// Vector: "agentsdock-browser-default-browser_1a2b3c" -> C82A50EC-B270-8AAE-B642-7E9F0C459051.
func profileStoreIdentifier(_ profile: String) -> UUID {
  var b = Array(SHA256.hash(data: Data(profile.utf8)).prefix(16))
  b[6] = (b[6] & 0x0F) | 0x80 // RFC 9562 version 8
  b[8] = (b[8] & 0x3F) | 0x80 // RFC 9562 variant
  return UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
}
