/** Shared allowlist for preferences and generation requests. Reviewed against official model docs. */
export const MODEL_CATALOG = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
] as const;
export type Model = typeof MODEL_CATALOG[number]["id"];
export type Effort = typeof MODEL_CATALOG[number]["efforts"][number];
export type Preferences = { model: Model; effort: Effort };
export const DEFAULT_PREFERENCES: Preferences = { model: "gpt-6-luna", effort: "medium" };

export function validatePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provide model and effort");
  const fields = value as Record<string, unknown>;
  const model = MODEL_CATALOG.find(entry => entry.id === fields.model);
  if (Object.keys(fields).some(key => key !== "model" && key !== "effort") || !model ||
      !model.efforts.some(effort => effort === fields.effort)) throw new Error("Unsupported model or reasoning effort");
  return { model: model.id, effort: fields.effort as Effort };
}

export function effectivePreferences(user: { preferredModel: string | null; preferredEffort: string | null }): Preferences {
  return validatePreferences({ model: user.preferredModel ?? DEFAULT_PREFERENCES.model, effort: user.preferredEffort ?? DEFAULT_PREFERENCES.effort });
}
