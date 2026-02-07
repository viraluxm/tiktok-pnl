import { redirect } from 'next/navigation';

export default function ProductsPage() {
  // All functionality is in the unified dashboard page
  redirect('/dashboard');
}
