# CodeBreak

[English](README.md) · **Français**

Un routeur LLM en ligne de commande, avec une interface qui ressemble à Claude Code. Tu décris ta tâche ; CodeBreak décide **quel outil et quel modèle** l'exécute, puis **vérifie le résultat** et **escalade** si ça n'a pas marché.

Outils pilotés : **Claude Code** (Opus / Sonnet / Haiku), **OpenCode** (modèles gratuits), **Ollama** (modèles locaux), **Copilot** (chat agent de VS Code), **Gemini CLI**, **Mistral Vibe**, **aider**, **LM Studio** et **llama.cpp**.

```
> Renomme la variable foo en bar dans utils.ts
⏺ Route → Ollama ministral-3:8b · complexité 1/5 · deploy/refactor
  ⎿ complexité 1/5 → niveau 0 (profil balanced)
    escalade : Ollama ministral-3:8b → OpenCode Nemotron Ultra → Sonnet
    classifieur : règles (confiance 0.85)

> Analyse cette authentification et corrige les vulnérabilités
⏺ Route → Claude Opus · complexité 4/5 · auth_security · sécurité
  ⎿ sécurité + tâche difficile → Opus préféré
```

## Langue

L'interface et les messages existent en **français et en anglais**. Par défaut CodeBreak suit la langue du système (français si la locale commence par `fr`, anglais sinon). Pour la forcer :

```bash
codebreak --lang fr                # pour cette exécution
codebreak config set language en   # persistant (auto | fr | en)
CODEBREAK_LANG=fr codebreak        # variable d'environnement (prioritaire sur la config)
```

Priorité : `--lang` / `CODEBREAK_LANG` › `language` de la config › locale du système › anglais. Changer la config dans l'interface (`/config set language en`) s'applique immédiatement.

## Installation

Prérequis : Node ≥ 22. Aucun des outils n'est obligatoire : CodeBreak détecte ce qui est installé et route avec ce qu'il trouve.

```bash
npm install
npm run build
npm link            # installe les commandes `codebreak` et `cb`
```

Sans `npm link` : `node dist/cli.js`, ou `npm run dev` pendant le développement.

## Utilisation

```bash
codebreak                        # interface interactive
codebreak "ajoute un test"       # interface interactive, demande déjà envoyée
codebreak -p "ajoute un test"    # non interactif : route, exécute, imprime le résultat
codebreak route "ta demande"     # affiche seulement la décision (--json disponible)
git diff | codebreak -p "relis ce diff"

codebreak detect                 # LLM installés et activés, matériel, MLX, quota (masque les outils décochés dans /tools)
codebreak models                 # cibles de routage
codebreak models recommend [catégorie]  # modèles locaux adaptés à CETTE machine (--json, --refresh)
codebreak models installed       # tous les modèles installés (Ollama, HF, MacWhisper, LM Studio, oMLX)
codebreak models install <nom> --yes · codebreak models remove <nom> --yes
codebreak tools                  # liste les outils IA ([x]/[ ]) — décoché = jamais appelé
codebreak tools off ollama gemini # désactive (persisté) · `on` réactive · `reset` tout active
codebreak models gemini          # modèles d'une IA et défaut actuel (voir plus bas)
codebreak models gemini gemini-2.5-flash   # fixe le modèle par défaut
codebreak usage                  # usage de toutes les IA installées + quota Claude
codebreak config init            # crée ~/.config/codebreak/config.yaml
codebreak config set router.model ministral-3:3b
```

Forcer une cible : préfixe `@opus`, `@sonnet`, `@haiku`, `@local`, `@free`, `@copilot` (ou `--use opus`).

Dans l'interface : `/help`, `/detect`, `/usage`, `/models`, `/discover`, `/tools`, `/context`, `/router`, `/profile`, `/use`, `/route <prompt>` (simulation), `/retry` (relance sur une cible plus puissante), `/verify on|off`, `/config`, `/clear`, `/exit`.
Raccourcis : **Shift+Tab** change de profil, **Esc** interrompt, **Ctrl+C** interrompt / efface / quitte (deux fois), `\` + Entrée pour un saut de ligne, ↑↓ pour l'historique, Tab pour compléter.

### Activer/désactiver des outils IA

`/tools` ouvre la liste à bascule : **Espace** coche/décoche, **Entrée** valide, **Esc** annule, **a** tout activer, **n** tout désactiver. Un outil décoché n'est **jamais appelé** — ni pour exécuter, ni comme routeur LLM, ni via `@alias`/`/use`/`--use` (qui affichent alors « désactivé » et retombent en routage auto) — et disparaît de `/detect` (comme s'il n'était pas installé). `/tools` lui-même montre toujours tout le monde, décochés inclus, pour pouvoir les réactiver. Le choix est persisté (`<outil>.enabled: false` dans `~/.config/codebreak/config.yaml`). En ligne de commande : `codebreak tools`, `codebreak tools off ollama`, `codebreak tools on claude`, `codebreak tools reset`. Même syntaxe dans l'interface, sans la liste : `/tools off ollama gemini`, `/tools reset`.

### Choisir le modèle de chaque IA

`/models` affiche le tableau des cibles de routage puis guide en 2 étapes : **1/2** choisir l'IA (le défaut actuel est rappelé pour chacune), **2/2** choisir son modèle (`auto` = CodeBreak décide). **Esc** à l'étape 1 ne garde que le tableau ; **Esc** à l'étape 2 revient à l'étape 1. Raccourcis : `/models <ia>` va direct à l'étape 2, `/models <ia> <modèle>` applique sans étapes — enregistré dans la config, donc persistant. Équivalent non interactif : `codebreak models [ia] [modèle]`. Claude n'a pas d'entrée ici : le routeur choisit déjà opus/sonnet/haiku selon la tâche et le quota (`@opus` pour forcer ponctuellement).

Pour **OpenCode**, les 8 modèles gratuits du moment sont proposés (dont `opencode/muse-spark-1.3-contributor-free`) : `/models opencode` puis Entrée sur celui voulu, ou direct `/models opencode opencode/muse-spark-1.3-contributor-free` — le routeur le choisira alors en priorité au niveau gratuit. Ponctuellement : `@opencode/muse-spark-1.3-contributor-free fais X` (ou `--use`). Un modèle d'un autre provider configuré dans OpenCode (ex. `anthropic/claude-sonnet-4-5` avec ta clé) se fixe de la même façon et devient routable ; déclare-le aussi dans `opencode.extra_models` pour le voir partout. S'il n'existe pas côté OpenCode, l'exécution échoue et l'escalade prend le relais.

### Discovery : les IA locales adaptées à ta machine

`/discover [catégorie]` (ou `codebreak models recommend`) répond à : *avec cette machine, quelles IA modernes puis-je installer et utiliser confortablement ?* CodeBreak détecte ton matériel (puce, RAM, GPU/VRAM, Metal/CUDA/ROCm, bande passante mémoire), lit les catalogues en ligne (Ollama, Hugging Face, MLX — mis en cache 24 h, `r` ou `--refresh` pour relire) et propose par catégorie **3 modèles au plus + 1 seul « lent »** : Code, Général, Raisonnement, Vision, RAG, Embeddings, Reranking, Voix→texte, Texte→voix, Image, Vidéo, OCR, Agents.

- 🟢 recommandé · 🟡 alternative (marge réduite) · 🐢 lent (un seul par catégorie, légèrement au-dessus de la zone de confort) · 🔴 exclu (jamais montré : OOM, swap, débit inutilisable).
- **Sécurité mémoire** : besoin = poids + KV cache + surcoût runtime, et une marge (`discovery.headroom_gb`, OS/autres apps) doit toujours rester libre. Seuils réglables : `discovery.comfort_ratio`, `alternative_ratio`, `slow_ratio`, `min_tps`, `slow_tps`.
- **Un seul modèle par fournisseur** et par catégorie (jamais deux Qwen), appliqué après le scoring. La liste n'est jamais complétée artificiellement.
- **Modernité sans liste figée** : filtre d'âge (`max_age_months`), signaux d'adoption (`min_downloads`), puis score = qualité (popularité + capacité) · fraîcheur · débit estimé · compatibilité. Les fine-tunes, merges, adaptateurs et dépôts de test sont écartés. Une donnée inconnue (taille, débit) reste « inconnu » et exclut le modèle plutôt que d'être inventée.
- Fiche détaillée (pourquoi recommandé, pourquoi ça tient, source, commande), **Installer** (confirmation puis progression : `ollama pull`, `hf download`) et **Supprimer** (`ollama rm`, purge du dossier du modèle, confirmation, irréversible ; garde-fou : uniquement sous les dossiers de modèles connus). Après installation, `Utiliser ce modèle` le fixe comme défaut Ollama du routeur ; le registre `model-registry.json` garde catégorie, adéquation et débit pour le routage.
- **Inventaire de toutes les IA installées** (`/detect`, `codebreak models installed`) : Ollama, cache Hugging Face (Pocket TTS, Qwen3-TTS…), MacWhisper (Parakeet, WhisperKit), LM Studio, oMLX, Osaurus, whisper.cpp, scripts Parakeet…, et paquets Python d'IA (mlx-audio, torch…). Chaque catégorie affiche aussi ce qui est déjà installé.

### Usage de toutes les IA installées

`/usage` (ou `codebreak usage`) commence par un tableau **par IA installée sur la machine** — pas seulement celles déjà utilisées : statut, coût (gratuit/inclus/abonnement), modèle par défaut, et pour Claude le quota en direct ; pour les autres, le nombre d'exécutions, les tokens consommés et le coût en $ quand le backend le reporte (Claude, OpenCode, Gemini, Vibe, LM Studio, llama.cpp) — ou « jamais utilisé » si détectée mais pas encore routée. Le détail par modèle précis (jour/semaine/tout) suit en dessous, comme avant. Aider et Copilot ne reportent pas de tokens : on y voit les exécutions et la durée moyenne.

### Contexte partagé entre outils (économiser des tokens)

Quand une tâche change d'outil en cours de route (escalade, ou reprise d'une conversation avec un autre backend), CodeBreak tenait à jour un résumé des derniers échanges à réinjecter en clair dans le prompt suivant. Pour les outils qui ont accès au dépôt (tous sauf LM Studio/llama.cpp et Ollama en pur chat), il reçoit désormais à la place une **référence courte** (une ligne) vers un fichier `.md` de contexte tenu à jour par CodeBreak : demandes précédentes, fichiers déjà modifiés, résumé des résultats. Le modèle ne le lit que s'il en a besoin, au lieu de repayer à chaque tour les tokens de tout l'historique — et ça évite qu'un outil ne relise le dépôt en entier ou ne refasse un travail déjà fait par le précédent. `/context` affiche ce fichier, `/context clear` le vide. Un fichier par projet, dans l'état de CodeBreak (jamais dans le dépôt) ; désactivable avec `context.enabled: false`.

### Presse-papiers (copie native de la sélection, collage d'image multi-plateforme)

- **Copier un message :** la sélection par la souris / highlight du terminal copie directement le texte sélectionné ; aucun raccourci `Ctrl+Y` n'est nécessaire. Molette et clic « Aller en bas » sont actifs : pour sélectionner du texte, glisse avec **Option** (macOS) ou **Maj** enfoncé. `CODEBREAK_MOUSE=0` rend la souris au terminal (sélection libre, défilement au clavier avec PageUp/PageDown).
- **Copier du code :** chaque bloc affiche `⧉ Copier le code`. `Ctrl+Shift+C` copie le dernier bloc de code affiché et montre brièvement `Texte copié`.
- **Collage très long :** comme Claude Code, un collage de plus de **800 caractères** ou de plus de **3 lignes** est replié en place en `[Texte collé #N +M lignes]` pour garder la saisie lisible ; le contenu complet est conservé et envoyé tel quel à l'envoi (seuil de lignes abaissé sur une fenêtre courte).
- **Images (macOS, Windows, Linux) :** une image copiée (capture d'écran, ou copiée depuis un explorateur/navigateur) se colle avec **Ctrl+V** : elle est enregistrée dans `$TMPDIR/codebreak-attachments/` et un repère `[Image #N] <chemin>` apparaît dans la saisie — le chemin reste dans le prompt pour que le backend (ex. Claude Code) puisse la lire. macOS via `osascript`, Windows via PowerShell (`System.Windows.Forms.Clipboard`), Linux via `xclip`/`wl-paste` (X11/Wayland).
- **Navigation dans la saisie :** ↑↓ / Ctrl+A · Ctrl+E (ou Home/End) pour les extrémités de ligne, **Ctrl+←/→** ou **Option+←/→** (macOS, selon le terminal) pour sauter de mot en mot, Ctrl+W ou Option+Retour arrière pour effacer le mot précédent, Ctrl+Suppr/Option+Suppr pour effacer le mot suivant. Cmd+←/→ n'atteint jamais un programme terminal (capté par macOS lui-même) : c'est Option qui fait office de saut de mot, comme dans les autres apps du Mac. Pour la même raison, un clic pour positionner le curseur n'est pas proposé : l'activer nécessiterait de capter la souris pour toute l'appli, ce qui casserait la sélection native décrite ci-dessus.

## Comment le routeur décide

```
demande ──► règles (FR/EN, instantanées) ──► sûr de soi ? ──oui──┐
                     │ non                                        │
                     ▼                                            ▼
        LLM routeur (petit modèle local)  ─►  fusion  ─►  politique  ─►  cible + paliers d'escalade
```

1. **Règles déterministes** : catégorie (frontend, backend, auth/sécurité, intégration, légal, contenu, média, SEO/perf, admin, design, déploiement/refactor, tests, question), complexité 1-5, sécurité, MCP/vision, taille de contexte, besoin d'accéder au dépôt.
2. **LLM routeur**, seulement si les règles hésitent (confiance < 0,7) : sortie JSON contrainte par schéma, température 0, résultat mis en cache. Il n'exécute rien et ne choisit pas le modèle : il fournit des *caractéristiques*. Les contraintes critiques des règles (sécurité, MCP) ne peuvent pas être abaissées par le LLM.
3. **Politique** : convertit ces caractéristiques en niveau requis, puis choisit la cible **la moins chère qui suffit**.

| Niveau | Cibles | Coût |
|---|---|---|
| 0 | Ollama · LM Studio · llama.cpp (local, le plus gros modèle qui tient en RAM) | gratuit |
| 1 | OpenCode, modèles gratuits (`nemotron-3-ultra-free`…) · Gemini CLI | gratuit |
| 2 | Claude Haiku · Copilot (VS Code) · Mistral Vibe · aider | quota / inclus / abonnement |
| 3 | Claude Sonnet | quota |
| 4 | Claude Opus | quota |

| Complexité | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `eco` | 0 | 0 | 1 | 3 | 3 |
| `balanced` (défaut) | 0 | 1 | 3 | 3 | 4 |
| `quality` | 1 | 3 | 3 | 4 | 4 |

Règles qui priment sur la complexité : sécurité/auth/légal → **jamais sous Sonnet** ; sécurité + tâche difficile → Opus ; outils MCP (Figma…) → cible compatible MCP ; contexte large → grande fenêtre ; confiance faible → +1 niveau.

### Ménager le quota Claude

Claude Code expose l'utilisation réelle de ses fenêtres 5 h et 7 jours ; CodeBreak la lit (une sonde de ~600 tokens Haiku au plus toutes les 10 min, plus chaque exécution Claude gratuitement) et l'affiche dans la barre du bas.

| Utilisation (max des deux fenêtres) | Effet |
|---|---|
| < 75 % | routage normal |
| ≥ 75 % *tendu* | Opus réservé aux tâches critiques ; complexité 3 → Haiku/Copilot au lieu de Sonnet |
| ≥ 90 % *critique* | Opus interdit ; Sonnet réservé aux tâches qui l'exigent (sécurité, MCP, complexité ≥ 4) |
| ≥ 98 % *coupé* | Claude désactivé, repli signalé |

Un refus « limite atteinte » est retenu 30 min seulement, pour ne pas couper Claude à vie.

### Escalade et vérification

Après chaque tentative qui modifie des fichiers, CodeBreak lance `typecheck`, `lint` et `test` détectés dans `package.json` (ou tes commandes). Il escalade au palier suivant (`ladder: [0, 1, 3, 4]`, 3 essais max) quand :

- le backend échoue (erreur, quota),
- une vérification échoue (la sortie de l'échec est transmise au modèle suivant),
- un modèle gratuit **annonce** une modification mais n'a modifié aucun fichier (constaté avec un modèle 3B qui décrivait l'écriture sans l'exécuter).

Une tâche n'est jamais « réussie » parce que le modèle le dit.

### Confidentialité

Une demande contenant un secret (clé privée, `sk-…`, `password=…`) n'est jamais envoyée au cloud : elle est traitée en local ou refusée (`privacy.action`). Le journal ne contient que des métadonnées, pas le texte des prompts (`logging.content: false`).

## Le rôle de routeur est configurable

`/router` ouvre un sélecteur ; ou `codebreak config set router.provider ollama` / `router.model ministral-3:3b`. En `auto` : petit modèle Ollama → modèle gratuit OpenCode → Claude Haiku → règles seules. `router.mode: never` désactive le LLM ; `always` classe chaque demande.

## Détection automatique

Au lancement (≈ 1 s) : chip, cœurs P/E, GPU, RAM, **Apple Silicon / MLX** (et présence de `mlx`/`mlx-lm` Python), batterie et mode économie d'énergie, budget mémoire pour les modèles locaux (les modèles qui ne tiennent pas sont écartés) ; Claude Code (connexion), OpenCode (modèles gratuits), Ollama (modèles, capacités `tools`/`vision`, démarrage auto du serveur), VS Code (`code chat`), Gemini CLI, Mistral Vibe, aider, LM Studio (`lms`, modèles via l'API OpenAI) et llama.cpp (`llama-server`/`llama-cli`, fichiers GGUF). Les autres CLI LLM trouvés (codex, kimi…) sont listés mais pas routés pour l'instant.

## Ce que fait chaque backend

- **Claude Code** : `claude -p --output-format stream-json --model <alias> --permission-mode acceptEdits --allowedTools Bash,WebFetch,WebSearch`, prompt par stdin. Les sessions sont reprises (`--resume`) d'un tour à l'autre. En mode non interactif, personne ne peut répondre aux demandes de confirmation : tout outil non autorisé est refusé (« The user rejected permission… »). Ajuste `claude.allowed_tools` (ex. `["Bash(git *)", "Bash(npm *)"]`) ou `claude.permission_mode`.
- **OpenCode** : `opencode run -m opencode/<modèle> --format json --thinking`, avec `OPENCODE_PERMISSION={"*":"allow"}` tant que `opencode.auto_approve` vaut `true` (défaut) ; sinon les outils soumis à permission sont refusés. La réflexion intermédiaire du modèle s'affiche en grisé (💭) dans l'interface comme en `-p` ; elle n'est ni copiable ni réinjectée dans le contexte. Coupe-la avec `opencode.thinking: false`.
- **Ollama** : question sans dépôt → chat direct (rapide, en flux). Tâche sur le dépôt → mode agent via OpenCode ; comme OpenCode envoie ~8 000 tokens de consignes, CodeBreak crée une variante `codebreak-<modèle>:ctx32k` du modèle (métadonnées seulement, aucune copie de poids ; masquée dans l'interface) avec un contexte plus grand. Les modèles sans capacité `tools` restent en chat.
- **Copilot** : Copilot n'a pas d'API en ligne de commande. CodeBreak ouvre le projet dans VS Code puis lance `code chat -m agent`. C'est une **passation** : la suite se passe dans l'éditeur, sans vérification ni escalade. Sélectionné automatiquement seulement quand le quota Claude est tendu (désactivable : `copilot.auto_route: false`).
- **Gemini CLI** : `gemini -p … --output-format stream-json --approval-mode <mode> --skip-trust`, sortie NDJSON (texte en flux, outils, usage). Gratuit à faible volume ; les erreurs de quota font escalader. Si le modèle par défaut répond **503 / saturé**, le CLI réessaie en interne (Esc pour interrompre) : réessaie plus tard ou change de modèle (`/models gemini <modèle>`, ex. un `flash`).
- **Mistral Vibe** : `vibe -p … --output streaming --agent <mode> --trust`, entrées JSON par ligne (messages et effets d'outils). Nécessite un abonnement Mistral payant : sans lui, chaque appel échoue en **402** avec un message explicite et fait escalader (ou `/tools off vibe` pour l'exclure).
- **aider** : `aider --message … --yes --no-pretty --no-auto-commits …`. Aider n'expose pas de flux : CodeBreak affiche sa sortie nettoyée et se fie aux vérifications pour escalader.
- **LM Studio** : serveur OpenAI-compatible (`http://localhost:1234`), démarré via `lms server start` si `lms.autostart`. Une cible par modèle installé.
- **llama.cpp** : `llama-server` en marche → API OpenAI (`http://localhost:8080`) ; sinon génération ponctuelle avec `llama-cli` sur le GGUF. Une cible par fichier trouvé dans `llamacpp.models_dirs`.

## Configuration

`~/.config/codebreak/config.yaml` (créé par `codebreak config init`), surchargé par `.codebreak.yaml` dans un projet. Référence complète et commentée : [`examples/config.yaml`](examples/config.yaml). Aucun nom de modèle n'est codé en dur pour Claude/Ollama : ils viennent de la détection. Variable `CODEBREAK_HOME` pour tout isoler dans un dossier.

État : `~/.local/state/codebreak/` (`ledger.jsonl` journal des décisions et résultats, `claude-usage.json` quota, cache du classifieur, historique des prompts).

## Limites connues

- Copilot : passation sans retour (pas de sortie capturée).
- aider : sortie non structurée (pas de flux d'outils) ; l'escalade repose sur les vérifications.
- Vibe exige un abonnement Mistral payant ; un refus (402) fait escalader.
- LM Studio et llama.cpp n'apparaissent que si des modèles sont installés/découverts.
- Le quota Claude n'est lu qu'à travers Claude Code (sonde + exécutions) ; l'usage de Claude Code interactif en parallèle apparaît au prochain rafraîchissement.
- Les modèles gratuits d'OpenCode changent avec le temps : ajuste `opencode.preferred`.
- Le mode agent local est lent au premier appel (chargement du modèle + préremplissage de ~9 000 tokens).
- L'« économie estimée » de `/usage` compare les tokens des cibles gratuites au tarif API de Sonnet ; c'est un ordre de grandeur, pas une facture.

## Développement

```bash
npm test            # vitest (routage, politique, escalade, parseurs, config…)
npm run typecheck
npm run build       # tsup → dist/cli.js
```

Structure : `src/catalog` (Discovery : sources, compatibilité, classement, installateur) · `src/commands` (parsing partagé CLI/TUI) · `src/detect` (matériel, backends, inventaire) · `src/router` (règles, classifieur, politique, cibles) · `src/backends` (adaptateurs) · `src/exec` (runner, vérification, git, contexte partagé) · `src/usage` (quota, journal) · `src/ui` (TUI Ink).

### Traduire

Tout texte visible passe par `t('texte français')` (`src/i18n/index.ts`) ; la traduction anglaise est dans `src/i18n/en.ts`, indexée par le texte français, avec des `{nom}` pour les variables. `test/i18n.test.ts` échoue si une chaîne n'a pas de traduction, si une traduction a une variable inconnue ou si une entrée est inutilisée ; `test/i18n-render.test.tsx` rend les écrans en anglais et échoue s'il reste du français. Pour ajouter une langue : ajouter son dictionnaire et étendre `Lang` dans `src/i18n/index.ts`.
