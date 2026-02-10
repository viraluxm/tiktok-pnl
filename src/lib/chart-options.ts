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

export function getDoughnutChartOptions(rawAmounts: number[]): ChartOptions<'doughnut'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right' as const,
        labels: {
          color: '#ffffff',
          font: { size: 12 },
          padding: 14,
          usePointStyle: true,
          generateLabels: (chart) => {
            const data = chart.data;
            if (!data.labels || !data.datasets.length) return [];
            const dataset = data.datasets[0];
            const total = (dataset.data as number[]).reduce((a, b) => a + b, 0);
            return (data.labels as string[]).map((label, i) => {
              const value = (dataset.data as number[])[i] || 0;
              const pct = total > 0 ? value.toFixed(1) : '0.0';
              return {
                text: `${label} (${pct}%)`,
                fillStyle: Array.isArray(dataset.backgroundColor) ? (dataset.backgroundColor as string[])[i] : '#ccc',
                strokeStyle: 'transparent',
                hidden: false,
                index: i,
                pointStyle: 'circle' as const,
              };
            });
          },
        },
      },
      tooltip: {
        callbacks: {
          label: (context) => {
            // Show the actual dollar amount on hover
            const idx = context.dataIndex;
            const amount = rawAmounts[idx] ?? 0;
            return ` ${context.label}: $${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          },
        },
      },
    },
    cutout: '65%',
  };
}
