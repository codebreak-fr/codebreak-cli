import { z } from 'zod';

const level = z.number().int().min(0).max(4);
const profileName = z.enum(['eco', 'balanced', 'quality']);
export type ProfileName = z.infer<typeof profileName>;

export const ConfigSchema = z.object({
  /** Langue de l'interface : auto = celle du système (français si fr*, sinon anglais). */
  language: z.enum(['auto', 'fr', 'en']).default('auto'),

  /** Profil de routage : eco = gratuit d'abord, quality = Claude plus tôt. */
  profile: profileName.default('balanced'),

  /** Le LLM qui joue le rôle de routeur (classification des demandes ambiguës). */
  router: z
    .object({
      /** auto = choisit le meilleur disponible (Ollama petit modèle → OpenCode gratuit → Claude Haiku → règles seules) */
      provider: z.enum(['auto', 'ollama', 'opencode', 'claude', 'rules']).default('auto'),
      /** auto, ou un nom précis : "ministral-3:3b", "opencode/big-pickle", "haiku" */
      model: z.string().default('auto'),
      /** ambiguous = le LLM n'intervient que si les règles hésitent ; always ; never */
      mode: z.enum(['ambiguous', 'always', 'never']).default('ambiguous'),
      timeout_ms: z.number().int().positive().default(15000),
      confidence_threshold: z.number().min(0).max(1).default(0.7),
      cache_ttl_hours: z.number().positive().default(168),
    })
    .prefault({}),

  /** Surcharges de la table complexité → niveau, par profil. */
  profiles: z.partialRecord(profileName, z.record(z.string(), level)).default({}),

  policy: z
    .object({
      /** niveau minimal par catégorie (surcharge les défauts) */
      category_floors: z.record(z.string(), level).default({}),
      security_min_level: level.default(3),
      security_preferred_level: level.default(4),
      mcp_min_level: level.default(2),
      large_context_min_level: level.default(2),
      low_confidence: z.number().min(0).max(1).default(0.5),
    })
    .prefault({}),

  /** Seuils d'utilisation du quota Claude (0..1). */
  quota: z
    .object({
      claude: z
        .object({
          /** au-delà : Opus réservé aux tâches critiques, Sonnet évité pour les tâches moyennes */
          soft: z.number().min(0).max(1).default(0.75),
          /** au-delà : Opus interdit, Claude réservé aux tâches qui l'exigent */
          hard: z.number().min(0).max(1).default(0.9),
          /** au-delà : Claude désactivé */
          stop: z.number().min(0).max(1).default(0.98),
          probe_ttl_min: z.number().positive().default(10),
        })
        .prefault({}),
    })
    .prefault({}),

  escalation: z
    .object({
      enabled: z.boolean().default(true),
      max_attempts: z.number().int().min(1).max(6).default(3),
      /** paliers parcourus lors d'une escalade */
      ladder: z.array(level).default([0, 1, 3, 4]),
      /** nouvelles tentatives avec le MÊME agent après une erreur simple (syntaxe, types, lint) avant d'escalader */
      same_agent_retries: z.number().int().min(0).max(3).default(1),
      /** budget de temps d'une tâche (minutes, 0 = illimité) et de coût (USD, 0 = illimité) */
      max_minutes: z.number().min(0).default(0),
      max_cost_usd: z.number().min(0).default(0),
      /** délai maximal d'une tentative d'agent (minutes, 0 = illimité) */
      attempt_timeout_minutes: z.number().min(0).default(0),
      /** annule les fichiers modifiés par une tentative ratée avant la suivante : never | on_no_progress | always */
      rollback: z.enum(['never', 'on_no_progress', 'always']).default('never'),
    })
    .prefault({}),

  /** Mémoire Markdown du projet (`.codebreak/`) et sélection du contexte envoyé aux agents. */
  memory: z
    .object({
      enabled: z.boolean().default(true),
      /** dossier relatif à la racine du projet */
      dir: z.string().default('.codebreak'),
      /** crée le dossier (et son .gitignore) au premier lancement */
      auto_init: z.boolean().default(true),
      /** taille maximale (caractères) du contexte injecté dans un prompt */
      max_context_chars: z.number().int().min(500).default(6000),
      max_failures: z.number().int().min(0).default(3),
      max_decisions: z.number().int().min(0).default(4),
    })
    .prefault({}),

  /** Contexte partagé entre outils (fichier .md), pour éviter qu'un LLM ne redécouvre ce qu'un autre a déjà fait. */
  context: z
    .object({
      enabled: z.boolean().default(true),
      /** nombre de tours conservés dans le fichier (les plus anciens sont purgés) */
      max_entries: z.number().int().positive().default(12),
    })
    .prefault({}),

  verify: z
    .object({
      /** auto = typecheck/lint/test détectés dans package.json quand des fichiers ont changé */
      mode: z.enum(['auto', 'off']).default('auto'),
      commands: z.array(z.string()).default([]),
      timeout_s: z.number().positive().default(180),
    })
    .prefault({}),

  claude: z
    .object({
      enabled: z.boolean().default(true),
      permission_mode: z.string().default('acceptEdits'),
      /** outils pré-autorisés : en mode non interactif, tout outil non autorisé est refusé sans question */
      allowed_tools: z.array(z.string()).default(['Bash', 'WebFetch', 'WebSearch']),
      /** dossiers hors du dépôt accessibles à Claude (--add-dir) ; le dossier de contexte est ajouté d'office */
      add_dirs: z.array(z.string()).default([]),
      extra_args: z.array(z.string()).default([]),
    })
    .prefault({}),

  opencode: z
    .object({
      enabled: z.boolean().default(true),
      /** modèles gratuits par ordre de préférence (les autres suivent) */
      preferred: z.array(z.string()).default(['nemotron-3-ultra-free', 'big-pickle', 'mimo-v2.5-free']),
      /** modèles supplémentaires autorisés (ex. providers payants configurés) */
      extra_models: z.array(z.string()).default([]),
      /** `opencode run` n'a personne pour répondre aux demandes : sans ça, les outils soumis à permission sont refusés */
      auto_approve: z.boolean().default(true),
      /** affiche la réflexion intermédiaire du modèle (`opencode run --thinking`, en grisé) */
      thinking: z.boolean().default(true),
    })
    .prefault({}),

  ollama: z
    .object({
      enabled: z.boolean().default(true),
      base_url: z.string().default('http://localhost:11434'),
      autostart: z.boolean().default(true),
      keep_alive: z.string().default('10m'),
      /** contexte utilisé en mode agent (via variante créée à la volée) */
      agent_num_ctx: z.number().int().default(32768),
      chat_num_ctx: z.number().int().default(8192),
      /** ratio de la RAM utilisable par un modèle local */
      memory_ratio: z.number().min(0.1).max(0.9).default(0.5),
      /** modèle Ollama à préférer quand plusieurs sont installés (vide = le plus gros qui tient) */
      preferred_model: z.string().default(''),
    })
    .prefault({}),

  copilot: z
    .object({
      enabled: z.boolean().default(true),
      mode: z.string().default('agent'),
      /** autorise le routeur à choisir Copilot automatiquement (sinon: seulement via @copilot) */
      auto_route: z.boolean().default(true),
      /** ouvre le dossier du projet dans VS Code avant d'envoyer le prompt */
      open_folder: z.boolean().default(true),
      /** Copilot a des serveurs MCP configurés (Figma…) : l'autorise pour les tâches MCP */
      mcp: z.boolean().default(false),
    })
    .prefault({}),

  /** Mistral Vibe : agent terminal, mode programmatique (`vibe -p`). */
  vibe: z
    .object({
      enabled: z.boolean().default(true),
      /** agent utilisé en mode -p (ask, plan, accept-edits, auto-approve, smart-approve…) */
      agent: z.string().default('auto-approve'),
      /** trust le dossier courant (sinon Vibe ignore la configuration du projet) */
      trust: z.boolean().default(true),
      extra_args: z.array(z.string()).default([]),
    })
    .prefault({}),

  /** Gemini CLI : mode headless (`gemini -p`). */
  gemini: z
    .object({
      enabled: z.boolean().default(true),
      /** auto, ou un modèle précis ("gemini-3.5-flash"…) */
      model: z.string().default('auto'),
      approval_mode: z.enum(['default', 'auto_edit', 'yolo', 'plan']).default('yolo'),
      extra_args: z.array(z.string()).default([]),
    })
    .prefault({}),

  /** aider : `aider --message … --yes` (provider/model via l'environnement ou .aider.conf.yml). */
  aider: z
    .object({
      enabled: z.boolean().default(true),
      /** vide = modèle par défaut d'aider ; sinon "sonnet", "gpt-4o", "gemini/…" */
      model: z.string().default(''),
      auto_commits: z.boolean().default(false),
      extra_args: z.array(z.string()).default([]),
    })
    .prefault({}),

  /** LM Studio : serveur local OpenAI-compatible. */
  lms: z
    .object({
      enabled: z.boolean().default(true),
      base_url: z.string().default('http://localhost:1234'),
      /** démarre `lms server start` si le serveur ne répond pas */
      autostart: z.boolean().default(true),
      temperature: z.number().min(0).max(2).default(0.2),
      max_tokens: z.number().int().min(0).default(0),
      /** modèle LM Studio à préférer quand plusieurs sont chargeables */
      preferred_model: z.string().default(''),
    })
    .prefault({}),

  /** llama.cpp : `llama-server` (OpenAI-compatible) et `llama-cli` (chat local). */
  llamacpp: z
    .object({
      enabled: z.boolean().default(true),
      base_url: z.string().default('http://localhost:8080'),
      /** dossiers scannés à la recherche de modèles .gguf */
      models_dirs: z.array(z.string()).default(['~/models', '~/.cache/huggingface/hub', '~/.lmstudio/models']),
      num_ctx: z.number().int().default(8192),
      n_predict: z.number().int().default(2048),
      temperature: z.number().min(0).max(2).default(0.2),
      extra_args: z.array(z.string()).default([]),
      /** modèle .gguf à préférer quand plusieurs sont trouvés */
      preferred_model: z.string().default(''),
    })
    .prefault({}),

  /** Discovery : recommandations de modèles locaux adaptés à la machine (`/discover`, `cb models recommend`). */
  discovery: z
    .object({
      /** durée de validité du catalogue en cache avant rafraîchissement réseau */
      cache_ttl_hours: z.number().positive().default(24),
      /** part de la mémoire unifiée (Apple Silicon) utilisable par un modèle */
      unified_memory_ratio: z.number().min(0.3).max(0.9).default(0.7),
      /** part de la RAM utilisable pour un modèle sur CPU seul */
      cpu_memory_ratio: z.number().min(0.2).max(0.8).default(0.5),
      /** marge minimale (Go) laissée libre en plus du besoin du modèle (OS, autres processus) */
      headroom_gb: z.number().min(0).default(2),
      /** contexte (tokens) prévu pour estimer le KV cache */
      context_tokens: z.number().int().positive().default(8192),
      /** besoin / mémoire disponible : ≤ comfort = 🟢, ≤ alternative = 🟡, ≤ slow = 🐢, au-delà exclu */
      comfort_ratio: z.number().min(0.1).max(1).default(0.6),
      alternative_ratio: z.number().min(0.1).max(1).default(0.78),
      slow_ratio: z.number().min(0.1).max(1).default(0.88),
      /** débit minimal (tokens/s) d'un LLM 🟢/🟡 ; entre slow_tps et min_tps = 🐢 ; en dessous = exclu */
      min_tps: z.number().positive().default(12),
      slow_tps: z.number().positive().default(6),
      /** un modèle plus vieux que ça (mois, d'après sa date de sortie ou de mise à jour) n'est pas « moderne » */
      max_age_months: z.number().positive().default(15),
      /** signaux de popularité minimaux (téléchargements ou likes) pour écarter les modèles sans traction */
      min_downloads: z.number().min(0).default(500),
      /** nombre max de fiches de tags Ollama interrogées lors d'un rafraîchissement */
      ollama_tag_pages: z.number().int().min(0).default(50),
    })
    .prefault({}),

  /** Surcharges par cible : { "claude:opus": { enabled: false } } */
  targets: z
    .record(z.string(), z.object({ enabled: z.boolean().optional(), level: level.optional() }))
    .default({}),

  privacy: z
    .object({
      /** si le prompt correspond, le cloud est interdit pour cette demande */
      never_cloud_patterns: z
        .array(z.string())
        .default([
          '-----BEGIN [A-Z ]*PRIVATE KEY-----',
          '\\bsk-[A-Za-z0-9_-]{20,}',
          '\\bgh[pousr]_[A-Za-z0-9]{30,}',
          '\\bAKIA[0-9A-Z]{16}\\b',
          '(?:password|passwd|secret|api[_-]?key|token)\\s*[:=]\\s*["\']?[^\\s"\']{8,}',
        ]),
      /** local = traiter en local ; block = refuser */
      action: z.enum(['local', 'block']).default('local'),
    })
    .prefault({}),

  logging: z
    .object({
      /** enregistrer le texte des prompts dans le journal (sinon: métadonnées seulement) */
      content: z.boolean().default(false),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
