import { redirect } from 'next/navigation'

/**
 * Login and self-service registration live on the server-side Mission Control app only.
 * `/login` is handled by middleware (redirect); this route is a fallback for direct navigation.
 */
export default function LoginPage() {
  redirect('/')
}
