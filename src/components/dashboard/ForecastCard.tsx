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

  // Get this month's entries
  const monthEntries = entries.filter((e) => {
    const d = new Date(e.date);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  });

  // Calculate actuals for this month so far
  let actualSales = 0;
  let actualOrders = 0;
  let actualUnits = 0;
  let actualRefunds = 0;
  let actualAdCost = 0;
  let actualNetProfit = 0;

  monthEntries.forEach((e) => {
    const c = calcEntry(e);
    actualSales += Number(e.gmv) || 0;
    actualOrders += 1;
    actualUnits += Number(e.videos_posted) || 0;
    actualAdCost += Number(e.ads) || 0;
    actualNetProfit += c.totalNetProfit;
    // Count refunds (entries with negative GMV or very low margin as proxy)
    if (c.totalNetProfit < 0) actualRefunds += 1;
  });

  // Calculate daily averages and forecast
  const daysTracked = Math.max(dayOfMonth, 1);
  const dailyAvgSales = actualSales / daysTracked;
  const dailyAvgOrders = actualOrders / daysTracked;
  const dailyAvgProfit = actualNetProfit / daysTracked;

  const forecastedSales = actualSales + (dailyAvgSales * daysRemaining);
  const forecastedOrders = Math.round(actualOrders + (dailyAvgOrders * daysRemaining));
  const forecastedProfit = actualNetProfit + (dailyAvgProfit * daysRemaining);
  const forecastedPayout = forecastedSales * 0.94; // After 6% platform fee

  // Calculate month-over-month change
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
  const profitChange = prevProfit > 0 ? ((forecastedProfit - prevProfit) / prevProfit) * 100 : 0;

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
              1–{daysInMonth} {monthName} {currentYear}
            </p>
          </div>
          <div className="text-[11px] text-tt-muted bg-tt-card px-2.5 py-1 rounded-full border border-tt-border">
            {daysRemaining} days remaining
          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {/* Sales */}
          <div className="col-span-2">
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
              {fmtInt(forecastedOrders)} / {fmtInt(actualUnits)}
            </div>
          </div>

          {/* Refunds */}
          <div>
            <div className="text-xs text-tt-muted mb-1">Refunds</div>
            <div className="text-lg font-bold text-tt-text">{fmtInt(actualRefunds)}</div>
          </div>

          {/* Adv. cost */}
          <div>
            <div className="text-xs text-tt-muted mb-1">Adv. cost</div>
            <div className="text-lg font-bold text-tt-text">{fmt(actualAdCost)}</div>
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
