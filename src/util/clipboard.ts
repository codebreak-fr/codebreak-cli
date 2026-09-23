import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec, which } from './exec.js';

const darwin = process.platform === 'darwin';
const win = process.platform === 'win32';

/** Copie du texte dans le presse-papiers système. Renvoie false si impossible. */
export async function copyText(text: string): Promise<boolean> {
  if (darwin) return (await exec('pbcopy', [], { input: text, timeoutMs: 5000 })).code === 0;
  if (win) {
    const cmd = which('powershell.exe') ?? which('powershell');
    if (!cmd) return false;
    return (await exec(cmd, ['-NoProfile', '-Command', 'Set-Clipboard'], { input: text, timeoutMs: 5000 })).code === 0;
  }
  if (which('xclip')) return (await exec('xclip', ['-selection', 'clipboard'], { input: text, timeoutMs: 5000 })).code === 0;
  if (which('wl-copy')) return (await exec('wl-copy', [], { input: text, timeoutMs: 5000 })).code === 0;
  return false;
}

/** Lit le texte du presse-papiers système ('' si aucun/vide). */
export async function pasteText(): Promise<string> {
  if (darwin) return (await exec('pbpaste', [], { timeoutMs: 5000 })).stdout;
  if (win) {
    const cmd = which('powershell.exe') ?? which('powershell');
    if (!cmd) return '';
    return (await exec(cmd, ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { timeoutMs: 5000 })).stdout;
  }
  if (which('xclip')) {
    const r = await exec('xclip', ['-selection', 'clipboard', '-o'], { timeoutMs: 5000 });
    return r.code === 0 ? r.stdout : '';
  }
  if (which('wl-paste')) return (await exec('wl-paste', ['--no-newline'], { timeoutMs: 5000 })).stdout;
  return '';
}

const IMAGE_TYPES = /PNGf|JPEG|TIFF|8BPS|public\.(png|jpeg|tiff|heic)/i;

/**
 * Lance `cmd` et écrit sa sortie standard directement dans un fichier (sans passer par une chaîne JS,
 * qui corromprait des octets binaires) — utilisé pour récupérer une image du presse-papiers sous X11/Wayland.
 */
function execToFile(cmd: string, args: string[], outPath: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(false);
    }, timeoutMs);
    const out = createWriteStream(outPath);
    let wroteAny = false;
    child.stdout!.on('data', (d: Buffer) => {
      wroteAny = wroteAny || d.length > 0;
    });
    child.stdout!.pipe(out);
    child.on('close', (code) => done(code === 0 && wroteAny));
    child.on('error', () => done(false));
  });
}

/** Détecte si le presse-papiers contient une image (macOS, Windows, X11/Wayland). */
export async function clipboardHasImage(): Promise<boolean> {
  if (darwin) {
    const r = await exec('osascript', ['-e', 'clipboard info'], { timeoutMs: 5000 });
    return r.code === 0 && IMAGE_TYPES.test(r.stdout);
  }
  if (win) {
    const cmd = which('powershell.exe') ?? which('powershell');
    if (!cmd) return false;
    const script = 'Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { Write-Output "yes" }';
    const r = await exec(cmd, ['-NoProfile', '-Command', script], { timeoutMs: 5000 });
    return r.code === 0 && /yes/.test(r.stdout);
  }
  if (which('xclip')) {
    const r = await exec('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], { timeoutMs: 5000 });
    return r.code === 0 && /image\/(png|jpeg)/i.test(r.stdout);
  }
  if (which('wl-paste')) {
    const r = await exec('wl-paste', ['--list-types'], { timeoutMs: 5000 });
    return r.code === 0 && /image\/(png|jpeg)/i.test(r.stdout);
  }
  return false;
}

/** Sauvegarde l'image du presse-papiers (macOS, Windows, X11/Wayland) dans un dossier et renvoie son chemin. */
export async function saveClipboardImage(outDir: string): Promise<string | null> {
  mkdirSync(outDir, { recursive: true });

  if (darwin) {
    for (const clazz of ['PNGf', 'JPEG']) {
      const path = join(outDir, `image-${Date.now()}-${clazz.toLowerCase()}.${clazz === 'PNGf' ? 'png' : 'jpg'}`);
      const script = [
        `set outFile to POSIX file "${escapePath(path)}"`,
        `set d to the clipboard as «class ${clazz}»`,
        `set fp to open for access outFile with write permission`,
        `write d to fp`,
        `close access fp`,
      ].join('\n');
      const r = await exec('osascript', ['-e', script], { timeoutMs: 8000 });
      if (r.code === 0) return path;
    }
    return null;
  }

  if (win) {
    const cmd = which('powershell.exe') ?? which('powershell');
    if (!cmd) return null;
    const path = join(outDir, `image-${Date.now()}.png`);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$img = [System.Windows.Forms.Clipboard]::GetImage()',
      `if ($img -ne $null) { $img.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) }`,
    ].join('; ');
    const r = await exec(cmd, ['-NoProfile', '-Command', script], { timeoutMs: 8000 });
    return r.code === 0 ? path : null;
  }

  if (which('xclip')) {
    const path = join(outDir, `image-${Date.now()}.png`);
    return (await execToFile('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], path)) ? path : null;
  }
  if (which('wl-paste')) {
    const path = join(outDir, `image-${Date.now()}.png`);
    return (await execToFile('wl-paste', ['-t', 'image/png'], path)) ? path : null;
  }
  return null;
}

/** Chemin du dossier de pièces jointes (captures collées via Ctrl+V). */
export function attachmentsDir(): string {
  return join(tmpdir(), 'codebreak-attachments');
}

function escapePath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
