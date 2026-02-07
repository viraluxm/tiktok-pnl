'use client';

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
import { Line, Bar, Doughnut } from 'react-chartjs-2';
import type { ChartData } from '@/types';
import { getLineChartOptions, getBarChartOptions, getDoughnutChartOptions } from '@/lib/chart-options';

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, ArcElement, Tooltip, Legend, Filler
);

interface ChartsProps {
  chartData: ChartData;
}

export default function Charts({ chartData }: ChartsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      {/* Daily Net Profit Trend */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl">
        <h3 className="text-sm font-semibold text-tt-muted mb-4">Daily Net Profit Trend</h3>
        <div className="relative h-[260px]">
          <Line
            data={{
              labels: chartData.profitByDate.labels,
              datasets: [{
                label: 'Net Profit',
                data: chartData.profitByDate.data,
                borderColor: '#69C9D0',
                backgroundColor: 'rgba(105, 201, 208, 0.1)',
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointBackgroundColor: '#69C9D0',
                pointBorderColor: '#0f0f0f',
                pointBorderWidth: 2,
              }],
            }}
            options={getLineChartOptions('$')}
          />
        </div>
      </div>

      {/* GMV vs Net Profit by Product */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl">
        <h3 className="text-sm font-semibold text-tt-muted mb-4">GMV vs Net Profit by Product</h3>
        <div className="relative h-[260px]">
          <Bar
            data={{
              labels: chartData.productCompare.labels,
              datasets: [
                {
                  label: 'GMV',
                  data: chartData.productCompare.gmv,
                  backgroundColor: 'rgba(105, 201, 208, 0.7)',
                  borderRadius: 6,
                },
                {
                  label: 'Net Profit',
                  data: chartData.productCompare.profit,
                  backgroundColor: 'rgba(238, 29, 82, 0.7)',
                  borderRadius: 6,
                },
              ],
            }}
            options={getBarChartOptions()}
          />
        </div>
      </div>

      {/* Cost Breakdown */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl">
        <h3 className="text-sm font-semibold text-tt-muted mb-4">Cost Breakdown</h3>
        <div className="relative h-[260px]">
          <Doughnut
            data={{
              labels: chartData.costBreakdown.labels,
              datasets: [{
                data: chartData.costBreakdown.data,
                backgroundColor: chartData.costBreakdown.colors,
                borderWidth: 0,
              }],
            }}
            options={getDoughnutChartOptions()}
          />
        </div>
      </div>

      {/* Profit Margin Trend */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl">
        <h3 className="text-sm font-semibold text-tt-muted mb-4">Profit Margin Trend</h3>
        <div className="relative h-[260px]">
          <Line
            data={{
              labels: chartData.marginByDate.labels,
              datasets: [{
                label: 'Profit Margin %',
                data: chartData.marginByDate.data,
                borderColor: '#EE1D52',
                backgroundColor: 'rgba(238, 29, 82, 0.1)',
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointBackgroundColor: '#EE1D52',
                pointBorderColor: '#0f0f0f',
                pointBorderWidth: 2,
              }],
            }}
            options={getLineChartOptions('%')}
          />
        </div>
      </div>
    </div>
  );
}
