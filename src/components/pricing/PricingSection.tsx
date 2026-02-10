'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function PricingSection() {
  const [yearly, setYearly] = useState(true);

  const monthlyPrice = 49;
  const yearlyMonthly = Math.round(monthlyPrice * 10 / 12); // 10 months = 2 free
  const yearlyTotal = monthlyPrice * 10;
  const extraShopPrice = 39;

  const displayPrice = yearly ? yearlyMonthly : monthlyPrice;
  const billingLabel = yearly ? '/mo (billed yearly)' : '/month';

  return (
    <div className="max-w-7xl mx-auto px-6">
      <div className="text-center mb-16">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-[#69C9D0] text-sm font-medium mb-4">
          Pricing
        </div>
        <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-4 text-white">
          Simple, Transparent Pricing
        </h2>
        <p className="text-gray-400 max-w-xl mx-auto mb-8">
          Start with a free 7-day trial — refer a friend and you both get access.
        </p>

        {/* Yearly Toggle */}
        <div className="flex items-center justify-center gap-3 mb-4">
          <span className={`text-sm font-medium ${!yearly ? 'text-white' : 'text-gray-500'}`}>Monthly</span>
          <button
            onClick={() => setYearly(!yearly)}
            className={`relative w-14 h-7 rounded-full transition-colors ${yearly ? 'bg-[#69C9D0]' : 'bg-white/10'}`}
          >
            <span className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow-md transition-transform ${yearly ? 'left-[calc(100%-1.625rem)]' : 'left-0.5'}`} />
          </button>
          <span className={`text-sm font-medium ${yearly ? 'text-white' : 'text-gray-500'}`}>Yearly</span>
          {yearly && (
            <span className="ml-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#69C9D0]/20 text-[#69C9D0] border border-[#69C9D0]/30">
              2 months free
            </span>
          )}
        </div>
      </div>

      <div className="max-w-xl mx-auto">
        {/* Main Plan */}
        <div className="rounded-2xl border border-[#69C9D0]/40 bg-white/[0.03] p-8 shadow-xl shadow-[#69C9D0]/5 relative">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-[#69C9D0] text-black text-[11px] font-bold uppercase tracking-wider">
            Most Popular
          </div>
          <p className="text-sm font-semibold text-[#69C9D0] uppercase tracking-wide mb-2 mt-2">Pro — 1 Shop</p>
          <div className="mb-1">
            <span className="text-5xl font-extrabold text-white">${displayPrice}</span>
            <span className="text-gray-500 ml-1">{billingLabel}</span>
          </div>
          {yearly && (
            <p className="text-xs text-gray-500 mb-4">${yearlyTotal}/year — save ${monthlyPrice * 2}</p>
          )}
          {!yearly && <div className="mb-4" />}

          <div className="bg-gradient-to-r from-[#EE1D52]/10 to-[#69C9D0]/10 border border-[#69C9D0]/20 rounded-xl p-3 mb-6">
            <p className="text-xs text-[#69C9D0] font-semibold mb-0.5">Free 7-Day Trial</p>
            <p className="text-[11px] text-gray-400">Refer a friend and you both get a full 7-day free trial — no credit card needed.</p>
          </div>

          <ul className="text-left space-y-3 mb-8">
            {[
              'Full P&L dashboard',
              'TikTok Shop auto-sync',
              'Unlimited products',
              'Real-time analytics & charts',
              'Daily / weekly / monthly breakdowns',
              'Expense & fee tracking',
              'CSV import & export',
              'Priority support',
            ].map((item, i) => (
              <li key={i} className="flex items-center gap-3 text-gray-300 text-sm">
                <svg className="w-4.5 h-4.5 text-[#69C9D0] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                {item}
              </li>
            ))}
          </ul>
          <Link
            href="/signup"
            className="block w-full px-8 py-3.5 text-base font-semibold text-black bg-white rounded-xl hover:bg-gray-200 transition-all text-center"
          >
            Start Free Trial
          </Link>

          {/* Additional Shops — compact section inside main card */}
          <div className="mt-6 pt-6 border-t border-white/[0.08]">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Additional Shops</p>
                <p className="text-[11px] text-gray-500 mt-0.5">Add as many shops as you need</p>
              </div>
              <div className="text-right">
                <span className="text-2xl font-extrabold text-white">${extraShopPrice}</span>
                <span className="text-gray-500 text-xs ml-1">/shop/mo</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                'Separate P&L per shop',
                'Same full feature set',
                'Compare across shops',
                'Consolidated reporting',
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-gray-500 text-[11px]">
                  <svg className="w-3 h-3 text-gray-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
