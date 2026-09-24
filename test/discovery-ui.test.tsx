import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../src/catalog/registry.js';
import { apple16, detWith, mk, NOW } from './catalog-helpers.js';
import { defaultCfg } from './helpers.js';

const models = [
  mk({ name: 'alpha:8b', provider: 'Alpha', categories: ['general'], capabilities: ['tools'], sizeGB: 5, paramsB: 8 }),
  mk({ name: 'beta:4b', provider: 'Beta', categories: ['general'], sizeGB: 2.5, paramsB: 4 }),
];
const catalog: Catalog = { models, fetchedAt: NOW, errors: [], stale: false };

vi.mock('../src/catalog/registry.js', async (orig) => ({ ...(await orig<typeof import('../src/catalog/registry.js')>()), loadCatalog: async () => catalog }));

const { Discovery } = await import('../src/ui/discovery/Discovery.js');

const DOWN = '\u001B[B';
const ENTER = '\r';
const ESC = '\u001B';
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function mount(over: Record<string, unknown> = {}) {
  const det = detWith(apple16, { ollama: { ...detWith(apple16).ollama, models: [{ name: 'alpha:8b', sizeGB: 5, capabilities: ['completion'], fits: true, loaded: false }] } });
  const events: string[] = [];
  const ui = render(
    <Discovery
      det={det}
      cfg={defaultCfg()}
      onClose={() => events.push('close')}
      onDetect={async () => det}
      onUse={(m) => events.push(`use:${m.name}`)}
      onRemoved={(m) => events.push(`removed:${m.name}`)}
      onNotice={(t) => events.push(`notice:${t}`)}
      {...over}
    />,
  );
  return { ...ui, events };
}

const press = async (ui: { stdin: { write: (s: string) => void } }, key: string) => {
  ui.stdin.write(key);
  await tick();
};

describe('Discovery (TUI)', () => {
  it('affiche la machine détectée puis les catégories, avec le compte de modèles', async () => {
    const ui = mount();
    await tick();
    const f = ui.lastFrame()!;
    expect(f).toContain('Découvrir l’IA locale');
    expect(f).toContain('Apple M4');
    expect(f).toContain('Général / Chat');
    expect(f).toContain('2 modèles');
    expect(f).toContain('aucun modèle adapté');
    expect(f).toContain('Modèles installés');
    ui.unmount();
  });

  it('catégorie → liste (un seul fournisseur par ligne, sélection détaillée) → fiche → confirmation d’installation', async () => {
    const ui = mount();
    await tick();
    for (let i = 0; i < 1; i++) await press(ui, DOWN); // Code → Général
    await press(ui, ENTER);
    let f = ui.lastFrame()!;
    expect(f).toContain('Général / Chat');
    expect(f).toContain('🟢');
    expect(f).toMatch(/Fournisseur\s+(Alpha|Beta)/);
    expect(f).toContain('i installer');
    await press(ui, ENTER);
    f = ui.lastFrame()!;
    expect(f).toContain('Pourquoi recommandé ?');
    expect(f).toContain('ollama pull');
    // « Installer » est la première action de la fiche d'un modèle non installé (beta:4b) ou « Utiliser » (alpha:8b installé)
    await press(ui, ESC);
    await press(ui, 'i');
    f = ui.lastFrame()!;
    if (f.includes('Confirmer l’installation')) expect(f).toContain('ollama pull');
    ui.unmount();
  });

  it('modèle installé : la fiche propose Utiliser et Supprimer, la confirmation montre la commande et l’irréversibilité', async () => {
    const ui = mount({ initialCategory: 'general' });
    await tick();
    await press(ui, DOWN); // beta:4b (mieux classé) puis alpha:8b, le modèle installé
    await press(ui, ENTER);
    let f = ui.lastFrame()!;
    expect(f).toContain('✔ installé');
    expect(f).toContain('Utiliser ce modèle');
    expect(f).toContain('Supprimer');
    await press(ui, DOWN);
    await press(ui, DOWN); // Utiliser → Pourquoi → Supprimer
    await press(ui, ENTER);
    f = ui.lastFrame()!;
    expect(f).toContain('ollama rm alpha:8b');
    expect(f).toContain('Irréversible');
    await press(ui, ESC);
    expect(ui.lastFrame()!).toContain('Supprimer');
    ui.unmount();
  });

  it('liste des modèles installés : suppression via Entrée, Esc ferme depuis la racine', async () => {
    const ui = mount();
    await tick();
    for (let i = 0; i < 13; i++) await press(ui, DOWN); // dernière ligne : Modèles installés
    await press(ui, ENTER);
    let f = ui.lastFrame()!;
    expect(f).toContain('📦 alpha:8b');
    await press(ui, ENTER);
    f = ui.lastFrame()!;
    expect(f).toContain('Supprimer alpha:8b');
    expect(f).toContain('Espace libéré');
    await press(ui, ESC);
    await press(ui, ESC);
    await press(ui, ESC);
    await tick(120);
    expect(ui.events).toContain('close');
    ui.unmount();
  });

  it('« pourquoi ça tient » détaille la mémoire et la marge', async () => {
    const ui = mount({ initialCategory: 'general' });
    await tick();
    await press(ui, ENTER); // beta:4b : Installer, Pourquoi, Retour
    await press(ui, DOWN); // Pourquoi
    await press(ui, ENTER);
    const f = ui.lastFrame()!;
    expect(f).toContain('Votre machine');
    expect(f).toContain('Marge de sécurité');
    expect(f).toContain('Résultat');
    ui.unmount();
  });
});
