import { redirect } from 'next/navigation';

export default function AdminTemplatesRedirect(): never {
  redirect('/settings/templates');
}
