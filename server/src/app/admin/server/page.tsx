import { redirect } from 'next/navigation';

export default function AdminServerRedirect(): never {
  redirect('/settings/world');
}
