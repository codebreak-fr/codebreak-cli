export * from './types.js';
export { CATEGORIES, CATEGORY_BY_ID, isCategoryId } from './categories.js';
export { loadCatalog, readRegistry, recordInstalled, forgetInstalled, type Catalog } from './registry.js';
export { recommendCategory, recommendAll } from './recommendations.js';
export { listInstalled, planInstall, planRemove, runInstall, runRemove, type InstalledModel, type ModelRef } from './installer.js';
export { isInstalled } from './installed.js';
