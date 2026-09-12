/**
 * 一次性迁移脚本：旧版单字符串数据模块 src/common/data/dict.js
 * → 文件库三件套 dict.dat / dict.smp / zh.dat（tools/lib/dict-pack.mjs）。
 *
 * 用法：node tools/migrate-from-js.mjs
 * 迁移完成后删除旧 dict.js（本脚本只做产物转换，不删源文件）。
 */
import { emitDictFiles } from './lib/dict-pack.mjs'
import { DICT_DATA } from '../src/common/data/dict.js'

const OUT_DIR = new URL('../src/common/data/', import.meta.url).pathname

const lines = DICT_DATA.split('\n')
const entries = []
for (const line of lines) {
  if (!line) continue
  const s1 = line.indexOf('\x01')
  const s2 = line.indexOf('\x02', s1 + 1)
  const s3 = line.indexOf('\x03', s2 + 1)
  entries.push({
    w: line.slice(0, s1),
    ph: line.slice(s1 + 1, s2),
    tr: line.slice(s2 + 1, s3),
    exStr: line.slice(s3 + 1)
  })
}
console.log('迁移词条:', entries.length)

const stats = emitDictFiles(entries, OUT_DIR)
console.log('dict.dat:', stats.dictMB + 'MB，', 'zh.dat:', stats.zhMB + 'MB，',
  'dict.smp:', stats.smpKB + 'KB', '（样本', stats.sampleCount, '，词条', stats.entryCount, '，中文语料', stats.zhCount, '）')
