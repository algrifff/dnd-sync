import { redirect } from 'next/navigation';

export default function SettingsUsersRedirect(): never {
  redirect('/admin/users');
}
