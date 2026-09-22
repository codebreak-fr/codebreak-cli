import { describe, expect, it } from 'vitest';
import { analyzeByRules, mergeFeatures } from '../src/router/heuristics.js';

describe('heuristiques', () => {
  it('petite tâche triviale → complexité basse', () => {
    const f = analyzeByRules('Renomme la variable foo en bar dans utils.ts');
    expect(f.complexity).toBeLessThanOrEqual(2);
    expect(f.needsEdit).toBe(true);
    expect(f.security).toBe(false);
  });

  it('détecte la sécurité et relève la catégorie', () => {
    const f = analyzeByRules('Analyse cette authentification et corrige les vulnérabilités de session');
    expect(f.security).toBe(true);
    expect(f.category).toBe('auth_security');
    expect(f.complexity).toBeGreaterThanOrEqual(3);
  });

  it('Figma → MCP + vision', () => {
    const f = analyzeByRules('Reproduis ce design Figma dans le projet : https://figma.com/design/abc');
    expect(f.needsMcp).toBe(true);
    expect(f.vision).toBe(true);
  });

  it('question générale sans dépôt', () => {
    const f = analyzeByRules("c'est quoi un JWT ?");
    expect(f.needsEdit).toBe(false);
    expect(f.needsRepo).toBe(false);
    expect(f.category === 'question' || f.security).toBe(true);
  });

  it('tâche large et multi-étapes → complexité haute', () => {
    const f = analyzeByRules(
      "Refonte complète de l'architecture : 1. migre le contenu des fichiers vers la base 2. ajoute les rôles 3. mets à jour toute l'app puis déploie",
    );
    expect(f.complexity).toBeGreaterThanOrEqual(4);
    expect(f.contextSize).toBe('large');
  });

  it('accents et anglais', () => {
    expect(analyzeByRules('Fix the XSS vulnerability in the login form').security).toBe(true);
    expect(analyzeByRules('Ajoute un test pour cette fonction').category).toBe('testing');
  });

  it('confiance faible sur un prompt très court', () => {
    expect(analyzeByRules('page login').confidence).toBeLessThan(0.7);
  });

  it('la fusion garde la sécurité des règles et prend la complexité la plus haute en cas de gros écart', () => {
    const rules = analyzeByRules('Corrige la faille XSS sur le formulaire de connexion');
    const merged = mergeFeatures(rules, { complexity: 1, security: false, category: 'chore' });
    expect(merged.security).toBe(true);
    expect(merged.category).toBe('auth_security');
    const rules2 = analyzeByRules('Renomme foo en bar');
    const merged2 = mergeFeatures(rules2, { complexity: 5 });
    expect(merged2.complexity).toBe(5);
  });
});

describe('heuristiques — cas réels', () => {
  it('générer une image OG n’est pas de la vision en entrée', () => {
    expect(analyzeByRules("Génère les favicons et l'image OG en pixel art").vision).toBe(false);
    expect(analyzeByRules('Reproduis cette maquette en React').vision).toBe(true);
  });
  it('correction de vulnérabilités → complexité ≥ 4 (Opus préféré)', () => {
    const f = analyzeByRules('Analyse cette authentification et corrige les vulnérabilités');
    expect(f.complexity).toBeGreaterThanOrEqual(4);
  });
  it('refonte d’architecture → complexité 5', () => {
    const f = analyzeByRules(
      "Refonte complète de l'architecture : migre le contenu des fichiers vers la base, ajoute les rôles puis déploie",
    );
    expect(f.complexity).toBe(5);
  });
});
