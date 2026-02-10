'use client';

import type { Entry } from '@/types';
import { calcEntry, fmt, fmtInt } from '@/lib/calculations';

interface ForecastCardProps {
  entries: Entry[];
}

export default function ForecastCard({ entries }: ForecastCardProps) {
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysRemaining = daysInMonth - dayOfMonth;

  // --- Use the previous 30 days of data to build daily averages for forecasting ---
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
  const todayStr = now.toISOString().split('T')[0];

  const last30DaysEntries = entries.filter((e) => e.date >= thirtyDaysAgoStr && e.date <= todayStr);

  // Compute totals from last 30 days
  let last30Sales = 0;
  let last30Orders = 0;
  let last30Videos = 0;
  let last30NetProfit = 0;

  last30DaysEntries.forEach((e) => {
    const c = calcEntry(e);
    last30Sales += Number(e.gmv) || 0;
    last30Orders += 1;
    last30Videos += Number(e.videos_posted) || 0;
    last30NetProfit += c.totalNetProfit;
  });

  // Daily averages from the last 30 days
  const dailyAvgSales = last30Sales / 30;
  const dailyAvgOrders = last30Orders / 30;
  const dailyAvgProfit = last30NetProfit / 30;
  const dailyAvgVideos = last30Videos / 30;

  // Get this month's actual data so far
  const monthEntries = entries.filter((e) => {
    const d = new Date(e.date);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  });

  let actualMonthlySales = 0;
  let actualMonthlyOrders = 0;
  let actualMonthlyVideos = 0;
  let actualMonthlyAdCost = 0;
  let actualMonthlyAffiliate = 0;
  let actualMonthlyProfit = 0;
  let actualMonthlyUnits = 0;

  monthEntries.forEach((e) => {
    const c = calcEntry(e);
    actualMonthlySales += Number(e.gmv) || 0;
    actualMonthlyOrders += 1;
    actualMonthlyVideos += Number(e.videos_posted) || 0;
    actualMonthlyAdCost += Number(e.ads) || 0;
    actualMonthlyAffiliate += Number(e.affiliate) || 0;
    actualMonthlyProfit += c.totalNetProfit;
    actualMonthlyUnits += Number(e.units_sold) || 0;
  });

  // Forecast: actual this month so far + (daily avg from last 30 days × remaining days)
  const forecastedSales = actualMonthlySales + (dailyAvgSales * daysRemaining);
  const forecastedOrders = Math.round(actualMonthlyOrders + (dailyAvgOrders * daysRemaining));
  const forecastedProfit = actualMonthlyProfit + (dailyAvgProfit * daysRemaining);
  const forecastedVideos = Math.round(actualMonthlyVideos + (dailyAvgVideos * daysRemaining));
  // Est. payout = forecasted sales minus platform fee (6%)
  const forecastedPayout = forecastedSales * 0.94;
  // Forecasted margin = net profit / sales
  const forecastedMargin = forecastedSales > 0 ? (forecastedProfit / forecastedSales) * 100 : 0;

  // Calculate month-over-month change vs previous full month
  const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
  const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
  const prevMonthEntries = entries.filter((e) => {
    const d = new Date(e.date);
    return d.getMonth() === prevMonth && d.getFullYear() === prevYear;
  });

  let prevSales = 0;
  let prevProfit = 0;
  prevMonthEntries.forEach((e) => {
    const c = calcEntry(e);
    prevSales += Number(e.gmv) || 0;
    prevProfit += c.totalNetProfit;
  });

  const salesChange = prevSales > 0 ? ((forecastedSales - prevSales) / prevSales) * 100 : 0;
  const profitChange = prevProfit !== 0 ? ((forecastedProfit - prevProfit) / Math.abs(prevProfit)) * 100 : 0;

  const monthName = now.toLocaleString('en-US', { month: 'long' });

  return (
    <div className="mb-6 animate-fade-in">
      <div className="bg-gradient-to-br from-[rgba(105,201,208,0.15)] to-[rgba(105,201,208,0.05)] border border-[rgba(105,201,208,0.3)] rounded-[14px] p-5 backdrop-blur-xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-tt-cyan animate-pulse" />
              <h3 className="text-sm font-semibold text-tt-cyan uppercase tracking-wide">This month (forecast)</h3>
            </div>
            <p className="text-xs text-tt-muted mt-0.5">
              1–{daysInMonth} {monthName} {currentYear} · based on last 30 days avg
            </p>
          </div>
          <div className="text-[11px] text-tt-muted bg-tt-card px-2.5 py-1 rounded-full border border-tt-border">
            {daysRemaining} days remaining
          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-4">
          {/* Sales */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-tt-muted">Sales</span>
              {salesChange !== 0 && (
                <span className={`text-[11px] font-semibold ${salesChange >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>
                  {salesChange >= 0 ? '+' : ''}{salesChange.toFixed(1)}%
                </span>
              )}
            </div>
            <div className="text-2xl font-bold text-tt-text">{fmt(forecastedSales)}</div>
          </div>

          {/* Orders / Units */}
          <div>
            <div className="text-xs text-tt-muted mb-1">Orders / Units</div>
            <div className="text-lg font-bold text-tt-text">
              {fmtInt(forecastedOrders)} / {fmtInt(actualMonthlyUnits)}
            </div>
          </div>

          {/* Videos Posted */}
          <div>
            <div className="text-xs text-tt-muted mb-1">Videos Posted</div>
            <div className="text-lg font-bold text-tt-cyan">{fmtInt(forecastedVideos)}</div>
          </div>

          {/* Affiliate Commission */}
          <div>
            <div className="text-xs text-tt-muted mb-1">Affiliate Comm.</div>
            <div className="text-lg font-bold text-tt-yellow">{fmt(actualMonthlyAffiliate)}</div>
          </div>

          {/* Adv. cost */}
          <div>
            <div className="text-xs text-tt-muted mb-1">Adv. cost</div>
            <div className="text-lg font-bold text-tt-text">{fmt(actualMonthlyAdCost)}</div>
          </div>

          {/* Est. payout */}
          <div>
            <div className="text-xs text-tt-muted mb-1">Est. payout</div>
            <div className="text-lg font-bold text-tt-text">{fmt(forecastedPayout)}</div>
          </div>
        </div>

        {/* Net profit section */}
        <div className="mt-4 pt-4 border-t border-[rgba(105,201,208,0.2)]">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-tt-muted">Net profit</span>
                {profitChange !== 0 && (
                  <span className={`text-[11px] font-semibold ${profitChange >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>
                    {profitChange >= 0 ? '+' : ''}{profitChange.toFixed(1)}%
                  </span>
                )}
              </div>
              <div className={`text-2xl font-bold ${forecastedProfit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>
                {fmt(forecastedProfit)}
              </div>
              <div className="text-[11px] text-tt-muted mt-0.5">
                {forecastedMargin.toFixed(1)}% margin
              </div>
            </div>
            {/* Progress bar for month */}
            <div className="flex flex-col items-end gap-1">
              <span className="text-[11px] text-tt-muted">{Math.round((dayOfMonth / daysInMonth) * 100)}% through month</span>
              <div className="w-32 h-1.5 bg-[rgba(255,255,255,0.1)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-tt-cyan rounded-full transition-all"
                  style={{ width: `${(dayOfMonth / daysInMonth) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
