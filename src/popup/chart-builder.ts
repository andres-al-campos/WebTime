import { CONFIG, COLORS, CHART_COLORS } from './config.js';
import { formatDateForDisplay, formatDateWithDayOfWeek, formatTime } from '../shared/utils.js';
import { AppState } from './state.js';
import type { GeneralViewData, DetailViewData, MovingAverageData } from './data-processor.js';

// Use any for Chart.js types since we're loading it via script tag
/* eslint-disable @typescript-eslint/no-explicit-any */
type ChartConfiguration = any;
type ChartDatasetType = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Forward declaration for UIManager to avoid circular dependency
declare const UIManager: {
  updateDailyBreakdown(totalTimeData: GeneralViewData, dataIndex: number): void;
  updatePieChart(totalTimeData: GeneralViewData, dataIndex: number): void;
  renderDetailView(domain: string | null): void;
  showDetailView(): void;
};

export interface DomainPieData {
  domain: string;
  seconds: number;
  percentage: number;
  color: string;
}

interface ExtendedDataset {
  type?: 'bar' | 'line';
  label?: string;
  data: number[];
  formattedTimes?: string[];
  originalData?: number[];
  domainNames?: (string | null)[];
  // backgroundColor may also be a Chart.js scriptable fn returning a gradient.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  backgroundColor?: string | string[] | ((ctx: any) => string | CanvasGradient);
  // borderColor/borderWidth may be Chart.js scriptable fns (per-bar highlight).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  borderColor?: string | string[] | ((ctx: any) => string);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  borderWidth?: number | number[] | ((ctx: any) => number);
  borderRadius?: number;
  fill?: boolean;
  tension?: number;
  pointRadius?: number;
  pointBackgroundColor?: string;
  pointBorderColor?: string;
  order?: number;
}

interface ExtendedChart {
  totalTimeData?: GeneralViewData;
  _deadZoneHitbox?: HTMLDivElement;
  data: {
    datasets: ExtendedDataset[];
    labels?: string[];
  };
  options?: {
    scales?: {
      x?: Record<string, unknown>;
      y?: Record<string, unknown>;
    };
  };
  update(mode?: string): void;
  chartArea?: {
    left: number;
    right: number;
    bottom: number;
  };
}

export function getGridColor(): string {
  return CHART_COLORS.grid;
}

/**
 * Per-chart highlight state. The general view lets you hover/lock a day; the
 * highlight is drawn by *scriptable* border functions (below) rather than by
 * mutating `borderColor` into an array. This is critical: `backgroundColor` is
 * itself a scriptable gradient function, and the old code used to do
 * `Array(n).fill(dataset.backgroundColor)` — filling the array with the function
 * REFERENCE, which Chart.js can't evaluate per-bar, so bars fell back to a black
 * fill / white stroke. Keeping every per-bar color a function side-steps that
 * entirely: highlight = update these indices + `chart.update('none')`.
 */
interface BarHighlightState {
  locked: number | null;  // AppState mirror, set on the chart so scriptables read fast
  hover: number | null;   // transient hover-preview index
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function highlightState(chart: any): BarHighlightState {
  if (!chart._barHighlight) chart._barHighlight = { locked: null, hover: null };
  return chart._barHighlight;
}

/**
 * A Chart.js scriptable backgroundColor: a top→bottom vertical gradient per bar
 * (lighter at top, deeper at bottom). The LAST bar (today, in progress) is the
 * same gradient at 70% opacity so it reads as "still running". Returns a flat
 * fallback before the chart area exists (first paint).
 *
 * `lastIndex` is captured per-build so we know which bar is "today".
 */
function makeBarGradient(lastIndex: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ctx: any): string | CanvasGradient => {
    const { chart, dataIndex } = ctx;
    const area = chart.chartArea;
    if (!area) return CHART_COLORS.barTop; // pre-paint fallback
    const today = dataIndex === lastIndex;
    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    if (today) {
      // 70%-opacity gradient for the in-progress day — dimmed enough to read as
      // "still running" but no longer washed out against the solid past bars.
      g.addColorStop(0, 'rgba(94, 142, 251, 0.7)');   // #5e8efb @ 70%
      g.addColorStop(1, 'rgba(63, 111, 224, 0.7)');   // #3f6fe0 @ 70%
    } else {
      g.addColorStop(0, CHART_COLORS.barTop);
      g.addColorStop(1, CHART_COLORS.barBottom);
    }
    return g;
  };
}

/**
 * Scriptable borderColor: white outline on the locked bar, a softer grey on the
 * hovered bar, transparent otherwise. Reading from per-chart highlight state
 * keeps the color a function (never an array of functions) — see the note above.
 *
 * The today bar (lastIndex) is drawn at 70% opacity, so its outline is dimmed
 * to match — a full-strength white ring around a translucent bar looks mismatched.
 */
function makeBarBorderColor(lastIndex: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ctx: any): string => {
    const { chart, dataIndex } = ctx;
    const hl = highlightState(chart);
    const today = dataIndex === lastIndex;
    if (dataIndex === hl.locked) return today ? 'rgba(255, 255, 255, 0.7)' : 'white';
    if (dataIndex === hl.hover) return today ? 'rgba(200, 200, 200, 0.7)' : 'rgba(200, 200, 200, 0.9)';
    return 'transparent';
  };
}

/** Scriptable borderWidth: 2px on the locked/hovered bar, 0 otherwise. */
function makeBarBorderWidth() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ctx: any): number => {
    const { chart, dataIndex } = ctx;
    const hl = highlightState(chart);
    return dataIndex === hl.locked || dataIndex === hl.hover ? 2 : 0;
  };
}

export function createMovingAverageDataset(
  movingAverageData: MovingAverageData[],
  label: string = 'Average'
): ExtendedDataset {
  return {
    type: 'line',
    label: label,
    data: movingAverageData.map(day => day.averageHours),
    formattedTimes: movingAverageData.map(day => day.formattedTime),
    backgroundColor: COLORS.movingAverage.background,
    borderColor: COLORS.movingAverage.border,
    borderWidth: COLORS.movingAverage.width,
    fill: false,
    tension: 0.35,            // smooth, round joins like the design's polyline
    pointRadius: 2,           // small dots
    pointBackgroundColor: CHART_COLORS.avgLine,
    pointBorderColor: CHART_COLORS.avgLine,
    order: -1
  };
}

export function createSingleDomainDataset(
  dailyData: { domainHours: number; domainFormattedTime: string }[],
  label: string = 'This Day'
): ExtendedDataset {
  return {
    type: 'bar',
    label: label,
    data: dailyData.map(day => day.domainHours),
    backgroundColor: COLORS.currentDomain.background, // replaced w/ gradient in build
    borderColor: makeBarBorderColor(dailyData.length - 1),
    borderWidth: makeBarBorderWidth(),
    borderRadius: 2,
    formattedTimes: dailyData.map(day => day.domainFormattedTime),
    order: 1
  };
}

export function getBaseChartOptions(_isGeneralView: boolean = false): Record<string, unknown> {
  return {
    animation: { duration: CONFIG.initAnimationDuration },
    responsive: true,
    maintainAspectRatio: false,
    // Inset the plot area from the canvas edges so the left y-axis labels and
    // the rotated x-axis date labels have room INSIDE the canvas — otherwise
    // they render flush against the panel edge (which clips them via
    // overflow:hidden) and look cramped on the left/bottom.
    layout: {
      padding: { left: 8, right: 0, top: 0, bottom: 20 }
    },
    scales: {
      y: {
        grid: { color: getGridColor(), drawBorder: false },
        beginAtZero: true,
        ticks: {
          color: CHART_COLORS.axisText,
          font: {
            size: 11,
            weight: '500',
            family: "'IBM Plex Mono', monospace"
          }
        },
        title: {
          display: true,
          text: 'Hours',
          color: CHART_COLORS.axisTitle,
          font: {
            size: 12,
            weight: '600'
          }
        }
      },
      x: {
        grid: { display: false },
        ticks: {
          color: CHART_COLORS.axisText,
          font: {
            size: 10,
            family: "'IBM Plex Mono', monospace"
          }
        }
      }
    },
    interaction: { intersect: false, mode: 'index' },
    elements: {
      bar: { barPercentage: 0.8, categoryPercentage: 0.9 }
    }
  };
}

export function buildGeneralViewChart(totalTimeData: GeneralViewData): ChartConfiguration {
  const datasets: ExtendedDataset[] = [];

  const totalBarsDataset: ExtendedDataset = {
    type: 'bar',
    label: 'Total Time',
    data: totalTimeData.dailyData.map(day => Math.pow(day.totalHours, CONFIG.scalingPower)),
    originalData: totalTimeData.dailyData.map(day => day.totalHours),
    formattedTimes: totalTimeData.dailyData.map(day => day.formattedTime),
    // top→bottom gradient; last bar (today) at half opacity
    backgroundColor: makeBarGradient(totalTimeData.dailyData.length - 1),
    borderColor: makeBarBorderColor(totalTimeData.dailyData.length - 1),
    borderWidth: makeBarBorderWidth(),
    borderRadius: 2,
    order: 1
  };
  datasets.push(totalBarsDataset);

  if (totalTimeData.movingAverageData) {
    const avgDataset = createMovingAverageDataset(
      totalTimeData.movingAverageData,
      `${CONFIG.movingAverageDays}-Day Average`
    );
    avgDataset.data = avgDataset.data.map(val => Math.pow(val, CONFIG.scalingPower));
    avgDataset.originalData = totalTimeData.movingAverageData.map(day => day.averageHours);
    datasets.push(avgDataset);
  }

  const totalDays = totalTimeData.dailyData.length;
  const windowSize = CONFIG.daysToDisplay;

  const maxIndex = totalDays - 1;
  const minIndex = Math.max(0, totalDays - windowSize);

  const allTotalHours = totalTimeData.dailyData.map(day => day.totalHours);
  const allScaledHours = allTotalHours.map(h => Math.pow(h, CONFIG.scalingPower));
  const maxScaled = Math.max(...allScaledHours);
  const yAxisMax = Math.ceil(maxScaled * 2) / 2;

  const baseOptions = getBaseChartOptions(true) as Record<string, unknown>;
  const baseScales = baseOptions.scales as Record<string, unknown>;
  const baseY = baseScales.y as Record<string, unknown>;
  const baseTicks = baseY.ticks as Record<string, unknown>;

  const options = {
    ...baseOptions,
    scales: {
      ...baseScales,
      x: {
        min: minIndex,
        max: maxIndex,
        display: true
      },
      y: {
        ...baseY,
        max: yAxisMax,
        ticks: {
          ...baseTicks,
          callback: function(value: number): string {
            const realHours = Math.pow(value, 1 / CONFIG.scalingPower);
            return realHours.toFixed(1);
          }
        },
        title: {
          display: true,
          text: 'Hours',
          color: CHART_COLORS.axisTitle,
          font: {
            size: 12,
            weight: '600'
          }
        }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: getGeneralViewTooltipConfig(totalTimeData)
    },
    onHover: (_event: unknown, elements: { index: number }[], chart: ExtendedChart) => {
      if (elements.length > 0) {
        const dataIndex = elements[0].index;

        if (!AppState.isLocked()) {
          UIManager.updateDailyBreakdown(chart.totalTimeData!, dataIndex);
          UIManager.updatePieChart(chart.totalTimeData!, dataIndex);
          showHoverPreview(chart, dataIndex);
        }
      } else {
        if (!AppState.isLocked()) {
          const todayIndex = chart.totalTimeData!.dailyData.length - 1;
          highlightBar(chart, todayIndex);
          UIManager.updateDailyBreakdown(chart.totalTimeData!, todayIndex);
          UIManager.updatePieChart(chart.totalTimeData!, todayIndex);
        }
      }
    },
    onClick: (_event: unknown, elements: { index: number }[], chart: ExtendedChart) => {
      if (elements.length > 0) {
        const clickedIndex = elements[0].index;

        if (AppState.lockedDayIndex === clickedIndex) {
          AppState.unlockDay();
          removeBarHighlight(chart);
        } else {
          AppState.lockDay(clickedIndex);
          UIManager.updateDailyBreakdown(chart.totalTimeData!, clickedIndex);
          UIManager.updatePieChart(chart.totalTimeData!, clickedIndex);
          highlightBar(chart, clickedIndex);
        }
      } else {
        AppState.unlockDay();
        removeBarHighlight(chart);
      }
    }
  };

  return {
    type: 'bar',
    data: {
      labels: totalTimeData.dailyData.map(day => formatDateForDisplay(day.date)),
      datasets: datasets as ChartDatasetType[]
    },
    options: options
  };
}

export function buildDetailViewChart(processedData: DetailViewData): ChartConfiguration {
  const datasets: ExtendedDataset[] = [];

  const domainDataset = createSingleDomainDataset(processedData.dailyData);
  domainDataset.data = domainDataset.data.map(val => Math.pow(val, CONFIG.scalingPower));
  domainDataset.originalData = processedData.dailyData.map(day => day.domainHours);
  domainDataset.backgroundColor = makeBarGradient(processedData.dailyData.length - 1);
  datasets.push(domainDataset);

  if (processedData.movingAverageData) {
    const avgDataset = createMovingAverageDataset(
      processedData.movingAverageData,
      `${CONFIG.movingAverageDays}-Day Average`
    );
    avgDataset.data = avgDataset.data.map(val => Math.pow(val, CONFIG.scalingPower));
    avgDataset.originalData = processedData.movingAverageData.map(day => day.averageHours);
    datasets.push(avgDataset);
  }

  const totalDays = processedData.dailyData.length;
  const windowSize = CONFIG.daysToDisplay;

  const maxIndex = totalDays - 1;
  const minIndex = Math.max(0, totalDays - windowSize);

  const allDomainHours = processedData.dailyData.map(day => day.domainHours);
  const allScaledHours = allDomainHours.map(h => Math.pow(h, CONFIG.scalingPower));
  const maxScaled = Math.max(...allScaledHours);
  const yAxisMax = Math.ceil(maxScaled * 2) / 2;

  const baseOptions = getBaseChartOptions() as Record<string, unknown>;
  const baseScales = baseOptions.scales as Record<string, unknown>;
  const baseY = baseScales.y as Record<string, unknown>;
  const baseTicks = baseY.ticks as Record<string, unknown>;

  const options = {
    ...baseOptions,
    scales: {
      ...baseScales,
      x: {
        min: minIndex,
        max: maxIndex,
        display: true
      },
      y: {
        ...baseY,
        max: yAxisMax,
        ticks: {
          ...baseTicks,
          callback: function(value: number): string {
            const realHours = Math.pow(value, 1 / CONFIG.scalingPower);
            return realHours.toFixed(1);
          }
        },
        title: {
          display: true,
          text: 'Hours',
          color: CHART_COLORS.axisTitle,
          font: {
            size: 12,
            weight: '600'
          }
        }
      }
    },
    plugins: {
      legend: {
        labels: { boxHeight: 8, padding: 8, font: { size: 11, family: "'IBM Plex Sans', sans-serif" } }
      },
      tooltip: getDetailViewTooltipConfig(processedData)
    },
    // Clicking a bar locks that day and swaps the right panel to its finished
    // session cards; clicking it again (or off the bars) returns to today. The
    // lock is the same one the general view uses, so the two stay in step.
    onClick: (_event: unknown, elements: { index: number }[]) => {
      const clickedIndex = elements.length > 0 ? elements[0].index : null;
      if (clickedIndex === null || AppState.lockedDayIndex === clickedIndex) {
        AppState.unlockDay();
      } else {
        AppState.lockDay(clickedIndex);
      }
      // The re-render builds a fresh chart, which re-applies the highlight from
      // the lock — so don't paint it here, it would be discarded.
      UIManager.renderDetailView(AppState.selectedDomain);
    }
  };

  return {
    type: 'bar',
    data: {
      labels: processedData.dailyData.map(day => formatDateForDisplay(day.date)),
      datasets: datasets as ChartDatasetType[]
    },
    options: options
  };
}

export function getGeneralViewTooltipConfig(totalTimeData: GeneralViewData): Record<string, unknown> {
  return {
    animation: { duration: 200 },
    backgroundColor: COLORS.tooltipBackground,
    itemSort: (a: { datasetIndex: number }, b: { datasetIndex: number }) => {
      return a.datasetIndex - b.datasetIndex;
    },
    callbacks: {
      title: (context: { dataIndex: number }[]) => {
        const dateString = totalTimeData.dailyData[context[0].dataIndex].date;
        return formatDateWithDayOfWeek(dateString);
      },
      label: (context: { dataIndex: number; dataset: ExtendedDataset }) => {
        const dataIndex = context.dataIndex;
        const dataset = context.dataset;

        if (dataset.type === 'bar') {
          const dayData = totalTimeData.dailyData[dataIndex];
          return `Total: ${dayData.formattedTime}`;
        }

        if (dataset.label && dataset.label.includes('Average')) {
          const time = dataset.formattedTimes?.[dataIndex];
          return `${dataset.label}: ${time}`;
        }

        return null;
      }
    }
  };
}

export function getDetailViewTooltipConfig(processedData: DetailViewData): Record<string, unknown> {
  return {
    animation: { duration: 200 },
    backgroundColor: COLORS.tooltipBackground,
    itemSort: (a: { datasetIndex: number }, b: { datasetIndex: number }) => {
      return a.datasetIndex - b.datasetIndex;
    },
    callbacks: {
      title: (context: { dataIndex: number }[]) => {
        const dateString = processedData.dailyData[context[0].dataIndex].date;
        return formatDateWithDayOfWeek(dateString);
      },
      label: (context: { dataIndex: number; datasetIndex: number; chart: { data: { datasets: ExtendedDataset[] } } }) => {
        const dataset = context.chart.data.datasets[context.datasetIndex];
        const dataIndex = context.dataIndex;
        const dayData = processedData.dailyData[dataIndex];
        const time = dataset.formattedTimes?.[dataIndex];

        if (dataset.type === 'bar' && processedData._yAxisMax && dayData.domainHours > processedData._yAxisMax) {
          const actualTime = dayData.domainFormattedTime;
          const cappedTime = formatTime(processedData._yAxisMax * 3600);
          return `${dataset.label}: ${actualTime} (capped at ${cappedTime} for scale)`;
        }

        return `${dataset.label}: ${time}`;
      }
    }
  };
}

export function highlightBar(chart: ExtendedChart, barIndex: number): void {
  const hl = highlightState(chart);
  hl.locked = barIndex;
  hl.hover = null;
  chart.update('none');
}

export function removeBarHighlight(chart: ExtendedChart): void {
  const hl = highlightState(chart);
  hl.locked = null;
  hl.hover = null;
  chart.update('none');
}

export function showHoverPreview(chart: ExtendedChart, barIndex: number): void {
  const hl = highlightState(chart);
  // Locked stays the source of truth; hover only previews a different bar.
  hl.locked = AppState.lockedDayIndex;
  hl.hover = barIndex === AppState.lockedDayIndex ? null : barIndex;
  chart.update('none');
}

export function buildPieChart(domainData: DomainPieData[]): ChartConfiguration {
  const labels = domainData.map(item => item.domain);
  const data = domainData.map(item => item.seconds / 3600);
  const colors = domainData.map(item => item.color);

  return {
    type: 'pie',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: colors,
        borderColor: colors.map(c => c.replace('0.7', '1')),
        borderWidth: 1
      }]
    },
    options: {
      responsive: false,
      maintainAspectRatio: true,
      animation: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: COLORS.tooltipBackground,
          callbacks: {
            label: (context: { label: string; dataIndex: number }) => {
              const domain = context.label;
              const seconds = domainData[context.dataIndex].seconds;
              const percentage = domainData[context.dataIndex].percentage;
              const formattedTimeStr = formatTime(seconds);
              return `${domain}: ${formattedTimeStr} (${percentage}%)`;
            }
          }
        }
      },
      onClick: (_event: unknown, elements: { index: number }[], chart: ExtendedChart) => {
        if (elements.length > 0) {
          const index = elements[0].index;
          const domain = chart.data.labels?.[index] as string;
          AppState.setSelectedDomain(domain);
          UIManager.renderDetailView(domain);
          UIManager.showDetailView();
        }
      }
    }
  };
}

