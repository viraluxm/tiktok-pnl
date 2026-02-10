'use client';

import Image from 'next/image';
import UserMenu from './UserMenu';

export default function Header() {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-tt-border bg-[rgba(15,15,15,0.95)] backdrop-blur-xl sticky top-0 z-50">
      <div className="flex items-center gap-3">
        <Image src="/logo.png" alt="Lensed" width={36} height={36} className="rounded-[10px]" />
        <h1 className="text-lg font-bold">
          Lensed
        </h1>
      </div>
      <UserMenu />
    </div>
  );
}
