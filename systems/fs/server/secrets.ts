/**
 * Which files hold secrets and so are never served as resources (listed, read, watched or indexed by the hub). The
 * fs config's `secrets` is a list of globs: a glob without `/` matches a file or folder name at any depth, one with
 * `/` matches the path from its root, and a glob starting with `!` is an exception that serves what it matches.
 * The fs fns (`read`, `grep`, ...) are not affected: they act for the person, under their shell and path rules.
 */
import { matchesGlob } from 'node:path';

/**
 * What the fs config leaves out when it names no `secrets`: env files (but the example), keys and credential files.
 * SSH keys are named by their kinds (`id_rsa`, `id_ed25519.pub`, ...) rather than `id_*`, which would hide source
 * files such as `id_map.ts`.
 */
export const DEFAULT_SECRETS: readonly string[] = [
  '.env', '.env.*', '!.env.example', '*.pem', '*.key', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '*.pfx', '*.p12', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  'credentials', 'credentials.*', '*.credentials', '*.credentials.json',
];

/**
 * `matchesGlob` with dot files included: `*`, `?` and `[...]` also match a leading dot, so `*.pem` hides `.secret.pem`.
 * Node's matcher has no dot option, so the second test swaps each name's leading dot for a NUL, which no glob spells
 * out but every wildcard matches; the first test keeps globs that spell the dot (`.env`) working.
 */
function matchesDotted(subject: string, glob: string): boolean {
  return matchesGlob(subject, glob) || matchesGlob(subject.replace(/(^|\/)\./g, '$1\u0000'), glob);
}

/** One glob of the list, and whether it is an exception. */
interface SecretRule {
  readonly glob: string;
  readonly byName: boolean;
  readonly serve: boolean;
}

/** A test for paths that hold secrets. */
export interface SecretFilter {
  /** Whether the path (relative to its root, with `/`) or any folder above it is a secret. */
  hides(relative: string): boolean;
}

/** The {@link SecretFilter} from a glob list; the last rule that matches decides, as in `.gitignore`. */
export class GlobSecrets implements SecretFilter {
  private readonly rules: readonly SecretRule[];

  constructor(globs: readonly string[] = DEFAULT_SECRETS) {
    this.rules = globs.filter((glob) => glob.trim() !== '' && glob !== '!').map((raw) => {
      const serve = raw.startsWith('!');
      const glob = serve ? raw.slice(1) : raw;
      return { glob, byName: !glob.includes('/'), serve };
    });
  }

  hides(relative: string): boolean {
    if (this.rules.length === 0 || relative === '') { return false; }
    const parts = relative.split('/');
    return parts.some((_, i) => this.secret(parts.slice(0, i + 1)));
  }

  /** Whether the entry at this path (its segments from the root) is itself a secret. */
  private secret(parts: readonly string[]): boolean {
    const name = parts[parts.length - 1] ?? '';
    const path = parts.join('/');
    let hidden = false;
    for (const rule of this.rules) {
      if (matchesDotted(rule.byName ? name : path, rule.glob)) { hidden = !rule.serve; }
    }
    return hidden;
  }
}
