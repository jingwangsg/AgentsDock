export function setNotificationHandler(): void {}
let permissionRequests = 0
export async function requestPermissionsAsync(): Promise<{ status: string }> { permissionRequests += 1; return { status: 'granted' } }
export function __notificationPermissionRequests(): number { return permissionRequests }
export function __resetNotifications(): void { permissionRequests = 0 }
export async function setBadgeCountAsync(): Promise<boolean> { return true }
const scheduledNotifications: Array<{ title?: string; body?: string }> = []
export async function scheduleNotificationAsync(request?: { content?: { title?: string; body?: string } }): Promise<string> {
  scheduledNotifications.push({ title: request?.content?.title, body: request?.content?.body })
  return 'mock-notification'
}
export function __scheduledNotifications(): Array<{ title?: string; body?: string }> { return scheduledNotifications }
export function addNotificationResponseReceivedListener(): { remove(): void } { return { remove() {} } }
export async function getLastNotificationResponseAsync(): Promise<null> { return null }
