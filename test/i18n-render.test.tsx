import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../src/catalog/registry.js';
import { setLang } from '../src/i18n/index.js';
import { Footer } from '../src/ui/Footer.js';
import { ItemView, type Item } from '../src/ui/items.js';
import { Picker } from '../src/ui/Picker.js';
import { ToolsPicker } from '../src/ui/ToolsPicker.js';
import { InputBox } from '../src/ui/InputBox.js';
import { AllAiUsagePanel, Environment, HelpPanel, ModelsTable, RouteView, UsagePanel, Welcome } from '../src/ui/panels.js';
import { buildTargets } from '../src/router/targets.js';
import { decisionOf, defaultCfg, detection, targetsOf } from './helpers.js';
import { apple16, detWith, mk, NOW } from './catalog-helpers.js';

const catalog: Catalog = { models: [mk({ name: 'alpha:8b', provider: 'Alpha', categories: ['general'], capabilities: ['tools'], sizeGB: 5, paramsB: 8 })], fetchedAt: NOW, errors: [], stale: false };
vi.mock('../src/catalog/registry.js', async (orig) => ({ ...(await orig<typeof import('../src/catalog/registry.js')>()), loadCatalog: async () => catalog }));
const { Discovery } = await import('../src/ui/discovery/Discovery.js');

// du français qui trahit une chaîne non traduite (accents, mots courants)
const FRENCH = /[àâçéèêëîïôûùüœ]|(?<![\w-])(le|la|les|des|pour|avec|aucun|aucune|modèle|modèles|outil|outils|installé|installés|sans|dans|est|une|jamais)(?![\w-])/i;

afterEach(() => setLang('fr'));

const frame = async (node: React.ReactElement, wait = 80) => {
  const ui = render(node);
  await new Promise((r) => setTimeout(r, wait));
  const f = ui.lastFrame() ?? '';
  ui.unmount();
  return f;
};

describe('aucun français résiduel en anglais', () => {
  it('panneaux d’état et d’aide', async () => {
    setLang('en');
    const cfg = defaultCfg();
    const targets = buildTargets(detection, cfg);
    const frames: Record<string, string> = {
      help: await frame(<HelpPanel />),
      env: await frame(<Environment det={detection} usage={null} cfg={cfg} router={null} />),
      models: await frame(<ModelsTable targets={targets} />),
      route: await frame(<RouteView decision={decisionOf([Object.values(targetsOf())[0]!])} />),
      welcome: await frame(<Welcome version="1" cwd="/tmp" det={detection} usage={null} cfg={cfg} router={null} />),
      usage: await frame(<AllAiUsagePanel det={detection} cfg={cfg} usage={null} entries={[]} />),
    };
    const leaks = Object.entries(frames).flatMap(([name, f]) => f.split('\n').filter((l) => FRENCH.test(l)).map((l) => `${name}: ${l.trim()}`));
    expect(leaks).toEqual([]);
  });

  it('éléments d’historique, pied de page, sélecteurs et saisie', async () => {
    setLang('en');
    const cfg = defaultCfg();
    const target = Object.values(targetsOf())[0]!;
    const items: Item[] = [
      { id: 1, kind: 'route', decision: decisionOf([target]) },
      { id: 2, kind: 'escalate', from: target, to: target, reason: 'x' },
      { id: 3, kind: 'done', ok: true, target, ms: 1500, tokens: 1200, costUsd: 0.02, verified: true, handoff: false },
      { id: 4, kind: 'done', ok: false, target, ms: 800, tokens: 0, costUsd: 0, handoff: true, message: 'x' },
      { id: 5, kind: 'verify', result: { ok: false, steps: [{ command: 'npm test', ok: false, output: 'boom', ms: 100, exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }] } },
      { id: 6, kind: 'info', text: 'ok' },
    ];
    const frames: Record<string, string> = {};
    for (const it of items) frames[`item${it.id}`] = await frame(<ItemView item={it} />);
    frames.footer = await frame(<Footer cfg={{ ...cfg, verify: { ...cfg.verify, mode: 'off' } }} usage={null} router={null} forced="opus" cwd="/tmp/x" columns={140} />);
    frames.picker = await frame(<Picker title="T" options={[{ label: 'a', value: 1 }]} onSelect={() => {}} onCancel={() => {}} />);
    frames.tools = await frame(<ToolsPicker cfg={cfg} det={detection} onSubmit={() => {}} onCancel={() => {}} />);
    frames.input = await frame(<InputBox disabled={false} placeholder="" history={[]} aliases={[]} width={100} onSubmit={() => {}} onNotice={() => {}} />);
    const leaks = Object.entries(frames).flatMap(([name, f]) => f.split('\n').filter((l) => FRENCH.test(l)).map((l) => `${name}: ${l.trim()}`));
    expect(leaks).toEqual([]);
  });

  it('Discovery : catégories, liste, fiche, pourquoi, confirmation', async () => {
    setLang('en');
    const det = detWith(apple16, { ollama: { ...detWith(apple16).ollama, models: [{ name: 'alpha:8b', sizeGB: 5, capabilities: ['completion'], fits: true, loaded: false }] } });
    const ui = render(<Discovery det={det} cfg={defaultCfg()} onClose={() => {}} onDetect={async () => det} onUse={() => {}} onRemoved={() => {}} onNotice={() => {}} />);
    const tick = () => new Promise((r) => setTimeout(r, 70));
    const seen: string[] = [];
    const snap = async (keys: string) => { ui.stdin.write(keys); await tick(); seen.push(ui.lastFrame() ?? ''); };
    await tick();
    seen.push(ui.lastFrame() ?? '');
    await snap('\u001B[B'); // General
    await snap('\r'); // liste
    await snap('\r'); // fiche
    await snap('\u001B[B'); // pourquoi (2e entrée après Utiliser)
    await snap('\r');
    await snap('\u001B'); // retour fiche
    await snap('\u001B[B\u001B[B\r'); // Supprimer → confirmation
    ui.unmount();
    const leaks = seen.flatMap((f, i) => f.split('\n').filter((l) => FRENCH.test(l)).map((l) => `#${i}: ${l.trim()}`));
    expect(leaks).toEqual([]);
  });
});
