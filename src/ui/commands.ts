export interface CommandDef {
  name: string;
  description: string;
  /** true si la commande attend un argument (complétion sans exécution) */
  args?: string;
}

export const COMMANDS: CommandDef[] = [
  { name: '/help', description: 'Aide et raccourcis' },
  { name: '/detect', description: 'Redétecte et affiche les LLM installés, le matériel et le quota' },
  { name: '/usage', description: 'Limites d’usage de chaque IA (observées, estimées ou inconnues) et statistiques', args: '[détails|rafraîchir]' },
  { name: '/models', description: 'Cibles de routage + choix guidé du modèle par défaut (2 étapes)', args: '[<ia> [<modèle>]]' },
  { name: '/discover', description: 'Découvre, installe et supprime des modèles locaux adaptés à cette machine', args: '[catégorie]' },
  { name: '/tools', description: 'Active/désactive les outils IA (décoché = jamais appelé)', args: '[on|off <outil…>|reset]' },
  { name: '/context', description: 'Fichier de contexte partagé entre outils (évite le double emploi)', args: '[show|clear|why [tâche]]' },
  { name: '/router', description: 'Choisit le LLM qui joue le rôle de routeur', args: '[ollama|opencode|claude|rules|auto] [modèle]' },
  { name: '/profile', description: 'Profil de routage : eco · balanced · quality', args: '<eco|balanced|quality>' },
  { name: '/use', description: 'Force une cible pour les prochains prompts (auto pour annuler)', args: '<opus|sonnet|haiku|local|free|copilot|gemini|vibe|aider|lms|llama|auto>' },
  { name: '/route', description: 'Simule le routage d’un prompt sans l’exécuter', args: '<prompt>' },
  { name: '/retry', description: 'Relance le dernier prompt sur une cible plus puissante', args: '[cible]' },
  { name: '/permissions', description: 'Permissions de Claude : mode, outils autorisés, dossiers accessibles', args: '[mode|allow|deny|dir|undir …]' },
  { name: '/verify', description: 'Active/désactive la vérification (typecheck, lint, tests)', args: '<on|off>' },
  { name: '/config', description: 'Affiche ou modifie la configuration', args: '[set <clé> <valeur>|path|init]' },
  { name: '/clear', description: 'Efface l’écran' },
  { name: '/exit', description: 'Quitte CodeBreak' },
];

export function matchCommands(value: string): CommandDef[] {
  if (!value.startsWith('/') || value.includes(' ')) return [];
  return COMMANDS.filter((c) => c.name.startsWith(value.toLowerCase()));
}
