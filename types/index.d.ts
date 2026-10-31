// The Prep Room mod's state (hooks/register.tsx): what the pane, the band and the status
// line draw from. The question itself lives on disk in prep/<id>/.preproom.json, written
// by the plugin's tools; this is the session's copy of it.

export type PreproomMode = 'solo' | 'mock' | 'round' | 'open'

/** The question being worked on. */
export type PreproomCurrent = {
  id: string
  title: string
  meta: string
  mode: PreproomMode
  startedAt: number
  minutes: number
  /** The answer file, and the folder it is in, relative to the project. */
  file: string
  dir: string
  url: string
  /** The task as README.md has it, for the pane. */
  task: string
}

export type PreproomHint = { number: number; text: string }

/** The last run of the examples, as lines for the pane. */
export type PreproomRun = { at: number; pass: boolean | null; lines: string[] }

/** One moment of a mock interview or an assisted round. */
export type PreproomLogEntry = { at: number; what: string }

declare module 'claude-code' {
  interface PluginState {
    preproom: {
      current: Shaped<PreproomCurrent | null>
      tab: 'task' | 'hints' | 'run'
      hints: Shaped<PreproomHint[]>
      run: Shaped<PreproomRun | null>
      link: string | null
      busy: string | null
      tick: number
      log: Shaped<PreproomLogEntry[]>
    }
  }
}
