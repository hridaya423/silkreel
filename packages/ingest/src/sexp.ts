export type SExprNode = string | SExprNode[]

import { ParseError } from './errors.js'

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_PAREN = 0x28
const CLOSE_PAREN = 0x29

class Source {
  private readonly text: string
  pos = 0
  readonly file: string

  constructor(text: string, file: string) {
    this.text = text
    this.file = file
  }

  peek(): number {
    if (this.pos >= this.text.length) return -1
    return this.text.charCodeAt(this.pos)
  }

  next(): number {
    const code = this.peek()
    if (code >= 0) this.pos += 1
    return code
  }

  atEnd(): boolean {
    return this.pos >= this.text.length
  }

  fail(reason: string): never {
    throw new ParseError(this.file, `the file is damaged or cut off (${reason} at offset ${this.pos})`, this.pos)
  }
}

function skipWhitespace(src: Source): void {
  while (!src.atEnd()) {
    const code = src.peek()
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c) {
      src.next()
      continue
    }
    return
  }
}

function parseQuoted(src: Source): string {
  src.next()
  let out = ''
  for (;;) {
    if (src.atEnd()) src.fail('unterminated quoted string')
    const code = src.next()
    if (code === BACKSLASH) {
      if (src.atEnd()) src.fail('escape sequence at end of input')
      const esc = src.next()
      if (esc === 0x6e) {
        out += '\n'
      } else if (esc === 0x74) {
        out += '\t'
      } else if (esc === 0x72) {
        out += '\r'
      } else {
        out += String.fromCharCode(esc)
      }
      continue
    }
    if (code === QUOTE) return out
    out += String.fromCharCode(code)
  }
}

function parseAtom(src: Source): string {
  let out = ''
  while (!src.atEnd()) {
    const code = src.peek()
    const isDelimiter = code <= 0x20 || code === OPEN_PAREN || code === CLOSE_PAREN
    if (isDelimiter) break
    out += String.fromCharCode(src.next())
  }
  return out
}

function parseList(src: Source): SExprNode[] {
  const openPos = src.pos
  src.next()
  const list: SExprNode[] = []
  for (;;) {
    skipWhitespace(src)
    if (src.atEnd()) {
      throw new ParseError(
        src.file,
        `the file is cut off: the list opened at offset ${openPos} never closes`,
        openPos
      )
    }
    const code = src.peek()
    if (code === CLOSE_PAREN) {
      src.next()
      return list
    }
    list.push(parseNode(src))
  }
}

function parseNode(src: Source): SExprNode {
  const code = src.peek()
  if (code === OPEN_PAREN) return parseList(src)
  if (code === QUOTE) return parseQuoted(src)
  if (code === CLOSE_PAREN) src.fail('unexpected closing parenthesis')
  const atom = parseAtom(src)
  if (atom.length === 0) src.fail('expected an atom')
  return atom
}

export function parseSExpr(text: string, file: string): SExprNode[] {
  const src = new Source(text, file)
  skipWhitespace(src)
  if (src.atEnd()) throw new ParseError(file, 'the file is empty', 0)
  const code = src.peek()
  if (code !== OPEN_PAREN) {
    throw new ParseError(file, 'it is not a KiCad board file', src.pos)
  }
  const root = parseList(src)
  skipWhitespace(src)
  if (!src.atEnd()) src.fail('unexpected trailing content after top-level s-expression')
  return root
}
