// Temporary loopback encoder for the canvas recording in bot-showcase.html.
// It only writes this named output; it does not expose the filesystem or colony state.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, rename } from 'node:fs/promises'
import { once } from 'node:events'
import { resolve } from 'node:path'
const directory = resolve('recordings')
await mkdir(directory, { recursive: true })
const output = resolve(directory, 'bot-faces-orbit-9x16.mp4')
const partial = resolve(directory, 'bot-faces-orbit-9x16.partial.mp4')
let encoder, frames = 0, finishing = false
const server = http.createServer(async (req, res) => {
  if (req.headers.origin !== 'http://127.0.0.1:5275') { res.writeHead(403); res.end('Local preview only'); return }
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5275')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
  try {
    if (req.url === '/start') {
      if (encoder) { res.writeHead(409); res.end('Capture already started'); return }
      encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-framerate', '30', '-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0', '-an', '-vf', 'scale=out_color_matrix=bt709', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-metadata', 'title=Bot Crossing — Faces and reflections', partial], { stdio: ['pipe', 'ignore', 'inherit'] })
      encoder.on('error', error => console.error(error))
      res.end('Ready'); return
    }
    if (!encoder || finishing) { res.writeHead(409); res.end('Encoder is not accepting frames'); return }
    if (req.url === `/frame/${frames}`) {
      const chunks = []; let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 12 * 1024 * 1024) throw new Error('Oversized frame')
        chunks.push(chunk)
      }
      if (!encoder.stdin.write(Buffer.concat(chunks))) await once(encoder.stdin, 'drain')
      frames++
      if (frames % 60 === 0) console.log(`Captured ${frames}/660 frames`)
      res.end('OK'); return
    }
    if (req.url === '/finish' && frames === 660) {
      finishing = true
      const done = once(encoder, 'close'); encoder.stdin.end()
      const [code] = await done
      if (code !== 0) throw new Error(`ffmpeg exited ${code}`)
      await rename(partial, output)
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ file: output, frames }))
      console.log(`Saved ${output}`)
      server.close(); return
    }
    res.writeHead(409); res.end(`Expected frame ${frames}`)
  } catch (error) { res.writeHead(500); res.end(error.message); console.error(error) }
})
server.listen(5276, '127.0.0.1', () => console.log('Portrait capture encoder listening on 127.0.0.1:5276'))
process.on('SIGINT', () => { encoder?.kill(); server.close(); process.exit(0) })
