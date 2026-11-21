export const MANEUVER_APPLICATION_FLAG = "maneuverApplication";
export const MANEUVER_TIMING_SETTING = "maneuverTimingPolicy";

export const MANEUVER_TIMING_POLICIES = Object.freeze({
  ALWAYS: "always",
  COMBAT: "combat",
  TURN: "turn"
});

const clean = value => String(value ?? "").trim();
const unique = values => [...new Set(Array.from(values || [], clean).filter(Boolean))];

export function normalizeManeuverApplication(value) {
  if (!value || typeof value !== "object") return null;
  const id = clean(value.id);
  const maneuverUuid = clean(value.maneuverUuid);
  if (!id || !maneuverUuid) return null;
  return {
    version: 1,
    id,
    maneuverUuid,
    optionBindingIds: unique(value.optionBindingIds),
    userId: clean(value.userId) || null,
    appliedAt: Number.isFinite(Number(value.appliedAt)) ? Number(value.appliedAt) : null
  };
}

export function sameManeuverSelection(left, right) {
  const leftManeuver = clean(left?.maneuverUuid);
  const rightManeuver = clean(right?.maneuverUuid);
  if (leftManeuver !== rightManeuver) return false;
  const leftOptions = unique(left?.optionBindingIds).sort();
  const rightOptions = unique(right?.optionBindingIds).sort();
  return leftOptions.length === rightOptions.length && leftOptions.every((id, index) => id === rightOptions[index]);
}

export function evaluateManeuverTiming({ policy, isGM = false, combatStarted = false, combatantFound = false, combatantAmbiguous = false, isCurrentTurn = false } = {}) {
  if (isGM || ![MANEUVER_TIMING_POLICIES.COMBAT, MANEUVER_TIMING_POLICIES.TURN].includes(policy)) {
    return { allowed: true, reason: null };
  }
  if (!combatStarted) return { allowed: false, reason: "combatRequired" };
  if (combatantAmbiguous) return { allowed: false, reason: "combatantAmbiguous" };
  if (!combatantFound) return { allowed: false, reason: "combatantRequired" };
  if (policy === MANEUVER_TIMING_POLICIES.TURN && !isCurrentTurn) return { allowed: false, reason: "turnRequired" };
  return { allowed: true, reason: null };
}
