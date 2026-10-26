export class IngestError extends Error {
  readonly file: string
  readonly reason: string

  constructor(file: string, reason: string) {
    super(`Could not read ${file}: ${reason}.`)
    this.name = 'IngestError'
    this.file = file
    this.reason = reason
  }
}

export class ParseError extends IngestError {
  constructor(file: string, reason: string, readonly position?: number) {
    super(file, reason)
    this.name = 'ParseError'
  }
}

export class UnsupportedFormatError extends IngestError {
  constructor(file: string, reason: string) {
    super(file, reason)
    this.name = 'UnsupportedFormatError'
  }
}
