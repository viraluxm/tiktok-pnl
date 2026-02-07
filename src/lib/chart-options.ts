import type { ChartOptions } from 'chart.js';

export function getLineChartOptions(suffix: '$' | '%'): ChartOptions<'line'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: '#666', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
      y: {
        ticks: {
          color: '#666',
          font: { size: 10 },
          callback: function (value) {
            const v = Number(value);
            return suffix === '$' ? '$' + v.toLocaleString() : v.toFixed(0) + '%';
          },
        },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
    },
    interaction: { intersect: false, mode: 'index' as const },
    elements: { line: { borderWidth: 2.5 } },
  };
}

export function getBarChartOptions(): ChartOptions<'bar'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: true, labels: { color: '#888', font: { size: 11 } } },
    },
    scales: {
      x: {
        ticks: { color: '#666', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
      y: {
        ticks: {
          color: '#666',
          font: { size: 10 },
          callback: function (value) {
            return '$' + Number(value).toLocaleString();
          },
        },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
    },
    interaction: { intersect: false, mode: 'index' as const },
  };
}

export function getDoughnutChartOptions(): ChartOptions<'doughnut'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right' as const,
        labels: { color: '#888', font: { size: 11 }, padding: 12, usePointStyle: true },
      },
    },
    cutout: '65%',
  };
}
