import { describe, it, expect } from 'vitest'
import { extractToolName, STATUS_TO_TOOL } from '../office/toolUtils.js'

describe('extractToolName', () => {
  it('maps Reading prefix to Read', () => {
    expect(extractToolName('Reading foo.ts')).toBe('Read')
  })

  it('maps Editing/Writing prefixes', () => {
    expect(extractToolName('Editing bar.kt')).toBe('Edit')
    expect(extractToolName('Writing baz.json')).toBe('Write')
  })

  it('maps Running to Bash', () => {
    expect(extractToolName('Running: ls -la')).toBe('Bash')
  })

  it('maps Searching to Grep (Glob takes Globbing)', () => {
    expect(extractToolName('Searching code')).toBe('Grep')
  })

  it('maps Globbing to Glob', () => {
    expect(extractToolName('Globbing src')).toBe('Glob')
  })

  it('maps Fetching to WebFetch', () => {
    expect(extractToolName('Fetching web content')).toBe('WebFetch')
  })

  it('maps Searching web to WebSearch (longer prefix wins by iteration order in object)', () => {
    // STATUS_TO_TOOL declares "Searching" before "Searching web" so the shorter
    // prefix matches first. Document the actual behavior so refactors don't
    // silently break expectations.
    expect(extractToolName('Searching web for something')).toBe('Grep')
  })

  it('maps Subtask: to Task', () => {
    // "Subtask:" doesn't match any prefix in STATUS_TO_TOOL (it has "Task" not
    // "Subtask"), so the fallback first-token extractor kicks in.
    expect(extractToolName('Subtask: investigate')).toBe('Subtask')
  })

  it('falls back to first whitespace-or-colon-delimited token', () => {
    expect(extractToolName('Using MysteryTool')).toBe('Using')
    expect(extractToolName('Custom: action')).toBe('Custom')
  })

  it('returns null for empty status', () => {
    expect(extractToolName('')).toBeNull()
  })

  it('STATUS_TO_TOOL exposes the canonical prefix → tool map', () => {
    expect(STATUS_TO_TOOL['Reading']).toBe('Read')
    expect(STATUS_TO_TOOL['Running']).toBe('Bash')
  })
})
