import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import type { RunEvent, Target } from '../types.js';

export interface RunRequest {
  prompt: string;
  cwd: string;
  target: Target;
  signal: AbortSignal;
  /** session à reprendre (même backend) */
  sessionId?: string;
  cfg: Config;
  det: Detection;
  /** la tâche a besoin du dépôt (fichiers, commandes) : sinon un simple chat suffit */
  needsTools?: boolean;
}

export type Adapter = (req: RunRequest) => AsyncGenerator<RunEvent>;
