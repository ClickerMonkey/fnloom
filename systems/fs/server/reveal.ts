/** Showing a file in the computer's file manager: Explorer on Windows, Finder on macOS, the default opener elsewhere. */
import type { EntryType, Exec, Opener } from './index.ts';
import { parentOf } from './paths.ts';
import { NOT_STARTED } from './shell.ts';

/** The program and arguments that reveal a path on a platform. */
export function revealCommand(platform: NodeJS.Platform, path: string, type: EntryType): { file: string; args: string[] } {
  switch (platform) {
    case 'win32': return { file: 'explorer.exe', args: type === 'folder' ? [path.replaceAll('/', '\\')] : [`/select,${path.replaceAll('/', '\\')}`] };
    case 'darwin': return { file: 'open', args: type === 'folder' ? [path] : ['-R', path] };
    default: return { file: 'xdg-open', args: [type === 'folder' ? path : parentOf(path)] };
  }
}

/** The platform's file manager. */
export class PlatformOpener implements Opener {
  private readonly exec: Exec;
  private readonly platform: NodeJS.Platform;
  private readonly timeout: number;
  constructor(exec: Exec, platform: NodeJS.Platform, timeout: number) {
    this.exec = exec;
    this.platform = platform;
    this.timeout = timeout;
  }

  async reveal(path: string, type: EntryType): Promise<boolean> {
    const { file, args } = revealCommand(this.platform, path, type);
    const run = await this.exec.exec(file, args, { timeout: this.timeout });
    // Explorer exits 1 even when it opened the window, so anything but "couldn't start" counts
    return run.ended === 'exit' && (this.platform === 'win32' ? run.exitCode !== NOT_STARTED : run.exitCode === 0);
  }
}
