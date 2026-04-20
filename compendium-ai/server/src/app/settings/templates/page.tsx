import { redirect } from 'next/navigation';

export default function SettingsTemplatesRedirect(): never {
  redirect('/admin/templates');
}
