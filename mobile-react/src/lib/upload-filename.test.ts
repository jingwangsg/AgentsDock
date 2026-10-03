import { utf8FilenameDisposition } from './upload-filename'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const encoded = encodeURIComponent('截图 "测试".jpg')
assert(
  utf8FilenameDisposition(`form-data; name="file"; filename="${encoded}"`)
    === `form-data; name="file"; filename="截图 %22测试%22.jpg"; filename*=UTF-8''${encoded}`,
  'the quoted filename carries the UTF-8 name and filename* carries the encoded one',
)
assert(
  utf8FilenameDisposition('form-data; name="file"; filename="plain.txt"')
    === `form-data; name="file"; filename="plain.txt"; filename*=UTF-8''plain.txt`,
  'an ASCII name is unchanged in the quoted form',
)
assert(
  utf8FilenameDisposition('form-data; name="file"; filename="%E6%ZZ.txt"') === 'form-data; name="file"; filename="%E6%ZZ.txt"',
  'an undecodable name is left as React Native wrote it',
)
assert(utf8FilenameDisposition('form-data; name="field"') === 'form-data; name="field"', 'a text part has no filename to rewrite')
console.log('upload filename header passed')
