import Link from 'next/link';
import Image from 'next/image';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-[#0a0a0a]/80 backdrop-blur-xl border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2.5">
              <Image src="/logo.png" alt="Lensed" width={36} height={36} className="rounded-lg" />
              <span className="text-xl font-bold tracking-tight text-white">Lensed</span>
            </Link>
            <div className="hidden md:flex items-center gap-6">
              <a href="#features" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Features</a>
              <a href="#how-it-works" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">How It Works</a>
              <a href="#pricing" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Pricing</a>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="px-4 py-2 text-sm font-medium text-gray-300 border border-white/10 rounded-lg hover:bg-white/5 transition-all"
            >
              Sign In
            </Link>
            <Link
              href="/signup"
              className="px-4 py-2 text-sm font-medium text-black bg-white rounded-lg hover:bg-gray-200 transition-all"
            >
              Get Started Free
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#4F46E5]/8 via-transparent to-[#69C9D0]/8 pointer-events-none" />
        <div className="absolute top-20 left-1/4 w-96 h-96 bg-[#4F46E5]/[0.07] rounded-full blur-3xl pointer-events-none" />
        <div className="absolute top-40 right-1/4 w-96 h-96 bg-[#69C9D0]/[0.07] rounded-full blur-3xl pointer-events-none" />

        <div className="relative max-w-7xl mx-auto px-6 pt-20 pb-16 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-gray-300 text-sm font-medium mb-8">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#69C9D0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            Built for TikTok Shop Sellers
          </div>

          <h1 className="text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6 text-white">
            Your TikTok Shop
            <br />
            <span className="bg-gradient-to-r from-[#69C9D0] to-[#4F46E5] bg-clip-text text-transparent">
              P&L Dashboard
            </span>
          </h1>

          <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Track profit, manage products, and visualize your TikTok Shop performance — all in one place. Stop guessing, start growing.
          </p>

          <div className="flex items-center justify-center gap-4 mb-16">
            <Link
              href="/signup"
              className="px-8 py-3.5 text-base font-semibold text-black bg-white rounded-xl hover:bg-gray-200 transition-all shadow-lg shadow-white/10"
            >
              Start Tracking Free
            </Link>
            <a
              href="#features"
              className="px-8 py-3.5 text-base font-semibold text-gray-300 bg-white/[0.06] border border-white/10 rounded-xl hover:bg-white/10 transition-all"
            >
              See Features
            </a>
          </div>

          {/* Dashboard Preview */}
          <div className="max-w-5xl mx-auto">
            <div className="rounded-2xl border border-white/[0.08] bg-[#111111] shadow-2xl shadow-black/40 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 bg-[#161616] border-b border-white/[0.06]">
                <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
                <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
                <div className="w-3 h-3 rounded-full bg-[#28c840]" />
                <span className="ml-3 text-xs text-gray-500">lensed.io/dashboard</span>
              </div>
              <div className="p-6 md:p-8">
                {/* Mock Dashboard Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                  {[
                    { label: 'Total GMV', value: '$24,580', change: '+18.2%', up: true },
                    { label: 'Net Profit', value: '$8,934', change: '+24.1%', up: true },
                    { label: 'Profit Margin', value: '36.3%', change: '+2.8%', up: true },
                    { label: 'Videos Posted', value: '142', change: '+31%', up: true },
                  ].map((card, i) => (
                    <div key={i} className="bg-[rgba(255,255,255,0.03)] rounded-xl p-4 border border-white/[0.06]">
                      <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-1">{card.label}</p>
                      <p className="text-xl font-bold text-white">{card.value}</p>
                      <p className={`text-xs mt-1 ${card.up ? 'text-[#00c853]' : 'text-[#ff1744]'}`}>{card.change}</p>
                    </div>
                  ))}
                </div>
                {/* Mock Chart Area */}
                <div className="bg-[rgba(255,255,255,0.03)] rounded-xl p-6 border border-white/[0.06]">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-medium text-gray-400">Profit Over Time</p>
                    <div className="flex gap-2">
                      <span className="px-2 py-1 text-[10px] rounded bg-[#69C9D0]/20 text-[#69C9D0]">7D</span>
                      <span className="px-2 py-1 text-[10px] rounded bg-white/[0.04] text-gray-500">30D</span>
                      <span className="px-2 py-1 text-[10px] rounded bg-white/[0.04] text-gray-500">ALL</span>
                    </div>
                  </div>
                  <svg viewBox="0 0 600 150" className="w-full h-auto">
                    <defs>
                      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#69C9D0" stopOpacity="0.3"/>
                        <stop offset="100%" stopColor="#69C9D0" stopOpacity="0"/>
                      </linearGradient>
                    </defs>
                    <path d="M0,120 Q50,110 100,95 T200,80 T300,50 T400,60 T500,30 T600,20 V150 H0Z" fill="url(#chartGrad)"/>
                    <path d="M0,120 Q50,110 100,95 T200,80 T300,50 T400,60 T500,30 T600,20" fill="none" stroke="#69C9D0" strokeWidth="2.5"/>
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-24 bg-[#0a0a0a]">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-[#69C9D0] text-sm font-medium mb-4">
              Features
            </div>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-4 text-white">
              Everything You Need to Track Your P&L
            </h2>
            <p className="text-gray-400 max-w-xl mx-auto">
              Purpose-built for TikTok Shop sellers who want clarity on their numbers.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.21 15.89A10 10 0 1 1 8 2.83"/>
                    <path d="M22 12A10 10 0 0 0 12 2v10z"/>
                  </svg>
                ),
                title: 'Real-Time Analytics',
                description: 'See your GMV, profit margins, and expenses update in real-time with interactive charts and KPI cards.',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="1" y="4" width="22" height="16" rx="2"/>
                    <path d="M1 10h22"/>
                  </svg>
                ),
                title: 'Multi-Product Tracking',
                description: 'Manage unlimited products and track each one individually. Filter by product, date range, or time period.',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                  </svg>
                ),
                title: 'CSV Import & Export',
                description: 'Bulk import your existing data and export reports with one click. Works with any spreadsheet format.',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                ),
                title: 'Expense Breakdown',
                description: 'Track shipping costs, affiliate commissions, and ad spend. Know exactly where your money is going.',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                ),
                title: 'Secure & Private',
                description: 'Your data is protected with row-level security. Only you can see your numbers — always.',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2"/>
                    <line x1="8" y1="21" x2="16" y2="21"/>
                    <line x1="12" y1="17" x2="12" y2="21"/>
                  </svg>
                ),
                title: 'Beautiful Dashboard',
                description: 'A clean, dark-themed interface built for TikTok sellers. Visualize trends with profit charts and product breakdowns.',
              },
            ].map((feature, i) => (
              <div key={i} className="bg-white/[0.03] rounded-2xl p-8 border border-white/[0.06] hover:border-[#69C9D0]/30 hover:bg-white/[0.05] transition-all group">
                <div className="w-12 h-12 rounded-xl bg-white/[0.06] text-[#69C9D0] flex items-center justify-center mb-5 group-hover:bg-[#69C9D0] group-hover:text-black transition-all">
                  {feature.icon}
                </div>
                <h3 className="text-lg font-bold mb-2 text-white">{feature.title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-24 bg-[#111111]">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-[#69C9D0] text-sm font-medium mb-4">
              How It Works
            </div>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-4 text-white">
              Start Tracking in 3 Steps
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: '1',
                title: 'Create Your Account',
                description: 'Sign up in seconds with Google or email. No credit card required.',
              },
              {
                step: '2',
                title: 'Add Your Products',
                description: 'Add the TikTok Shop products you sell and start logging daily metrics.',
              },
              {
                step: '3',
                title: 'See Your Profits',
                description: 'Instantly visualize your P&L with charts, margins, and expense breakdowns.',
              },
            ].map((step, i) => (
              <div key={i} className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#69C9D0] to-[#4F46E5] text-white text-2xl font-extrabold flex items-center justify-center mx-auto mb-6 shadow-lg shadow-[#69C9D0]/20">
                  {step.step}
                </div>
                <h3 className="text-xl font-bold mb-3 text-white">{step.title}</h3>
                <p className="text-gray-400 max-w-xs mx-auto">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-24 bg-[#0a0a0a]">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-[#69C9D0] text-sm font-medium mb-4">
              Pricing
            </div>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-4 text-white">
              Simple, Transparent Pricing
            </h2>
          </div>

          <div className="max-w-md mx-auto">
            <div className="rounded-2xl border border-[#69C9D0]/40 bg-white/[0.03] p-8 text-center shadow-xl shadow-[#69C9D0]/5">
              <p className="text-sm font-semibold text-[#69C9D0] uppercase tracking-wide mb-2">Free Forever</p>
              <div className="mb-6">
                <span className="text-5xl font-extrabold text-white">$0</span>
                <span className="text-gray-500 ml-1">/month</span>
              </div>
              <ul className="text-left space-y-3 mb-8">
                {[
                  'Unlimited products',
                  'Real-time analytics dashboard',
                  'CSV import & export',
                  'Expense tracking',
                  'Interactive charts',
                  'Secure cloud storage',
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-gray-300">
                    <svg className="w-5 h-5 text-[#69C9D0] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="block w-full px-8 py-3.5 text-base font-semibold text-black bg-white rounded-xl hover:bg-gray-200 transition-all"
              >
                Get Started Free
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 bg-gradient-to-br from-[#69C9D0]/10 to-[#4F46E5]/10 border-y border-white/[0.06]">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-6 text-white">
            Ready to Know Your Real Profit?
          </h2>
          <p className="text-lg text-gray-400 mb-10 max-w-xl mx-auto">
            Join TikTok Shop sellers who use Lensed to track their P&L and make smarter business decisions.
          </p>
          <Link
            href="/signup"
            className="inline-flex px-8 py-3.5 text-base font-semibold bg-white text-black rounded-xl hover:bg-gray-200 transition-all shadow-lg shadow-white/10"
          >
            Start Tracking for Free
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#0a0a0a] border-t border-white/[0.06] text-gray-500 py-12">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-2.5">
              <Image src="/logo.png" alt="Lensed" width={28} height={28} className="rounded-md" />
              <span className="text-white font-bold">Lensed</span>
            </div>
            <p className="text-sm">&copy; {new Date().getFullYear()} Lensed. All rights reserved.</p>
            <div className="flex gap-6">
              <Link href="/login" className="text-sm hover:text-white transition-colors">Sign In</Link>
              <Link href="/signup" className="text-sm hover:text-white transition-colors">Get Started</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
