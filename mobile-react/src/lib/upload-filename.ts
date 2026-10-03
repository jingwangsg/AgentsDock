/**
 * React Native's FormData percent-encodes a part's filename (encodeURIComponent)
 * into `filename="…"`, so a server that reads it literally stores 截图.jpg as
 * `%E6%88%AA%E5%9B%BE.jpg`. Rewrite the header the way browsers send it: the
 * UTF-8 name in the quoted form, escaping only quotes and line breaks, plus the
 * RFC 5987 `filename*` for servers that prefer it.
 */
export function utf8FilenameDisposition(contentDisposition: string): string {
  return contentDisposition.replace(/; filename="([^"]*)"$/, (match, encoded: string) => {
    let name: string
    try {
      name = decodeURIComponent(encoded)
    } catch {
      return match
    }
    const quoted = name.replaceAll('\r', '%0D').replaceAll('\n', '%0A').replaceAll('"', '%22')
    return `; filename="${quoted}"; filename*=UTF-8''${encoded}`
  })
}

type FormDataPart = { string?: string; uri?: string; headers: Record<string, string>; fieldName: string }

/** A FormData whose file parts carry their UTF-8 filename; see utf8FilenameDisposition. */
export class Utf8FilenameFormData extends FormData {
  getParts(): Array<FormDataPart> {
    // React Native's FormData defines getParts; the DOM typings do not know it.
    const parts = (FormData.prototype as unknown as { getParts: () => Array<FormDataPart> }).getParts.call(this)
    return parts.map(part => {
      const disposition = part.headers['content-disposition']
      return disposition ? { ...part, headers: { ...part.headers, 'content-disposition': utf8FilenameDisposition(disposition) } } : part
    })
  }
}
