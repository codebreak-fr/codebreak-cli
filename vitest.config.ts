import { defineConfig } from 'vitest/config';

// Les tests d'affichage vérifient les textes français ; l'anglais est couvert par test/i18n.test.ts.
export default defineConfig({ test: { setupFiles: ['./test/setup.ts'] } });
