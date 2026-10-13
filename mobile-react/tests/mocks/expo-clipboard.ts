export const clipboardWrites: string[] = []
export async function setStringAsync(value: string): Promise<boolean> { clipboardWrites.push(value); return true }
