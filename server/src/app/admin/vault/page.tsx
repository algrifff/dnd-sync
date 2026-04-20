import { redirect } from 'next/navigation';

export default function AdminVaultRedirect(): never {
  redirect('/settings/vault');
}
