import { CONFIG } from './config.js';
import { formatTime } from '../shared/utils.js';
import type { TimeHistory, Domain, DateString } from '../types.js';

export interface RankData {
  domain: string | null;
  hours: number;
  count?: number;
}

export interface DailyRankedData {
  date: DateString;
  totalSeconds: number;
  totalHours: number;
  formattedTime: string;
  ranks: RankData[];
}

export interface GeneralViewData {
  dailyData: DailyRankedData[];
  movingAverageData: MovingAverageData[];
}

export interface DetailDayData {
  date: DateString;
  domainSeconds: number;
  totalSeconds: number;
  domainHours: number;
  totalHours: number;
  domainFormattedTime: string;
  totalFormattedTime: string;
}

export interface MovingAverageData {
  date: DateString;
  averageSeconds: number;
  averageHours: number;
  formattedTime: string;
}

export interface DetailViewData {
  dailyData: DetailDayData[];
  movingAverageData: MovingAverageData[];
  _yAxisMax?: number;
}

export function processGeneralViewData(timeHistory: TimeHistory): GeneralViewData {
  const sortedDates = Object.keys(timeHistory).sort();

  const dailyRankedData: DailyRankedData[] = sortedDates.map(date => {
    const rawDayData = timeHistory[date];

    const domains: { domain: string; seconds: number }[] = [];
    let totalSeconds = 0;

    Object.keys(rawDayData).forEach(domain => {
      const seconds = rawDayData[domain] || 0;
      totalSeconds += seconds;
      if (seconds > 0) {
        domains.push({ domain, seconds });
      }
    });

    domains.sort((a, b) => b.seconds - a.seconds);

    const topDomains = domains.slice(0, CONFIG.topDomainsLimit);
    const otherDomains = domains.slice(CONFIG.topDomainsLimit);
    const othersSeconds = otherDomains.reduce((sum, d) => sum + d.seconds, 0);

    const ranked: DailyRankedData = {
      date,
      totalSeconds,
      totalHours: totalSeconds / 3600,
      formattedTime: formatTime(totalSeconds),
      ranks: []
    };

    for (let i = 0; i < CONFIG.topDomainsLimit; i++) {
      if (i < topDomains.length) {
        ranked.ranks[i] = {
          domain: topDomains[i].domain,
          hours: topDomains[i].seconds / 3600
        };
      } else {
        ranked.ranks[i] = { domain: null, hours: 0 };
      }
    }

    ranked.ranks[CONFIG.topDomainsLimit] = {
      domain: 'Others',
      hours: othersSeconds / 3600,
      count: otherDomains.length
    };

    return ranked;
  });

  return {
    dailyData: dailyRankedData,
    movingAverageData: calculateMovingAverageTotal(dailyRankedData)
  };
}

export function processDetailViewData(timeHistory: TimeHistory, targetDomain: Domain): DetailViewData {
  const sortedDates = Object.keys(timeHistory).sort();

  const dailyData: DetailDayData[] = sortedDates.map(date => {
    const dayData = timeHistory[date];
    let domainSeconds = 0;
    let totalSeconds = 0;

    if (typeof dayData === 'number') {
      domainSeconds = dayData;
      totalSeconds = dayData;
    } else if (typeof dayData === 'object' && dayData) {
      domainSeconds = dayData[targetDomain] || 0;
      totalSeconds = Object.values(dayData).reduce((sum, time) => sum + time, 0);
    }

    return {
      date,
      domainSeconds,
      totalSeconds,
      domainHours: domainSeconds / 3600,
      totalHours: totalSeconds / 3600,
      domainFormattedTime: formatTime(domainSeconds),
      totalFormattedTime: formatTime(totalSeconds)
    };
  });

  return {
    dailyData,
    movingAverageData: calculateMovingAverage(dailyData)
  };
}

export function calculateMovingAverage(dailyData: DetailDayData[]): MovingAverageData[] {
  return dailyData.map((dayData, index) => {
    const startIndex = Math.max(0, index - CONFIG.movingAverageDays + 1);
    const window = dailyData.slice(startIndex, index + 1);

    const totalSeconds = window.reduce((sum, day) => sum + day.domainSeconds, 0);
    const averageSeconds = window.length > 0 ? totalSeconds / window.length : 0;
    const roundedAverage = Math.round(averageSeconds);

    return {
      date: dayData.date,
      averageSeconds: roundedAverage,
      averageHours: Math.round((averageSeconds / 3600) * 10) / 10,
      formattedTime: formatTime(roundedAverage)
    };
  });
}

export function calculateMovingAverageTotal(dailyData: DailyRankedData[]): MovingAverageData[] {
  return dailyData.map((dayData, index) => {
    const startIndex = Math.max(0, index - CONFIG.movingAverageDays + 1);
    const window = dailyData.slice(startIndex, index + 1);

    const totalSeconds = window.reduce((sum, day) => sum + (day.totalSeconds || 0), 0);
    const averageSeconds = window.length > 0 ? totalSeconds / window.length : 0;
    const roundedAverage = Math.round(averageSeconds);

    return {
      date: dayData.date,
      averageSeconds: roundedAverage,
      averageHours: Math.round((averageSeconds / 3600) * 10) / 10,
      formattedTime: formatTime(roundedAverage)
    };
  });
}

export function calculateTodaysTotals(
  timeHistory: TimeHistory,
  currentDate: DateString,
  currentDomain: Domain
): { domain: number; total: number } {
  const todaysData = timeHistory[currentDate] || {};
  const todaysTotalTime = Object.values(todaysData).reduce((sum, time) => sum + time, 0);
  const todaysDomainTime = todaysData[currentDomain] || 0;

  return {
    domain: todaysDomainTime,
    total: todaysTotalTime
  };
}

