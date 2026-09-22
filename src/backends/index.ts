import type { RunEvent } from '../types.js';
import { runAider } from './aider.js';
import { runClaude } from './claude.js';
import { runCopilot } from './copilot.js';
import { runGemini } from './gemini.js';
import { runLlamacpp } from './llamacpp.js';
import { runLms } from './lms.js';
import { runOllama } from './ollama.js';
import { runOpencode } from './opencode.js';
import { runVibe } from './vibe.js';
import type { RunRequest } from './types.js';

export type { RunRequest } from './types.js';

export function runTarget(req: RunRequest): AsyncGenerator<RunEvent> {
  switch (req.target.backend) {
    case 'claude':
      return runClaude(req);
    case 'opencode':
      return runOpencode(req, { model: req.target.model });
    case 'ollama':
      return runOllama(req);
    case 'copilot':
      return runCopilot(req);
    case 'vibe':
      return runVibe(req);
    case 'gemini':
      return runGemini(req);
    case 'aider':
      return runAider(req);
    case 'lms':
      return runLms(req);
    case 'llamacpp':
      return runLlamacpp(req);
  }
}
