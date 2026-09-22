import { CONFIG, ViewState, ViewStateType } from './config.js';
import type { TimeHistory, Domain, ChartInstance } from '../types.js';
import type { SessionHistory } from '../shared/session-history.js';

export interface AppStateInterface {
  currentView: ViewStateType;
  activeTabDomain: Domain | null;
  selectedDomain: Domain | null;
  allTimeHistory: TimeHistory | null;
  generalChartCreated: boolean;
  scrollPosition: number;
  totalDays: number;
  chartInstance: ChartInstance | null;
  pieChartInstance: ChartInstance | null;
  lockedDayIndex: number | null;
  /** Hour (0-23) the day rolls over, from settings. Matches the background's
   *  day-reset so the popup's notion of "today" agrees with tracked time. */
  dayResetTime: number;
  /** Finished sessions per day per domain, for the past-day panel. */
  sessionHistory: SessionHistory;
  /** Either store was saved by a newer build. The histories above are empty
   *  only because this build cannot read them — nothing here is the truth. */
  storedByNewerVersion: boolean;

  setCurrentDomain(domain: Domain | null): void;
  setSelectedDomain(domain: Domain | null): void;
  setTimeHistory(history: TimeHistory): void;
  setView(view: ViewStateType): void;
  markGeneralChartCreated(): void;
  setChartInstance(chart: ChartInstance | null): void;
  lockDay(dayIndex: number): void;
  unlockDay(): void;
  isLocked(): boolean;
  updateScrollPosition(delta: number): number;
  getVisibleDateRange(): { startIndex: number; endIndex: number };
}

export const AppState: AppStateInterface = {
  currentView: ViewState.DETAIL,
  activeTabDomain: null,
  selectedDomain: null,
  allTimeHistory: null,
  generalChartCreated: false,
  scrollPosition: 0,
  totalDays: 0,
  chartInstance: null,
  pieChartInstance: null,
  lockedDayIndex: null,
  dayResetTime: 0,
  sessionHistory: {},
  storedByNewerVersion: false,

  setCurrentDomain(domain: Domain | null): void {
    this.activeTabDomain = domain;
    this.selectedDomain = domain;
  },

  setSelectedDomain(domain: Domain | null): void {
    this.selectedDomain = domain;
  },

  setTimeHistory(history: TimeHistory): void {
    this.allTimeHistory = history;
    this.totalDays = Object.keys(history).length;
    this.scrollPosition = 0;
    this.lockedDayIndex = null;
  },

  setView(view: ViewStateType): void {
    this.currentView = view;
  },

  markGeneralChartCreated(): void {
    this.generalChartCreated = true;
  },

  setChartInstance(chart: ChartInstance | null): void {
    this.chartInstance = chart;
  },

  lockDay(dayIndex: number): void {
    this.lockedDayIndex = dayIndex;
  },

  unlockDay(): void {
    this.lockedDayIndex = null;
  },

  isLocked(): boolean {
    return this.lockedDayIndex !== null;
  },

  updateScrollPosition(delta: number): number {
    const maxScroll = Math.max(0, this.totalDays - CONFIG.daysToDisplay);
    this.scrollPosition = Math.max(0, Math.min(maxScroll, this.scrollPosition + delta));
    return this.scrollPosition;
  },

  getVisibleDateRange(): { startIndex: number; endIndex: number } {
    const startIndex = this.totalDays - CONFIG.daysToDisplay - this.scrollPosition;
    const endIndex = this.totalDays - this.scrollPosition;
    return { startIndex: Math.max(0, startIndex), endIndex };
  }
};

export default AppState;
