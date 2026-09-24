import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCatalog, type Catalog } from '../../catalog/index.js';
import type { Config } from '../../config/schema.js';
import type { HardwareInfo } from '../../detect/types.js';

export type CatalogState = { status: 'loading'; progress: string; startedAt: number } | { status: 'ready'; catalog: Catalog };

/** Charge le catalogue (cache d'abord, réseau si périmé) ; `refresh()` force une nouvelle lecture des sources. */
export function useCatalog(cfg: Config, hw: HardwareInfo) {
  const [state, setState] = useState<CatalogState>({ status: 'loading', progress: '', startedAt: Date.now() });
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  // clé stable : la config est rechargée (nouvel objet) à chaque /config set, sans que le catalogue change
  const settings = JSON.stringify(cfg.discovery);
  const load = useCallback(
    (refresh: boolean) => {
      setState({ status: 'loading', progress: '', startedAt: Date.now() });
      void loadCatalog(cfg, hw, {
        refresh,
        onProgress: (progress) => alive.current && setState((s) => (s.status === 'loading' ? { ...s, progress } : s)),
      }).then((catalog) => alive.current && setState({ status: 'ready', catalog }));
    },
    // le catalogue ne dépend que de la config de découverte et du matériel, pas des modèles installés
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, hw.appleSilicon],
  );
  useEffect(() => load(false), [load]);
  return [state, () => load(true)] as const;
}
