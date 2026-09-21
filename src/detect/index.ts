import type { Config } from '../config/schema.js';
import {
  detectAider,
  detectClaude,
  detectCopilot,
  detectGemini,
  detectHuggingface,
  detectLlamacpp,
  detectLms,
  detectOllama,
  detectOpencode,
  detectOtherClis,
  detectVibe,
} from './backends.js';
import { detectHardware } from './hardware.js';
import { detectInventory } from './inventory.js';
import type { Detection } from './types.js';

export * from './types.js';

export async function detectAll(cfg: Config): Promise<Detection> {
  const hardware = await detectHardware(cfg.ollama.memory_ratio);
  const [claude, opencode, ollama, copilot, vibe, gemini, aider, lms, llamacpp, huggingface, inventory] = await Promise.all([
    detectClaude(),
    detectOpencode(),
    detectOllama(cfg, hardware),
    detectCopilot(),
    detectVibe(),
    detectGemini(),
    detectAider(),
    detectLms(cfg),
    detectLlamacpp(cfg, hardware),
    detectHuggingface(),
    detectInventory(),
  ]);
  return { hardware, claude, opencode, ollama, copilot, vibe, gemini, aider, lms, llamacpp, huggingface, inventory, others: detectOtherClis(), at: Date.now() };
}
