import { redirect } from 'next/navigation';

export default function SettingsIndex(): never {
  redirect('/settings/profile');
}
