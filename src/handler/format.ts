import workspace from '../workspace'
import window from '../window'
import events from '../events'
import languages from '../languages'
import { Neovim } from '@chemzqm/neovim'
import { ConfigurationChangeEvent, StatusBarItem } from '../types'
import { disposeAll } from '../util'
import { CancellationTokenSource, Disposable, Range, Position, TextEdit, CancellationToken } from 'vscode-languageserver-protocol'
import snippetManager from '../snippets/manager'
import { synchronizeDocument } from './helper'
import { isWord } from '../util/string'
import { getChangedFromEdits } from '../util/position'
const logger = require('../util/logger')('handler-format')

const pairs: Map<string, string> = new Map([
  ['<', '>'],
  ['>', '<'],
  ['{', '}'],
  ['[', ']'],
  ['(', ')'],
])

interface FormatPreferences {
  formatOnType: boolean
  formatOnTypeFiletypes: string[]
  formatOnSaveFiletypes: string[]
  formatOnInsertLeave: boolean
  bracketEnterImprove: boolean
}

export default class FormatHandler {
  private preferences: FormatPreferences
  private disposables: Disposable[] = []
  private requestStatusItem: StatusBarItem
  private requestTokenSource: CancellationTokenSource | undefined
  constructor(private nvim: Neovim) {
    this.requestStatusItem = window.createStatusBarItem(0, { progress: true })
    this.loadPreferences()
    workspace.onDidChangeConfiguration(this.loadPreferences, this, this.disposables)
    workspace.onWillSaveTextDocument(event => {
      let { languageId } = event.document
      let filetypes = this.preferences.formatOnSaveFiletypes
      if (filetypes.includes(languageId) || filetypes.some(item => item === '*')) {
        let willSaveWaitUntil = async (): Promise<TextEdit[] | undefined> => {
          if (!languages.hasFormatProvider(event.document)) {
            logger.warn(`Format provider not found for ${event.document.uri}`)
            return undefined
          }
          let options = await workspace.getFormatOptions(event.document.uri)
          let tokenSource = new CancellationTokenSource()
          let timer = setTimeout(() => {
            tokenSource.cancel()
          }, 1000)
          let textEdits = await languages.provideDocumentFormattingEdits(event.document, options, tokenSource.token)
          clearTimeout(timer)
          return textEdits
        }
        event.waitUntil(willSaveWaitUntil())
      }
    }, null, this.disposables)
    events.on(['CursorMoved', 'CursorMovedI', 'InsertEnter', 'TextChangedI', 'TextChangedP', 'TextChanged'], () => {
      if (this.requestTokenSource) {
        this.requestTokenSource.cancel()
        this.requestTokenSource = null
      }
    }, null, this.disposables)
    events.on('Enter', async bufnr => {
      let { bracketEnterImprove } = this.preferences
      await this.tryFormatOnType('\n', bufnr)
      if (bracketEnterImprove) {
        let line = (await nvim.call('line', '.') as number) - 1
        let doc = workspace.getDocument(bufnr)
        if (!doc) return
        let pre = doc.getline(line - 1)
        let curr = doc.getline(line)
        let prevChar = pre[pre.length - 1]
        if (prevChar && pairs.has(prevChar)) {
          let nextChar = curr.trim()[0]
          if (nextChar && pairs.get(prevChar) == nextChar) {
            let edits: TextEdit[] = []
            let opts = await workspace.getFormatOptions(doc.uri)
            let space = opts.insertSpaces ? ' '.repeat(opts.tabSize) : '\t'
            let preIndent = pre.match(/^\s*/)[0]
            let currIndent = curr.match(/^\s*/)[0]
            let newText = '\n' + preIndent + space
            let pos: Position = Position.create(line - 1, pre.length)
            // make sure indent of current line
            if (preIndent != currIndent) {
              let newText = doc.filetype == 'vim' ? '  \\ ' + preIndent : preIndent
              edits.push({ range: Range.create(Position.create(line, 0), Position.create(line, currIndent.length)), newText })
            } else if (doc.filetype == 'vim') {
              edits.push({ range: Range.create(line, currIndent.length, line, currIndent.length), newText: '  \\ ' })
            }
            if (doc.filetype == 'vim') {
              newText = newText + '\\ '
            }
            edits.push({ range: Range.create(pos, pos), newText })
            await doc.applyEdits(edits)
            await window.moveTo(Position.create(line, newText.length - 1))
          }
        }
      }
    }, null, this.disposables)

    let changedTs: number
    let lastInsert: number
    events.on('InsertCharPre', async () => {
      lastInsert = Date.now()
    }, null, this.disposables)
    events.on('TextChangedI', async (bufnr, info) => {
      changedTs = Date.now()
      if (!lastInsert || changedTs - lastInsert > 300) return
      lastInsert = null
      let doc = workspace.getDocument(bufnr)
      if (!doc || doc.isCommandLine || !doc.attached) return
      let pre = info.pre[info.pre.length - 1]
      if (!pre) return
      if (this.preferences.formatOnType && !isWord(pre)) {
        await this.tryFormatOnType(pre, bufnr)
      }
    }, null, this.disposables)
    let leaveBufnr: number
    events.on('InsertLeave', async bufnr => {
      let { formatOnInsertLeave, formatOnType } = this.preferences
      if (!formatOnInsertLeave || !formatOnType) return
      leaveBufnr = bufnr
    }, null, this.disposables)
    events.on('CursorMoved', async bufnr => {
      if (leaveBufnr && leaveBufnr == bufnr) {
        leaveBufnr = undefined
        await this.tryFormatOnType('\n', bufnr, true)
      }
    })
  }

  private loadPreferences(e?: ConfigurationChangeEvent): void {
    if (!e || e.affectsConfiguration('coc.preferences')) {
      let config = workspace.getConfiguration('coc.preferences')
      this.preferences = {
        formatOnType: config.get<boolean>('formatOnType', false),
        formatOnSaveFiletypes: config.get<string[]>('formatOnSaveFiletypes', []),
        formatOnTypeFiletypes: config.get('formatOnTypeFiletypes', []),
        formatOnInsertLeave: config.get<boolean>('formatOnInsertLeave', false),
        bracketEnterImprove: config.get<boolean>('bracketEnterImprove', true),
      }
    }
  }

  private async withRequestToken<T>(name: string, fn: (token: CancellationToken) => Thenable<T>): Promise<T | null> {
    if (this.requestTokenSource) {
      this.requestTokenSource.cancel()
      this.requestTokenSource.dispose()
    }
    let statusItem = this.requestStatusItem
    this.requestTokenSource = new CancellationTokenSource()
    let { token } = this.requestTokenSource
    token.onCancellationRequested(() => {
      statusItem.text = `${name} request canceled`
      statusItem.isProgress = false
      statusItem.hide()
    })
    statusItem.isProgress = true
    statusItem.text = `requesting ${name}`
    statusItem.show()
    let res: T
    try {
      res = await Promise.resolve(fn(token))
    } catch (e) {
      window.showMessage(e.message, 'error')
      logger.error(`Error on ${name}`, e)
    }
    if (this.requestTokenSource) {
      this.requestTokenSource.dispose()
      this.requestTokenSource = undefined
    }
    if (token.isCancellationRequested) return null
    statusItem.hide()
    if (res == null) {
      logger.warn(`${name} provider not found!`)
    }
    return res
  }

  private async tryFormatOnType(ch: string, bufnr: number, insertLeave = false): Promise<void> {
    if (!ch || isWord(ch) || !this.preferences.formatOnType) return
    if (snippetManager.getSession(bufnr) != null) return
    let doc = workspace.getDocument(bufnr)
    if (!doc || !doc.attached || doc.isCommandLine) return
    const filetypes = this.preferences.formatOnTypeFiletypes
    if (filetypes.length && !filetypes.includes(doc.filetype)) {
      // Only check formatOnTypeFiletypes when set, avoid breaking change
      return
    }
    if (!languages.hasOnTypeProvider(ch, doc.textDocument)) return
    let position: Position
    let edits = await this.withRequestToken<TextEdit[]>('onTypeFormat ', async token => {
      position = await window.getCursorPosition()
      let origLine = doc.getline(position.line)
      // not format for empty line.
      if (insertLeave && /^\s*$/.test(origLine)) return
      let pos: Position = insertLeave ? { line: position.line, character: origLine.length } : position
      await synchronizeDocument(doc)
      return await languages.provideDocumentOnTypeEdits(ch, doc.textDocument, pos, token)
    })
    if (!edits || !edits.length) return
    let changed = getChangedFromEdits(position, edits)
    await doc.applyEdits(edits)
    let to = changed ? Position.create(position.line + changed.line, position.character + changed.character) : null
    if (to) await window.moveTo(to)
  }

  public async documentFormat(): Promise<boolean> {
    let doc = await workspace.document
    if (!doc || !doc.attached) return false
    await synchronizeDocument(doc)
    let options = await workspace.getFormatOptions(doc.uri)
    let textEdits = await this.withRequestToken('format', token => {
      return languages.provideDocumentFormattingEdits(doc.textDocument, options, token)
    })
    if (textEdits && textEdits.length > 0) {
      await doc.applyEdits(textEdits)
      return true
    }
    return false
  }

  public async documentRangeFormat(mode: string): Promise<number> {
    let doc = await workspace.document
    if (!doc || !doc.attached) return -1
    await synchronizeDocument(doc)
    let range: Range
    if (mode) {
      range = await workspace.getSelectedRange(mode, doc)
      if (!range) return -1
    } else {
      let [lnum, count, mode] = await this.nvim.eval("[v:lnum,v:count,mode()]") as [number, number, string]
      // we can't handle
      if (count == 0 || mode == 'i' || mode == 'R') return -1
      range = Range.create(lnum - 1, 0, lnum - 1 + count, 0)
    }
    let options = await workspace.getFormatOptions(doc.uri)
    let textEdits = await this.withRequestToken('format', token => {
      return languages.provideDocumentRangeFormattingEdits(doc.textDocument, range, options, token)
    })
    if (textEdits && textEdits.length > 0) {
      await doc.applyEdits(textEdits)
      return 0
    }
    return -1
  }

  public dispose() {
    disposeAll(this.disposables)
  }
}
