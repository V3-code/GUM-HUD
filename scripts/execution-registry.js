export const MODULE_ID = "gum-hud";
export const EXECUTION_REGISTRY_SETTING = "executionRegistry";
export const LEGACY_MIGRATION_SETTING = "legacyCombatOptionsMigrated";
export const EXECUTION_REGISTRY_VERSION = 1;

const clean = value => String(value ?? "").trim();

export function normalizeExecutionBinding(binding = {}, index = 0) {
  const sourceType = binding.sourceType === "effect" ? "effect" : "modifier";
  return {
    id: clean(binding.id) || `binding-${index + 1}`,
    maneuverUuid: clean(binding.maneuverUuid),
    actorUuid: clean(binding.actorUuid) || null,
    sourceType,
    sourceUuid: clean(binding.sourceUuid),
    group: clean(binding.group),
    mode: binding.mode === "cumulative" ? "cumulative" : "exclusive",
    reset: binding.reset === "sticky" ? "sticky" : "after_roll",
    order: Number.isFinite(Number(binding.order)) ? Number(binding.order) : index
  };
}

export function normalizeExecutionRegistry(value = {}) {
  const seen = new Set();
  const bindings = (Array.isArray(value?.bindings) ? value.bindings : [])
    .map(normalizeExecutionBinding)
    .filter(binding => {
      if (!binding.maneuverUuid || !binding.sourceUuid || seen.has(binding.id)) return false;
      if (binding.sourceType === "modifier" && !binding.actorUuid) return false;
      seen.add(binding.id);
      return true;
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { version: EXECUTION_REGISTRY_VERSION, bindings };
}

export function executionBindingsFor(registry, { actorUuid, maneuverUuids } = {}) {
  const active = new Set(Array.from(maneuverUuids || [], clean).filter(Boolean));
  const actor = clean(actorUuid);
  if (!active.size || !actor) return [];
  return normalizeExecutionRegistry(registry).bindings.filter(binding =>
    active.has(binding.maneuverUuid)
    && (binding.sourceType === "effect" ? !binding.actorUuid || binding.actorUuid === actor : binding.actorUuid === actor)
  );
}

export function getExecutionRegistry() {
  return normalizeExecutionRegistry(game.settings.get(MODULE_ID, EXECUTION_REGISTRY_SETTING));
}

export async function setExecutionRegistry(value) {
  return game.settings.set(MODULE_ID, EXECUTION_REGISTRY_SETTING, normalizeExecutionRegistry(value));
}

export function upsertExecutionBinding(registry, binding) {
  const normalized = normalizeExecutionRegistry(registry);
  const next = normalizeExecutionBinding(binding, normalized.bindings.length);
  const index = normalized.bindings.findIndex(entry => entry.id === next.id);
  if (index >= 0) normalized.bindings[index] = next;
  else normalized.bindings.push(next);
  normalized.bindings.forEach((entry, order) => { entry.order = order; });
  return normalizeExecutionRegistry(normalized);
}

export function removeExecutionBinding(registry, id) {
  const bindings = normalizeExecutionRegistry(registry).bindings.filter(binding => binding.id !== id);
  bindings.forEach((binding, order) => { binding.order = order; });
  return normalizeExecutionRegistry({ bindings });
}

const effectCache = new Map();

export async function hydrateExecutionSources(registry = getExecutionRegistry()) {
  const effectUuids = [...new Set(normalizeExecutionRegistry(registry).bindings
    .filter(binding => binding.sourceType === "effect")
    .map(binding => binding.sourceUuid))];
  const resolved = await Promise.all(effectUuids.map(uuid => fromUuid(uuid).catch(() => null)));
  effectCache.clear();
  effectUuids.forEach((uuid, index) => effectCache.set(uuid, resolved[index] || null));
  return effectCache;
}

export function resolveExecutionSource(binding, actor) {
  if (binding.sourceType === "modifier") {
    return [...(actor?.items || [])].find(item => item.uuid === binding.sourceUuid || item.id === binding.sourceUuid) || null;
  }
  return effectCache.get(binding.sourceUuid) || null;
}
