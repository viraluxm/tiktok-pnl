'use client';

import { useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Doughnut } from 'react-chartjs-2';
import type { ChartData } from '@/types';
import { getLineChartOptions, getDoughnutChartOptions } from '@/lib/chart-options';

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, ArcElement, Tooltip, Legend, Filler
);

interface ChartsProps {
  chartData: ChartData;
}

type ChartView = 'profit' | 'sales' | 'both';

export default function Charts({ chartData }: ChartsProps) {
  const [chartView, setChartView] = useState<ChartView>('both');

  const viewOptions: Array<{ label: string; value: ChartView }> = [
    { label: 'Daily Profit', value: 'profit' },
    { label: 'Daily Sales', value: 'sales' },
    { label: 'Both', value: 'both' },
  ];

  // Build datasets based on selected view
  const datasets = [];
  if (chartView === 'profit' || chartView === 'both') {
    datasets.push({
      label: 'Net Profit',
      data: chartData.profitByDate.data,
      borderColor: '#69C9D0',
      backgroundColor: 'rgba(105, 201, 208, 0.1)',
      fill: chartView === 'profit',
      tension: 0.4,
      pointRadius: 4,
      pointBackgroundColor: '#69C9D0',
      pointBorderColor: '#0f0f0f',
      pointBorderWidth: 2,
      yAxisID: 'y',
    });
  }
  if (chartView === 'sales' || chartView === 'both') {
    datasets.push({
      label: 'Sales (GMV)',
      data: chartData.gmvByDate.data,
      borderColor: '#EE1D52',
      backgroundColor: 'rgba(238, 29, 82, 0.1)',
      fill: chartView === 'sales',
      tension: 0.4,
      pointRadius: 4,
      pointBackgroundColor: '#EE1D52',
      pointBorderColor: '#0f0f0f',
      pointBorderWidth: 2,
      yAxisID: chartView === 'both' ? 'y1' : 'y',
    });
  }

  // Use the longest label set (they should be the same dates)
  const labels = chartData.profitByDate.labels.length >= chartData.gmvByDate.labels.length
    ? chartData.profitByDate.labels
    : chartData.gmvByDate.labels;

  // Build chart options based on view
  const getOptions = () => {
    const baseOptions = getLineChartOptions('$');
    if (chartView === 'both') {
      return {
        ...baseOptions,
        scales: {
          ...baseOptions.scales,
          y: {
            ...(baseOptions.scales as Record<string, unknown>)?.y as object,
            position: 'left' as const,
            title: {
              display: true,
              text: 'Net Profit ($)',
              color: '#69C9D0',
              font: { size: 11 },
            },
            ticks: {
              color: 'rgba(255,255,255,0.5)',
              font: { size: 11 },
              callback: (value: unknown) => '$' + value,
            },
            grid: {
              color: 'rgba(255,255,255,0.06)',
            },
          },
          y1: {
            position: 'right' as const,
            title: {
              display: true,
              text: 'Sales / GMV ($)',
              color: '#EE1D52',
              font: { size: 11 },
            },
            ticks: {
              color: 'rgba(255,255,255,0.5)',
              font: { size: 11 },
              callback: (value: unknown) => '$' + value,
            },
            grid: {
              drawOnChartArea: false,
            },
          },
          x: {
            ticks: {
              color: 'rgba(255,255,255,0.5)',
              font: { size: 11 },
            },
            grid: {
              color: 'rgba(255,255,255,0.06)',
            },
          },
        },
      };
    }
    return baseOptions;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      {/* Combined Profit & Sales Chart */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl lg:col-span-1">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-tt-muted">Performance Trend</h3>
          <div className="flex gap-1">
            {viewOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setChartView(opt.value)}
                className={`px-3 py-1 rounded-full text-[11px] font-medium cursor-pointer transition-all ${
                  chartView === opt.value
                    ? 'bg-tt-cyan text-black'
                    : 'bg-tt-card-hover text-tt-muted hover:text-tt-text'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="relative h-[280px]">
          <Line
            data={{ labels, datasets }}
            options={getOptions()}
          />
        </div>
      </div>

      {/* Cost Breakdown */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl">
        <h3 className="text-sm font-semibold text-tt-muted mb-4">Cost Breakdown</h3>
        <div className="relative h-[280px]">
          <Doughnut
            data={{
              labels: chartData.costBreakdown.labels,
              datasets: [{
                data: chartData.costBreakdown.data,
                backgroundColor: chartData.costBreakdown.colors,
                borderWidth: 0,
              }],
            }}
            options={getDoughnutChartOptions(chartData.costBreakdown.rawAmounts || [])}
          />
        </div>
      </div>
    </div>
  );
}
