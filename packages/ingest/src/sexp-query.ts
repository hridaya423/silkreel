import type { SExprNode } from './sexp.js'
import { ParseError } from './errors.js'

export function isList(node: SExprNode): node is SExprNode[] {
  return Array.isArray(node)
}

export function isAtom(node: SExprNode): node is string {
  return typeof node === 'string'
}

export function head(node: SExprNode[]): string {
  const first: SExprNode | undefined = node[0]
  return first !== undefined && isAtom(first) ? first : ''
}

export function children(node: SExprNode[]): SExprNode[] {
  return node.slice(1)
}

export function listsNamed(node: SExprNode[], name: string): SExprNode[][] {
  const out: SExprNode[][] = []
  for (const child of node) {
    if (isList(child) && head(child) === name) out.push(child)
  }
  return out
}

export function firstListNamed(node: SExprNode[], name: string): SExprNode[] | undefined {
  for (const child of node) {
    if (isList(child) && head(child) === name) return child
  }
  return undefined
}

export function atomsAfterHead(node: SExprNode[]): string[] {
  const out: string[] = []
  for (let i = 1; i < node.length; i++) {
    const child: SExprNode | undefined = node[i]
    if (child !== undefined && isAtom(child)) out.push(child)
  }
  return out
}

export function toNumber(atom: string, contextFile: string, what: string): number {
  const value = Number.parseFloat(atom)
  if (!Number.isFinite(value)) {
    throw new ParseError(contextFile, `${what} is "${atom}", not a number. Please report this file at https://github.com/hridaya423/silkreel/issues`)
  }
  return value
}

export function parseXY(node: SExprNode[], file: string): { x: number; y: number } {
  const atoms = atomsAfterHead(node)
  if (atoms.length < 2) throw new ParseError(file, 'a point has only one coordinate, so the file is damaged')
  return { x: toNumber(atoms[0] as string, file, 'xy coordinate'), y: toNumber(atoms[1] as string, file, 'xy coordinate') }
}
