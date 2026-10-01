import assert from 'node:assert/strict'
import { isImageUpload, photoAssetsToUploads, uploadRequestTimeoutMs } from './uploads'

const uploads = photoAssetsToUploads([
  { uri: 'file:///picker/IMG_0042.HEIC', fileName: 'Vacation.heic', mimeType: 'image/heic', fileSize: 4_200_000 },
  { uri: 'file:///picker/render', mimeType: 'image/png' },
  { uri: 'file:///picker/no-name.webp?token=local' },
  { uri: '   ' },
], 1234)

assert.equal(JSON.stringify(uploads), JSON.stringify([
  { uri: 'file:///picker/IMG_0042.HEIC', name: 'Vacation.heic', type: 'image/heic', size: 4_200_000 },
  { uri: 'file:///picker/render', name: 'photo-1234-2.png', type: 'image/png' },
  { uri: 'file:///picker/no-name.webp?token=local', name: 'photo-1234-3.webp' },
]))

assert.equal(isImageUpload({ uri: 'file:///picker/render', name: 'render', type: 'image/png' }), true)
assert.equal(isImageUpload({ uri: 'file:///picker/IMG_0042.HEIC', name: 'Vacation.heic' }), true)
assert.equal(isImageUpload({ uri: 'file:///picker/photo', name: 'photo.TIFF?ignored' }), true)
assert.equal(isImageUpload({ uri: 'file:///picker/photo.webp?token=local', name: '', type: undefined }), true)
assert.equal(isImageUpload({ uri: 'file:///picker/report.pdf', name: 'report.pdf', type: 'application/pdf' }), false)

// A phone photo gets the five-minute floor; a huge file scales at 1 MiB/s plus overhead; unknown sizes get the floor.
assert.equal(uploadRequestTimeoutMs(858_000), 5 * 60_000)
assert.equal(uploadRequestTimeoutMs(25 * 1024 * 1024 * 1024), (2 * 60 + 25 * 1024) * 1_000)
assert.equal(uploadRequestTimeoutMs(undefined), 5 * 60_000)
assert.equal(uploadRequestTimeoutMs(64 * 1024 ** 3), 8 * 60 * 60_000)

console.log('photo upload mapping regressions passed')
