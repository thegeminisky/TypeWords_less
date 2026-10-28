import { getDefaultArticleWord, PracticeArticleWordType } from '../types'

/**
 * 把句子文本切成可逐词练习的 token 列表
 * 原属文章模块，单词例句展示同样复用，故独立出来
 */
export function parseSentence(sentence: string) {
  // 先统一一些常见的“智能引号” -> 直引号，避免匹配问题
  sentence = sentence
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // 各种单引号 → '
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"') // 各种双引号 → "

  const len = sentence.length
  const tokens = []
  let i = 0

  while (i < len) {
    const ch = sentence[i]

    // 跳过空白（但不把空白作为 token）
    if (/\s/.test(ch)) {
      i++
      continue
    }

    const rest = sentence.slice(i)

    // 1) 货币 + 数字（$1,000.50 或 ¥200 或 €100.5）
    let m = rest.match(/^[\$¥€£]\d{1,3}(?:,\d{3})*(?:\.\d+)?%?/)
    if (m) {
      tokens.push({ word: m[0], start: i, end: i + m[0].length, type: PracticeArticleWordType.Number })
      i += m[0].length
      continue
    }

    // 2) 数字/小数/百分比（100% 3.14 1,000.00）
    m = rest.match(/^\d{1,3}(?:,\d{3})*(?:\.\d+)?%?/)
    if (m) {
      tokens.push({ word: m[0], start: i, end: i + m[0].length, type: PracticeArticleWordType.Number })
      i += m[0].length
      continue
    }

    // 3) 带点缩写或多段缩写（U.S. U.S.A. e.g. i.e. Ph.D.）
    m = rest.match(/^[A-Za-z]+(?:\.[A-Za-z]+)+\.?/)
    if (m) {
      tokens.push({ word: m[0], start: i, end: i + m[0].length, type: PracticeArticleWordType.Word })
      i += m[0].length
      continue
    }

    // 4) 单词（包含撇号/连字符，如 it's, o'clock, we'll, mother-in-law）
    m = rest.match(/^[A-Za-z0-9]+(?:[\'\-][A-Za-z0-9]+)*/)
    if (m) {
      tokens.push({ word: m[0], start: i, end: i + m[0].length, type: PracticeArticleWordType.Word })
      i += m[0].length
      continue
    }

    // 5) 其它可视符号（标点）——单字符处理（连续标点会被循环拆为单字符）
    //    包括：.,!?;:"'()-[]{}<>/\\@#%^&*~`等非单词非空白字符
    if (/[^\w\s]/.test(ch)) {
      tokens.push({ word: ch, start: i, end: i + 1, type: PracticeArticleWordType.Symbol })
      i += 1
      continue
    }

    // 6) 回退方案：把当前字符当作一个 token（防止意外丢失）
    tokens.push({ word: ch, start: i, end: i + 1, type: PracticeArticleWordType.Symbol })
    i += 1
  }

  // 计算 nextSpace：查看当前 token 的 end 到下一个 token 的 start 之间是否含空白
  const result = tokens.map((t, idx) => {
    const next = tokens[idx + 1]
    const between = next ? sentence.slice(t.end, next.start) : sentence.slice(t.end)
    const nextSpace = /\s/.test(between)
    return getDefaultArticleWord({ word: t.word, nextSpace, type: t.type })
  })

  return result
}
