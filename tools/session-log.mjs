/**
 * Read a DSH session log: a plain JSONL file, or the `.zstd` container written
 * as many concatenated frames (one per appended batch), which Node's
 * `zstdDecompressSync` decodes only as far as its first frame.
 *
 * Frame boundaries are not stored in the container, so they are recovered by
 * scanning for the zstd magic number: frames are start-aligned and each decode
 * is retried against a shrinking tail when the next magic turns out to sit
 * inside a frame payload.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Index every zstd frame start in one buffer.
 * @param buffer - whole file contents.
 * @returns ascending offsets of the magic number.
 */
function frameStarts(buffer) {
  const starts = []
  let offset = buffer.indexOf(MAGIC)
  while (offset >= 0) {
    starts.push(offset)
    offset = buffer.indexOf(MAGIC, offset + MAGIC.length)
  }
  return starts
}

/**
 * Decompress every concatenated zstd frame of one buffer.
 * @param buffer - whole file contents.
 * @returns decoded UTF-8 text of all frames, in order, plus per-frame diagnostics.
 */
export function decodeZstdFrames(buffer) {
  if (buffer.indexOf(MAGIC) !== 0) return { text: buffer.toString('utf8'), frames: 1, skipped: 0 }
  const starts = frameStarts(buffer)
  let text = ''
  let frames = 0
  let skipped = 0
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const next = starts[index + 1] ?? buffer.length
    let window = next - start
    let decoded
    for (;;) {
      try {
        decoded = zstdDecompressSync(buffer.subarray(start, start + window))
        break
      } catch (error) {
        if (window <= 1) {
          decoded = undefined
          break
        }
        window -= 1
      }
    }
    if (decoded === undefined) {
      skipped += 1
      continue
    }
    frames += 1
    text += decoded.toString('utf8')
  }
  return { text, frames, skipped }
}

/**
 * Read and parse one session log into its event list.
 * @param file - path to `session.v3.jsonl` or `session.v3.jsonl.zstd`.
 * @returns parsed events in log order.
 */
export function readSessionEvents(file) {
  const { text } = decodeZstdFrames(readFileSync(file))
  return text
    .split(/\r?\n/u)
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`line ${String(index + 1)} of ${file} is not JSON: ${String(error)}`)
      }
    })
}
