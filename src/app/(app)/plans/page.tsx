'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';

export default function PlansPage() {
  const [yearly, setYearly] = useState(true);
  const router = useRouter();

  const monthlyPrice = 49;
  const yearlyMonthly = Math.round(monthlyPrice * 10 / 12); // 10 months = 2 free
  const yearlyTotal = monthlyPrice * 10;
  const extraShopPrice = 39;

  const displayPrice = yearly ? yearlyMonthly : monthlyPrice;
  const billingLabel = yearly ? '/mo (billed yearly)' : '/month';

  // Mock current plan (will be replaced with real data)
  const currentPlan = 'pro';
  const currentShops = 1;

  return (
    <div className="min-h-screen bg-tt-bg">
      <Header />

      <div className="p-6 max-w-xl mx-auto">
        {/* Back button */}
        <button
          onClick={() => router.push('/account')}
          className="flex items-center gap-1.5 text-tt-muted text-sm hover:text-tt-text transition-colors mb-6"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Back to Account
        </button>

        <h1 className="text-2xl font-bold text-tt-text mb-2">Manage Plan</h1>
        <p className="text-sm text-tt-muted mb-8">Choose the plan that works best for your business</p>

        {/* Current Plan Summary */}
        <div className="bg-tt-card border border-tt-cyan/30 rounded-xl p-5 mb-8">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-tt-cyan uppercase tracking-wide font-semibold mb-1">Your Current Plan</p>
              <p className="text-lg font-bold text-tt-text">Pro — {currentShops} {currentShops === 1 ? 'Shop' : 'Shops'}</p>
              <p className="text-xs text-tt-muted mt-0.5">${monthlyPrice}/month &middot; Renews on March 9, 2026</p>
            </div>
            <span className="px-3 py-1 rounded-full text-[11px] font-bold bg-tt-cyan/15 text-tt-cyan border border-tt-cyan/30">
              Active
            </span>
          </div>
        </div>

        {/* Billing Toggle */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <span className={`text-sm font-medium ${!yearly ? 'text-tt-text' : 'text-tt-muted'}`}>Monthly</span>
          <button
            onClick={() => setYearly(!yearly)}
            className={`relative w-14 h-7 rounded-full transition-colors ${yearly ? 'bg-tt-cyan' : 'bg-white/10'}`}
          >
            <span className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow-md transition-transform ${yearly ? 'left-[calc(100%-1.625rem)]' : 'left-0.5'}`} />
          </button>
          <span className={`text-sm font-medium ${yearly ? 'text-tt-text' : 'text-tt-muted'}`}>Yearly</span>
          {yearly && (
            <span className="ml-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-tt-cyan/15 text-tt-cyan border border-tt-cyan/30">
              Save ${monthlyPrice * 2}
            </span>
          )}
        </div>

        {/* Pro Plan */}
        <div className={`rounded-xl border p-6 transition-all mb-5 ${currentPlan === 'pro' ? 'border-tt-cyan/50 bg-tt-cyan/[0.03]' : 'border-tt-border bg-tt-card'}`}>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold text-tt-cyan uppercase tracking-wide">Pro — 1 Shop</p>
            {currentPlan === 'pro' && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-tt-cyan/15 text-tt-cyan">Current</span>
            )}
          </div>
          <div className="mb-1">
            <span className="text-4xl font-extrabold text-tt-text">${displayPrice}</span>
            <span className="text-tt-muted ml-1 text-sm">{billingLabel}</span>
          </div>
          {yearly && (
            <p className="text-xs text-tt-muted mb-4">${yearlyTotal}/year</p>
          )}
          {!yearly && <div className="mb-4" />}

          <div className="bg-gradient-to-r from-[#EE1D52]/10 to-tt-cyan/10 border border-tt-cyan/20 rounded-lg p-2.5 mb-5">
            <p className="text-[11px] text-tt-cyan font-semibold">Free 7-Day Trial</p>
            <p className="text-[10px] text-tt-muted">Refer a friend — you both get 7 days free, no card needed.</p>
          </div>

          <ul className="space-y-2 mb-6">
            {[
              'Full P&L dashboard',
              'TikTok Shop auto-sync',
              'Unlimited products',
              'Real-time analytics & charts',
              'CSV import & export',
              'Priority support',
            ].map((item, i) => (
              <li key={i} className="flex items-center gap-2 text-tt-text text-xs">
                <svg className="w-3.5 h-3.5 text-tt-cyan shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                {item}
              </li>
            ))}
          </ul>

          {currentPlan === 'pro' ? (
            <button disabled className="w-full py-2.5 rounded-lg text-xs font-semibold bg-tt-card border border-tt-border text-tt-muted cursor-default">
              Current Plan
            </button>
          ) : (
            <button className="w-full py-2.5 rounded-lg text-xs font-semibold bg-tt-cyan text-black hover:opacity-90 transition-opacity">
              Switch to Pro
            </button>
          )}

          {/* Additional Shops — compact section below */}
          <div className="mt-6 pt-6 border-t border-white/[0.08]">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-xs font-semibold text-tt-muted uppercase tracking-wide">Additional Shops</p>
                <p className="text-[11px] text-tt-muted/60 mt-0.5">Add as many shops as you need</p>
              </div>
              <div className="text-right">
                <span className="text-2xl font-extrabold text-tt-text">${extraShopPrice}</span>
                <span className="text-tt-muted text-xs ml-1">/shop/mo</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {[
                'Separate P&L per shop',
                'Same full feature set',
                'Compare across shops',
                'Consolidated reporting',
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-tt-muted text-[11px]">
                  <svg className="w-3 h-3 text-tt-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  {item}
                </div>
              ))}
            </div>
            <button className="w-full py-2 rounded-lg text-xs font-semibold border border-tt-border text-tt-text hover:bg-tt-card-hover transition-all">
              Add a Shop — ${extraShopPrice}/mo
            </button>
          </div>
        </div>

        {/* Referral CTA */}
        <div className="bg-gradient-to-r from-[#EE1D52]/10 to-tt-cyan/10 border border-tt-cyan/20 rounded-xl p-6 text-center">
          <h3 className="text-lg font-bold text-tt-text mb-2">Try Free for 7 Days</h3>
          <p className="text-sm text-tt-muted mb-4 max-w-md mx-auto">
            Refer a friend to Lensed and you both get a full 7-day free trial — no credit card required.
          </p>
          <button className="px-6 py-2.5 rounded-lg bg-tt-cyan text-black text-sm font-semibold hover:opacity-90 transition-opacity">
            Invite a Friend
          </button>
        </div>
      </div>
    </div>
  );
}
