import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/ui/commands.js';
import { InputBox } from '../src/ui/InputBox.js';

const tick = () => new Promise((r) => setTimeout(r, 50));

describe('liste des commandes /', () => {
  it('la sélection reste visible quand on descend au-delà de la fenêtre, et quand on remonte', async () => {
    const ui = render(<InputBox disabled={false} placeholder="" history={[]} aliases={[]} width={100} onSubmit={() => {}} onNotice={() => {}} />);
    ui.stdin.write('/');
    await tick();
    for (let i = 0; i < 12; i++) {
      ui.stdin.write('\u001B[B');
      await tick();
    }
    const down = ui.lastFrame()!;
    expect(down).toContain(COMMANDS[12]!.name);
    expect(down).toContain('↑');
    for (let i = 0; i < 12; i++) {
      ui.stdin.write('\u001B[A');
      await tick();
    }
    const up = ui.lastFrame()!;
    expect(up).toContain(COMMANDS[0]!.name);
    expect(up).not.toContain('↑ ');
    ui.unmount();
  });
});
