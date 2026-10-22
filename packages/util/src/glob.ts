import type { GlobOptions } from "glob"
import { minimatch } from "minimatch"

export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
    ignore?: string[]
  }

  function toGlobOptions(options: Options): GlobOptions {
    return {
      cwd: options.cwd,
      absolute: options.absolute,
      dot: options.dot,
      follow: options.symlink ?? false,
      nodir: options.include !== "all",
      ignore: options.ignore,
    }
  }

  export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
    // glob and its dependencies are slow to load, and almost every process imports this module.
    const { glob } = await import("glob")
    return glob(pattern, toGlobOptions(options)) as Promise<string[]>
  }

  export function match(pattern: string, filepath: string): boolean {
    return minimatch(filepath, pattern, { dot: true })
  }
}
