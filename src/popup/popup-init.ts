import { extractDomain } from '../shared/utils.js';
import { AppState } from './state.js';
import { UIManager } from './ui-manager.js';
import { CONFIG, ViewState } from './config.js';

declare const browser: typeof chrome;

// Expose UIManager globally for chart-builder callbacks
(window as unknown as { UIManager: typeof UIManager }).UIManager = UIManager;

export const App = {
  async initialize(): Promise<void> {
    try {
      this.setupEventListeners();
      await this.loadData();
      this.renderInitialView();
    } catch (error) {
      console.error("Error initializing popup:", error);
      UIManager.displayMessage('#detail-page .left-panel',
        "Could not load your time data.", 'error');
    }
  },

  setupEventListeners(): void {
    // Merged topbar: one nav button toggles between the two carousel pages.
    const navToggleBtn = document.getElementById('nav-toggle-btn');
    const settingsToggleBtn = document.getElementById('settings-toggle-btn');
    const saveSettingsBtn = document.getElementById('save-settings-btn');

    if (navToggleBtn) {
      navToggleBtn.addEventListener('click', () => {
        if (AppState.currentView === ViewState.DETAIL) {
          UIManager.showGeneralView();
        } else {
          UIManager.renderDetailView(AppState.selectedDomain);
          UIManager.showDetailView();
        }
      });
    }

    // One button toggles the right-half settings overlay; it morphs hamburger→✕.
    if (settingsToggleBtn) {
      settingsToggleBtn.addEventListener('click', () => UIManager.toggleSettings());
    }

    if (saveSettingsBtn) {
      saveSettingsBtn.addEventListener('click', async () => {
        await UIManager.saveSettings();
        UIManager.closeSettings();
        // Re-render so chart-affecting settings (e.g. scale) show immediately.
        if (AppState.currentView === ViewState.GENERAL) {
          UIManager.renderGeneralView();
        } else {
          UIManager.renderDetailView(AppState.selectedDomain);
        }
      });
    }
  },

  async loadData(): Promise<void> {
    const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
    // Only http(s) pages are trackable (mirrors the background's isWebUrl /
    // tab-query filter). On a new-tab page, settings page, extension page, etc.
    // extractDomain would still return junk like "newtab" — gate on the scheme
    // so the detail view falls through to its "go to a real site" empty state
    // instead of showing a bogus domain + usage card.
    const activeUrl = activeTabs.length > 0 ? activeTabs[0].url : undefined;
    const isWebUrl = activeUrl?.startsWith('http://') || activeUrl?.startsWith('https://');
    const currentDomain = isWebUrl && activeUrl ? extractDomain(activeUrl) : null;

    const storedData = await browser.storage.local.get([
      "trackedTime",
      "webTimeSettings",
      "webTimeSessionHistory",
    ]);
    const timeHistory = storedData.trackedTime?.timeHistory || {};
    const settings = storedData.webTimeSettings || { global: {}, domains: {} };

    if (settings.global?.scalingPower !== undefined) {
      CONFIG.scalingPower = Math.max(0.3, Math.min(1.0, settings.global.scalingPower));
    }

    // Mirror the background's day-reset hour so the popup's "today" agrees with
    // tracked time between midnight and the reset hour.
    AppState.dayResetTime = settings.global?.dayResetTime || 0;

    AppState.setCurrentDomain(currentDomain);
    AppState.setTimeHistory(timeHistory);
    AppState.sessionHistory = storedData.webTimeSessionHistory || {};
  },

  renderInitialView(): void {
    if (!AppState.allTimeHistory || Object.keys(AppState.allTimeHistory).length === 0) {
      UIManager.displayMessage('#detail-page .left-panel',
        `No tracking data available yet for ${AppState.activeTabDomain || "any site"}. Start browsing to collect data.`);
      return;
    }

    UIManager.renderDetailView(AppState.selectedDomain);
    UIManager.showDetailView();
  }
};

document.addEventListener('DOMContentLoaded', () => App.initialize());

export default App;
