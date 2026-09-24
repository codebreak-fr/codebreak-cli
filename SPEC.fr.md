# CodeBreak (`cb`) — spécification pour LLM

[English](SPEC.md) · **Français**

> Ce document décrit l'outil en ligne de commande `cb` (alias de `codebreak`) pour qu'un LLM puisse l'expliquer, l'utiliser ou l'appeler correctement. Tout ce qui est écrit ici vient du code du dépôt.

## 1. Résumé

`cb` est un **routeur de LLM en CLI** (Node ≥ 22, TypeScript, TUI Ink). L'utilisateur décrit une tâche de développement. `cb` :

1. **Classe** la tâche (catégorie, complexité 1–5, sécurité, besoin MCP/vision, taille de contexte, accès au dépôt) ;
2. **Choisit** l'outil IA et le modèle **le moins cher qui suffit** ;
3. **Exécute** la tâche via le CLI ou l'API de cet outil ;
4. **Vérifie** le résultat (typecheck, lint, tests) ;
5. **Escalade** vers une cible plus puissante si ça échoue.

`cb` n'est **pas** un modèle : il pilote des outils existants. Aucun n'est obligatoire ; il détecte ce qui est installé. L'interface existe en français et en anglais (`--lang fr|en|auto`, `language` dans la config, `CODEBREAK_LANG`).

## 2. Outils pilotés

| Backend | Rôle | Niveau | Coût |
|---|---|---|---|
| Ollama, LM Studio, llama.cpp | modèles locaux | 0 | gratuit |
| OpenCode (modèles free), Gemini CLI | cloud gratuit | 1 | gratuit |
| Claude Haiku, Copilot (VS Code), Mistral Vibe, aider | intermédiaire | 2 | quota / abonnement |
| Claude Sonnet | fort | 3 | quota |
| Claude Opus | le plus fort | 4 | quota |

Copilot est une **passation** : `code chat -m agent` ouvre VS Code, sans sortie capturée, sans vérification ni escalade. Vibe exige un abonnement Mistral payant (sinon erreur 402 puis escalade).

## 3. Installation

```bash
npm install && npm run build && npm link   # installe `codebreak` et `cb`
node dist/cli.js                           # sans npm link
npm run dev                                # développement (tsx)
```

## 4. Interface en ligne de commande

### Usage général

```
cb                          TUI interactive
cb "demande"                TUI, demande déjà envoyée
cb -p "demande"             non interactif : route, exécute, imprime le résultat
cb route "demande" [--json] affiche seulement la décision de routage
git diff | cb -p "relis ce diff"     # stdin accepté
```

### Options

| Option | Effet |
|---|---|
| `-p`, `--print` | mode non interactif |
| `--use <cible>` | force la cible : `opus sonnet haiku local free copilot gemini vibe aider lms llama` |
| `--profile <p>` | `eco` \| `balanced` \| `quality` |
| `--router <fournisseur[:modèle]>` | qui classe la tâche : `ollama:ministral-3:3b`, `opencode`, `claude:haiku`, `rules` |
| `--dry-run` | avec `-p` : décision sans exécution |
| `--json` | sortie JSON |
| `--cwd <dossier>` | dossier de travail |
| `--lang <l>` | `fr` \| `en` \| `auto` : langue de l'interface |
| `-q`, `--quiet` | moins de messages |
| `--refresh` | (`models recommend\|install`) relit le catalogue en ligne |
| `-y`, `--yes` | confirme `models install\|remove` sans question |
| `-v`, `--version` · `-h`, `--help` | |

Préfixes dans la demande pour forcer une cible : `@opus`, `@sonnet`, `@haiku`, `@local`, `@free`, `@copilot`, `@opencode/<modèle>`.
Exemple : `cb -p "@sonnet refactore src/auth.ts"`.

### Sous-commandes

| Commande | Effet |
|---|---|
| `cb detect` | LLM installés/activés, matériel (chip, RAM, GPU/VRAM, MLX), inventaire des IA locales (MacWhisper, HF, LM Studio, oMLX…), quota Claude |
| `cb models` | cibles de routage |
| `cb models recommend [catégorie] [--json] [--refresh]` | modèles locaux adaptés à la machine (3 max + 1 lent par catégorie, 1 par fournisseur) |
| `cb models installed` | tous les modèles installés (Ollama, HF, MacWhisper, LM Studio, oMLX) |
| `cb models install <nom> --yes` / `cb models remove <nom> --yes` | installe / supprime |
| `cb tools` | liste des outils `[x]`/`[ ]` |
| `cb tools off <outil…>` / `on <outil…>` / `reset` | active/désactive (persisté). Un outil décoché n'est **jamais appelé** |
| `cb models <ia>` / `cb models <ia> <modèle>` | modèles d'une IA / fixe son modèle par défaut (persisté) |
| `cb usage` | usage de toutes les IA installées + quota Claude |
| `cb config init` | crée `~/.config/codebreak/config.yaml` |
| `cb config set <clé> <valeur>` | ex. `router.model ministral-3:3b` |

### Codes de sortie
`2` = cible inconnue ou désactivée (`--use`). Les autres cas suivent le résultat de l'exécution (0 = succès).

## 5. Commandes de la TUI

`/help /detect /usage /models /discover [catégorie] /tools /context /router /profile /use /route <prompt> /retry /verify on|off /config /clear /exit`

- `/route <prompt>` simule sans exécuter ; `/retry` relance sur une cible plus puissante.
- `/models` : étape 1/2 choisir l'IA, étape 2/2 choisir le modèle (`auto` = cb décide). `/models <ia> <modèle>` applique directement.
- `/context` affiche le fichier de contexte partagé ; `/context clear` le vide.

Raccourcis : Shift+Tab (change de profil), Esc (interrompt), Ctrl+C (interrompt / efface / quitte), `\`+Entrée (saut de ligne), ↑↓ historique, Tab complétion, Ctrl+V colle une image, Ctrl+Shift+C copie le dernier bloc de code.

## 6. Algorithme de routage

```
demande → règles déterministes (FR/EN) → confiance ≥ 0.7 ? ─oui─┐
                    │ non                                        │
                    ▼                                            ▼
     LLM routeur (petit modèle, JSON contraint) → fusion → politique → cible + échelle d'escalade
```

1. **Règles** : catégorie (frontend, backend, auth_security, intégration, légal, contenu, média, SEO/perf, admin, design, deploy/refactor, tests, question), complexité 1–5, sécurité, MCP/vision, taille de contexte, accès au dépôt.
2. **LLM routeur** seulement si confiance < 0.7 : température 0, sortie JSON, résultat en cache. Il fournit des *caractéristiques*, jamais le choix du modèle. Il ne peut pas abaisser les contraintes critiques des règles (sécurité, MCP). Ordre en `auto` : petit modèle Ollama → modèle gratuit OpenCode → Claude Haiku → règles seules. `router.mode` : `never` (jamais de LLM), `always` (toujours).
3. **Politique** : caractéristiques → niveau requis → cible la moins chère qui convient.

### Profil × complexité → niveau

| Complexité | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `eco` | 0 | 0 | 1 | 3 | 3 |
| `balanced` (défaut) | 0 | 1 | 3 | 3 | 4 |
| `quality` | 1 | 3 | 3 | 4 | 4 |

### Règles prioritaires
- sécurité / auth / légal → jamais sous Sonnet ;
- sécurité + tâche difficile → Opus ;
- outils MCP (ex. Figma) → cible compatible MCP ;
- gros contexte → grande fenêtre ;
- faible confiance → +1 niveau.

### Quota Claude
Lu depuis Claude Code (fenêtres 5 h et 7 j ; sonde ~600 tokens Haiku au plus toutes les 10 min).

| Usage (max des 2 fenêtres) | Effet |
|---|---|
| < 75 % | normal |
| ≥ 75 % | Opus réservé aux tâches critiques ; complexité 3 → Haiku/Copilot |
| ≥ 90 % | Opus interdit ; Sonnet réservé (sécurité, MCP, complexité ≥ 4) |
| ≥ 98 % | Claude désactivé |

Un refus « limite atteinte » n'est retenu que 30 min.

## 7. Exécution, vérification, escalade

- Après chaque tentative qui modifie des fichiers : `typecheck`, `lint`, `test` (détectés dans `package.json` ou commandes configurées).
- Échelle par défaut `ladder: [0, 1, 3, 4]`, **3 essais max**.
- Escalade si : le backend échoue (erreur/quota) ; une vérification échoue (la sortie est transmise au modèle suivant) ; un modèle gratuit annonce une modification sans avoir modifié de fichier.
- Principe : une tâche n'est jamais « réussie » parce que le modèle le dit.

## 8. Contexte partagé entre outils

Lors d'un changement d'outil (escalade ou reprise), les backends ayant accès au dépôt reçoivent une **référence d'une ligne** vers un `.md` tenu par cb (demandes précédentes, fichiers modifiés, résumé), au lieu de l'historique complet. Un fichier par projet, stocké dans l'état de cb, jamais dans le dépôt. Désactivable : `context.enabled: false`. LM Studio, llama.cpp et Ollama en chat pur reçoivent un résumé en clair.

## 9. Confidentialité

Une demande contenant un secret (clé privée, `sk-…`, `password=…`) n'est **jamais envoyée au cloud** : traitée en local ou refusée (`privacy.action`). Le journal ne contient que des métadonnées (`logging.content: false`).

## 10. Commandes exécutées par backend

- **Claude Code** : `claude -p --output-format stream-json --model <alias> --permission-mode acceptEdits --allowedTools Bash,WebFetch,WebSearch`, prompt sur stdin, `--resume` entre tours. Réglages : `claude.allowed_tools`, `claude.permission_mode`.
- **OpenCode** : `opencode run -m opencode/<modèle> --format json --thinking`, `OPENCODE_PERMISSION={"*":"allow"}` si `opencode.auto_approve` (défaut true). Réflexion affichée en grisé ; `opencode.thinking: false` la coupe.
- **Ollama** : question sans dépôt → chat direct ; tâche sur le dépôt → agent via OpenCode avec une variante `codebreak-<modèle>:ctx32k` (métadonnées seules). Modèles sans capacité `tools` → chat.
- **Gemini CLI** : `gemini -p … --output-format stream-json --approval-mode <mode> --skip-trust`.
- **Mistral Vibe** : `vibe -p … --output streaming --agent <mode> --trust`.
- **aider** : `aider --message … --yes --no-pretty --no-auto-commits` (pas de flux ; escalade via vérifications).
- **LM Studio** : API OpenAI-compatible `http://localhost:1234` (`lms server start` si `lms.autostart`).
- **llama.cpp** : `llama-server` (API `http://localhost:8080`) sinon `llama-cli` sur un GGUF (`llamacpp.models_dirs`).

## 11. Configuration et fichiers

- Global : `~/.config/codebreak/config.yaml` ; projet : `.codebreak.yaml` (surcharge). Référence commentée : `examples/config.yaml`.
- État : `~/.local/state/codebreak/` — `ledger.jsonl` (décisions/résultats), `claude-usage.json`, cache du classifieur, historique des prompts.
- `CODEBREAK_HOME` isole tout dans un dossier ; `CODEBREAK_MOUSE=0` rend la souris au terminal.
- Aucun nom de modèle Claude/Ollama n'est codé en dur : ils viennent de la détection.
- Clés utiles : `<outil>.enabled`, `router.provider`, `router.model`, `router.mode`, `opencode.preferred`, `opencode.extra_models`, `copilot.auto_route`, `privacy.action`, `context.enabled`, `logging.content`.

## 12. Limites connues

- Copilot : passation sans retour ; aider : sortie non structurée.
- LM Studio / llama.cpp n'apparaissent que si des modèles existent.
- Quota Claude lu seulement via Claude Code (rafraîchi avec délai).
- Modèles gratuits OpenCode variables : ajuster `opencode.preferred`.
- Mode agent local lent au premier appel (~9 000 tokens de préremplissage).
- L'« économie estimée » de `/usage` est un ordre de grandeur (tarif API Sonnet), pas une facture.
- Autres CLI détectés (codex, kimi…) : listés, pas routés.

## 13. Structure du code

`src/detect` (matériel, backends) · `src/router` (règles, classifieur, politique, cibles) · `src/backends` (adaptateurs) · `src/exec` (runner, vérification, git, contexte) · `src/usage` (quota, journal) · `src/ui` (TUI Ink) · `src/cli.tsx` (entrée, args) · `src/oneshot.ts` (mode `-p`). Tests : `npm test` (vitest), `npm run typecheck`, `npm run build` (tsup → `dist/cli.js`).

## 14. Exemples

```bash
cb route "Renomme foo en bar dans utils.ts" --json
# → primary: ollama, complexité 1, chaîne d'escalade: ollama → opencode → sonnet

cb -p --profile quality "Analyse l'auth et corrige les vulnérabilités"
# → Claude Opus (sécurité + tâche difficile)

cb -p --use free "Explique ce code" < src/router/policy.ts
cb tools off vibe gemini
cb models opencode opencode/muse-spark-1.3-contributor-free
```

## 15. Conseils pour un LLM qui appelle `cb`

- Pour connaître le choix sans coût : `cb route "<prompt>" --json` ou `cb -p --dry-run --json`.
- En non interactif, toujours `-p` ; les confirmations d'outils non autorisés sont refusées automatiquement.
- Pour forcer un modèle : `--use` ou préfixe `@alias`, sinon laisser le routeur décider.
- Ne pas supposer qu'un outil est disponible : vérifier avec `cb detect` / `cb tools`.
- Ne jamais mettre de secrets dans le prompt.
