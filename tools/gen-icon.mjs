/**
 * 零依赖应用图标生成器：翻开的书主题图标 → src/common/images/icon.png（192×192 PNG）
 * 运行：npm run gen:icon
 */
import zlib from 'node:zlib'
import fs from 'node:fs'

const SIZE = 192
const SS = 3 // 超采样倍数
const W = SIZE * SS

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

const BG_TOP = [10, 18, 32]
const BG_BOT = [16, 34, 52]
const PAPER = [238, 245, 255]
const PAPER_HI = [252, 254, 255]
const SPINE = [13, 110, 255]
const INK = [96, 110, 140]
const GLASS = null

function insideRounded(x, y) {
  const r = 44 * SS
  const max = W - 1
  if (x < r && y < r && Math.hypot(x - r, y - r) > r) return false
  if (x > max - r && y < r && Math.hypot(x - (max - r), y - r) > r) return false
  if (x < r && y > max - r && Math.hypot(x - r, y - (max - r)) > r) return false
  if (x > max - r && y > max - r && Math.hypot(x - (max - r), y - (max - r)) > r) return false
  return true
}

function inRect(x, y, x1, y1, x2, y2) {
  return x >= x1 && x <= x2 && y >= y1 && y <= y2
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ]
}

// 书本几何
const BOOK_TOP = 0.33 * W
const BOOK_BOT = 0.71 * W
const CX = 0.5 * W
const PAGE_L = 0.27 * W
const PAGE_R = 0.73 * W
const SPINE_W = 0.010 * W
const LINE_H = 0.012 * W
const LINE_W = 0.014 * W

function pageRect(x, y) {
  // 左/右页区域（页面向书脊处微微收高，模拟翻开）
  const inY = y >= BOOK_TOP && y <= BOOK_BOT
  if (x < PAGE_L || x > PAGE_R || !inY) return 0
  // 书脊处顶边上抬的斜面：距离书脊越近，有效顶边越低
  const d = Math.abs(x - CX) / (CX - PAGE_L) // 0（书脊） → 1（书口）
  const top = BOOK_TOP + (1 - d) * 0.020 * W
  if (y < top) return 0
  return x < CX ? -1 : 1 // -1 左页，1 右页
}

function sample(px, py) {
  if (!insideRounded(px, py)) return [0, 0, 0, 0]
  let col = mix(BG_TOP, BG_BOT, py / W)

  const page = pageRect(px, py)
  if (page) {
    // 页内文字行：每页 4 行
    let inked = false
    const side = page > 0 ? 1 : -1
    const inner = CX + side * 0.028 * W
    const outer = CX + side * 0.20 * W
    const x1 = Math.min(inner, outer)
    const x2 = Math.max(inner, outer)
    for (let i = 0; i < 4; i++) {
      const yc = BOOK_TOP + 0.075 * W + i * 0.075 * W
      // 页口越靠外，行越短
      const endX = x1 + (x2 - x1) * (1 - i * 0.12)
      if (inRect(px, py, x1, yc - LINE_H / 2, endX, yc + LINE_H / 2)) { inked = true; break }
    }
    col = inked ? INK : PAPER
    // 纸面高光（左上）
    if (!inked && segDist(px, py, PAGE_L + 0.02 * W, BOOK_TOP, CX, BOOK_BOT) > (PAGE_R - PAGE_L) * 0.45) {
      col = mix(PAPER, PAPER_HI, 0.5)
    }
  }
  // 书脊
  if (Math.abs(px - CX) <= SPINE_W && py >= BOOK_TOP - 0.004 * W && py <= BOOK_BOT + 0.004 * W) col = SPINE
  // 书口边线（轻描）
  if (page && (Math.abs(py - BOOK_BOT) <= 1.6 * SS)) col = mix(PAPER, SPINE, 0.25)

  return [col[0], col[1], col[2], 255]
}

/* 渲染 + 超采样降采样 */
const raw = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const p = sample(x * SS + sx + 0.5, y * SS + sy + 0.5)
        r += p[0]; g += p[1]; b += p[2]; a += p[3]
      }
    }
    const n = SS * SS
    const o = (y * SIZE + x) * 4
    raw[o] = clamp(Math.round(r / n))
    raw[o + 1] = clamp(Math.round(g / n))
    raw[o + 2] = clamp(Math.round(b / n))
    raw[o + 3] = clamp(Math.round(a / n))
  }
}

/* PNG 编码 */
const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const stride = SIZE * 4
const scanlined = Buffer.alloc((stride + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  scanlined[y * (stride + 1)] = 0
  raw.copy(scanlined, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(scanlined, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
fs.writeFileSync(new URL('../src/common/images/icon.png', import.meta.url).pathname, png)
console.log('icon.png generated:', png.length, 'bytes')
