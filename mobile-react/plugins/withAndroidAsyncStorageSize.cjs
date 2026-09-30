const { withGradleProperties } = require('expo/config-plugins')

const KEY = 'AsyncStorage_db_size_in_MB'

/**
 * AsyncStorage on Android is one SQLite database capped at 6 MB by default. The
 * chat snapshot cache (up to 80 chats per server) outgrows it, and then every
 * write fails with SQLITE_FULL, including the one that switches servers.
 * storage/cache.ts still drops the snapshots if this larger cap fills.
 */
module.exports = function withAndroidAsyncStorageSize(config) {
  return withGradleProperties(config, next => {
    next.modResults = next.modResults.filter(item => item.type !== 'property' || item.key !== KEY)
    next.modResults.push({ type: 'property', key: KEY, value: '64' })
    return next
  })
}
