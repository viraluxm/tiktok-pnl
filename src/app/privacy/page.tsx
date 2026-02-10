import Link from 'next/link';
import Image from 'next/image';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-[#0a0a0a]/80 backdrop-blur-xl border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/logo.png" alt="Lensed" width={36} height={36} className="rounded-lg" />
            <span className="text-xl font-bold tracking-tight text-white">Lensed</span>
          </Link>
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

      {/* Content */}
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-extrabold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-gray-500 mb-12">Last updated: February 9, 2026</p>

        <div className="space-y-10 text-gray-300 leading-relaxed">
          <section>
            <h2 className="text-xl font-bold text-white mb-3">1. Introduction</h2>
            <p>
              Lensed (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) operates the website lensed.io and provides a profit and loss dashboard for TikTok Shop sellers. This Privacy Policy explains how we collect, use, store, and protect your information when you use our service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">2. Information We Collect</h2>
            <p className="mb-3">We collect the following types of information:</p>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li><span className="text-white font-medium">Account Information:</span> Email address and name when you create an account via email or Google sign-in.</li>
              <li><span className="text-white font-medium">TikTok Shop Data:</span> When you connect your TikTok Shop account, we access order information, product details, finance/settlement data, and shop information through the TikTok Shop Open API. This data is used solely to calculate and display your P&L metrics.</li>
              <li><span className="text-white font-medium">User-Entered Data:</span> Cost of goods, additional expenses, and other financial data you manually input into the dashboard.</li>
              <li><span className="text-white font-medium">Usage Data:</span> Basic analytics about how you interact with our service to improve the product.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">3. How We Use Your Information</h2>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>To provide, maintain, and improve the Lensed dashboard and P&L analytics.</li>
              <li>To sync and display your TikTok Shop order, product, and finance data.</li>
              <li>To calculate profit margins, expense breakdowns, and other financial metrics.</li>
              <li>To authenticate your identity and secure your account.</li>
              <li>To communicate with you about service updates or support requests.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">4. Data Storage and Security</h2>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>All data is stored on Supabase (hosted on AWS) in the United States (us-east-1, Virginia).</li>
              <li>Data in transit is encrypted via TLS/HTTPS.</li>
              <li>Data at rest is encrypted using AES-256 encryption.</li>
              <li>Database access is protected by row-level security (RLS) policies, ensuring each user can only access their own data.</li>
              <li>TikTok API access tokens are stored securely and are never exposed to the client-side application.</li>
              <li>Our application is hosted on Vercel with built-in DDoS protection and edge security.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">5. Data Sharing</h2>
            <p>
              We do not sell, rent, or share your personal data or TikTok Shop data with any third parties. Your data is used exclusively to provide you with P&L analytics within the Lensed dashboard. We do not use your data for advertising, marketing to third parties, or any purpose other than delivering our service to you.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">6. TikTok Shop Data</h2>
            <p>
              When you connect your TikTok Shop account, we access data through the TikTok Shop Open API with your explicit authorization. We only request the permissions necessary to provide P&L analytics. You can disconnect your TikTok Shop account at any time from the dashboard, which will revoke our access and delete your stored TikTok data.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">7. Data Retention and Deletion</h2>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>Your data is retained for as long as your account is active.</li>
              <li>When you disconnect your TikTok Shop, all associated tokens and synced data are permanently deleted.</li>
              <li>When you delete your account, all of your data including account information, entries, products, and TikTok connection data is permanently deleted from our systems.</li>
              <li>You can request data deletion at any time by contacting us.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">8. Your Rights</h2>
            <p className="mb-3">You have the right to:</p>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>Access the personal data we hold about you.</li>
              <li>Request correction of inaccurate data.</li>
              <li>Request deletion of your data.</li>
              <li>Disconnect your TikTok Shop account at any time.</li>
              <li>Export your data from the dashboard.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">9. Cookies</h2>
            <p>
              We use essential cookies only for authentication and session management. We do not use tracking cookies or third-party advertising cookies.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">10. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the updated policy on this page with a revised date. Your continued use of the service after changes constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-3">11. Contact Us</h2>
            <p>
              If you have any questions about this Privacy Policy or our data practices, please contact us at:
            </p>
            <p className="mt-2 text-white font-medium">support@lensed.io</p>
          </section>
        </div>
      </div>

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
              <Link href="/privacy" className="text-sm hover:text-white transition-colors">Privacy Policy</Link>
              <Link href="/login" className="text-sm hover:text-white transition-colors">Sign In</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
