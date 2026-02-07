import { redirect } from 'next/navigation';

export default function EntriesPage() {
  // All functionality is in the unified dashboard page
  redirect('/dashboard');
}
