/**
 * RPK 安装包校验脚本（零依赖，Node 18+）
 *
 * 校验项：
 *   1. 文件是合法 ZIP / RPK 结构
 *   2. 内含 manifest.json，且能解析出 package / name / versionCode
 *      （安装器显示「没有包名」时，本项必然失败）
 *   3. 包含 "RPK Sig Block 42" 签名块（未签名包无法通过设备安装校验）
 *
 * 用法：node scripts/verify-rpk.mjs <path/to/*.rpk>
 * 任意一项失败即以非零码退出，可直接用于 CI 闸门。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const SIG_MAGIC = Buffer.from('RPK Sig Block 42')

function fail(msg) {
  console.error(`[verify-rpk] FAIL: ${msg}`)
  process.exit(1)
}

const rpkPath = process.argv[2]
if (!rpkPath) fail('用法: node scripts/verify-rpk.mjs <path/to/*.rpk>')
if (!fs.existsSync(rpkPath)) fail(`文件不存在: ${rpkPath}`)

const buf = fs.readFileSync(rpkPath)
console.log(`[verify-rpk] 文件: ${rpkPath} (${buf.length} bytes)`)

// ---- 1. ZIP / RPK 结构 ----
if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
  fail('不是合法的 RPK（ZIP）文件')
}

// 定位 EOCD（End Of Central Directory）
let eocd = -1
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
}
if (eocd === -1) fail('ZIP 结构损坏：找不到 EOCD')

const entries = buf.readUInt16LE(eocd + 10)
const cdOffset = buf.readUInt32LE(eocd + 16)

// ---- 2. 遍历中央目录，提取 manifest.json ----
function readEntry(nameWanted) {
  let p = cdOffset
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const fnLen = buf.readUInt16LE(p + 28)
    const exLen = buf.readUInt16LE(p + 30)
    const cmLen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + fnLen).toString('utf8')
    if (name === nameWanted) {
      if (buf.readUInt32LE(lho) !== 0x04034b50) fail(`本地文件头损坏: ${name}`)
      const lfnLen = buf.readUInt16LE(lho + 26)
      const lexLen = buf.readUInt16LE(lho + 28)
      const start = lho + 30 + lfnLen + lexLen
      const raw = buf.subarray(start, start + csize)
      if (method === 0) return raw
      if (method === 8) return zlib.inflateRawSync(raw)
      fail(`不支持的压缩方式(${method}): ${name}`)
    }
    p += 46 + fnLen + exLen + cmLen
  }
  return null
}

const manifestBuf = readEntry('manifest.json')
if (!manifestBuf) {
  fail(
    '包内没有 manifest.json，无法解析包名。\n' +
    '  提示：GitHub Action 的 artifact 是 zip 包装，直接拿 zip 安装就会「没有包名」。\n' +
    '  请从 Releases 下载原始 .rpk，或先解压 artifact 再安装其中的 .rpk。'
  )
}

let manifest
try {
  manifest = JSON.parse(manifestBuf.toString('utf8'))
} catch (e) {
  fail(`manifest.json 解析失败: ${e.message}`)
}
if (!manifest.package || typeof manifest.package !== 'string' || !manifest.package.includes('.')) {
  fail('manifest.json 缺少有效 package 字段（包名）')
}
if (!manifest.name) fail('manifest.json 缺少 name 字段（应用名）')
if (!Number.isInteger(manifest.versionCode)) fail('manifest.json 缺少有效 versionCode')

// ---- 3. 签名块 ----
if (buf.indexOf(SIG_MAGIC) === -1) {
  fail('缺少 RPK Sig Block 42 签名块：包未签名，设备将无法安装')
}

console.log('[verify-rpk] 包名:', manifest.package)
console.log('[verify-rpk] 应用名:', manifest.name)
console.log('[verify-rpk] 版本:', manifest.versionName, `(versionCode ${manifest.versionCode})`)
console.log('[verify-rpk] 签名块: 已找到 RPK Sig Block 42')
console.log('[verify-rpk] OK: 该 RPK 可直接用于设备安装')
