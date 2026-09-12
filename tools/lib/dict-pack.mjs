/**
 * 词典数据打包（tools 内共享，勿进 src/）：
 *   gen-dict.mjs（ECDICT → 词库）与 migrate-from-js.mjs（旧 dict.js → 词库）共用。
 *
 * 产物三件套（src/common/data/，全部作为包内资产随 rpk 分发）：
 *   dict.dat  —— 全文词条，行格式 word \x01 音标 \x02 中文释义 \x03 变形标记 + '\n'，
 *                UTF-8，按 word 字典序排序。运行时按需小窗口随机读取（file.readArrayBuffer）。
 *   dict.smp  —— 二分抽样索引（二进制，运行时整表驻留 ~21KB）：
 *                头 32B：'DSMP' + ver u8 + sampleCount u32 + entryCount u32 + dictLen u32 + zhLen u32 + 8B 保留；
 *                记录 sampleCount × 8B：[word 前 6 字母 packed u32(5bit/字母)] [dict.dat 行首字节偏移 u32]，小端。
 *                采样规则：每桶字节跨度 ≥ SPAN_TARGET 即在新词条处取一个样本（首样本恒为 entry 0），
 *                故任一桶跨度 ≤ SPAN_TARGET + 单条词条长度（词条行 ≤ 256B）。
 *   zh.dat    —— 中文反查语料，行格式 word \x02 释义 + '\n'（仅含释义非空的词条），
 *                供顺序窗口扫描，词条量级与 dict.dat 同序。
 */
import fs from 'node:fs'

const SPAN_TARGET = 1408

export function packKey6(word) {
  let key = 0
  for (let i = 0; i < 6; i++) {
    const c = i < word.length ? word.charCodeAt(i) : 0
    const v = c >= 97 && c <= 122 ? c - 96 : 0
    key = key * 32 + v
  }
  return key
}

/**
 * 打包三件套。
 * @param entries [{ w, ph, tr, exStr }] 已按 w 字典序排序的最终词条（exStr 已编码）
 * @param outDir 输出目录（src/common/data/）
 * @returns 统计信息
 */
export function emitDictFiles(entries, outDir) {
  // ---- dict.dat + 采样表 ----
  const datLines = []
  const lineByteLen = []
  for (const e of entries) {
    const line = e.w + '\x01' + e.ph + '\x02' + e.tr + '\x03' + e.exStr + '\n'
    if (Buffer.byteLength(line, 'utf8') > 640) {
      throw new Error('词条行超长，窗口带宽保证金失效: ' + e.w)
    }
    datLines.push(line)
    lineByteLen.push(Buffer.byteLength(line, 'utf8'))
  }
  const datStr = datLines.join('')
  const datBuf = Buffer.from(datStr, 'utf8')
  const dictLen = datBuf.length

  // 采样：每桶跨度 ≥ SPAN_TARGET 取一个样本（手算字节偏移）
  const samples = [] // { key, off }
  let off = 0
  let acc = 0
  for (let i = 0; i < entries.length; i++) {
    if (samples.length === 0 || acc >= SPAN_TARGET) {
      samples.push({ key: packKey6(entries[i].w), off })
      acc = 0
    }
    acc += lineByteLen[i]
    off += lineByteLen[i]
  }

  // ---- zh.dat ----
  const zhLines = []
  for (const e of entries) {
    if (e.tr) zhLines.push(e.w + '\x02' + e.tr + '\n')
  }
  const zhBuf = Buffer.from(zhLines.join(''), 'utf8')
  const zhLen = zhBuf.length

  // ---- dict.smp（32B 头 + 8B/样本）----
  const smp = Buffer.alloc(32 + samples.length * 8)
  smp.write('DSMP', 0, 'ascii')
  smp.writeUInt8(1, 4)
  smp.writeUInt8(0, 5); smp.writeUInt8(0, 6); smp.writeUInt8(0, 7)
  smp.writeUInt32LE(samples.length, 8)
  smp.writeUInt32LE(entries.length, 12)
  smp.writeUInt32LE(dictLen, 16)
  smp.writeUInt32LE(zhLen, 20)
  // 24..31 保留
  for (let i = 0; i < samples.length; i++) {
    smp.writeUInt32LE(samples[i].key, 32 + i * 8)
    smp.writeUInt32LE(samples[i].off, 32 + i * 8 + 4)
  }

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outDir + '/dict.dat', datBuf)
  fs.writeFileSync(outDir + '/dict.smp', smp)
  fs.writeFileSync(outDir + '/zh.dat', zhBuf)

  return {
    entryCount: entries.length,
    zhCount: zhLines.length,
    sampleCount: samples.length,
    dictLen,
    zhLen,
    dictMB: (dictLen / 1048576).toFixed(2),
    zhMB: (zhLen / 1048576).toFixed(2),
    smpKB: (smp.length / 1024).toFixed(1)
  }
}
