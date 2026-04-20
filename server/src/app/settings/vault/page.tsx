import { redirect } from 'next/navigation';

export default function SettingsVaultRedirect(): never {
  redirect('/admin/vault');
}
