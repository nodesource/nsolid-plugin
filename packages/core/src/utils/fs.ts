import { mkdirSync } from 'node:fs'
import writeFileAtomic from 'write-file-atomic'

export async function atomicWrite (filePath: string, content: string): Promise<void> {
  await writeFileAtomic(filePath, content)
}

export function atomicWriteSync (filePath: string, content: string): void {
  writeFileAtomic.sync(filePath, content)
}

export function ensureDir (dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

export async function writeJsonFile (filePath: string, data: unknown): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2) + '\n')
}

export function writeJsonFileSync (filePath: string, data: unknown): void {
  atomicWriteSync(filePath, JSON.stringify(data, null, 2) + '\n')
}
