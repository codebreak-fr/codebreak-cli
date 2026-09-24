import { makeHfSource } from './huggingface.js';

/** Modèles convertis pour MLX (Apple Silicon) : dépôts `mlx-community` sur Hugging Face. */
export const mlxSource = makeHfSource('mlx');
