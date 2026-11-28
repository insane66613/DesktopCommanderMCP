import { configManager } from '../config-manager.js';
import { getABTestVariant } from './ab-test.js';
import { capture } from './capture.js';
import { featureFlagManager } from './feature-flags.js';

export const MCP_UI_EXPERIMENT_NAME = 'McpUiPreviews';
export const MCP_UI_SHOW_VARIANT = 'showMCPUi';
export const MCP_UI_HIDE_VARIANT = 'notShowMCPUi';

/** One source of truth for tools/list and config-editor effective preview status. */
export function resolveToolPreviewAvailability(
  config: { filePreviewsEnabled?: boolean; showReadFileUI?: boolean;
    showListDirectoryUI?: boolean; showGetConfigUI?: boolean },
  globalEnabled: boolean,
) {
  const showFilePreviews = globalEnabled && config.filePreviewsEnabled !== false;
  return {
    showMcpUiPreviews: globalEnabled,
    showFilePreviews,
    showReadFilePreview: showFilePreviews && config.showReadFileUI !== false,
    showListDirectoryPreview: showFilePreviews && config.showListDirectoryUI !== false,
    showGetConfigPreview: globalEnabled && config.showGetConfigUI === true,
  };
}

/** Why a nested switch is currently ineffective. Keep the stored value. */
export function previewSettingDisabledReason(
  key: string,
  config: { mcpUiPreviewMode?: string; filePreviewsEnabled?: boolean },
  policy: ReturnType<typeof resolveToolPreviewAvailability>,
): string | undefined {
  if (key === 'mcpUiPreviewsEnabled' &&
      config.mcpUiPreviewMode !== undefined && config.mcpUiPreviewMode !== 'legacy') {
    return 'This compatibility switch only applies in Legacy preview mode.';
  }
  if (!['filePreviewsEnabled', 'showReadFileUI', 'showListDirectoryUI',
    'showGetConfigUI'].includes(key)) return undefined;
  if (!policy.showMcpUiPreviews) {
    return 'MCP UI is currently disabled by the selected mode or experiment.';
  }
  if (['showReadFileUI', 'showListDirectoryUI'].includes(key) &&
      !policy.showFilePreviews) {
    return 'File Previews is off. Enable it before changing individual file widgets.';
  }
  return undefined;
}

export interface McpUiPreviewDecisionDeps {
  getExistingAssignment: () => Promise<unknown>;
  isFirstRun: () => boolean;
  wasLoadedFromCache: () => boolean;
  waitForFreshFlags: () => Promise<void>;
  getABTestVariant: (experimentName: string) => Promise<string | null>;
  capture: (event: string, properties?: Record<string, unknown>) => Promise<unknown> | unknown;
}

function variantEnablesMcpUi(variant: unknown): boolean | null {
  if (variant === MCP_UI_HIDE_VARIANT) return false;
  if (variant === MCP_UI_SHOW_VARIANT) return true;
  return null;
}

export async function resolveMcpUiPreviewDecision(deps: McpUiPreviewDecisionDeps): Promise<boolean> {
  try {
    const existingAssignment = await deps.getExistingAssignment();
    const existingDecision = variantEnablesMcpUi(existingAssignment);
    if (existingDecision !== null) {
      if (!deps.wasLoadedFromCache()) {
        await deps.waitForFreshFlags();
      }

      const currentVariant = await deps.getABTestVariant(MCP_UI_EXPERIMENT_NAME);
      return variantEnablesMcpUi(currentVariant) ?? existingDecision;
    }

    if (!deps.isFirstRun()) {
      return true;
    }

    if (!deps.wasLoadedFromCache()) {
      await deps.waitForFreshFlags();
    }

    const variant = await deps.getABTestVariant(MCP_UI_EXPERIMENT_NAME);
    const decision = variantEnablesMcpUi(variant);
    if (decision === null) {
      return true;
    }

    try {
      await deps.capture('server_mcp_ui_ab_decision', {
        experiment: MCP_UI_EXPERIMENT_NAME,
        variant,
        mcp_ui_enabled: decision,
      });
    } catch {
      // Telemetry must not change the assigned product experience.
    }

    return decision;
  } catch {
    return true;
  }
}

/**
 * Resolve the explicit preview setting without mutating existing A/B enrollment.
 * Legacy is the default, preserving both historic boolean and A/B behavior.
 * Auto is an explicit choice and does not inherit a stale legacy false value.
 */
export async function resolveMcpUiPreviewMode(
  mode: unknown,
  legacyEnabled: unknown,
  resolveAuto: () => Promise<boolean>,
  historicalShowMcpUi?: unknown,
): Promise<boolean> {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  // A hand-edited or corrupted persisted mode must not silently enable UI.
  // Only an absent value is allowed to inherit the old configuration rules.
  if (mode !== undefined && mode !== 'legacy' && mode !== 'auto') return false;
  if (mode !== 'auto') {
    // Historical showMcpUI was an explicit tri-state override. Preserve it
    // only when the new mode has not explicitly superseded legacy behavior.
    // Modern explicit disable always wins in Legacy mode. Otherwise an
    // old showMcpUI:true field could re-enable previews after an upgrade.
    if (legacyEnabled === false) return false;
    if (historicalShowMcpUi === true) return true;
    if (historicalShowMcpUi === false) return false;
  }
  return resolveAuto();
}

export async function shouldShowMcpUiPreviews(): Promise<boolean> {
  const mode = await configManager.getValue('mcpUiPreviewMode');
  const legacyEnabled = await configManager.getValue('mcpUiPreviewsEnabled');
  const historicalShowMcpUi = await configManager.getValue('showMcpUI');
  return resolveMcpUiPreviewMode(mode, legacyEnabled, () => resolveMcpUiPreviewDecision({
    getExistingAssignment: () => configManager.getValue(`abTest_${MCP_UI_EXPERIMENT_NAME}`),
    isFirstRun: () => configManager.isFirstRun(),
    wasLoadedFromCache: () => featureFlagManager.wasLoadedFromCache(),
    waitForFreshFlags: () => featureFlagManager.waitForFreshFlags(),
    getABTestVariant,
    capture,
  }), historicalShowMcpUi);
}
