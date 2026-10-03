const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 of the UTF-8 bytes. Hermes has no Buffer; TextEncoder gives the bytes. */
export function base64(source: string): string {
  const bytes = new TextEncoder().encode(source)
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = index + 1 < bytes.length ? bytes[index + 1] : null
    const third = index + 2 < bytes.length ? bytes[index + 2] : null
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    chunks.push(
      BASE64_ALPHABET[triple >> 18]
      + BASE64_ALPHABET[(triple >> 12) & 63]
      + (second === null ? '=' : BASE64_ALPHABET[(triple >> 6) & 63])
      + (third === null ? '=' : BASE64_ALPHABET[triple & 63]),
    )
  }
  return chunks.join('')
}
